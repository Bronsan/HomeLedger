//! 图片出壳：系统分享与系统打印。
//!
//! 二维码/标签在应用里是 SVG，但安卓的分享目标与打印框架只认位图文件。
//! 前端把 SVG 栅格化成 PNG data URL，Kotlin 侧 `SharePlugin`
//! （`native/android/SharePlugin.kt`，构建时校正进 gen 工程）负责：
//!
//! * `shareImage` —— 写 cache/shared/，FileProvider 转 content://，
//!   弹系统分享面板（保存到相册 / 发给微信都从那里选）；
//! * `printImage` —— 离屏 WebView 装一张 <img> 交给 PrintManager，
//!   这是 Android WebView 上唯一能弹系统打印对话框的路径（window.print
//!   在 WebView 里是 no-op，标签页的 iframe 打印路径因此用不了）。
//!
//! 结构与 calendar.rs 一致：插件本体在 Android 上加载 Kotlin 类，命令注册
//! 在主 invoke_handler（免 capability），桌面端这些命令不可用（桌面直接
//! 下载文件 + 用标签页的系统打印路径）。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareImageRequest {
    pub file_name: String,
    pub data_url: String,
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintImageRequest {
    pub job_name: String,
    pub data_url: String,
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintHtmlRequest {
    pub job_name: String,
    pub html: String,
}

pub struct ShareBridge<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _marker: std::marker::PhantomData<R>,
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
impl<R: Runtime> ShareBridge<R> {
    #[cfg(target_os = "android")]
    fn run<T: serde::de::DeserializeOwned>(
        &self,
        command: &str,
        payload: impl Serialize,
    ) -> Result<T, String> {
        self.handle
            .run_mobile_plugin(command, payload)
            .map_err(|e| e.to_string())
    }
}

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("share")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("app.homeledger.desktop", "SharePlugin")?;
                app.manage(ShareBridge { handle });
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = app;
                let _ = api;
            }
            Ok(())
        })
        .build()
}

#[tauri::command]
pub fn share_image(app: AppHandle, file_name: String, data_url: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let bridge = app
            .try_state::<ShareBridge<tauri::Wry>>()
            .ok_or_else(|| "分享组件未初始化".to_string())?;
        return bridge
            .run("shareImage", ShareImageRequest { file_name, data_url })
            .map(|_: serde_json::Value| ());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &file_name, &data_url);
        Err("当前平台请在预览里用「下载」".into())
    }
}

#[tauri::command]
pub fn print_image(app: AppHandle, job_name: String, data_url: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let bridge = app
            .try_state::<ShareBridge<tauri::Wry>>()
            .ok_or_else(|| "打印组件未初始化".to_string())?;
        return bridge
            .run("printImage", PrintImageRequest { job_name, data_url })
            .map(|_: serde_json::Value| ());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &job_name, &data_url);
        Err("当前平台请用标签页的系统打印".into())
    }
}

/// 整张标签纸（A4 多枚标签的 HTML 文档）直接交给系统打印框架。
/// 标签页预览里那份 blob 文档的正文就是它——安卓 WebView 里 window.print()
/// 是 no-op，这是批量打印唯一走得通的路。
#[tauri::command]
pub fn print_html(app: AppHandle, job_name: String, html: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let bridge = app
            .try_state::<ShareBridge<tauri::Wry>>()
            .ok_or_else(|| "打印组件未初始化".to_string())?;
        return bridge
            .run("printHtml", PrintHtmlRequest { job_name, html })
            .map(|_: serde_json::Value| ());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &job_name, &html);
        Err("当前平台请用标签页的系统打印".into())
    }
}

/// 把 data URL（PNG 等）落成系统「下载」目录里的文件。
///
/// 壳里的 blob 锚点下载走不通（WebView 不接宿主的下载 UI，点了就是没反应），
/// 桌面端的「下载」一律改走这条命令；返回落盘路径给前端提示用户去哪找。
#[tauri::command]
pub fn save_download(
    app: AppHandle,
    file_name: String,
    data_url: String,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (&app, &file_name, &data_url);
        Err("手机端请使用分享面板保存".into())
    }
    #[cfg(not(target_os = "android"))]
    {
        let marker = "base64,";
        let idx = data_url.find(marker).ok_or("图片解码失败：不是 data URL")?;
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&data_url[idx + marker.len()..])
            .map_err(|_| "图片解码失败")?;

        let dir = app
            .path()
            .download_dir()
            .map_err(|e| format!("找不到下载目录：{e}"))?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("下载目录不可写：{e}"))?;
        let safe: String = file_name
            .chars()
            .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
            .collect();
        let mut target = dir.join(if safe.is_empty() { "homeledger.png" } else { &safe });
        // 同名不覆盖：后缀 -2、-3 往上排（备份文件名的既有约定）。
        let mut n = 2;
        while target.exists() {
            let stem = target
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "homeledger".into());
            let ext = target
                .extension()
                .map(|s| format!(".{}", s.to_string_lossy()))
                .unwrap_or_default();
            target = dir.join(format!("{stem}-{n}{ext}"));
            n += 1;
        }
        std::fs::write(&target, bytes).map_err(|e| format!("写入失败：{e}"))?;
        Ok(target.to_string_lossy().into_owned())
    }
}
