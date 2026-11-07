import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./pages.css";
import "./glass.css";
// Lens 是当前皮肤：glass.css 保留为结构与降级底稿，lens.css 只覆盖材质。
import "./lens.css";
import { isTauri, warmUp } from "./api/client";
import { BUILD_ID } from "./lib/build";
import { applyAccent, applyBg, currentAccent, currentBg } from "./lib/theme";

// 皮肤标记要先于首屏出现，否则会闪一下旧的暖色玻璃。
document.documentElement.dataset.lens = "1";

// Restore appearance before first paint to avoid a flash of the wrong theme.
const saved = localStorage.getItem("hl_theme") || "light";
if (saved === "system") {
  document.documentElement.dataset.theme = window.matchMedia("(prefers-color-scheme: dark)")
    .matches
    ? "dark"
    : "light";
} else {
  document.documentElement.dataset.theme = saved;
}

// 配色与背景同样在首屏前恢复。种子色以 CSS 变量下发，必须走 applyAccent，
// 只写 data-accent 的话新方案没有对应的 CSS 规则。
applyAccent(currentAccent(), false);
applyBg(currentBg(), false);

// 标记原生壳：安卓/iOS 的全屏 WebView 里，刘海和挖孔不会可靠地出现在
// env(safe-area-inset-top) 里，手机布局需要额外兜一段顶部安全距离。
if (isTauri()) document.documentElement.dataset.native = "1";

// Open IndexedDB before React mounts so the first screen does not wait on it.
warmUp();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Opt-in handle for automated checks and for support ("open the console, run
// __hl.dump()"). Off unless explicitly enabled, so it is not part of the
// normal attack surface.
if (localStorage.getItem("hl_debug") === "1") {
  void (async () => {
    const client = await import("./api/client");
    const local = await import("./local/store");
    const sync = await import("./sync/engine");
    (window as unknown as Record<string, unknown>).__hl = {
      api: client.api,
      getMode: client.getMode,
      setMode: client.setMode,
      store: local.store,
      reset: local.resetStore,
      sync,
    };
  })();
}

// 把构建指纹写到 <html data-build> 上：设置页会显示它，控制台里
// `document.documentElement.dataset.build` 也能直接读到。
document.documentElement.dataset.build = BUILD_ID;

if ("serviceWorker" in navigator && import.meta.env.PROD && isTauri()) {
  // 桌面壳里不要 Service Worker。
  //
  // 界面资源是编进二进制的，每次构建文件名都换；而 SW 会把上一版的 index.html
  // 缓存下来，它引用的 index-xxxx.js 在新包里不存在——窗口打开了，脚本一行都
  // 不执行，白屏，而且每次导航都从缓存拿旧 HTML，自己好不了。
  // 桌面壳由 Rust 侧在启动时清缓存（main.rs 的 reset_webview_caches），这里
  // 再兜一层：把已经注册的注销掉，免得旧的继续接管。
  void navigator.serviceWorker
    .getRegistrations()
    .then((regs) => regs.forEach((r) => void r.unregister()))
    .catch(() => {});
} else if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;

    // 新 worker 接管时，内存里跑的还是旧壳，它接下来要懒加载的分片可能已经
    // 不存在了。刷新一次两个问题一起解决。首次安装也会触发这个事件，
    // 所以用 hadController 挡住，避免白屏循环。
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });

    void navigator.serviceWorker
      // updateViaCache: "none" 防止 HTTP 缓存把旧的 sw.js 钉死——否则
      // 手机上可能几周都在跑上一版界面。
      .register("/sw.js", { updateViaCache: "none" })
      .then((reg) => reg.update().catch(() => {}))
      .catch(() => {});
  });
}
