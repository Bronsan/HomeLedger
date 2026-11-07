import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { familyStore, isTauri, setMode, tokenStore } from "../api/client";
import { BrandMark } from "../components/BrandMark";
import { Icon } from "../components/icons";
import { Spinner, useToast } from "../components/ui";
import {
  entryStore,
  isAllowedServiceEmail,
  serviceApi,
  serviceSession,
  type ServiceUser,
} from "../lib/service";

type View = "choose" | "login" | "register";

function PrivacyNote() {
  return (
    <div className="auth-privacy">
      <Icon name="shield" size={14} style={{ flex: "0 0 auto", marginTop: 1 }} />
      <div>
        <b>隐私与数据</b>
        <p>本机模式不注册账号，物品、照片和附件只保存在这台设备。联网模式的服务服务器只保存邮箱、密码哈希和显示名，用于账号管理与登录验证。</p>
        <p>用户注册仅对使用者账号进行记录，不对用户个人信息进行收集。</p>
      </div>
    </div>
  );
}

/**
 * 安装后的第一屏：先选“本机”还是“联网账号”。
 *
 * 本机模式直接进入 me@local；联网模式在这里注册/登录服务服务器，冷启动时
 * 会先用保存的令牌向服务器确认一次。两种方式都只影响账号与会话，物品数据
 * 仍然留在本机。
 */
export function WelcomePage() {
  const nav = useNavigate();
  const toast = useToast();
  const [view, setView] = useState<View>("choose");
  const [checking, setChecking] = useState<boolean>(
    () => entryStore.get() === "online" && Boolean(serviceSession.token())
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (!isTauri()) return;
    const entry = entryStore.get();

    if (entry === "local") {
      nav("/", { replace: true });
      return;
    }
    if (entry !== "online") {
      setChecking(false);
      return;
    }
    if (serviceSession.verified()) {
      nav("/", { replace: true });
      return;
    }

    const token = serviceSession.token();
    if (!token) {
      setChecking(false);
      setView("login");
      return;
    }

    setChecking(true);
    serviceApi<{ user: ServiceUser }>("/auth/me", { timeoutMs: 10000 })
      .then((res) => {
        if (!alive.current) return;
        serviceSession.set(token, res.user);
        serviceSession.markVerified();
        nav("/", { replace: true });
      })
      .catch((err) => {
        if (!alive.current) return;
        setChecking(false);
        setView("login");
        if ((err as { status?: number }).status === 401) {
          serviceSession.clear();
        } else {
          setError((err as Error).message || "账号验证失败");
        }
      });

    return () => {
      alive.current = false;
    };
  }, [nav]);

  if (!isTauri()) return <Navigate to="/login" replace />;
  if (entryStore.get() === "local") return <Navigate to="/" replace />;

  const chooseLocal = () => {
    entryStore.set("local");
    familyStore.clear();
    setMode("local");
    tokenStore.set("local");
    toast("已进入本机模式");
    nav("/", { replace: true });
  };

  const chooseOnline = () => {
    setError("");
    setView("register");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || view === "choose") return;
    setError("");

    const clean = email.trim().toLowerCase();
    if (!clean) {
      setError("请填写邮箱");
      return;
    }
    if (!isAllowedServiceEmail(clean)) {
      setError("邮箱格式不正确");
      return;
    }
    if (view === "register" && password.length < 8) {
      setError("密码至少 8 位");
      return;
    }
    if (!password) {
      setError("请填写密码");
      return;
    }

    setBusy(true);
    try {
      const body =
        view === "register"
          ? {
              email: clean,
              password,
              display_name: name.trim() || clean.split("@")[0],
              family_name: "我的家",
            }
          : { email: clean, password };
      const res = await serviceApi<{ token: string; user: ServiceUser }>(
        view === "register" ? "/auth/register" : "/auth/login",
        { method: "POST", body }
      );
      serviceSession.set(res.token, res.user);
      entryStore.set("online");
      serviceSession.markVerified();
      // 账号在服务服务器，物品数据仍然交给本机引擎。
      familyStore.clear();
      setMode("local");
      tokenStore.set("local");
      toast(view === "register" ? "联网账号已创建" : "登录成功");
      nav("/", { replace: true });
    } catch (err) {
      setError((err as Error).message || "操作失败");
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-art">
        <div className="auth-brand">
          <BrandMark />
          HomeLedger
        </div>

        <div className="auth-copy">
          <h2>
            先选一种方式，
            <br />
            再开始整理。
          </h2>
          <p>本机模式打开就能用，物品数据不出这台设备；联网账号用于用户管理与登录验证，物品数据同样只留在本机。两种方式之后都可以切换。</p>
          <div className="auth-points">
            <div className="auth-point">
              <span className="ic">
                <Icon name="hard-drive" size={13} />
              </span>
              <div>
                <b>本机模式</b>，不需要账号，直接以 me@local 使用
              </div>
            </div>
            <div className="auth-point">
              <span className="ic">
                <Icon name="cloud" size={13} />
              </span>
              <div>
                <b>联网账号</b>，每次启动向服务服务器验证一次
              </div>
            </div>
            <div className="auth-point">
              <span className="ic">
                <Icon name="shield" size={13} />
              </span>
              <div>
                <b>数据边界不变</b>，服务服务器不接收物品、照片或同步口令
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="auth-panel">
        <div className="auth-form">
          <BrandMark size={36} className="auth-form-seal" />

          {checking ? (
            <div
              className="col gap-14"
              style={{ alignItems: "center", padding: "48px 0", gap: 14 }}
            >
              <Spinner size={22} />
              <span className="hint">正在验证联网账号…</span>
            </div>
          ) : view === "choose" ? (
            <>
              <h1>选择使用方式</h1>
              <p className="sub">本机模式无需账号；联网账号用于用户管理与登录验证。两种方式的物品数据都只保存在这台设备。</p>

              <div className="entry-options">
                <button className="entry-option primary" onClick={chooseLocal}>
                  <span className="ic">
                    <Icon name="hard-drive" size={18} />
                  </span>
                  <span className="copy">
                    <b>本机使用</b>
                    <span>直接进入 me@local，不注册账号</span>
                  </span>
                  <Icon name="arrow-right" size={16} className="go" />
                </button>
                <button className="entry-option" onClick={chooseOnline}>
                  <span className="ic">
                    <Icon name="cloud" size={18} />
                  </span>
                  <span className="copy">
                    <b>联网账号</b>
                    <span>注册或登录，账号保存在服务服务器</span>
                  </span>
                  <Icon name="arrow-right" size={16} className="go" />
                </button>
              </div>

              <PrivacyNote />
            </>
          ) : (
            <>
              <h1>{view === "login" ? "登录联网账号" : "创建联网账号"}</h1>
              <p className="sub">账号保存在服务服务器，每次启动都会验证登录；物品数据仍只在本机。</p>

              <form onSubmit={submit} className="col gap-14" style={{ gap: 14 }}>
                {view === "register" && (
                  <div className="field">
                    <label className="label">你的称呼</label>
                    <input
                      className="input"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="家里怎么称呼你"
                    />
                  </div>
                )}
                <div className="field">
                  <label className="label">邮箱</label>
                  <input
                    className="input"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                  />
                </div>
                <div className="field">
                  <label className="label">
                    密码
                    {view === "register" && <span className="hint">至少 8 位</span>}
                  </label>
                  <input
                    className="input"
                    type="password"
                    autoComplete={view === "login" ? "current-password" : "new-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    minLength={view === "register" ? 8 : undefined}
                  />
                </div>

                {error && (
                  <div
                    className="row gap-8"
                    style={{
                      fontSize: 12.5,
                      color: "var(--danger)",
                      background: "var(--danger-soft)",
                      padding: "9px 11px",
                      borderRadius: "var(--radius-xs)",
                    }}
                  >
                    <Icon name="alert" size={14} />
                    {error}
                  </div>
                )}

                <button
                  className="btn btn-primary btn-lg btn-block"
                  type="submit"
                  disabled={busy}
                >
                  {busy ? <Spinner /> : <Icon name="arrow-right" size={16} />}
                  {view === "login" ? "登录" : "注册并进入"}
                </button>
              </form>

              <div className="auth-switch">
                {view === "login" ? (
                  <>
                    还没有账号？
                    <a
                      onClick={() => {
                        setView("register");
                        setError("");
                      }}
                      style={{ marginLeft: 4 }}
                    >
                      创建一个
                    </a>
                  </>
                ) : (
                  <>
                    已有账号？
                    <a
                      onClick={() => {
                        setView("login");
                        setError("");
                      }}
                      style={{ marginLeft: 4 }}
                    >
                      去登录
                    </a>
                  </>
                )}
              </div>
              <div className="auth-switch" style={{ marginTop: 8 }}>
                <a
                  onClick={() => {
                    setView("choose");
                    setError("");
                  }}
                >
                  返回使用方式
                </a>
              </div>

              <PrivacyNote />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
