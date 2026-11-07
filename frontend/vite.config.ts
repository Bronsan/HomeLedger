import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 构建指纹：`20261030-1140`。
 *
 * 打进 bundle，显示在"设置 → 账户"和登录页页脚。它回答一个看起来简单、
 * 实际很容易扯不清的问题——「这台设备上跑的是哪一次构建」。改完 UI 却看不到
 * 变化时，先比对这一行，就知道是没装上新包，还是新包本身不对。
 */
function makeBuildId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const BUILD_ID = makeBuildId();

/** Service Worker 的缓存名必须跟着构建走，否则旧壳会永远留在设备上。 */
function stampServiceWorker(): Plugin {
  return {
    name: "homeledger:sw-version",
    closeBundle() {
      const sw = path.resolve(__dirname, "../backend/app/static/sw.js");
      if (!fs.existsSync(sw)) return;
      const src = fs.readFileSync(sw, "utf8");
      fs.writeFileSync(sw, src.replace(/__BUILD_ID__/g, BUILD_ID));
    },
  };
}

export default defineConfig({
  plugins: [react(), stampServiceWorker()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
    },
  },
  build: {
    outDir: "../backend/app/static",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
