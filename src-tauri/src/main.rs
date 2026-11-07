//! Binary entry point.
//!
//! Everything lives in `lib.rs` because Tauri's Android and iOS targets link
//! the crate as a library and call `run()` themselves. Keeping a thin `main`
//! here means the desktop build and the phone build execute the same code path
//! from the same source of truth.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 清掉 WebView 里遗留的 Service Worker 和 HTTP 缓存。
///
/// 前端在浏览器里是 PWA，会注册 Service Worker 把界面缓存下来——那是给"刷新
/// 一下就能更新"的场景准备的。桌面壳里这套机制只有害处：界面资源是**编进二进制**
/// 的，换个版本就换一批带哈希的文件名，而 Service Worker 还攥着上一版的
/// `index.html`，它引用的 `index-xxxx.js` 在新包里根本不存在。结果是窗口打开、
/// 页面框架在、应用脚本一行都不执行——白屏，而且会一直白下去，因为每次导航都
/// 从缓存里拿那份旧 HTML。
///
/// 直接删掉这两个目录最省事：它们纯粹是缓存，删了下次启动重新生成。放在建窗口
/// 之前，所以不存在"删的时候 WebView 正在用"的问题。
#[cfg(target_os = "windows")]
fn reset_webview_caches() {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    // WebView2 的用户数据目录按 bundle identifier 命名，见 tauri.conf.json。
    let base = std::path::PathBuf::from(local)
        .join("app.homeledger.desktop")
        .join("EBWebView")
        .join("Default");
    for sub in ["Service Worker", "Cache", "Code Cache"] {
        let _ = std::fs::remove_dir_all(base.join(sub));
    }
}

fn main() {
    #[cfg(target_os = "windows")]
    reset_webview_caches();
    homeledger_desktop_lib::run()
}
