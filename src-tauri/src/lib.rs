//! HomeLedger shell.
//!
//! The shell's job is to make a HomeLedger installation feel like a native
//! application: it owns process lifetime, the tray, and the window. It contains
//! no business logic.
//!
//! The window always loads the web client bundled into the binary — the same
//! assets `backend/app/static` holds, built from `frontend/`. That client is a
//! complete application on its own: every device keeps its own database in
//! IndexedDB and works with no network at all. The shell no longer decides
//! where the data comes from; the user does, in 设置 → 同步, by choosing
//! 本机 / 同步 / 服务器.
//!
//! Two shapes, one crate:
//!
//! * **desktop** — additionally ships a Python sidecar and keeps it running in
//!   the background. The sidecar is a *server* other devices can sync to and a
//!   LAN gateway for browsers; it is not where this window's data lives. If it
//!   fails to start, the app still works, just without that extra service.
//! * **mobile** — no sidecar. Android cannot run a long-lived Python process,
//!   and it does not need to: the app's database is local, and syncing points
//!   at a server somewhere else in the household (or none at all).
//!
//! Keeping both in one crate is deliberate: the tray, the single-instance lock
//! and the window lifecycle are identical, and duplicating them is how the two
//! clients drift apart.

mod calendar;
mod config;
#[cfg(desktop)]
mod server;
mod share;
mod state;
#[cfg(desktop)]
mod tray;

use std::path::Path;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use state::{AppState, BootStage};

/// 把启动过程中的关键节点写进 `<数据目录>/logs/boot.log`。
///
/// 内置服务起不来的时候，用户手上**一条日志都没有**：`desktop.log` 是 sidecar
/// 自己写的，而 sidecar 根本没跑起来；窗口里的错误面板一关就没了，GUI 子系统的
/// `eprintln!` 又进不了任何地方。排查"为什么托盘里没有局域网地址"这种问题时，
/// 这个文件是唯一能看的东西。
fn log_boot(data_dir: &Path, line: &str) {
    let dir = data_dir.join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("boot.log"))
    {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{stamp}] {line}");
    }
}

/// Is this build a phone client rather than a host?
///
/// Used by the boot screen to decide whether to offer "retry the built-in
/// server" (desktop) or "enter your gateway address" (mobile).
pub fn is_mobile() -> bool {
    cfg!(any(target_os = "android", target_os = "ios"))
}

fn set_stage(app: &AppHandle, stage: BootStage) {
    app.state::<AppState>().set_stage(stage);
}

/// Point the window somewhere else. Desktop-only: on a phone the window always
/// shows the bundled client, and the only "somewhere else" would be a web page.
#[cfg_attr(mobile, allow(dead_code))]
fn navigate(app: &AppHandle, url: &str) {
    if let Some(window) = app.get_webview_window("main") {
        match url.parse::<tauri::Url>() {
            Ok(parsed) => {
                if let Err(err) = window.navigate(parsed) {
                    eprintln!("导航失败：{err}");
                }
            }
            Err(err) => eprintln!("无效地址 {url}：{err}"),
        }
    }
}

fn boot(app: AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let cfg = state.config.lock().map(|c| c.clone()).unwrap_or_default();
        log_boot(
            &state.data_dir,
            &format!("boot 开始，数据目录 {}", state.data_dir.display()),
        );

        // UI work bypasses the whole sidecar: point the window at a running
        // Vite dev server and edits hot-reload like in a browser. The API calls
        // from that page go through Vite's proxy, so a backend still has to be
        // running — scripts/dev-desktop.sh --vite starts both.
        #[cfg(desktop)]
        if let Ok(dev_url) = std::env::var("HOMELEDGER_DESKTOP_DEV_URL") {
            if !dev_url.trim().is_empty() {
                set_stage(&app, BootStage::ready(&dev_url));
                navigate(&app, &dev_url);
                return;
            }
        }

        // The window is already showing the bundled client, which reads and
        // writes this device's own database. Nothing has to load first and
        // there is nowhere to navigate to: whether the household also uses a
        // server is a per-device setting inside the app, not a launch mode.
        //
        // A phone has no sidecar to start, so there it is simply "ready".
        #[cfg(mobile)]
        {
            let _ = &cfg;
            set_stage(&app, BootStage::ready(""));
        }

        #[cfg(desktop)]
        {
            if !cfg.lan_server_enabled() {
                // Someone turned the built-in gateway off on this machine —
                // the config file is the only way to say "this device is just
                // a client, do not listen on a port". The local library still
                // works; only LAN sharing is off.
                log_boot(&state.data_dir, "lanShare=false，内置服务不启动");
                set_stage(&app, BootStage::ready(""));
                return;
            }

            log_boot(&state.data_dir, "lanShare=true，正在启动内置服务");
            set_stage(&app, BootStage::starting("正在启动家庭服务…"));
            match server::ensure_started(&app, &state.data_dir, cfg.lan_server_enabled()) {
                Ok(running) => {
                    let url = running.url.clone();
                    log_boot(&state.data_dir, &format!("内置服务就绪：{url}"));
                    if let Some(mut old) = state.replace_server(running) {
                        old.shutdown();
                    }
                    set_stage(&app, BootStage::ready(&url));
                }
                Err(err) => {
                    log_boot(
                        &state.data_dir,
                        &format!("内置服务启动失败：{} | {}", err.message, err.tail.join(" / ")),
                    );
                    eprintln!(
                        "内置服务未启动（局域网共享不可用，本机功能不受影响）：{}\n{}",
                        err.message,
                        err.tail.join("\n")
                    );
                    set_stage(&app, BootStage::error(
                        err.message,
                        format!("数据目录：{}", state.data_dir.display()),
                        err.tail,
                    ));
                }
            }
        }
    });
}

// --- IPC (only reachable from the bundled splash page) ----------------------

#[tauri::command]
fn boot_status(state: tauri::State<AppState>) -> BootStage {
    state.stage()
}

#[tauri::command]
fn retry_boot(app: AppHandle) {
    #[cfg(desktop)]
    {
        {
            let state = app.state::<AppState>();
            if let Some(mut running) = state.take_server() {
                running.shutdown();
            }
        }
    }
    boot(app);
}

#[tauri::command]
fn app_info(app: AppHandle) -> serde_json::Value {
    let state = app.state::<AppState>();
    let cfg = state.config.lock().map(|c| c.clone()).unwrap_or_default();

    // Addresses other devices in the household can type in. Empty when there is
    // no LAN listener or no LAN route — the UI then offers to turn the listener
    // on instead of showing an address that cannot work.
    #[cfg(desktop)]
    let lan_urls: Vec<String> = {
        let base = state.base_url();
        if !cfg.lan_share {
            Vec::new()
        } else {
            match (server::lan_ip(), base.rsplit_once(':')) {
                (Some(ip), Some((_, port))) if !base.is_empty() => {
                    vec![format!("http://{ip}:{port}")]
                }
                _ => Vec::new(),
            }
        }
    };
    #[cfg(mobile)]
    let lan_urls: Vec<String> = vec![];

    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "dataDir": state.data_dir.to_string_lossy(),
        "mode": cfg.mode,
        "remoteUrl": cfg.remote_url,
        "mobile": is_mobile(),
        "baseUrl": state.base_url(),
        "lanUrls": lan_urls,
    })
}

/// Turn the built-in LAN gateway on or off for this device.
///
/// This used to also steer the window ("remote" meant: load someone else's
/// gateway). It no longer does — the window always runs the bundled client
/// against the local database, and connecting to a server happens inside the
/// app (设置 → 同步). So the only thing left here is the port listener, which is
/// why the setting takes effect on the next launch instead of restarting.
#[tauri::command]
fn set_mode(app: AppHandle, mode: String, remote_url: String) -> Result<(), String> {
    let normalized = remote_url.trim().trim_end_matches('/').to_string();
    if !normalized.is_empty() && !(normalized.starts_with("http://") || normalized.starts_with("https://"))
    {
        return Err("请填写以 http:// 或 https:// 开头的地址".into());
    }

    let state = app.state::<AppState>();
    let mut cfg = state.config.lock().map_err(|_| "状态锁失效".to_string())?;
    cfg.mode = if mode == "remote" { "remote".into() } else { "local".into() };
    cfg.remote_url = normalized;
    cfg.save(&state.data_dir)
        .map_err(|e| format!("保存配置失败：{e}"))?;
    Ok(())
}

/// Turn this device into a server for the household, or stop being one.
///
/// Changing the bind address means restarting the sidecar, so this is a real
/// action with a visible cost (~1s), not a preference toggle — which is also
/// why it is a button in the UI that explains what it does rather than a
/// checkbox buried in settings.
#[tauri::command]
fn set_lan_share(app: AppHandle, enabled: bool) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    {
        let mut cfg = state.config.lock().map_err(|_| "状态锁失效".to_string())?;
        cfg.lan_share = enabled;
        cfg.save(&state.data_dir)
            .map_err(|e| format!("保存配置失败：{e}"))?;
    }

    #[cfg(desktop)]
    {
        if let Some(mut running) = state.take_server() {
            running.shutdown();
        }
        let running = server::ensure_started(&app, &state.data_dir, enabled)
            .map_err(|e| e.message)?;
        if let Some(mut old) = state.replace_server(running) {
            old.shutdown();
        }
    }

    Ok(app_info(app))
}

/// Open the folder holding the data directory.
///
/// Desktop only: on Android the data directory is inside the app sandbox and
/// there is no file manager that can be handed a path the user could act on.
#[tauri::command]
fn open_data_dir(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    let _ = &app;
    #[cfg(desktop)]
    {
        use tauri_plugin_opener::OpenerExt;
        let state = app.state::<AppState>();
        std::fs::create_dir_all(&state.data_dir).ok();
        return app
            .opener()
            .open_path(state.data_dir.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string());
    }
    #[allow(unreachable_code)]
    Err("手机端没有可打开的本地目录".into())
}

#[tauri::command]
fn open_logs(app: AppHandle) -> Result<(), String> {
    #[cfg(mobile)]
    let _ = &app;
    #[cfg(desktop)]
    {
        use tauri_plugin_opener::OpenerExt;
        let state = app.state::<AppState>();
        let dir = state.data_dir.join("logs");
        std::fs::create_dir_all(&dir).ok();
        return app
            .opener()
            .open_path(dir.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string());
    }
    #[allow(unreachable_code)]
    Err("手机端没有可打开的日志目录".into())
}

/// Holds the single-instance lock for the lifetime of the process.
///
/// The `single-instance` plugin covers the common case through D-Bus, but a
/// session bus is not guaranteed: minimal Linux installs, some containers and
/// remote sessions do not have one, and there the plugin silently does nothing.
/// An advisory file lock costs nothing and works everywhere. It is released by
/// the kernel when the process dies, so a crash cannot leave a stale lock.
#[cfg(desktop)]
struct ShellLock(#[allow(dead_code)] std::fs::File);

#[cfg(desktop)]
fn acquire_shell_lock(dir: &std::path::Path) -> Option<std::fs::File> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(".shell.lock"))
        .ok()?;
    match file.try_lock() {
        Ok(()) => Some(file),
        Err(_) => None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Notifications are the only plugin both platforms share: on desktop the
    // tray posts "backup finished", on mobile a long attachment upload does.
    let builder = builder.plugin(tauri_plugin_notification::init());

    // 系统日历写入：Android 加载内嵌的 Kotlin 插件；桌面端注册一个空壳，
    // 命令走 Outlook COM（见 calendar.rs）。
    let builder = builder.plugin(calendar::init());

    // 图片出壳（分享/打印）：Android 加载 SharePlugin；桌面端命令不可用。
    let builder = builder.plugin(share::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch = "show me the window I already have".
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));

    builder
        .invoke_handler(tauri::generate_handler![
            boot_status,
            retry_boot,
            app_info,
            set_mode,
            set_lan_share,
            open_data_dir,
            open_logs,
            calendar::calendar_write_event,
            calendar::calendar_remove_event,
            share::share_image,
            share::print_image,
            share::print_html,
            share::save_download
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = config::data_dir(&handle);
            std::fs::create_dir_all(&data_dir)?;
            let cfg = config::DesktopConfig::load(&data_dir);

            #[cfg(desktop)]
            {
                let lock = match acquire_shell_lock(&data_dir) {
                    Some(f) => f,
                    None => {
                        // Another window is already serving this data directory.
                        // Without a session bus we cannot raise it, so at minimum
                        // do not start a second copy that would fight for the port.
                        eprintln!(
                            "HomeLedger 已在运行（数据目录 {}）。请从托盘图标打开窗口。",
                            data_dir.display()
                        );
                        std::process::exit(0);
                    }
                };
                app.manage(ShellLock(lock));
            }

            app.manage(AppState::new(cfg, data_dir));
            #[cfg(desktop)]
            tray::build(&handle)?;

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }

            boot(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let state = app.state::<AppState>();
                let keep_running = state
                    .config
                    .lock()
                    .map(|c| c.close_to_tray)
                    .unwrap_or(true);
                // On mobile "closing the window" is the OS backing out of the
                // activity; preventing it would trap the user in the app.
                if cfg!(desktop) && !state.is_quitting() && keep_running {
                    // Closing the window hides it; the household's phones may
                    // still be syncing through this process.
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("HomeLedger 启动失败")
        .run(|app, event| match event {
            // Hiding the window is not the same as wanting to quit, but Tauri
            // exits once the last window closes. Without this, "close to tray"
            // would silently kill the household's server on every window close.
            RunEvent::ExitRequested { api, .. } => {
                let state = app.state::<AppState>();
                if cfg!(desktop) && !state.is_quitting() {
                    api.prevent_exit();
                }
            }
            RunEvent::Exit => {
                let state = app.state::<AppState>();
                state.quitting.store(true, Ordering::SeqCst);
                #[cfg(desktop)]
                if let Some(mut running) = state.take_server() {
                    running.shutdown();
                }
            }
            _ => {}
        });
}
