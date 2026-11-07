//! System tray.
//!
//! The desktop build keeps the server running while the window is closed, so
//! the tray is the only place the user can see that fact and act on it.

use crate::state::AppState;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开 HomeLedger", true, None::<&str>)?;
    let data = MenuItem::with_id(app, "data", "打开数据目录", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "查看运行日志", true, None::<&str>)?;
    let backup = MenuItem::with_id(app, "backup", "立即备份", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &data,
            &logs,
            &backup,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("homeledger-tray")
        .tooltip("HomeLedger")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

fn reveal(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "show" => reveal(app),
        "data" => {
            let state = app.state::<AppState>();
            open_path(app, &state.data_dir);
        }
        "logs" => {
            let state = app.state::<AppState>();
            open_path(app, &state.data_dir.join("logs"));
        }
        "backup" => {
            let handle = app.clone();
            // A backup of a large library can take a while; never block the
            // tray thread on I/O.
            std::thread::spawn(move || {
                let state = handle.state::<AppState>();
                let result = state
                    .with_server(|r| r.post("/api/v1/desktop/backup"))
                    .unwrap_or_else(|| Err("内置服务未就绪".to_string()));

                match result {
                    Ok(v) => {
                        let name = v
                            .get("filename")
                            .and_then(|f| f.as_str())
                            .unwrap_or("备份完成");
                        notify(&handle, "备份完成", name);
                    }
                    Err(err) => notify(&handle, "备份失败", &err),
                }
            });
        }
        "quit" => {
            let state = app.state::<AppState>();
            state.quitting.store(true, std::sync::atomic::Ordering::SeqCst);
            app.exit(0);
        }
        _ => {}
    }
}

fn open_path(app: &AppHandle, path: &std::path::Path) {
    use tauri_plugin_opener::OpenerExt;
    std::fs::create_dir_all(path).ok();
    let _ = app.opener().open_path(path.to_string_lossy(), None::<&str>);
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
}
