#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
compile_error!("DeepSeek Harness Desktop is released for Apple Silicon macOS only");

mod bridge;
mod sidecar;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use url::Url;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .setup(|app| {
            setup_main_window(app)?;

            let app_handle = app.handle().clone();
            let bridge = bridge::BridgeHandle::start(app_handle.clone())
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            let sidecar = sidecar::start(app_handle.clone(), bridge.port(), bridge.token());

            app.manage(bridge);
            app.manage(sidecar);
            setup_tray(app)?;

            ctrlc::set_handler(move || {
                app_handle.exit(0);
            })?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building DeepSeek Harness desktop application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(sidecar) = app_handle.try_state::<sidecar::SidecarHandle>() {
                    sidecar.stop();
                }
                if let Some(bridge) = app_handle.try_state::<bridge::BridgeHandle>() {
                    bridge.stop();
                }
            }
        });
}

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("DeepSeek Harness")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

fn setup_main_window(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let opener = app.handle().clone();
    let new_window_opener = app.handle().clone();
    WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
        .title("DeepSeek Harness")
        .inner_size(1280.0, 820.0)
        .min_inner_size(960.0, 640.0)
        .center()
        .visible(false)
        .resizable(true)
        .on_navigation(move |url| {
            if is_internal_url(url) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https") {
                let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                let _ = new_window_opener
                    .opener()
                    .open_url(url.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

fn is_internal_url(url: &Url) -> bool {
    if url.scheme() == "tauri" {
        return true;
    }
    matches!(url.scheme(), "http" | "https")
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
