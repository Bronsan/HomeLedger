import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { get } from "../api/client";
import type { DeploymentInfo } from "../api/types";
import { useAuth } from "../hooks/auth";
import { BrandMark } from "../components/BrandMark";
import { Icon } from "../components/icons";
import { Spinner, useToast } from "../components/ui";

interface Info {
  app_name: string;
  version: string;
  deployment: DeploymentInfo;
  allow_registration: boolean;
  bootstrap_required: boolean;
  /** Aggregate only — the API never returns account identities here. */
  registered_users?: number;
}

export function Login() {
  const { login, register, user } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [joinMode, setJoinMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState<Info | null>(null);

  useEffect(() => {
    get<Info>("/system/info").then(setInfo).catch(() => {});
  }, []);

  useEffect(() => {
    const invite = params.get("invite");
    if (invite) {
      setMode("register");
      setJoinMode(true);
      setInviteCode(invite.toUpperCase());
    }
  }, [params]);

  useEffect(() => {
    if (user) nav("/", { replace: true });
  }, [user, nav]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "login") {
        await login(email.trim(), password);
        toast("欢迎回来");
      } else {
        await register({
          email: email.trim(),
          password,
          display_name: name.trim() || email.split("@")[0],
          family_name: joinMode ? undefined : familyName.trim() || undefined,
          invite_code: joinMode ? inviteCode.trim().toUpperCase() : undefined,
        });
        toast("账号已创建");
      }
      nav("/", { replace: true });
    } catch (err) {
      setError((err as Error).message || "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const dep = info?.deployment;

  return (
    <div className="auth">
      <div className="auth-art">
        <div className="auth-brand">
          <BrandMark />
          HomeLedger
        </div>

        <div className="auth-copy">
          <h2>
            家里的每一件东西，
            <br />
            都值得被好好记住。
          </h2>
          <p>
            买过什么、放在哪里、什么时候过保、上次保养是哪天。HomeLedger
            把这些散落在抽屉、相册和记忆里的信息，收拢成一份全家都能用的账本。
          </p>
          <div className="auth-points">
            <div className="auth-point">
              <span className="ic">
                <Icon name="hard-drive" size={13} />
              </span>
              <div>
                <b>本地优先</b>，物品默认只保存在你的设备上；主动开启同步时才上传加密副本
              </div>
            </div>
            <div className="auth-point">
              <span className="ic">
                <Icon name="users" size={13} />
              </span>
              <div>
                <b>全家协作</b>，一台网关，手机、平板、电脑同时用同一份数据
              </div>
            </div>
            <div className="auth-point">
              <span className="ic">
                <Icon name="qr" size={13} />
              </span>
              <div>
                <b>一物一码</b>，贴一张标签，扫码就能查到全部档案
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="auth-panel">
        <div className="auth-form">
          <BrandMark size={36} className="auth-form-seal" />
          {info?.bootstrap_required && (
            <div
              className="badge brand mb-16"
              style={{ height: 24, padding: "0 10px", marginBottom: 18 }}
            >
              <Icon name="sparkles" size={12} />
              首次启动 · 第一个注册的账号将成为家庭所有者
            </div>
          )}

          <h1>{mode === "login" ? "登录你的家庭账本" : "创建账号"}</h1>
          <p className="sub">
            {mode === "login"
              ? "使用邮箱和密码继续。物品数据默认仍保存在本机。"
              : "创建后可以新建一个家庭，或通过邀请码加入已有的家庭。"}
          </p>

          {mode === "register" && (
            <div className="auth-tabs">
              <div
                className={`auth-tab ${!joinMode ? "active" : ""}`}
                onClick={() => setJoinMode(false)}
              >
                新建家庭
              </div>
              <div
                className={`auth-tab ${joinMode ? "active" : ""}`}
                onClick={() => setJoinMode(true)}
              >
                加入家庭
              </div>
            </div>
          )}

          <form onSubmit={submit} className="col gap-14" style={{ gap: 14 }}>
            {mode === "register" && !joinMode && (
              <div className="field">
                <label className="label">家庭名称</label>
                <input
                  className="input"
                  value={familyName}
                  onChange={(e) => setFamilyName(e.target.value)}
                  placeholder="例如：我的家"
                />
              </div>
            )}
            {mode === "register" && joinMode && (
              <div className="field">
                <label className="label">邀请码</label>
                <input
                  className="input mono"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                  placeholder="8 位邀请码"
                  style={{ letterSpacing: "0.08em" }}
                />
                <div className="hint">向家庭管理员索取，或让对方在「成员」页面复制邀请码。</div>
              </div>
            )}
            {mode === "register" && (
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
                {mode === "register" && <span className="hint">至少 8 位</span>}
              </label>
              <input
                className="input"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={mode === "register" ? 8 : undefined}
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

            <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
              {busy ? <Spinner /> : <Icon name="arrow-right" size={16} />}
              {mode === "login" ? "登录" : "创建账号"}
            </button>
          </form>

          <div className="auth-switch">
            {mode === "login" ? (
              <>
                还没有账号？
                <a onClick={() => setMode("register")} style={{ marginLeft: 4 }}>
                  创建一个
                </a>
              </>
            ) : (
              <>
                已经有账号了？
                <a onClick={() => setMode("login")} style={{ marginLeft: 4 }}>
                  去登录
                </a>
              </>
            )}
          </div>

          <div className="auth-privacy">
            <Icon name="shield" size={14} style={{ flex: "0 0 auto", marginTop: 1 }} />
            <div>
              <b>隐私与数据</b>
              <p>物品、照片和附件默认只保存在这台设备。连接账号服务器时，服务器只保存邮箱、密码哈希、显示名和家庭成员关系；不采集手机号、真实姓名、住址、定位、通讯录、设备标识或使用行为。</p>
              <p>用户注册仅对使用者账号进行记录，不对用户个人信息进行收集。</p>
              {info?.registered_users != null && info.registered_users > 0 && (
                <p className="auth-privacy-count">
                  当前服务器注册账号：{info.registered_users} 个（仅显示总数）
                </p>
              )}
            </div>
          </div>

          {dep?.warnings?.[0] && (
            <div className="hint mt-16" style={{ display: "flex", gap: 6 }}>
              <Icon name="shield" size={13} style={{ flex: "0 0 auto", marginTop: 1 }} />
              {dep.warnings[0]}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
