import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getMode, post, serverStore } from "../api/client";
import { Icon } from "../components/icons";
import { Spinner } from "../components/ui";
import { useAuth } from "../hooks/auth";

export function JoinPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { user, refresh, switchFamily } = useAuth();
  const code = (params.get("code") || "").toUpperCase();
  const [state, setState] = useState<"checking" | "joining" | "ok" | "error" | "login" | "guide">("checking");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!code) {
      setState("error");
      setMessage("链接中缺少邀请码。");
      return;
    }
    if (!user) {
      setState("login");
      const t = setTimeout(() => {
        nav(`/login?invite=${encodeURIComponent(code)}`, { replace: true });
      }, 900);
      return () => clearTimeout(t);
    }
    // 加入家庭的对象是服务器上的另一个成员记录。本机模式连服务器都没有，
    // 请求只会撞上 localApi 的「暂不支持」——在这里就说清楚该怎么办。
    if (getMode() !== "remote" && !serverStore.get()) {
      setState("guide");
      return;
    }
    setState("joining");
    post<{ family: { id: string; name: string }; already_member?: boolean }>("/families/join", {
      invite_code: code,
    })
      .then(async (res) => {
        await refresh();
        await switchFamily(res.family.id);
        setState("ok");
        setMessage(res.family.name);
        setTimeout(() => nav("/", { replace: true }), 900);
      })
      .catch((err) => {
        setState("error");
        setMessage((err as Error).message);
      });
  }, [code, user, nav, refresh, switchFamily]);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--bg)",
        padding: 20,
      }}
    >
      <div className="card" style={{ maxWidth: 380, width: "100%", textAlign: "center", padding: 32 }}>
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: "var(--radius-xs)",
            background: "var(--brand-soft)",
            color: "var(--brand)",
            display: "grid",
            placeItems: "center",
            margin: "0 auto 16px",
          }}
        >
          {state === "error" || state === "guide" ? (
            <Icon name="alert" size={24} />
          ) : state === "ok" ? (
            <Icon name="check" size={24} />
          ) : (
            <Spinner size={22} />
          )}
        </div>
        <div className="h2">
          {state === "ok"
            ? "已加入家庭"
            : state === "error"
            ? "无法加入"
            : state === "guide"
            ? "先连接家里的服务器"
            : "正在加入家庭…"}
        </div>
        <div className="small muted" style={{ marginTop: 8, lineHeight: 1.7 }}>
          {state === "login" ? (
            "需要先登录或注册账号，正在跳转…"
          ) : state === "ok" ? (
            `你已加入「${message}」，即将进入概览`
          ) : state === "guide" ? (
            <>
              这台设备目前是单机使用，还没有可加入的服务器。
              先在「设置 → 同步」里连接家里的 HomeLedger 服务器，再打开这个邀请链接。
            </>
          ) : (
            message || `邀请码 ${code}`
          )}
        </div>
        {(state === "error" || state === "guide") && (
          <button className="btn mt-16" onClick={() => nav("/")}>
            返回首页
          </button>
        )}
      </div>
    </div>
  );
}
