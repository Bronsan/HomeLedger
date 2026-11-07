/**
 * The screen you get when this device is set to talk to a server and cannot.
 *
 * It exists because the alternative was a blank window. Server mode on a
 * packaged app has three ways to fail before the first byte of UI matters —
 * no address saved, address unreachable, server up but the database wedged —
 * and none of them should look like "the app is broken". Each one is named
 * here, with the one action that actually helps.
 *
 * The screen is deliberately not a modal over the app: an empty dashboard
 * behind it would be a lie about the data.
 */

import { useEffect, useRef, useState } from "react";
import {
  familyStore,
  getMode,
  normalizeServer,
  probeServer,
  serverStore,
  setMode,
  tokenStore,
} from "../api/client";
import { Icon } from "../components/icons";
import { Spinner, useToast } from "../components/ui";
import { useAuth } from "../hooks/auth";

type Phase = "idle" | "probing" | "ok" | "fail";

export function ConnectPage() {
  const { connectionError, retry } = useAuth();
  const toast = useToast();
  const [url, setUrl] = useState(serverStore.get());
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState("");
  const [auto, setAuto] = useState(true);
  const tries = useRef(0);

  const check = async (addr: string, silent = false): Promise<boolean> => {
    setPhase("probing");
    if (!silent) setNote("");
    const res = await probeServer(addr);
    if (res.ok) {
      setPhase("ok");
      setNote(`已连上 · 版本 ${res.version || "?"}`);
      return true;
    }
    setPhase("fail");
    setNote(res.error || "连不上");
    return false;
  };

  // The address we already know about is worth a try before asking anything:
  // most of the time the server is simply still waking up.
  useEffect(() => {
    const saved = serverStore.get();
    if (!saved) {
      setPhase("fail");
      setNote("还没有填写服务器地址");
      return;
    }
    void check(saved, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep trying quietly while the screen is up. A NAS that spins its disk up
  // takes about 20 seconds to answer the first request; making the user press
  // a button for that is busywork.
  useEffect(() => {
    if (!auto || phase !== "fail") return;
    const delay = Math.min(30000, 3000 * Math.pow(2, Math.min(tries.current, 3)));
    const t = window.setTimeout(() => {
      tries.current += 1;
      if (serverStore.get()) void check(serverStore.get(), true);
    }, delay);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, phase]);

  const connect = async () => {
    const clean = normalizeServer(url);
    if (!clean) {
      setPhase("fail");
      setNote("地址格式不对，示例：192.168.1.10:8000");
      return;
    }
    setUrl(clean);
    const ok = await check(clean);
    if (!ok) return;
    serverStore.set(clean);
    // The token belongs to the previous address. Keeping it would send a
    // foreign bearer token to a different server.
    tokenStore.clear();
    familyStore.clear();
    location.href = "/login";
  };

  const useLocal = () => {
    setMode("local");
    location.reload();
  };

  const retryNow = () => {
    tries.current = 0;
    setAuto(true);
    if (serverStore.get()) void check(serverStore.get());
    void retry();
  };

  // A phone that just re-joined the Wi-Fi should not need a tap to notice.
  useEffect(() => {
    const onOnline = () => {
      tries.current = 0;
      if (serverStore.get()) void check(serverStore.get(), true);
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="connect">
      <div className="connect-card">
        <div className="connect-head">
          <div className="connect-logo">
            <Icon name="home" size={22} />
          </div>
          <div>
            <h1>连接家庭服务器</h1>
            <p>
              {getMode() === "remote"
                ? "这台设备直接读写服务器上的数据。"
                : "这台设备用自己的数据库，服务器只做同步。"}
            </p>
          </div>
        </div>

        <div className={`connect-state ${phase}`}>
          {phase === "probing" ? (
            <>
              <Spinner size={15} />
              <span>正在连接 {serverStore.get() || url || "…"}</span>
            </>
          ) : phase === "ok" ? (
            <>
              <Icon name="check-circle" size={15} />
              <span>{note}</span>
            </>
          ) : (
            <>
              <Icon name="alert" size={15} />
              <span>{connectionError || note || "连不上服务器"}</span>
            </>
          )}
        </div>

        <label className="field">
          <span>服务器地址</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="192.168.1.10:8000"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter") void connect();
            }}
          />
        </label>

        <div className="connect-actions">
          <button className="btn btn-primary" onClick={connect} disabled={phase === "probing"}>
            {phase === "probing" ? <Spinner /> : <Icon name="link" size={14} />}
            连接
          </button>
          <button className="btn" onClick={retryNow} disabled={phase === "probing"}>
            <Icon name="refresh" size={14} />
            重试
          </button>
          <button className="btn btn-ghost" onClick={useLocal}>
            改用本机模式
          </button>
        </div>

        <div className="connect-tips">
          <b>找不到地址？</b>
          <ul>
            <li>在跑服务器的那台电脑上打开 HomeLedger，设置 → 同步，地址就写在那里。</li>
            <li>手机和电脑要在同一个 Wi-Fi。访客网络通常会把设备隔开。</li>
            <li>桌面端默认不对外监听，需要在同一个设置页里打开「允许家庭内设备连接」。</li>
          </ul>
          <button
            className="linkish"
            onClick={() => {
              setAuto((v) => !v);
              toast(auto ? "已停止自动重试" : "已开始自动重试", "info");
            }}
          >
            {auto ? "停止自动重试" : "继续自动重试"}
          </button>
        </div>
      </div>
    </div>
  );
}
