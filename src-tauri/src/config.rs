//! Desktop-side preferences and filesystem layout.
//!
//! These are *shell* settings (whether to listen on a LAN port, whether closing
//! the window quits), stored next to the data directory. They are deliberately
//! separate from the application database: the shell must be able to read them
//! before any server exists, which is exactly the case on first launch.
//!
//! Note what is *not* here any more: which server the UI talks to. Every build
//! runs the bundled client against this device's own database, and the choice
//! between 本机 / 同步 / 服务器 lives in the app itself (设置 → 同步), because it
//! has to be available on phones and in a browser too — places with no config
//! file to edit.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const DEFAULT_REMOTE: &str = "";

fn default_mode() -> String {
    "local".to_string()
}

fn default_true() -> bool {
    true
}

fn default_false_bool() -> bool {
    false
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    /// `local`  = 本机同时充当家庭服务器（监听局域网端口，供其他设备同步）
    /// `remote` = 本机只做客户端，不监听端口
    ///
    /// 两种取值都不影响数据所在的位置——数据永远在本机的 IndexedDB 里。
    #[serde(default = "default_mode")]
    pub mode: String,
    /// 曾经用来记录「去连哪台网关」。界面已经不再使用（连接服务器改为在
    /// 应用内扫码/填地址，地址存在同步配置里），保留字段只为让老配置文件
    /// 反序列化时不报错。
    #[serde(default = "default_false")]
    pub remote_url: String,
    /// 关闭窗口时最小化到托盘而不是退出。内置服务是常驻进程，
    /// 关窗即退会让「手机还能不能同步」变成随机事件。
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    /// 是否允许同一局域网内的其他设备连上这台机器。
    ///
    /// 默认关闭。打开它意味着这个进程开始在网卡上监听，同一 Wi-Fi 下的
    /// 任何人都能访问登录页——这不该是一个用户没做过选择的默认值。
    /// 打开之后数据仍然是端到端加密的，但「谁能看到登录框」这件事依然
    /// 值得由用户点头。
    #[serde(default = "default_false_bool", rename = "lanShare")]
    pub lan_share: bool,
}

fn default_false() -> String {
    DEFAULT_REMOTE.to_string()
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            mode: default_mode(),
            remote_url: default_false(),
            close_to_tray: true,
            lan_share: false,
        }
    }
}

impl DesktopConfig {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("desktop.json");
        match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|err| {
                // A corrupt config must not brick the app. Fall back to the
                // safe default and keep the bad file around for diagnosis.
                eprintln!("desktop.json 解析失败（{err}），已使用默认配置");
                let _ = std::fs::copy(&path, dir.join("desktop.json.broken"));
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("desktop.json");
        let tmp = dir.join("desktop.json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(&tmp, &path)
    }

    /// Should this device listen on a LAN port for the household?
    ///
    /// Off unless the user turned it on: a port that is reachable from the
    /// coffee-shop Wi-Fi is not something to enable on somebody's behalf.
    /// Phones have no sidecar, so nothing there reads this.
    #[cfg_attr(mobile, allow(dead_code))]
    pub fn lan_server_enabled(&self) -> bool {
        self.lan_share
    }
}

/// Data directory, following each platform's convention.
///
/// We deliberately do not use the raw bundle identifier as the folder name:
/// users are told to "open the data folder" from the tray menu, and
/// `app.homeledger.desktop` is a terrible thing to see in Finder.
pub fn data_dir(app: &AppHandle) -> PathBuf {
    let home = app
        .path()
        .home_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    if cfg!(any(target_os = "android", target_os = "ios")) {
        // The sandbox is the only place a phone app may write, and `home_dir`
        // does not point at anything writable there. `app_data_dir` resolves to
        // the app's private files directory on Android.
        return app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| home.join("HomeLedger"));
    }

    if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support").join("HomeLedger")
    } else if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("HomeLedger")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local").join("share"))
            .join("homeledger")
    }
}
