import { Fragment, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { get } from "../api/client";
import type { Dashboard as DashboardData, Item, Page } from "../api/types";
import { Icon } from "../components/icons";
import { AnimatedNumber, Empty, Skeleton } from "../components/ui";
import { useAuth } from "../hooks/auth";
import { useLiveRefresh } from "../hooks/live";
import { STATUS_META, fmtCompact, fmtDate, fmtMoney, relativeTime } from "../lib/format";

function Donut({
  data,
  total,
}: {
  data: { name: string; color: string; count: number }[];
  total: number;
}) {
  const size = 116;
  const stroke = 15;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const sum = data.reduce((a, b) => a + b.count, 0) || 1;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="donut">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--surface-hover)"
        strokeWidth={stroke}
      />
      {data.map((d) => {
        const len = (d.count / sum) * c;
        const el = (
          <circle
            key={d.name}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={d.color}
            strokeWidth={stroke}
            strokeDasharray={`${Math.max(len - 2.5, 0)} ${c}`}
            strokeDashoffset={-offset}
            strokeLinecap="butt"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        );
        offset += len;
        return el;
      })}
      <text
        x="50%"
        y="47%"
        textAnchor="middle"
        fontSize="20"
        fontWeight="650"
        fill="var(--text)"
        letterSpacing="-0.03em"
      >
        {total}
      </text>
      <text x="50%" y="62%" textAnchor="middle" fontSize="10" fill="var(--text-3)">
        件物品
      </text>
    </svg>
  );
}

export function DashboardPage() {
  const { family, user, can } = useAuth();
  const nav = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [recent, setRecent] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [d, items] = await Promise.all([
        get<DashboardData>("/system/dashboard"),
        get<Page<Item>>("/items?page_size=6&sort=updated&order=desc"),
      ]);
      setData(d);
      setRecent(items.items);
    } catch {
      /* 静默失败：首页留着上一次的数据，总比重置成骨架屏好 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 统计数字关心所有实体：任何一次写入都可能改变物品数、价值、临期批次。
  useLiveRefresh(() => void load());

  const hour = new Date().getHours();
  const greeting = hour < 6 ? "夜深了" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 19 ? "下午好" : "晚上好";
  const now = new Date();
  const todayLabel = `${now.getFullYear()} · ${String(now.getMonth() + 1).padStart(2, "0")} · ${String(
    now.getDate()
  ).padStart(2, "0")}`;
  const hasAlerts =
    (data?.overdue_tasks || 0) +
      (data?.overdue_loans || 0) +
      (data?.low_stock || 0) +
      (data?.warranty_expiring || 0) +
      (data?.expiring_batches || 0) +
      (data?.expired_batches || 0) >
    0;

  // 告警条的按钮要落到"这次告警最该去处理的地方"。维护任务有独立页面，
  // 批次没有——它挂在物品下面，所以直接把人送到那个物品的详情页。
  const alertTarget = !data
    ? "/maintenance"
    : data.overdue_tasks > 0
    ? "/maintenance"
    : data.overdue_loans > 0
    ? "/loans"
    : data.low_stock > 0
    ? "/items?low_stock=1"
    : data.expiring_list.length > 0
    ? `/items/${data.expiring_list[0].item_id}`
    : data.warranty_expiring > 0
    ? "/items"
    : "/maintenance";

  if (loading) {
    return (
      <div>
        <div className="page-head">
          <div>
            <Skeleton w={220} h={30} />
            <div style={{ height: 8 }} />
            <Skeleton w={320} h={14} />
          </div>
        </div>
        <div className="dash-grid">
          {[1, 2, 3, 4].map((i) => (
            <div className="stat" key={i}>
              <Skeleton w={70} h={12} />
              <div style={{ height: 12 }} />
              <Skeleton w={100} h={28} />
            </div>
          ))}
        </div>
        <div className="dash-main">
          <div className="card">
            <Skeleton w="100%" h={180} />
          </div>
          <div className="card">
            <Skeleton w="100%" h={180} />
          </div>
        </div>
      </div>
    );
  }
  if (!data) return <Empty title="加载失败" desc="请刷新页面重试" />;

  const trendMax = Math.max(...data.purchase_trend.map((t) => t.amount), 1);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="h1">
            {greeting}，{user?.display_name}
          </h1>
          <div className="sub">
            {family?.name} · 共 {data.total_items} 件物品
            {data.archived_items > 0 && `，其中 ${data.archived_items} 件已归档`}
          </div>
        </div>
        <div className="page-actions">
          <span className="ar-folio hide-sm" style={{ marginRight: 6 }}>
            {todayLabel}
          </span>
          {can("item.create") && (
            <button className="btn btn-primary" onClick={() => nav("/items/new")}>
              <Icon name="plus" size={15} />
              新增物品
            </button>
          )}
        </div>
      </div>

      <div className="stat-strip">
        <button type="button" className="stat-cell" onClick={() => nav("/items")}>
          <div className="stat-label">物品总数</div>
          <div className="stat-value">
            <AnimatedNumber value={data.total_items} />
            <span className="unit">件</span>
          </div>
          <div className="stat-foot">
            {Object.entries(data.by_status).slice(0, 2).map(([k, v]) => (
              <span key={k}>
                {STATUS_META[k]?.label || k} {v}
              </span>
            ))}
          </div>
        </button>

        <button type="button" className="stat-cell" onClick={() => nav("/items?sort=price")}>
          <div className="stat-label">登记价值</div>
          <div className="stat-value">
            <span style={{ fontSize: 19, verticalAlign: 3, color: "var(--text-3)" }}>¥</span>
            <AnimatedNumber value={data.total_value} format={fmtCompact} />
          </div>
          <div className="stat-foot">按购入价累计，仅含未归档物品</div>
        </button>

        <button
          type="button"
          className={`stat-cell ${data.overdue_tasks > 0 ? "danger" : ""}`}
          onClick={() => nav("/maintenance")}
        >
          <div className="stat-label">待维护</div>
          <div className="stat-value">
            <AnimatedNumber value={data.overdue_tasks + data.upcoming_tasks} />
            <span className="unit">项</span>
          </div>
          <div className="stat-foot">
            {data.overdue_tasks > 0 ? (
              <span>
                {data.overdue_tasks} 项已逾期
              </span>
            ) : (
              <span>未来 30 天内有 {data.upcoming_tasks} 项</span>
            )}
          </div>
        </button>

        <button
          type="button"
          className={`stat-cell ${data.warranty_expiring > 0 ? "warn" : ""}`}
          onClick={() => nav("/items?warranty=expiring")}
        >
          <div className="stat-label">保修提醒</div>
          <div className="stat-value">
            <AnimatedNumber value={data.warranty_expiring} />
            <span className="unit">件</span>
          </div>
          <div className="stat-foot">
            {data.warranty_expired > 0
              ? `另有 ${data.warranty_expired} 件已过保`
              : "30 天内到期"}
          </div>
        </button>
      </div>

      {hasAlerts && (
        <div
          className="card"
          style={{
            marginTop: 14,
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderLeft: "3px solid var(--amber)",
            borderRadius: "var(--radius-sm)",
          }}
        >
          <Icon name="alert" size={17} style={{ color: "var(--amber)", flex: "0 0 auto" }} />
          <div className="grow" style={{ fontSize: 12.5, color: "var(--text)" }}>
            {(
              [
                data.overdue_tasks > 0 && <b>{data.overdue_tasks} 项维护已逾期</b>,
                data.overdue_loans > 0 && <b>{data.overdue_loans} 件借出已逾期</b>,
                data.low_stock > 0 && <b>{data.low_stock} 件物品库存不足</b>,
                data.warranty_expiring > 0 && (
                  <span>
                    <b>{data.warranty_expiring} 件物品</b> 的保修将在 30 天内到期
                  </span>
                ),
                data.expired_batches > 0 && <b>{data.expired_batches} 个批次已过期</b>,
                data.expiring_batches > 0 && (
                  <span>
                    <b>{data.expiring_batches} 个批次</b> 将在 30 天内到期
                  </span>
                ),
              ].filter(Boolean) as React.ReactNode[]
            ).map((part, i) => (
              <Fragment key={i}>
                {i > 0 && "，"}
                {part}
              </Fragment>
            ))}
          </div>
          <button className="btn btn-sm" onClick={() => nav(alertTarget)}>
            去处理
            <Icon name="arrow-right" size={13} />
          </button>
        </div>
      )}

      <div className="dash-main">
        <div className="col gap-16">
          {data.open_loans > 0 && (
            <div
              className="card"
              style={{
                padding: "13px 16px",
                display: "flex",
                alignItems: "center",
                gap: 12,
                cursor: "pointer",
              }}
              onClick={() => nav("/loans")}
            >
              <Icon name="inbox" size={17} style={{ color: "var(--brand)", flex: "0 0 auto" }} />
              <div className="grow" style={{ fontSize: 12.5, color: "var(--text)" }}>
                <b>{data.open_loans} 件物品</b> 借出在外
              </div>
              <Icon name="arrow-right" size={13} style={{ color: "var(--text-3)" }} />
            </div>
          )}
          {data.low_stock_list.length > 0 && (
            <div className="card card-flush">
              <div className="card-head" style={{ padding: "16px 18px 0", marginBottom: 10 }}>
                <div className="card-title">
                  <Icon name="package" size={15} />
                  低库存
                </div>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => nav("/items?low_stock=1")}
                >
                  全部
                  <Icon name="arrow-right" size={12} />
                </button>
              </div>
              <div style={{ padding: "0 8px 8px" }}>
                {data.low_stock_list.map((l) => (
                  <div
                    key={l.id}
                    className="expiry-row"
                    onClick={() => nav(`/items/${l.id}`)}
                  >
                    <div className={`expiry-days ${l.quantity <= 0 ? "danger" : "warn"}`}>
                      <span className="num">{l.quantity}</span>
                      <span className="u">{l.unit}</span>
                    </div>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="truncate" style={{ fontSize: 12.5, fontWeight: 550 }}>
                        {l.name}
                      </div>
                      <div className="tiny faint" style={{ marginTop: 2 }}>
                        <span className="mono">{l.code}</span> · 阈值 {l.min_stock} {l.unit}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {data.expiring_list.length > 0 && (
            <div className="card card-flush">
              <div className="card-head" style={{ padding: "16px 18px 0", marginBottom: 10 }}>
                <div className="card-title">
                  <Icon name="tag" size={15} />
                  临期与过期
                </div>
                <span className="tiny faint">
                  {data.expired_batches > 0 && `${data.expired_batches} 个已过期`}
                  {data.expired_batches > 0 && data.expiring_batches > 0 && " · "}
                  {data.expiring_batches > 0 && `${data.expiring_batches} 个临期`}
                </span>
              </div>
              <div style={{ padding: "0 8px 8px" }}>
                {data.expiring_list.map((b) => {
                  const expired = b.expiry_state === "expired";
                  return (
                    <div
                      key={b.id}
                      className="expiry-row"
                      onClick={() => nav(`/items/${b.item_id}`)}
                    >
                      <div className={`expiry-days ${expired ? "danger" : "warn"}`}>
                        <span className="num">{Math.abs(b.days_left ?? 0)}</span>
                        <span className="u">{expired ? "天前" : "天后"}</span>
                      </div>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="truncate" style={{ fontSize: 12.5, fontWeight: 550 }}>
                          {b.item_name}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                          {b.batch_no || "未命名批次"} · {b.quantity} {b.unit || b.item_unit} ·{" "}
                          {fmtDate(b.expires_on)}
                        </div>
                      </div>
                      <span className={`badge ${expired ? "danger" : "warn"}`}>
                        {expired ? "已过期" : "临期"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <div className="card-title">
                <Icon name="trending-up" size={15} />
                近 6 个月购入
              </div>
              <span className="tiny faint">
                合计 {fmtMoney(data.purchase_trend.reduce((a, b) => a + b.amount, 0))}
              </span>
            </div>
            <div className="chart-bars">
              {data.purchase_trend.map((t, i) => (
                <div className="chart-bar-col" key={t.month} title={`${t.month} · ${fmtMoney(t.amount)}`}>
                  <div className="chart-bar-val">{t.amount > 0 ? fmtCompact(t.amount) : ""}</div>
                  <div className="chart-bar-track">
                    <div
                      className={`chart-bar ${i === data.purchase_trend.length - 1 ? "hi" : ""}`}
                      style={{ height: `${Math.max((t.amount / trendMax) * 100, 2)}%` }}
                    />
                  </div>
                  <div className="chart-label">{t.month.slice(5)}月</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card card-flush">
            <div className="card-head" style={{ padding: "16px 18px 0", marginBottom: 12 }}>
              <div className="card-title">
                <Icon name="package" size={15} />
                最近更新
              </div>
              <button className="btn btn-sm btn-ghost" onClick={() => nav("/items")}>
                全部
                <Icon name="chevron-right" size={13} />
              </button>
            </div>
            <div style={{ padding: "0 8px 8px" }}>
              {recent.map((it) => (
                <div
                  key={it.id}
                  onClick={() => nav(`/items/${it.id}`)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    padding: "9px 10px",
                    borderRadius: "var(--radius-sm)",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: "var(--radius-xs)",
                      background: "var(--bg-sunken)",
                      overflow: "hidden",
                      flex: "0 0 auto",
                      display: "grid",
                      placeItems: "center",
                      color: "var(--text-3)",
                    }}
                  >
                    {it.cover_url ? (
                      <img
                        src={it.cover_url}
                        alt=""
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        onError={(e) => (e.currentTarget.style.display = "none")}
                      />
                    ) : (
                      <Icon name="package" size={15} />
                    )}
                  </div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="truncate" style={{ fontSize: 12.5, fontWeight: 550 }}>
                      {it.name}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                      {it.location_path || "未分配位置"} · {it.code}
                    </div>
                  </div>
                  <span className={`badge ${STATUS_META[it.status]?.cls || ""}`}>
                    <span className="dot" />
                    {STATUS_META[it.status]?.label || it.status}
                  </span>
                </div>
              ))}
              {recent.length === 0 && (
                <Empty
                  title="还没有物品"
                  desc="从扫码或点右上角「新增物品」开始建立你家的第一份清单"
                />
              )}
            </div>
          </div>
        </div>

        <div className="col gap-16">
          <div className="card">
            <div className="card-head">
              <div className="card-title">
                <Icon name="pie-chart" size={15} />
                分类分布
              </div>
            </div>
            {data.by_category.length > 0 ? (
              <div className="donut-wrap">
                <Donut data={data.by_category} total={data.total_items} />
                <div className="donut-legend">
                  {data.by_category.slice(0, 5).map((c) => (
                    <div className="legend-row" key={c.name}>
                      <span className="legend-dot" style={{ background: c.color }} />
                      <span className="truncate">{c.name}</span>
                      <span className="val">{c.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="faint small">暂未分类</div>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <div className="card-title">
                <Icon name="zap" size={15} />
                快捷操作
              </div>
            </div>
            <div className="quick-grid">
              <div className="quick-tile" onClick={() => nav("/loans")}>
                <div className="ic">
                  <Icon name="inbox" size={14} />
                </div>
                <div className="t">借还登记</div>
                <div className="d">借出与归还</div>
              </div>
              <div className="quick-tile" onClick={() => nav("/maintenance")}>
                <div className="ic">
                  <Icon name="wrench" size={14} />
                </div>
                <div className="t">维护计划</div>
                <div className="d">保养与耗材更换</div>
              </div>
              <div className="quick-tile" onClick={() => nav("/labels")}>
                <div className="ic">
                  <Icon name="printer" size={14} />
                </div>
                <div className="t">打印标签</div>
                <div className="d">A4 一次贴满</div>
              </div>
              <div className="quick-tile" onClick={() => nav("/settings?tab=data")}>
                <div className="ic">
                  <Icon name="database" size={14} />
                </div>
                <div className="t">备份数据</div>
                <div className="d">导出与恢复</div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div className="card-title">
                <Icon name="activity" size={15} />
                最近动态
              </div>
              <span className="tiny faint">全家庭共享</span>
            </div>
            <div className="feed">
              {data.recent_events.length === 0 && (
                <div className="faint small">还没有操作记录</div>
              )}
              {data.recent_events.slice(0, 6).map((e) => (
                <div className="feed-row" key={e.id}>
                  <div className="feed-ic">
                    <Icon
                      name={
                        e.event_type === "created"
                          ? "plus"
                          : e.event_type === "moved"
                          ? "map-pin"
                          : e.event_type === "status_change"
                          ? "refresh"
                          : e.event_type === "maintenance_done"
                          ? "check"
                          : e.event_type === "attachment"
                          ? "image"
                          : "edit"
                      }
                      size={13}
                    />
                  </div>
                  <div className="feed-body">
                    <div className="feed-text">
                      <b>{e.actor_name}</b> {e.summary}
                    </div>
                    <div className="feed-time">{relativeTime(e.created_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
