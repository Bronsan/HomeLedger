import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authedUrl, del, get, getMode, post } from "../api/client";
import type { Item, MaintenanceTask, Page } from "../api/types";
import { Icon } from "../components/icons";
import { AnimatedNumber, ButtonLabel, ConfirmDialog, Empty, Modal, NestedSwitch, Select, Spinner, shakeElement, useToast } from "../components/ui";
import { useAuth } from "../hooks/auth";
import { useLiveRefresh } from "../hooks/live";
import { PRIORITY_META, TASK_TYPE_LABEL, dueLabel, fmtDate, fmtMoney } from "../lib/format";
import { calendarFallbackStart, maintenanceEvent, maintenanceTitle } from "../lib/calendar-plan";
import { canWriteCalendar, removeCalendarEvent, writeCalendarEvent } from "../lib/native-calendar";
import { isMobileShell } from "../lib/platform";

/**
 * 维护页筛选分成两级：状态（待办 / 已完成），以及只属于「待办」的
 * 时间范围。以前是 5 个平铺 chip；改成两级后，范围选项只在待办下
 * 展开，切到「已完成」时仍记住上次选的范围。
 */
const STATUS = [
  { key: "pending", label: "待办" },
  { key: "done", label: "已完成" },
] as const;

const RANGES = [
  { key: "all", label: "全部" },
  { key: "week", label: "7 天" },
  { key: "month", label: "30 天" },
  { key: "overdue", label: "逾期" },
] as const;

type StatusKey = (typeof STATUS)[number]["key"];
type RangeKey = (typeof RANGES)[number]["key"];

interface Draft {
  item_id: string;
  title: string;
  task_type: string;
  interval_days: string;
  due_at: string;
  priority: string;
  assignee_id: string;
  notes: string;
  estimated_cost: string;
}

export function MaintenancePage() {
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [params] = useSearchParams();

  const [tasks, setTasks] = useState<MaintenanceTask[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<StatusKey>("pending");
  const [range, setRange] = useState<RangeKey>("all");
  // 后端只认一个 filter 字符串：已完成忽略范围，其余都归到待办的范围查询。
  const filter = status === "done" ? "done" : range;
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [invalid, setInvalid] = useState({ item: false, title: false });
  const itemFieldRef = useRef<HTMLDivElement>(null);
  const titleFieldRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [complete, setComplete] = useState<MaintenanceTask | null>(null);
  const [completeForm, setCompleteForm] = useState({ cost: "", notes: "" });
  const [confirm, setConfirm] = useState<MaintenanceTask | null>(null);
  const [saving, setSaving] = useState(false);
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const query =
        filter === "overdue"
          ? "/maintenance?overdue=true"
          : filter === "week"
          ? "/maintenance?upcoming_days=7"
          : filter === "month"
          ? "/maintenance?upcoming_days=30"
          : filter === "done"
          ? "/maintenance?status=done"
          : "/maintenance?status=pending";
      const res = await get<{ items: MaintenanceTask[]; counts: Record<string, number> }>(query);
      setTasks(res.items);
      setCounts(res.counts);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  // 维护任务可能被任何一个人完成或新建，列表跟着刷新即可，不用重连。
  useLiveRefresh(() => void load(true), ["maintenance"]);

  useEffect(() => {
    get<Page<Item>>("/items?page_size=200").then((r) => setItems(r.items)).catch(() => {});
  }, []);

  // 行尾菜单是向上展开的浮层：点页面其他地方先收起，避免它挡住下面的行。
  // 不用 <details>——部分 Android WebView 会把溢出 details 边界的绝对定位
  // 子元素画出来，却不把触摸事件交给它。
  useEffect(() => {
    if (!openMenu) return;
    const close = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      const holder = target?.closest("[data-maint-menu]");
      if (!holder || holder.getAttribute("data-maint-menu") !== openMenu) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [openMenu]);

  useEffect(() => {
    const itemId = params.get("item");
    if (itemId && can("maintenance.create")) {
      setDraft({
        item_id: itemId,
        title: "",
        task_type: "routine",
        interval_days: "",
        due_at: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        priority: "normal",
        assignee_id: "",
        notes: "",
        estimated_cost: "",
      });
      setInvalid({ item: false, title: false });
    }
  }, [params, can]);

  const save = async () => {
    if (!draft) return;
    /* 校验结果直接落在出错的那个字段上：抖动 + 红框 + 字段下方说明，
       而不是只在屏幕角落弹一条 toast——用户正看着表单，反馈也应该在表单里。 */
    const missingItem = !draft.item_id;
    const missingTitle = !draft.title.trim();
    if (missingItem || missingTitle) {
      setInvalid({ item: missingItem, title: missingTitle });
      if (missingItem) {
        shakeElement(itemFieldRef.current);
        itemFieldRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      } else {
        shakeElement(titleFieldRef.current);
        titleFieldRef.current?.querySelector<HTMLInputElement>("input")?.focus();
      }
      return;
    }
    setInvalid({ item: false, title: false });
    setSaving(true);
    try {
      await post("/maintenance", {
        item_id: draft.item_id,
        title: draft.title.trim(),
        task_type: draft.task_type,
        interval_days: draft.interval_days ? Number(draft.interval_days) : null,
        due_at: draft.due_at ? new Date(draft.due_at).toISOString() : null,
        priority: draft.priority,
        assignee_id: draft.assignee_id || null,
        notes: draft.notes,
        estimated_cost: draft.estimated_cost ? Number(draft.estimated_cost) : null,
      });
      toast("维护任务已创建");
      setDraft(null);
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const doComplete = async () => {
    if (!complete) return;
    setSaving(true);
    try {
      await post(`/maintenance/${complete.id}/complete`, {
        cost: completeForm.cost ? Number(completeForm.cost) : null,
        notes: completeForm.notes || null,
      });
      toast(
        complete.interval_days
          ? `已完成，下次到期日已顺延 ${complete.interval_days} 天`
          : "已完成"
      );
      setComplete(null);
      setCompleteForm({ cost: "", notes: "" });
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const stats = useMemo(() => {
    const overdue = tasks.filter((t) => t.overdue).length;
    const soon = tasks.filter((t) => t.due_in_days !== null && t.due_in_days !== undefined && t.due_in_days >= 0 && t.due_in_days <= 7).length;
    return { overdue, soon, pending: counts.pending || 0, done: counts.done || 0 };
  }, [tasks, counts]);

  /** 没有原生写入能力（浏览器）时的老路：生成 .ics 交给用户手动导入。 */
  const exportIcs = () => {
    if (getMode() === "remote") {
      window.location.href = authedUrl("/maintenance/calendar.ics");
      return;
    }
    void get<string>("/maintenance/calendar.ics").then((text) => {
      const blob = new Blob([text], { type: "text/calendar" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "homeledger-maintenance.ics";
      a.click();
      URL.revokeObjectURL(a.href);
      toast("已下载日历文件，导入系统日历即可提醒");
    });
  };

  /**
   * 壳内直接写系统日历：一次性任务一条事件，周期计划一条 RRULE 循环事件，
   * 由系统日历负责提醒。写入按任务 id 幂等，周期任务完成顺延后再点一次
   * 即可把提醒挪到新的到期日。
   */
  const syncToCalendar = async () => {
    if (calendarBusy) return;
    setCalendarBusy(true);
    try {
      // 不能用当前筛选后的 tasks：用户可能停在「已完成」或「7 天内」，
      // 那样会把不在当前视图里的待办漏掉。这里单独取全部待办。
      const res = await get<{ items: MaintenanceTask[] }>("/maintenance?status=pending");
      const pending = res.items.filter((t) => t.status === "pending");
      if (pending.length === 0) {
        toast("没有待办任务可以写入日历");
        return;
      }
      const fallback = calendarFallbackStart();
      const undated = pending.filter((t) => !t.next_due_at).length;
      let ok = 0;
      let lastErr = "";
      for (const t of pending) {
        try {
          await writeCalendarEvent(maintenanceEvent(t, fallback));
          ok += 1;
        } catch (err) {
          lastErr = (err as Error).message;
          break;
        }
      }
      if (ok === pending.length) {
        const fallbackLabel = fallback.toLocaleDateString("zh-CN", {
          month: "long",
          day: "numeric",
        });
        const note = undated > 0 ? `（${undated} 条未设到期日，按 ${fallbackLabel} 09:00 写入）` : "";
        toast(
          ok === 1
            ? `已写入 1 条维护提醒到系统日历${note}`
            : `已写入 ${ok} 条维护提醒到系统日历${note}`
        );
      } else if (ok > 0) {
        toast(`已写入 ${ok} 条，其余失败：${lastErr}`, "error");
      } else {
        toast(lastErr || "写入日历失败", "error");
        // 手机上多半是没授权（下载 .ics 在手机上也没法导入），桌面端没装
        // Outlook 才走这条路——那种环境 .ics 仍是最接近的做法。
        if (!isMobileShell()) exportIcs();
      }
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setCalendarBusy(false);
    }
  };

  const nativeCalendar = canWriteCalendar();

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="h1">维护计划</h1>
          <div className="sub">保养、检查、耗材更换，到期自动提醒全家人</div>
        </div>
        <button
          className="btn"
          disabled={calendarBusy}
          title={
            nativeCalendar
              ? "把待办维护和周期计划直接写入本设备的系统日历；未设到期日的任务按次日 09:00 写入"
              : "把待办维护导出成日历文件，导入系统日历后由日历提醒"
          }
          onClick={() => (nativeCalendar ? void syncToCalendar() : exportIcs())}
        >
          <Icon name="calendar" size={14} />
          <ButtonLabel
            busy={calendarBusy}
            idle={nativeCalendar ? "写入系统日历" : "导出日历文件"}
            busyLabel="写入中…"
          />
        </button>
        {can("maintenance.create") && (
          <button
            className="btn btn-primary"
            onClick={() => {
              setDraft({
                item_id: "",
                title: "",
                task_type: "routine",
                interval_days: "",
                due_at: new Date().toISOString().slice(0, 10),
                priority: "normal",
                assignee_id: "",
                notes: "",
                estimated_cost: "",
              });
              setInvalid({ item: false, title: false });
            }}
          >
            <Icon name="plus" size={15} />
            新建任务
          </button>
        )}
      </div>

      <div className="stat-strip" style={{ marginBottom: 16 }}>
        <div className={`stat-cell static ${stats.overdue > 0 ? "danger" : ""}`}>
          <div className="stat-label">已逾期</div>
          <div className="stat-value"><AnimatedNumber value={stats.overdue} /></div>
          <div className="stat-foot">{stats.overdue > 0 ? "需要尽快处理" : "一切正常"}</div>
        </div>
        <div className="stat-cell static">
          <div className="stat-label">7 天内</div>
          <div className="stat-value"><AnimatedNumber value={stats.soon} /></div>
          <div className="stat-foot">即将到期</div>
        </div>
        <div className="stat-cell static">
          <div className="stat-label">待办总数</div>
          <div className="stat-value"><AnimatedNumber value={stats.pending} /></div>
          <div className="stat-foot">含周期性任务</div>
        </div>
        <div className="stat-cell static">
          <div className="stat-label">已完成</div>
          <div className="stat-value"><AnimatedNumber value={stats.done} /></div>
          <div className="stat-foot">一次性任务</div>
        </div>
      </div>

      <div className="hl-switch-row">
        <NestedSwitch
          primary={STATUS}
          secondary={RANGES}
          primaryValue={status}
          secondaryValue={range}
          onPrimaryChange={(key) => {
            if (key === "pending" || key === "done") setStatus(key);
          }}
          onSecondaryChange={(key) => {
            const next = RANGES.find((r) => r.key === key);
            if (next) setRange(next.key);
          }}
          ariaLabel="任务状态"
          secondaryLabel="待办时间范围"
        />
      </div>

      <div className={`card card-flush maint-list${openMenu ? " menu-open" : ""}`}>
        {loading && (
          <div style={{ padding: 20 }}>
            <div className="skeleton" style={{ height: 160 }} />
          </div>
        )}
        {!loading && tasks.length === 0 && (
          <Empty
            icon="wrench"
            title={filter === "done" ? "还没有完成记录" : "没有待办任务"}
            desc={
              filter === "done"
                ? "完成维护后，记录会出现在这里"
                : "为吸尘器、净水器、灭火器这类需要定期照顾的物品建立计划"
            }
          />
        )}
        {!loading &&
          tasks.map((t) => {
            const due = dueLabel(t.due_in_days);
            return (
              <div
                className={`maint-row${openMenu === t.id ? " menu-open" : ""}`}
                key={t.id}
              >
                {can("maintenance.complete") && t.status === "pending" ? (
                  <button
                    className="maint-check"
                    onClick={() => {
                      setComplete(t);
                      setCompleteForm({ cost: "", notes: "" });
                    }}
                    title="标记完成"
                  >
                    <Icon name="check" size={10} />
                  </button>
                ) : (
                  <div
                    className="maint-check"
                    style={{
                      borderColor: "var(--brand)",
                      background: "var(--brand-soft)",
                    }}
                  >
                    <Icon name="check" size={10} style={{ opacity: 1 }} />
                  </div>
                )}
                <div className="maint-main" onClick={() => t.item_id && nav(`/items/${t.item_id}`)}>
                  <div className="maint-title">
                    {t.title}
                    {t.priority === "high" || t.priority === "urgent" ? (
                      <span className={`badge ${PRIORITY_META[t.priority].cls}`}>
                        {PRIORITY_META[t.priority].label}
                      </span>
                    ) : null}
                    {t.interval_days && (
                      <span className="badge" style={{ fontWeight: 400 }}>
                        每 {t.interval_days} 天
                      </span>
                    )}
                  </div>
                  <div className="maint-sub">
                    <Icon name="package" size={11} />
                    <span>{t.item_name || "未知物品"}</span>
                    <span className="dot-sep">·</span>
                    <span>{TASK_TYPE_LABEL[t.task_type] || t.task_type}</span>
                    {t.assignee && (
                      <>
                        <span className="dot-sep">·</span>
                        <span>{t.assignee.display_name}</span>
                      </>
                    )}
                    {t.estimated_cost != null && (
                      <>
                        <span className="dot-sep">·</span>
                        <span>预计 {fmtMoney(t.estimated_cost)}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="col" style={{ alignItems: "flex-end", gap: 2 }}>
                  <div className={`maint-due ${due.cls}`}>{due.text}</div>
                  <div className="tiny faint num">{fmtDate(t.next_due_at)}</div>
                </div>
                <div style={{ position: "relative" }} data-maint-menu={t.id}>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ cursor: "pointer" }}
                    onClick={() => setOpenMenu(openMenu === t.id ? null : t.id)}
                    aria-label="更多操作"
                    aria-expanded={openMenu === t.id}
                  >
                    <Icon name="more-h" size={15} />
                  </button>
                  {openMenu === t.id && (
                    <div
                      className="card"
                      style={{
                        position: "absolute",
                        right: 0,
                        // 向上展开：列表底部紧挨着固定导航栏，向下展开时最后一项
                        // 会被导航栏盖住。向上展开后菜单始终在行尾按钮上方。
                        bottom: "100%",
                        marginBottom: 4,
                        width: 150,
                        padding: 5,
                        zIndex: 10,
                        boxShadow: "var(--shadow-lg)",
                      }}
                    >
                      {t.item_id && (
                        <div
                          className="nav-item"
                          style={{ fontSize: 12 }}
                          onClick={() => {
                            setOpenMenu(null);
                            nav(`/items/${t.item_id}`);
                          }}
                        >
                          <Icon name="package" size={13} />
                          查看物品
                        </div>
                      )}
                      {can("maintenance.complete") && t.status === "pending" && t.interval_days && (
                        <div
                          className="nav-item"
                          style={{ fontSize: 12 }}
                          onClick={async () => {
                            setOpenMenu(null);
                            await post(`/maintenance/${t.id}/skip`, {});
                            toast("已跳过一次，到期日顺延");
                            void load(true);
                          }}
                        >
                          <Icon name="refresh" size={13} />
                          跳过一次
                        </div>
                      )}
                      {nativeCalendar && t.status === "pending" && (
                        <div
                          className="nav-item"
                          style={{ fontSize: 12 }}
                          onClick={async () => {
                            setOpenMenu(null);
                            try {
                              const assumed = !t.next_due_at;
                              await writeCalendarEvent(maintenanceEvent(t, calendarFallbackStart()));
                              toast(
                                assumed
                                  ? "已写入系统日历（未设到期日，按次日 09:00）"
                                  : "写入系统日历，到期时由日历提醒"
                              );
                            } catch (err) {
                              toast((err as Error).message, "error");
                            }
                          }}
                        >
                          <Icon name="calendar" size={13} />
                          写入系统日历
                        </div>
                      )}
                      {can("maintenance.update") && (
                        <div
                          className="nav-item"
                          style={{ fontSize: 12, color: "var(--danger)" }}
                          onClick={() => {
                            setOpenMenu(null);
                            setConfirm(t);
                          }}
                        >
                          <Icon name="trash" size={13} />
                          删除任务
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
      </div>

      <Modal
        open={Boolean(draft)}
        onClose={() => setDraft(null)}
        title="新建维护任务"
        size="wide"
        footer={
          <>
            <button className="btn" onClick={() => setDraft(null)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? <Spinner /> : <Icon name="check" size={14} />}
              创建
            </button>
          </>
        }
      >
        {draft && (
          <div className="col gap-14" style={{ gap: 14 }}>
            <div className={`field${invalid.item ? " is-invalid" : ""}`} ref={itemFieldRef}>
              <label className="label">
                物品 <span className="req">*</span>
              </label>
              <Select
                value={draft.item_id}
                onChange={(v) => {
                  setDraft({ ...draft, item_id: v });
                  if (v) setInvalid((s) => ({ ...s, item: false }));
                }}
                placeholder="选择要维护的物品"
                title="选择物品"
                ariaLabel="物品"
                searchable
                options={[
                  { value: "", label: "选择要维护的物品" },
                  ...items.map((i) => ({
                    value: i.id,
                    label: i.name,
                    hint: i.code,
                  })),
                ]}
              />
              {invalid.item && (
                <div className="field-error" role="alert">
                  请选择要维护的物品
                </div>
              )}
            </div>
            <div className={`field${invalid.title ? " is-invalid" : ""}`} ref={titleFieldRef}>
              <label className="label">
                任务名称 <span className="req">*</span>
              </label>
              <input
                className="input"
                value={draft.title}
                onChange={(e) => {
                  setDraft({ ...draft, title: e.target.value });
                  if (e.target.value.trim()) setInvalid((s) => ({ ...s, title: false }));
                }}
                placeholder="例如：更换净水器滤芯"
                aria-invalid={invalid.title || undefined}
                autoFocus
              />
              {invalid.title && (
                <div className="field-error" role="alert">
                  请填写任务名称
                </div>
              )}
            </div>
            <div className="form-grid">
              <div className="field">
                <label className="label">类型</label>
                <Select
                  value={draft.task_type}
                  onChange={(v) => setDraft({ ...draft, task_type: v })}
                  title="选择任务类型"
                  ariaLabel="任务类型"
                  options={["routine", "inspection", "replacement", "repair", "warranty"].map(
                    (k) => ({ value: k, label: TASK_TYPE_LABEL[k] })
                  )}
                />
              </div>
              <div className="field">
                <label className="label">优先级</label>
                <Select
                  value={draft.priority}
                  onChange={(v) => setDraft({ ...draft, priority: v })}
                  title="选择优先级"
                  ariaLabel="优先级"
                  options={["low", "normal", "high", "urgent"].map((k) => ({
                    value: k,
                    label: PRIORITY_META[k].label,
                  }))}
                />
              </div>
              <div className="field">
                <label className="label">首次到期</label>
                <input
                  className="input"
                  type="date"
                  value={draft.due_at}
                  onChange={(e) => setDraft({ ...draft, due_at: e.target.value })}
                />
              </div>
              <div className="field">
                <label className="label">重复间隔（天）</label>
                <input
                  className="input"
                  type="number"
                  min="1"
                  value={draft.interval_days}
                  onChange={(e) => setDraft({ ...draft, interval_days: e.target.value })}
                  placeholder="留空表示一次性"
                />
                <div className="hint">完成后自动顺延到下一个周期</div>
              </div>
            </div>
            <div className="field">
              <label className="label">备注</label>
              <textarea
                className="textarea"
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                placeholder="滤芯型号、注意事项…"
              />
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(complete)}
        onClose={() => setComplete(null)}
        title="完成维护"
        subtitle={complete?.title}
        footer={
          <>
            <button className="btn" onClick={() => setComplete(null)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={doComplete} disabled={saving}>
              <Icon name="check" size={14} />
              确认完成
            </button>
          </>
        }
      >
        <div className="col gap-14" style={{ gap: 14 }}>
          {complete?.interval_days && (
            <div
              className="row gap-8"
              style={{
                fontSize: 12,
                background: "var(--brand-soft)",
                color: "var(--brand)",
                padding: "9px 11px",
                borderRadius: "var(--radius-xs)",
              }}
            >
              <Icon name="refresh" size={13} />
              这是周期性任务，完成后会自动顺延 {complete.interval_days} 天
            </div>
          )}
          <div className="field">
            <label className="label">本次花费（元）</label>
            <input
              className="input"
              type="number"
              min="0"
              step="0.01"
              value={completeForm.cost}
              onChange={(e) => setCompleteForm({ ...completeForm, cost: e.target.value })}
              placeholder="选填"
            />
          </div>
          <div className="field">
            <label className="label">维护记录</label>
            <textarea
              className="textarea"
              value={completeForm.notes}
              onChange={(e) => setCompleteForm({ ...completeForm, notes: e.target.value })}
              placeholder="换了什么、发现什么问题…"
            />
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        title="删除维护任务？"
        message={`「${confirm?.title}」将被删除，历史完成记录仍保留在物品时间线中。`}
        confirmText="删除"
        danger
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          if (!confirm) return;
          const task = confirm;
          await del(`/maintenance/${task.id}`);
          // 任务删了，之前写进系统日历的提醒也要撤回，否则日历还会为一个
          // 已不存在的任务响铃。日历里没有这条事件（或桌面没装 Outlook）
          // 都不影响删除本身，因此失败只吞掉。桌面走 PowerShell/COM，
          // 遇到 Outlook 忙时可能长时间不返回，不能卡住删除后的刷新。
          if (nativeCalendar) {
            const cleanup = removeCalendarEvent(task.id, maintenanceTitle(task)).catch(() => {
              /* 尽力而为 */
            });
            if (isMobileShell()) await cleanup;
          }
          toast("已删除");
          await load();
        }}
      />
    </div>
  );
}
