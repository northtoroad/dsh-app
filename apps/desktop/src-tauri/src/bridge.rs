use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

const MAX_FRAME_BYTES: usize = 16 * 1024;

/// The host-side desktop shell provider connects to this loopback endpoint.
/// The token is regenerated for every application launch and is never exposed
/// to the WebView.
pub struct BridgeHandle {
    port: u16,
    token: String,
    stop: Arc<AtomicBool>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl BridgeHandle {
    pub fn start(app: AppHandle) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("failed to bind desktop bridge: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("failed to configure desktop bridge: {error}"))?;

        let port = listener
            .local_addr()
            .map_err(|error| format!("failed to inspect desktop bridge: {error}"))?
            .port();
        let token = Uuid::new_v4().to_string();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread_token = token.clone();

        let join = thread::Builder::new()
            .name("dsh-desktop-bridge".to_owned())
            .spawn(move || run_listener(listener, app, thread_token, thread_stop))
            .map_err(|error| format!("failed to start desktop bridge: {error}"))?;

        Ok(Self {
            port,
            token,
            stop,
            join: Mutex::new(Some(join)),
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        if let Ok(mut join) = self.join.lock() {
            if let Some(handle) = join.take() {
                let _ = handle.join();
            }
        }
    }
}

impl Drop for BridgeHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

fn run_listener(listener: TcpListener, app: AppHandle, token: String, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _peer)) => {
                let app = app.clone();
                let token = token.clone();
                let _ = thread::Builder::new()
                    .name("dsh-desktop-bridge-client".to_owned())
                    .spawn(move || handle_client(stream, &app, &token));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                eprintln!("desktop bridge accept failed: {error}");
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

fn handle_client(mut stream: TcpStream, app: &AppHandle, expected_token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));

    let reader_stream = match stream.try_clone() {
        Ok(stream) => stream,
        Err(_) => return,
    };
    let mut reader = BufReader::new(reader_stream);
    let mut line = String::new();

    if !read_line(&mut reader, &mut line) {
        return;
    }

    let hello = match serde_json::from_str::<Value>(&line) {
        Ok(value) => value,
        Err(_) => {
            write_error(&mut stream, "unauthorized");
            return;
        }
    };
    if hello.get("type").and_then(Value::as_str) != Some("hello")
        || hello.get("token").and_then(Value::as_str) != Some(expected_token)
    {
        write_error(&mut stream, "unauthorized");
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }

    loop {
        line.clear();
        if !read_line(&mut reader, &mut line) {
            return;
        }

        let frame = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        match frame.get("type").and_then(Value::as_str) {
            Some("notify") => notify(app, &frame),
            Some("revealPath") => reveal_path(app, &frame),
            _ => {}
        }
    }
}

fn read_line<R: BufRead>(reader: &mut R, line: &mut String) -> bool {
    line.clear();
    match reader.read_line(line) {
        Ok(0) => false,
        Ok(bytes) => bytes <= MAX_FRAME_BYTES && line.ends_with('\n'),
        Err(_) => false,
    }
}

fn write_error(stream: &mut TcpStream, message: &str) {
    let frame = json!({ "type": "error", "message": message });
    let _ = writeln!(stream, "{frame}");
}

fn notify(app: &AppHandle, frame: &Value) {
    let Some(title) = frame.get("title").and_then(Value::as_str) else {
        return;
    };

    let mut builder = app.notification().builder().title(title);
    if let Some(body) = frame.get("body").and_then(Value::as_str) {
        builder = builder.body(body);
    }
    if let Err(error) = builder.show() {
        eprintln!("desktop notification failed: {error}");
    }
}

fn reveal_path(app: &AppHandle, frame: &Value) {
    let Some(path) = frame.get("path").and_then(Value::as_str) else {
        return;
    };
    if !std::path::Path::new(path).is_absolute() {
        eprintln!("refusing to reveal a non-absolute path");
        return;
    }
    if let Err(error) = app.opener().reveal_item_in_dir(path) {
        eprintln!("failed to reveal path {path}: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::MAX_FRAME_BYTES;

    #[test]
    fn frame_limit_is_large_enough_for_normal_notifications() {
        assert!(MAX_FRAME_BYTES >= 4096);
    }
}
