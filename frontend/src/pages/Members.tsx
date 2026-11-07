import { Fragment, useCallback, useEffect, useState } from "react";
import { authedUrl, del, get, getMode, patch, post } from "../api/client";
import type { Member, PermissionMeta } from "../api/types";
import { Icon } from "../components/icons";
import { ConfirmDialog, CopyButton, Empty, Modal, Select, Spinner, useToast } from "../components/ui";
import { ROLE_LABEL, useAuth } from "../hooks/auth";
import { fmtDate, relativeTime } from "../lib/format";

const ROLE_DESC: Record<string, string> = {
  owner: "管理家庭、成员、数据与部署设置，不可被移除",
  admin: "管理物品、分类、位置、提醒，可邀请成员",
  member: "查看共享物品、录入物品、执行维护任务",
  viewer: "只能查看，不能修改任何数据",
  guest: "仅能查看被单独授权的内容",
};

const ROLE_ICON: Record<string, string> = {
  owner: "shield",
  admin: "key",
  member: "user",
  viewer: "eye",
  guest: "lock",
};

export function MembersPage() {
  const { can, family, role: myRole, refresh } = useAuth();
  const toast = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [meta, setMeta] = useState<PermissionMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState({ email: "", display_name: "", role: "member" });
  const [editing, setEditing] = useState<Member | null>(null);
  const [editRole, setEditRole] = useState<string>("member");
  // 邀请码 5 分钟时效：剩余分钟数每 10s 重算一次，过期把复制按钮禁掉
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (!family?.invite_expires_at) return;
    const t = window.setInterval(() => setNowTick(Date.now()), 10_000);
    return () => window.clearInterval(t);
  }, [family?.invite_expires_at]);
  const inviteExpired = family?.invite_expires_at
    ? new Date(family.invite_expires_at).getTime() < nowTick
    : false;
  const inviteMinutesLeft = family?.invite_expires_at
    ? Math.max(0, Math.ceil((new Date(family.invite_expires_at).getTime() - nowTick) / 60_000))
    : 0;
  const [grant, setGrant] = useState<string[]>([]);
  const [deny, setDeny] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<Member | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, pm] = await Promise.all([
        get<{ items: Member[] }>("/families/current/members"),
        get<PermissionMeta>("/families/current/permission-meta"),
      ]);
      setMembers(m.items);
      setMeta(pm);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sendInvite = async () => {
    if (!invite.email.trim()) return;
    setSaving(true);
    try {
      const res = await post<{ created_user: boolean; member: Member }>(
        "/families/current/members",
        {
          email: invite.email.trim(),
          display_name: invite.display_name.trim() || undefined,
          role: invite.role,
        }
      );
      toast(
        res.created_user
          ? "已添加成员。对方需要用该邮箱注册后才能登录。"
          : "已加入家庭"
      );
      setInviteOpen(false);
      setInvite({ email: "", display_name: "", role: "member" });
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (m: Member) => {
    setEditing(m);
    setEditRole(m.role);
    setGrant(m.permission_overrides?.grant || []);
    setDeny(m.permission_overrides?.deny || []);
  };

  const saveEdit = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await patch(`/families/current/members/${editing.id}`, {
        role: editRole,
        permission_overrides: { grant, deny },
      });
      toast("权限已更新");
      setEditing(null);
      await load();
      await refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const togglePerm = (key: string, mode: "grant" | "deny") => {
    if (mode === "grant") {
      setDeny((d) => d.filter((x) => x !== key));
      setGrant((g) => (g.includes(key) ? g.filter((x) => x !== key) : [...g, key]));
    } else {
      setGrant((g) => g.filter((x) => x !== key));
      setDeny((d) => (d.includes(key) ? d.filter((x) => x !== key) : [...d, key]));
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="h1">成员与权限</h1>
          <div className="sub">
            {members.length} 位成员 · 你的角色是 {ROLE_LABEL[myRole || "member"]}
          </div>
        </div>
        {can("member.invite") && (
          <button className="btn btn-primary" onClick={() => setInviteOpen(true)}>
            <Icon name="plus" size={15} />
            邀请成员
          </button>
        )}
      </div>

      <div className="dash-main" style={{ gridTemplateColumns: "1.7fr 1fr", marginTop: 0 }}>
        <div className="card card-flush">
          <div className="card-head" style={{ padding: "16px 18px 12px", marginBottom: 0 }}>
            <div className="card-title">
              <Icon name="users" size={15} />
              家庭成员
            </div>
          </div>
          {loading && (
            <div style={{ padding: 16 }}>
              <div className="skeleton" style={{ height: 120 }} />
            </div>
          )}
          {!loading && members.length === 0 && <Empty title="还没有成员" />}
          {members.map((m) => (
            <div
              className="maint-row"
              key={m.id}
              style={{ cursor: "default", padding: "12px 18px" }}
            >
              <div
                className="avatar"
                style={{ width: 34, height: 34, overflow: "hidden", background: m.avatar_color }}
              >
                {m.avatar_url ? (
                  <img
                    src={authedUrl(m.avatar_url)}
                    alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  />
                ) : (
                  (m.nickname || m.display_name).slice(0, 1)
                )}
              </div>
              <div className="maint-main">
                <div className="maint-title">
                  {m.nickname || m.display_name}
                  {m.user_id === undefined ? null : null}
                  <span className={`badge ${m.role === "owner" ? "brand" : ""}`}>
                    <Icon name={ROLE_ICON[m.role] || "user"} size={10} />
                    {ROLE_LABEL[m.role]}
                  </span>
                  {m.status === "suspended" && <span className="badge danger">已停用</span>}
                </div>
                <div className="maint-sub">
                  <span>{m.email}</span>
                  <span className="dot-sep">·</span>
                  <span>加入于 {fmtDate(m.joined_at)}</span>
                  {m.last_login_at && (
                    <>
                      <span className="dot-sep">·</span>
                      <span>最近登录 {relativeTime(m.last_login_at)}</span>
                    </>
                  )}
                </div>
              </div>
              {/* 本机模式的家庭只有自己一个成员：改自己的角色、把自己移出，
                  都是伪操作；后两条接口在 localApi 里也没有实现，点了只会报
                  「暂不支持」。同步模式保留入口——成员是复制的真实数据，
                  操作经 api() 的白名单直达服务器（见 api/client.ts）。 */}
              {getMode() !== "local" && can("member.update") && m.role !== "owner" && (
                <button className="btn btn-sm" onClick={() => openEdit(m)}>
                  权限
                </button>
              )}
              {getMode() !== "local" && can("member.disable") && m.role !== "owner" && (
                <button
                  className="icon-btn"
                  onClick={() => setConfirm(m)}
                  title="移除成员"
                >
                  <Icon name="trash" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="col gap-16">
          <div className="card">
            <div className="card-head">
              <div className="card-title">
                <Icon name="link" size={15} />
                邀请码
              </div>
            </div>
            <div
              className="mono"
              style={{
                fontSize: 20,
                letterSpacing: "0.18em",
                fontWeight: 600,
                padding: "12px 14px",
                borderRadius: "var(--radius-xs)",
                background: "var(--brand-soft)",
                color: inviteExpired ? "var(--danger)" : "var(--brand)",
                textAlign: "center",
              }}
            >
              {family?.invite_code}
            </div>
            <div className="row gap-6 mt-10">
              <CopyButton
                className="grow"
                value={family ? `${location.origin}/join?code=${family.invite_code}` : ""}
                label={inviteExpired ? "邀请码已过期" : "复制邀请链接"}
                disabled={inviteExpired}
                title={inviteExpired ? "邀请码已过期，请先刷新" : "复制注册链接"}
              />
              {can("member.invite") && (
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    const res = await post<{ invite_code: string }>(
                      "/families/current/rotate-invite"
                    );
                    toast(`新邀请码（5 分钟内有效）：${res.invite_code}`);
                    await refresh();
                  }}
                  title="生成新邀请码（5 分钟内有效）"
                >
                  <Icon name="refresh" size={13} />
                </button>
              )}
            </div>
            <div className="hint mt-10" style={{ lineHeight: 1.6 }}>
              {family?.invite_expires_at ? (
                inviteExpired ? (
                  <span style={{ color: "var(--danger)" }}>
                    邀请码已过期（有效期 5 分钟）。点 ↻ 生成新码后把邀请链接发给对方。
                  </span>
                ) : (
                  <>
                    对方注册时填入邀请码即可加入。
                    <b> 有效期 5 分钟（剩 {inviteMinutesLeft} 分钟）</b>，过期或重置后立即失效。
                  </>
                )
              ) : (
                <>对方注册时填入邀请码即可加入。重置后旧邀请码立即失效。</>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div className="card-title">
                <Icon name="shield" size={15} />
                角色说明
              </div>
            </div>
            <div className="col gap-8">
              {(["owner", "admin", "member", "viewer", "guest"] as const).map((r) => (
                <div className="role-card" key={r} style={{ padding: 10 }}>
                  <div className="rc-ic">
                    <Icon name={ROLE_ICON[r]} size={14} />
                  </div>
                  <div>
                    <div className="rc-t">{ROLE_LABEL[r]}</div>
                    <div className="rc-d">{ROLE_DESC[r]}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {meta && (
        <div className="card mt-16">
          <div className="card-head">
            <div className="card-title">
              <Icon name="sliders" size={15} />
              权限对照表
            </div>
            <span className="tiny faint">角色预设，可在成员上单独调整</span>
          </div>
          <div className="table-wrap">
            <table className="perm-grid">
              <thead>
                <tr>
                  <th style={{ width: "34%" }}>权限</th>
                  {meta.roles.map((r) => (
                    <th key={r.value} className="center">
                      {r.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {meta.groups.map((g) => (
                  <Fragment key={g.name}>
                    <tr className="perm-group-row">
                      <td colSpan={meta.roles.length + 1}>{g.name}</td>
                    </tr>
                    {g.items.map((p) => (
                      <tr key={p.key}>
                        <td>{p.label}</td>
                        {meta.roles.map((r) => {
                          const on = r.permissions.includes(p.key);
                          return (
                            <td className="center" key={r.value}>
                              {on ? (
                                <span className="perm-check on" style={{ cursor: "default" }}>
                                  <Icon name="check" size={10} />
                                </span>
                              ) : (
                                <span
                                  style={{
                                    display: "inline-block",
                                    width: 17,
                                    height: 1.5,
                                    background: "var(--border)",
                                    verticalAlign: "middle",
                                  }}
                                />
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="邀请成员"
        subtitle="如果对方还没有账号，系统会先创建一个待激活账号"
        footer={
          <>
            <button className="btn" onClick={() => setInviteOpen(false)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={sendInvite} disabled={saving}>
              {saving ? <Spinner /> : <Icon name="plus" size={14} />}
              发送邀请
            </button>
          </>
        }
      >
        <div className="col gap-14" style={{ gap: 14 }}>
          <div className="field">
            <label className="label">
              邮箱 <span className="req">*</span>
            </label>
            <input
              className="input"
              type="email"
              value={invite.email}
              onChange={(e) => setInvite({ ...invite, email: e.target.value })}
              placeholder="member@example.com"
              autoFocus
            />
          </div>
          <div className="field">
            <label className="label">称呼</label>
            <input
              className="input"
              value={invite.display_name}
              onChange={(e) => setInvite({ ...invite, display_name: e.target.value })}
              placeholder="选填"
            />
          </div>
          <div className="field">
            <label className="label">角色</label>
            <Select
              value={invite.role}
              onChange={(v) => setInvite({ ...invite, role: v as typeof invite.role })}
              title="选择角色"
              ariaLabel="角色"
              options={[
                { value: "member", label: "普通成员", hint: "可录入与修改物品" },
                { value: "viewer", label: "只读成员", hint: "只能查看" },
                { value: "guest", label: "访客", hint: "仅查看授权内容" },
                { value: "admin", label: "家庭管理员", hint: "可管理大部分内容" },
              ]}
            />
          </div>
          <div className="hint">
            提示：家庭成员需要各自注册账号并加入，权限按角色生效，也可单独勾选额外权限。
          </div>
        </div>
      </Modal>

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={`调整权限 · ${editing?.display_name || ""}`}
        size="wide"
        footer={
          <>
            <button className="btn" onClick={() => setEditing(null)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={saveEdit} disabled={saving}>
              {saving ? <Spinner /> : <Icon name="check" size={14} />}
              保存
            </button>
          </>
        }
      >
        {editing && meta && (
          <div className="col gap-16">
            <div className="field">
              <label className="label">角色</label>
              <Select
                value={editRole}
                onChange={setEditRole}
                title="选择角色"
                ariaLabel="角色"
                options={[
                  { value: "admin", label: "家庭管理员" },
                  { value: "member", label: "普通成员" },
                  { value: "viewer", label: "只读成员" },
                  { value: "guest", label: "访客" },
                ]}
              />
              <div className="hint">{ROLE_DESC[editRole]}</div>
            </div>

            <div>
              <div className="row-between mb-8">
                <span className="h4">单独调整</span>
                <span className="tiny faint">勾选"授予"额外开放，勾选"禁止"覆盖角色预设</span>
              </div>
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                {meta.groups.map((g) => (
                  <div key={g.name} style={{ marginBottom: 12 }}>
                    <div
                      className="eyebrow"
                      style={{ marginBottom: 5, fontSize: 10, letterSpacing: "0.08em" }}
                    >
                      {g.name}
                    </div>
                    {g.items.map((p) => {
                      const roleHas = meta.roles.find((r) => r.value === editRole)?.permissions.includes(p.key);
                      const isGrant = grant.includes(p.key);
                      const isDeny = deny.includes(p.key);
                      return (
                        <div
                          key={p.key}
                          className="row gap-10"
                          style={{
                            padding: "6px 8px",
                            borderRadius: "var(--radius-xs)",
                            fontSize: 12.5,
                            background:
                              isGrant || isDeny ? "var(--surface-hover)" : "transparent",
                          }}
                        >
                          <span className="grow">{p.label}</span>
                          <span className="tiny faint" style={{ width: 52 }}>
                            {roleHas ? "角色默认" : "默认无"}
                          </span>
                          <button
                            className={`chip ${isGrant ? "active" : ""}`}
                            style={{ height: 24, fontSize: 11, padding: "0 9px" }}
                            onClick={() => togglePerm(p.key, "grant")}
                          >
                            授予
                          </button>
                          <button
                            className={`chip ${isDeny ? "active" : ""}`}
                            style={{
                              height: 24,
                              fontSize: 11,
                              padding: "0 9px",
                              ...(isDeny
                                ? { background: "var(--danger)", borderColor: "var(--danger)" }
                                : {}),
                            }}
                            onClick={() => togglePerm(p.key, "deny")}
                          >
                            禁止
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        title="移除成员？"
        message={`「${confirm?.display_name}」将失去对此家庭的访问权限，其录入的物品与记录会保留。`}
        confirmText="移除"
        danger
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          if (!confirm) return;
          await del(`/families/current/members/${confirm.id}`);
          toast("已移除");
          await load();
        }}
      />
    </div>
  );
}
