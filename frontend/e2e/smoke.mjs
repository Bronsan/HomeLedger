/**
 * E2E 冒烟测试（M3 最小集）。
 *
 * 用 playwright-core 驱动**系统 Edge**（channel: "msedge"），不下载 Chromium——
 * 这台机器上 WebView2/Edge 一定在，装个 300MB 的浏览器不值得。
 * 也不是 @playwright/test：那会带上整套 runner，这里一个 Node 脚本就够，
 * 断言失败即非零退出，CI 只要 `npm run e2e`。
 *
 * 场景（每条都对应一个历史 bug 或一轮新功能的回归）：
 * 1. 远程：注册 → 建物品 → 列表可见（登录/表单/列表全链路）
 * 2. 本机：IndexedDB 写入 → 刷新仍在（write-behind 窗口类 bug）
 * 3. 远程：归档 → 回收站 → 恢复（归档不再是单向门）
 * 4. 远程：低库存阈值 → 首页告警 → /items 筛选
 * 5. 远程：借出 → 列表 → 归还
 * 每个场景还顺带断言页面级 pageerror 为零。
 *
 * 跑法：`npm run e2e`（自己拉起后端 8000 + Vite 5174，跑完清理）。
 * 要求 8000/5174 空闲；harness 会先清掉占着 8000 的残留进程。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FRONTEND = join(ROOT, "frontend");
const BACKEND = join(ROOT, "backend");
const VITE_PORT = 5174;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const API = "http://127.0.0.1:8000/api/v1";
const NAME_INPUT = 'input[placeholder="例如：戴森 V12 无线吸尘器"]';

const procs = [];
let dataDir = null;
let backendProc = null;

function start(name, cmd, opts) {
  const p = spawn(cmd, { shell: true, stdio: ["ignore", "pipe", "pipe"], ...opts });
  // 两个管道都必须一直读：stdout 没人排走时，子进程写满 64KB 缓冲就会
  // 整个卡死——表现为「跑到后面几个场景后端突然没响应」的假性随机失败。
  const sink = (tag) => (d) => {
    if (process.env.E2E_VERBOSE) process.stdout.write(`[${tag}] ${d}`);
  };
  p.stdout.on("data", sink(name));
  p.stderr.on("data", sink(`${name}:err`));
  procs.push(p);
  return p;
}

async function waitReady(url, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} 在 ${tries * 0.5}s 内没有就绪：${url}`);
}

function startBackend() {
  backendProc = start(
    "backend",
    join(BACKEND, ".venv", "Scripts", "python.exe") + " -m uvicorn app.main:app --port 8000",
    {
      cwd: BACKEND,
      env: {
        ...process.env,
        HOMELEDGER_DATA_DIR: dataDir,
        HOMELEDGER_SECRET_KEY: process.env.HOMELEDGER_SECRET_KEY || "e2e-only-secret-key",
      },
    }
  );
}

async function restartBackend() {
  if (backendProc) {
    const old = backendProc;
    backendProc = null;
    const at = procs.indexOf(old);
    if (at >= 0) procs.splice(at, 1);
    if (process.platform === "win32" && old.pid) {
      spawn("taskkill", ["/PID", String(old.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      old.kill("SIGTERM");
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  startBackend();
  await waitReady("http://127.0.0.1:8000/api/v1/system/health", "后端（重启后）");
}

/** 用服务器终端的方式提升管理员；cwd 用临时目录，避免读到项目里的 .env。 */
function promoteAdmin(email) {
  const py = join(BACKEND, ".venv", "Scripts", "python.exe");
  const env = {
    ...process.env,
    HOMELEDGER_DATA_DIR: dataDir,
    HOMELEDGER_SECRET_KEY: process.env.HOMELEDGER_SECRET_KEY || "e2e-only-secret-key",
    PYTHONPATH: BACKEND,
  };
  const res = spawnSync(py, ["-m", "app.cli", "admin", email], {
    cwd: dataDir,
    env,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`提升实例管理员失败：${(res.stderr || res.stdout || "").trim().slice(0, 300)}`);
  }
}

async function cleanup() {
  for (const p of procs) {
    try {
      // shell:true 包了一层 cmd /c，直接 kill 只杀得到壳
      if (process.platform === "win32" && p.pid) {
        spawn("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        p.kill("SIGTERM");
      }
    } catch {
      /* already gone */
    }
  }
  // taskkill 是异步的，SQLite 的句柄松开要一拍；删不掉就留给系统清 temp
  await new Promise((r) => setTimeout(r, 800));
  if (dataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* 文件还被占着：temp 目录，系统重启会清 */
    }
  }
}

const results = [];
function check(name, ok, extra = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
}

/** 每个场景一个独立上下文/账号：失败互不传染。 */
/** 每个场景一个独立上下文/账号：失败互不传染。 */
async function scenario(name, browser, email, opts, fn) {
  const uiRegister = !opts || opts.uiRegister !== false;
  const ctx = await browser.newContext();
  if (!uiRegister) {
    // 经 API 注册，并在**每个文档启动时**重播 token（addInitScript）：
    // headless Edge 的临时上下文偶发把 localStorage 的键弄丢——取证多轮：
    // 全程无任何 removeItem/clear/setItem 调用（含卸载期 sendBeacon 兜底）、
    // 无 4xx、桶身份探针一致，纯浏览器环境问题而非应用 bug。文档级重播
    // 让它无从生效；UI 注册路径由场景 1 保留覆盖。
    const reg = await fetch(`${API}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "e2e-password-8", display_name: "E2E" }),
    });
    if (!reg.ok) throw new Error(`API 注册 ${email} 失败：${reg.status}`);
    const token = (await reg.json()).token;
    await ctx.addInitScript((t) => localStorage.setItem("hl_token", t), token);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (process.env.E2E_VERBOSE) {
    // 取证用：批量场景「状态被重置」只在套件里出现——先抓到它时页面到底
    // 发生了什么（整页导航？控制台报错？），截图只是结果不是过程。
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) process.stdout.write(`[nav] ${f.url()}\n`);
    });
    page.on("console", (m) => process.stdout.write(`[console:${m.type()}] ${m.text()}\n`));
    // 踢回 /login 的形态需要知道是哪个请求先挂的：记录所有非 2xx 的 API 响应
    page.on("response", (r) => {
      const u = r.url();
      if ((u.includes("/api/") && r.status() >= 400) || u.includes("/hl-debug")) {
        process.stdout.write(`[http] ${r.status()} ${r.request().method()} ${u.slice(0, 500)}\n`);
      }
    });
  }
  try {
    await fn(page);
    check(`${name}`, true);
  } catch (e) {
    try {
      await page.screenshot({ path: `e2e-fail-${name.slice(3, 6)}.png`, fullPage: true });
    } catch {
      /* 截不了就算了 */
    }
    check(`${name}`, false, `${String(e).split("\n")[0].slice(0, 300)}（失败时 URL: ${page.url()}）`);
  }
  check(`${name}：无页面级 JS 错误`, errors.length === 0, errors.join(" | ").slice(0, 200));
  await ctx.close();
}

/** 注册（登录页 → 注册 tab）并等进入应用。 */
async function register(page, email) {
  await page.goto(`${BASE}/login`);
  // 登录页默认是「登录」tab，先切到注册
  await page.click('a:has-text("创建一个")');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', "e2e-password-8");
  await page.click('button:has-text("创建账号")');
  await page.waitForURL(`${BASE}/`, { timeout: 20000 });
}

/** 通过 UI 建一件物品，等落到详情页。 */
async function createItem(page, name, extra = {}) {
  await page.goto(`${BASE}/items/new`);
  await page.fill(NAME_INPUT, name);
  if (extra.minStock !== undefined) {
    await page.fill('input[placeholder="不提醒"]', String(extra.minStock));
  }
  await page.click('button:has-text("创建物品")');
  await page.waitForURL(/\/items\/[0-9a-f-]+$/, { timeout: 15000 });
}

/** 打开一个「仅本机」的独立浏览器上下文（IndexedDB 不会互相污染）。 */
async function localPage(browser) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    localStorage.setItem("hl_mode", "local");
    localStorage.setItem("hl_token", "local");
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, errors };
}

/** 在「设置 → 同步」里连接 127.0.0.1:8000；createAccount=false 表示登录已有账号。 */
async function linkDevice(page, email, createAccount, passphrase) {
  await page.goto(`${BASE}/settings?tab=sync`);
  await page.fill('input[placeholder="http://192.168.1.10:8000"]', "http://127.0.0.1:8000");
  await page.fill('.field:has-text("服务器账号") input', email);
  await page.fill('.field:has-text("账号密码") input', "e2e-sync-password");
  await page.fill('input[placeholder="至少 8 位，务必记住"]', passphrase);
  await page.fill('.field:has-text("再输一次") input', passphrase);
  if (!createAccount) {
    await page.uncheck('label:has-text("在这台服务器上新注册账号") input');
  }
  await page.click('button:has-text("连接并开始同步")');
  await page.waitForSelector('button:has-text("锁定口令")', { timeout: 30000 });
}

async function main() {
  // 上一次跑挂留下的 uvicorn 会占着 8000，bind 失败时冒烟测的是旧数据——先清场
  if (process.platform === "win32") {
    spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "foreach ($p in 8000, ${VITE_PORT}) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force } }",
      ],
      { stdio: "ignore" }
    );
    await new Promise((r) => setTimeout(r, 1000));
  }

  dataDir = mkdtempSync(join(tmpdir(), "hl-e2e-"));
  // venv 里的解释器——系统 python 没装 pydantic_settings
  startBackend();
  start("vite", `npm run dev -- --port ${VITE_PORT} --strictPort`, { cwd: FRONTEND });

  await waitReady("http://127.0.0.1:8000/api/v1/system/health", "后端");
  await waitReady(`${BASE}/`, "Vite");

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    // ---- 1. 远程：注册 → 建物品 → 列表 ----------------------------------
    await scenario("远程：注册 → 建物品 → 列表可见", browser, "e2e-remote@home.lan", {}, async (page) => {
      await register(page, "e2e-remote@home.lan");
      await createItem(page, "E2E 测试梯子");
      await page.goto(`${BASE}/items`);
      await page.waitForSelector("text=E2E 测试梯子", { timeout: 10000 });
    });

    // ---- 2. 本机：写入 → 刷新仍在 ---------------------------------------
    {
      const ctx = await browser.newContext();
      await ctx.addInitScript(() => {
        localStorage.setItem("hl_mode", "local");
        localStorage.setItem("hl_token", "local");
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      try {
        // 已带合成 token，直接进应用而不是登录页
        await page.goto(`${BASE}/`);
        await page.waitForSelector('a[href="/items"]', { timeout: 15000 });
        await createItem(page, "E2E 本机钻头");
        await page.reload();
        await page.waitForSelector("text=E2E 本机钻头", { timeout: 10000 });
        check("本机：建物品 → 刷新仍在", true);
      } catch (e) {
        check("本机：建物品 → 刷新仍在", false, String(e).split("\n")[0].slice(0, 300));
      }
      // 设置 → 部署：本机 /system/providers 的字段必须与服务端同形，
      // 否则 providers.database.dialect 会抛错并触发错误边界。
      try {
        await page.goto(`${BASE}/settings?tab=deploy`);
        await page.waitForSelector("text=服务组件", { timeout: 10000 });
        check("本机：设置「部署」标签正常渲染", true);
      } catch (e) {
        check("本机：设置「部署」标签正常渲染", false, String(e).split("\n")[0].slice(0, 300));
      }
      // 维护页：本机处理器必须把前端传来的 due_at 写进 next_due_at；
      // 旧实现只认 next_due_at，任务会显示「无期限」，日历导出也会跳过。
      // 同时在手机宽度下检查行尾「更多」菜单没有被 card-flush 裁掉。
      try {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${BASE}/maintenance`);
        await page.waitForSelector('button:has-text("新建任务")', { timeout: 10000 });
        await page.click('button:has-text("新建任务")');
        await page.click('button[data-field="物品"]');
        await page.click('.ui-select-opt:has-text("E2E 本机钻头")');
        await page.fill('.field:has-text("任务名称") input', "E2E 无期限保养");
        await page.fill('input[type="date"]', "");
        await page.click('button:has-text("创建")');
        await page.waitForSelector("text=E2E 无期限保养", { timeout: 10000 });
        const row = page.locator('.maint-row:has-text("E2E 无期限保养")');
        const dueText = (await row.locator('.maint-due').innerText()).trim();
        check(
          "本机：维护任务保存到期日（不再显示无期限）",
          dueText !== "无期限",
          `due=${dueText}`
        );
        // 两级筛选：切到「已完成」时待办任务应消失，切回「待办」后回来；
        // 范围「7 天」应包含今天到期的任务。覆盖滑动开关不是纯装饰件。
        await page.getByRole("radio", { name: "已完成" }).click();
        await page.waitForSelector('.empty:has-text("还没有完成记录")', { timeout: 10000 });
        check("本机：维护筛选切到已完成", true);
        await page.getByRole("radio", { name: "待办" }).click();
        await page.waitForSelector("text=E2E 无期限保养", { timeout: 10000 });
        check("本机：维护筛选切回待办", true);
        await page.getByRole("radio", { name: "7 天" }).click();
        await page.waitForSelector("text=E2E 无期限保养", { timeout: 10000 });
        check("本机：维护范围筛选 7 天", true);
        await row.locator("[data-maint-menu] > button").click();
        const menuHit = await page.evaluate(() => {
          const r = [...document.querySelectorAll(".maint-row")].find((n) =>
            n.textContent?.includes("E2E 无期限保养")
          );
          const holder = r?.querySelector("[data-maint-menu]");
          const menu = holder?.querySelector(":scope > .card");
          if (!r || !holder || !menu) return null;
          const m = menu.getBoundingClientRect();
          const anchorTop = holder.getBoundingClientRect().top;
          const nav = document.querySelector(".bottomnav");
          const navTop = nav ? nav.getBoundingClientRect().top : null;
          const hitTop = document.elementFromPoint(m.left + m.width / 2, m.top + 4);
          const hitBottom = document.elementFromPoint(m.left + m.width / 2, m.bottom - 4);
          return {
            hitMenuTop: !!hitTop && menu.contains(hitTop),
            hitMenuBottom: !!hitBottom && menu.contains(hitBottom),
            // 菜单底边贴住触发按钮的上沿，说明是向上展开（按钮仍可再次点击收起）。
            opensUp: m.bottom <= anchorTop + 1,
            aboveNav: navTop == null || m.bottom <= navTop,
            inViewport: m.top >= 0 && m.bottom <= innerHeight,
            text: menu.textContent || "",
            top: m.top,
            bottom: m.bottom,
            anchorTop,
            navTop,
            viewport: innerHeight,
          };
        });
        check(
          "本机：维护「更多」菜单完整可见且在导航栏之上",
          !!menuHit &&
            menuHit.hitMenuTop &&
            menuHit.hitMenuBottom &&
            menuHit.opensUp &&
            menuHit.aboveNav &&
            menuHit.inViewport &&
            menuHit.text.includes("删除任务"),
          JSON.stringify(menuHit)
        );
        // 可见还不够：菜单项必须真的能点。点「删除任务」应弹出确认框。
        await row.locator('[data-maint-menu] .nav-item:has-text("删除任务")').click();
        const confirmOpen = await page
          .locator('.modal:has-text("删除维护任务？")')
          .isVisible()
          .catch(() => false);
        check("本机：维护「更多」菜单可点击", confirmOpen);
        if (confirmOpen) await page.click('.modal button:has-text("取消")');
      } catch (e) {
        check("本机：维护页回归", false, String(e).split("\n")[0].slice(0, 300));
      }
      check("本机：无页面级 JS 错误", errors.length === 0, errors.join(" | ").slice(0, 200));
      await ctx.close();
    }

    // ---- 3. 远程：归档 → 回收站 → 恢复 ----------------------------------
    await scenario("远程：归档 → 回收站 → 恢复", browser, "e2e-arc@home.lan", { uiRegister: false }, async (page) => {
      await createItem(page, "E2E 归档箱子");
      // 详情页操作藏在 <details> 折叠菜单里，先展开再点「归档物品」
      await page.click("summary.btn-icon");
      await page.click('div.nav-item:has-text("归档物品")');
      await page.waitForSelector("text=已归档", { timeout: 15000 });
      // 常规列表里消失
      await page.goto(`${BASE}/items`);
      await page.waitForSelector('text=E2E 归档箱子', { state: "detached", timeout: 15000 });
      // 回收站里出现，一键恢复
      await page.goto(`${BASE}/archive`);
      await page.waitForSelector("text=E2E 归档箱子", { timeout: 15000 });
      await page.click('button:has-text("恢复")');
      await page.waitForSelector("text=已恢复", { timeout: 15000 });
      // 回到常规列表
      await page.goto(`${BASE}/items`);
      await page.waitForSelector("text=E2E 归档箱子", { timeout: 15000 });
    });

    // ---- 4. 远程：低库存 → 告警条 → 筛选 -------------------------------
    await scenario("远程：低库存阈值 → 告警 → 筛选", browser, "e2e-stock@home.lan", { uiRegister: false }, async (page) => {
      // 数量 1、阈值 2：创建即触发
      await createItem(page, "E2E 洗衣液", { minStock: 2 });
      await page.goto(`${BASE}/`);
      await page.waitForSelector("text=件物品库存不足", { timeout: 10000 });
      await page.goto(`${BASE}/items?low_stock=1`);
      await page.waitForSelector("text=E2E 洗衣液", { timeout: 10000 });
    });

    // ---- 6. 远程：软删除 → 回收站已删除视图 → 恢复 ---------------------
    await scenario("远程：软删除 → 回收站 → 恢复", browser, "e2e-bin@home.lan", { uiRegister: false }, async (page) => {
      await createItem(page, "E2E 误删相机");
      // 详情页 <details> 菜单里的「删除物品」，走 ConfirmDialog
      await page.click("summary.btn-icon");
      await page.click('div.nav-item:has-text("删除物品")');
      await page.click('button:has-text("删除")');
      await page.waitForSelector("text=已删除", { timeout: 15000 });
      // 常规列表里消失
      await page.goto(`${BASE}/items`);
      await page.waitForSelector("text=E2E 误删相机", { state: "detached", timeout: 15000 });
      // 回收站「已删除」tab 里出现，恢复
      await page.goto(`${BASE}/archive`);
      await page.click('button:has-text("已删除")');
      await page.waitForSelector("text=E2E 误删相机", { timeout: 15000 });
      await page.click('button:has-text("恢复")');
      await page.waitForSelector("text=已恢复", { timeout: 15000 });
      await page.goto(`${BASE}/items`);
      await page.waitForSelector("text=E2E 误删相机", { timeout: 15000 });
    });

    // ---- 7. 本机：删除 → 解墓碑恢复（store.all 不含墓碑，恢复走原始表）--
    {
      const ctx = await browser.newContext();
      await ctx.addInitScript(() => {
        localStorage.setItem("hl_mode", "local");
        localStorage.setItem("hl_token", "local");
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      try {
        await page.goto(`${BASE}/`);
        await page.waitForSelector('a[href="/items"]', { timeout: 15000 });
        await createItem(page, "E2E 本机误删");
        await page.goto(`${BASE}/items`);
        await page.click('text=E2E 本机误删');
        await page.waitForURL(/\/items\/[0-9a-f-]+$/, { timeout: 15000 });
        await page.click("summary.btn-icon");
        await page.click('div.nav-item:has-text("删除物品")');
        await page.click('button:has-text("删除")');
        await page.waitForSelector("text=已删除", { timeout: 15000 });
        await page.goto(`${BASE}/items`);
        await page.waitForSelector("text=E2E 本机误删", { state: "detached", timeout: 15000 });
        // 回收站已删除视图（本地=原始墓碑扫描），恢复后回列表，刷新仍在
        await page.goto(`${BASE}/archive`);
        await page.click('button:has-text("已删除")');
        await page.waitForSelector("text=E2E 本机误删", { timeout: 15000 });
        await page.click('button:has-text("恢复")');
        await page.waitForSelector("text=已恢复", { timeout: 15000 });
        await page.goto(`${BASE}/items`);
        await page.waitForSelector("text=E2E 本机误删", { timeout: 15000 });
        await page.reload();
        await page.waitForSelector("text=E2E 本机误删", { timeout: 15000 });
        check("本机：软删除 → 解墓碑恢复 → 刷新仍在", true);
      } catch (e) {
        check("本机：软删除 → 解墓碑恢复 → 刷新仍在", false, String(e).split("\n")[0].slice(0, 300));
      }
      check("本机（恢复）：无页面级 JS 错误", errors.length === 0, errors.join(" | ").slice(0, 200));
      await ctx.close();
    }

    // ---- 8. 远程：批量管理 → 多选 → 移动位置 ---------------------------
    // 历史教训：曾断言 toast「已把 N 件物品移到新位置」，但测试选的目标是
    // 「无位置」——Items.tsx 对清空位置走的是「已清空 N 件物品的位置」文案，
    // 移动其实每次都成功、批量条正常收口，截图于是呈现「状态被重置」的假象，
    // 被误当成了页面重载竞态排查了好几轮。现在建真实位置走真实路径，
    // 并以服务器真相（卡片上的位置名）而不是 toast 收尾。
    const BATCH_E2E_ENABLED = true;
    if (BATCH_E2E_ENABLED) await scenario("远程：批量管理 → 移动位置", browser, "e2e-bulk@home.lan", { uiRegister: false }, async (page) => {
      await createItem(page, "E2E 批量甲");
      await page.goto(`${BASE}/items/new`);
      await page.fill(NAME_INPUT, "E2E 批量乙");
      await page.click('button:has-text("创建物品")');
      await page.waitForURL(/\/items\/[0-9a-f-]+$/, { timeout: 15000 });
      // 移动目标不依赖新家庭的默认数据：直接经 API 建一个（token 在 hl_token）
      const locOk = await page.evaluate(async () => {
        const res = await fetch("/api/v1/locations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${localStorage.getItem("hl_token")}`,
          },
          body: JSON.stringify({ name: "E2E 批量仓位" }),
        });
        return res.ok;
      });
      if (!locOk) throw new Error("经 API 建测试位置失败");
      await page.goto(`${BASE}/items`);
      await page.click('button:has-text("批量管理")');
      await page.click('.item-card:has-text("E2E 批量甲")');
      await page.waitForSelector("text=已选 1 件", { timeout: 15000 });
      await page.click('.item-card:has-text("E2E 批量乙")');
      await page.waitForSelector("text=已选 2 件", { timeout: 15000 });
      await page.click(".labels-bar [aria-haspopup=\"listbox\"]");
      await page.click('[role="option"]:has-text("E2E 批量仓位")');
      await page.click('.labels-bar button:has-text("移动")');
      await page.waitForSelector("text=已把 2 件物品移到新位置", { timeout: 15000 });
      await page.waitForSelector('.item-card:has-text("E2E 批量甲"):has-text("E2E 批量仓位")', { timeout: 15000 });
    });

    // ---- 5. 远程：借出 → 列表 → 归还 -----------------------------------
    await scenario("远程：借出 → 列表 → 归还", browser, "e2e-loan@home.lan", { uiRegister: false }, async (page) => {
      await createItem(page, "E2E 伸缩梯");
      await page.goto(`${BASE}/loans`);
      await page.click('button:has-text("登记借出")');
      // 自绘 Select：aria-haspopup 触发器 + role=option 选项
      await page.click('[aria-haspopup="listbox"][aria-label*="借出"]');
      await page.click('[role="option"]:has-text("E2E 伸缩梯")');
      await page.fill('input[placeholder="姓名或称呼"]', "邻居老王");
      await page.click('button:has-text("登记"):not(:has-text("借出"))');
      await page.waitForSelector("text=邻居老王", { timeout: 10000 });
      await page.click('button:has-text("归还")');
      await page.waitForSelector("text=已归还", { timeout: 15000 });
    });

    // ---- 9. 远程：详情菜单 → 复制物品 → 副本落在列表 --------------------
    await scenario("远程：复制物品", browser, "e2e-clone@home.lan", { uiRegister: false }, async (page) => {
      await createItem(page, "E2E 原型相机");
      // 详情页 <details> 折叠菜单里的「复制物品」
      await page.click("summary.btn-icon");
      await page.click('div.nav-item:has-text("复制物品")');
      // 跳到新物品详情，名字带「（副本）」
      await page.waitForURL(/\/items\/[0-9a-f-]+$/, { timeout: 15000 });
      await page.waitForSelector('text=E2E 原型相机（副本）', { timeout: 15000 });
      // 列表里两件都在（服务器真相收尾，不依赖 toast）
      await page.goto(`${BASE}/items`);
      await page.waitForSelector('.item-card:has-text("E2E 原型相机（副本）")', { timeout: 15000 });
      await page.waitForSelector('.item-card:has-text("E2E 原型相机")', { timeout: 15000 });
    });

    // ---- 10. 本机：软删除 → 清空已删除 → 真正消失 ------------------------
    // 本机硬删曾经只写墓碑，行永远挂在「已删除」视图——这条场景锁住修复。
    {
      const ctx = await browser.newContext();
      await ctx.addInitScript(() => {
        localStorage.setItem("hl_mode", "local");
        localStorage.setItem("hl_token", "local");
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      try {
        await page.goto(`${BASE}/`);
        await page.waitForSelector('a[href="/items"]', { timeout: 15000 });
        await createItem(page, "E2E 本机清空");
        await page.goto(`${BASE}/items`);
        await page.click('text=E2E 本机清空');
        await page.waitForURL(/\/items\/[0-9a-f-]+$/, { timeout: 15000 });
        await page.click("summary.btn-icon");
        await page.click('div.nav-item:has-text("删除物品")');
        await page.click('button:has-text("删除")');
        await page.waitForSelector("text=已删除", { timeout: 15000 });
        // 回收站已删除视图里可见 → 一键清空 → 视图变空、列表里也没有
        await page.goto(`${BASE}/archive`);
        await page.click('button:has-text("已删除")');
        await page.waitForSelector("text=E2E 本机清空", { timeout: 15000 });
        await page.click('button:has-text("清空已删除")');
        await page.click('button:has-text("全部彻底删除")');
        await page.waitForSelector("text=没有已删除的物品", { timeout: 15000 });
        await page.goto(`${BASE}/items`);
        await page.waitForSelector('text=E2E 本机清空', { state: "detached", timeout: 15000 });
        check("本机：清空已删除后真正消失", true);
      } catch (e) {
        check("本机：清空已删除后真正消失", false, String(e).split("\n")[0].slice(0, 300));
      }
      check("本机（清空）：无页面级 JS 错误", errors.length === 0, errors.join(" | ").slice(0, 200));
      await ctx.close();
    }

    // ---- 11. 同步：A 建立加密同步、锁定/解锁；B 登录同账号拉取 ----------
    // 两套独立的浏览器存储模拟两台设备。A 先在本机建物品，再连接服务器；
    // B 用同一账号和口令登录，必须能拉到 A 的数据。锁定后刷新仍保持锁定，
    // 输入口令解锁后同步恢复——这条覆盖此前最容易回归的生命周期。
    {
      const passphrase = "e2e sync pass 1234";
      const email = "e2e-sync-device@example.com";
      const a = await localPage(browser);
      const b = await localPage(browser);
      const label = "同步：A 建库 → B 登录同账号可见 → 锁定后重载仍锁定 → 解锁";
      try {
        await a.page.goto(`${BASE}/`);
        await a.page.waitForSelector('a[href="/items"]', { timeout: 15000 });
        await createItem(a.page, "E2E 同步物品");
        await linkDevice(a.page, email, true, passphrase);

        await a.page.click('button:has-text("锁定口令")');
        await a.page.waitForSelector("text=已连接，但口令未解锁", { timeout: 15000 });
        await a.page.reload();
        await a.page.waitForSelector('input[placeholder="同步口令"]', { timeout: 15000 });
        await a.page.fill('input[placeholder="同步口令"]', passphrase);
        await a.page.click('button:has-text("解锁")');
        await a.page.waitForSelector('button:has-text("锁定口令")', { timeout: 30000 });

        await b.page.goto(`${BASE}/`);
        await b.page.waitForSelector('a[href="/items"]', { timeout: 15000 });
        await linkDevice(b.page, email, false, passphrase);
        await b.page.goto(`${BASE}/items`);
        await b.page.waitForSelector("text=E2E 同步物品", { timeout: 20000 });
        check(label, true);
      } catch (e) {
        check(label, false, String(e).split("\n")[0].slice(0, 300));
      }
      check(
        "同步：无页面级 JS 错误",
        a.errors.length + b.errors.length === 0,
        [...a.errors, ...b.errors].join(" | ").slice(0, 200)
      );
      await a.ctx.close();
      await b.ctx.close();
    }

    // ---- 12. 备份 → 新增数据 → 恢复 → 重启后回到备份点 ------------------
    // 备份/恢复是实例级操作，所以先用服务器终端的方式把测试账号提升为管理员。
    // 恢复会替换数据库文件，完成后必须重启后端；这里真的重启一次，而不是只
    // 断言 toast，否则「恢复成功但连接池还指着旧文件」这类问题测不出来。
    {
      const adminEmail = "e2e-backup-admin@example.com";
      const label = "备份：创建 → 新增数据 → 恢复 → 重启后回到备份点";
      let ctx = null;
      try {
        const reg = await fetch(`${API}/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: adminEmail,
            password: "e2e-backup-password",
            display_name: "E2E 管理员",
            family_name: "E2E 备份家庭",
          }),
        });
        if (!reg.ok) throw new Error(`API 注册管理员失败：${reg.status}`);
        const adminToken = (await reg.json()).token;
        promoteAdmin(adminEmail);

        ctx = await browser.newContext();
        await ctx.addInitScript((t) => localStorage.setItem("hl_token", t), adminToken);
        const page = await ctx.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(`${BASE}/`);
        await page.waitForSelector('a[href="/items"]', { timeout: 15000 });
        await createItem(page, "E2E 备份内物品");

        await page.goto(`${BASE}/settings?tab=data`);
        await page.click('button:has-text("立即备份")');
        await page.waitForSelector('.provider-row:has-text("含附件")', { timeout: 30000 });

        await createItem(page, "E2E 备份后新增");
        await page.goto(`${BASE}/settings?tab=data`);
        await page.click('.provider-row button:has-text("恢复")');
        await page.fill('input[placeholder="RESTORE"]', "RESTORE");
        await page.click('button:has-text("确认恢复")');
        await page.waitForSelector("text=数据已恢复", { timeout: 30000 });

        await restartBackend();
        await page.reload();
        await page.goto(`${BASE}/items`);
        await page.waitForSelector("text=E2E 备份内物品", { timeout: 20000 });
        await page.waitForSelector("text=E2E 备份后新增", { state: "detached", timeout: 15000 });
        check(label, true);
        check("备份：无页面级 JS 错误", errors.length === 0, errors.join(" | ").slice(0, 200));
      } catch (e) {
        check(label, false, String(e).split("\n")[0].slice(0, 300));
      } finally {
        if (ctx) await ctx.close();
      }
    }
  } finally {
    await browser.close();
    await cleanup();
  }
}

await main();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
