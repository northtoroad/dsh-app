use std::env;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use url::Url;

const READY_TIMEOUT: Duration = Duration::from_secs(90);
const READY_POLL_INTERVAL: Duration = Duration::from_millis(250);

pub struct SidecarHandle {
    child: Mutex<Option<Child>>,
}

impl SidecarHandle {
    pub fn stop(&self) {
        let Ok(mut child) = self.child.lock() else {
            return;
        };
        let Some(mut child) = child.take() else {
            return;
        };

        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

impl Drop for SidecarHandle {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut child) = child.take() {
                if child.try_wait().ok().flatten().is_none() {
                    let _ = child.kill();
                }
                let _ = child.wait();
            }
        }
    }
}

pub fn start(app: AppHandle, bridge_port: u16, bridge_token: &str) -> SidecarHandle {
    let state = SidecarHandle {
        child: Mutex::new(None),
    };

    let sidecar_port = match pick_loopback_port() {
        Ok(port) => port,
        Err(error) => {
            show_launch_error(&app, &format!("无法分配本地端口：{error}"));
            return state;
        }
    };

    let (node, dsh_bin) = match resolve_runtime(&app) {
        Ok(paths) => paths,
        Err(error) => {
            show_launch_error(&app, &error);
            return state;
        }
    };
    let profile = env::var("DSH_DESKTOP_PROFILE").unwrap_or_else(|_| "web".to_owned());

    let log_path = sidecar_log_path(&app);
    let mut command = Command::new(&node);
    command
        .arg(&dsh_bin)
        .arg("--profile")
        .arg(profile)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(sidecar_port.to_string())
        .env("DSH_DESKTOP_BRIDGE_PORT", bridge_port.to_string())
        .env("DSH_DESKTOP_BRIDGE_TOKEN", bridge_token)
        .env("DSH_DESKTOP_SIDECAR_PORT", sidecar_port.to_string())
        .env("DSH_DESKTOP_HOST", "127.0.0.1")
        .env("DSH_DESKTOP_APP", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            show_launch_error(
                &app,
                &format!(
                    "无法启动 DSH 本地服务：{error}\n请检查运行时资源或 DSH_DESKTOP_* 环境变量。"
                ),
            );
            return state;
        }
    };

    if let Some(stdout) = child.stdout.take() {
        spawn_log_reader(stdout, "stdout", log_path.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_log_reader(stderr, "stderr", log_path);
    }

    if let Ok(mut slot) = state.child.lock() {
        *slot = Some(child);
    }

    let ready_app = app.clone();
    thread::Builder::new()
        .name("dsh-desktop-ready-check".to_owned())
        .spawn(move || {
            if wait_until_ready(sidecar_port) {
                open_sidecar(&ready_app, sidecar_port);
            } else {
                show_launch_error(
                    &ready_app,
                    "DSH 本地服务启动超时，请查看 sidecar.log 获取详情。",
                );
            }
        })
        .ok();

    state
}

fn pick_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| error.to_string())
}

fn resolve_runtime(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位应用资源目录：{error}"))?;

    let node_override = env::var_os("DSH_DESKTOP_NODE").map(PathBuf::from);
    let dsh_override = env::var_os("DSH_DESKTOP_DSH_BIN").map(PathBuf::from);

    let node = node_override
        .clone()
        .filter(|path| path.exists())
        .or_else(|| first_existing(&resource_runtime_candidates(&resource_dir, "node/bin/node")))
        .or_else(|| node_override.filter(|path| path.as_os_str() == std::ffi::OsStr::new("node")))
        .or_else(|| {
            if cfg!(debug_assertions) {
                Some(PathBuf::from("node"))
            } else {
                None
            }
        });
    let dsh_bin = dsh_override
        .filter(|path| path.exists())
        .or_else(|| {
            first_existing(&[
                resource_dir.join("runtime/dsh/apps/cli/lib/bin.js"),
                resource_dir.join("runtime/dsh/lib/bin.js"),
                resource_dir.join("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
                resource_dir.join("runtime/dsh/bin.js"),
                resource_dir.join("resources/runtime/dsh/apps/cli/lib/bin.js"),
                resource_dir.join("resources/runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
            ])
        })
        .or_else(|| {
            first_existing(&[PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../node_modules/@deepseek-ai/dsh/lib/bin.js")])
        });

    match (node, dsh_bin) {
        (Some(node), Some(dsh_bin)) => Ok((node, dsh_bin)),
        _ => Err(
            "未找到 DSH 运行时。请先安装 @deepseek-ai/dsh，或将 runtime/node/bin/node 和 runtime/dsh/lib/bin.js 放入应用资源；也可以设置 DSH_DESKTOP_NODE 与 DSH_DESKTOP_DSH_BIN。"
                .to_owned(),
        ),
    }
}

fn resource_runtime_candidates(resource_dir: &Path, suffix: &str) -> Vec<PathBuf> {
    vec![
        resource_dir.join(format!("runtime/{suffix}")),
        resource_dir.join(format!("resources/runtime/{suffix}")),
    ]
}

fn first_existing(paths: &[PathBuf]) -> Option<PathBuf> {
    paths.iter().find(|path| path.is_file()).cloned()
}

fn sidecar_log_path(app: &AppHandle) -> PathBuf {
    let directory = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| env::temp_dir().join("ai.deepseek.dsh.desktop"));
    let _ = fs::create_dir_all(&directory);
    directory.join("sidecar.log")
}

fn spawn_log_reader<R>(reader: R, stream_name: &'static str, log_path: PathBuf)
where
    R: Read + Send + 'static,
{
    thread::Builder::new()
        .name(format!("dsh-sidecar-{stream_name}"))
        .spawn(move || {
            let reader = BufReader::new(reader);
            for line in reader.lines().map_while(Result::ok) {
                append_log_line(&log_path, stream_name, &line);
            }
        })
        .ok();
}

fn append_log_line(path: &Path, stream_name: &str, line: &str) {
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(file, "[{stream_name}] {line}");
}

fn wait_until_ready(port: u16) -> bool {
    let started = Instant::now();
    while started.elapsed() < READY_TIMEOUT {
        if probe_http_root(port) {
            return true;
        }
        thread::sleep(READY_POLL_INTERVAL);
    }
    false
}

fn probe_http_root(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let request = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = [0_u8; 64];
    let Ok(bytes_read) = stream.read(&mut response) else {
        return false;
    };
    let response = String::from_utf8_lossy(&response[..bytes_read]);
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

fn open_sidecar(app: &AppHandle, port: u16) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(url) = Url::parse(&format!("http://127.0.0.1:{port}/")) else {
        return;
    };
    if let Err(error) = window.navigate(url) {
        show_launch_error(app, &format!("无法打开 DSH 界面：{error}"));
        return;
    }
    let _ = window.show();
    let _ = window.set_focus();
}

fn show_launch_error(app: &AppHandle, message: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let message = serde_json::to_string(message).unwrap_or_else(|_| "启动失败".to_owned());
    let script = format!(
        "document.querySelector('p').textContent = {message}; document.querySelector('.spinner').style.display = 'none';"
    );
    let _ = window.eval(&script);
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::{first_existing, probe_http_root};
    use std::path::PathBuf;
    use std::thread;

    #[test]
    fn first_existing_selects_a_file() {
        let paths = vec![
            PathBuf::from("/does/not/exist"),
            PathBuf::from("Cargo.toml"),
        ];
        assert_eq!(first_existing(&paths), Some(PathBuf::from("Cargo.toml")));
    }

    #[test]
    fn readiness_probe_rejects_an_unused_port() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!probe_http_root(port));
        thread::yield_now();
    }
}
