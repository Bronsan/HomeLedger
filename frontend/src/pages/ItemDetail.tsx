import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, assetUrl, del, get, getMode, patch, post } from "../api/client";
import type { ItemBatch, ItemDetail, Location } from "../api/types";
import { ExportPreview, type ExportTarget } from "../components/ExportPreview";
import { Icon } from "../components/icons";
import {
  ButtonLabel,
  ConfirmDialog,
  CopyButton,
  Empty,
  Modal,
  Select,
  Spinner,
  Tabs,
  useConfirm,
  useToast,
} from "../components/ui";
import { useAuth } from "../hooks/auth";
import { useLiveRefresh } from "../hooks/live";
import { resolveAsset } from "../local/blobs";
import { labelDataUrl, qrDataUrl } from "../local/qr";
import { fetchBlob, qrLinkFor } from "../sync/engine";
import {
  ATTACHMENT_KIND_LABEL,
  CONDITION_LABEL,
  STATUS_META,
  TASK_TYPE_LABEL,
  dueLabel,
  fmtBytes,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  relativeTime,
} from "../lib/format";

const EVENT_ICON: Record<string, string> = {
  created: "plus",
  updated: "edit",
  moved: "map-pin",
  status_change: "refresh",
  borrowed: "arrow-up-right",
  lent: "arrow-up-right",
  returned: "corner-down-right",
  maintenance_created: "wrench",
  maintenance_done: "check",
  attachment: "image",
  attachment_removed: "trash",
  archived: "archive",
  restored: "refresh",
  component_added: "layers",
  batch_added: "tag",
  batch_updated: "tag",
  batch_removed: "trash",
};

/** 到期状态徽章。状态由服务端/本机按当天算出，这里只负责呈现。 */
function ExpiryBadge({ batch }: { batch: ItemBatch }) {
  if (batch.expiry_state === "expired") {
    return (
      <span className="badge danger">
        {batch.days_left === null ? "已过期" : `已过期 ${Math.abs(batch.days_left)} 天`}
      </span>
    );
  }
  if (batch.expiry_state === "expiring") {
    return (
      <span className="badge warn">
        {batch.days_left === 0 ? "今天到期" : `${batch.days_left} 天后到期`}
      </span>
    );
  }
  return null;
}

interface BatchForm {
  id?: string;
  batch_no: string;
  quantity: string;
  unit: string;
  produced_on: string;
  expires_on: string;
  location_id: string;
  supplier: string;
  note: string;
}

export function ItemDetailPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm();
  const { can, user } = useAuth();
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [tab, setTab] = useState<"overview" | "files" | "maint" | "batches" | "timeline" | "loans">(
    "overview"
  );
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);

  // Attachments live in the device database, not behind a URL. Resolving one
  // may hit disk, and — on a device that has only just paired — the network,
  // so the click handler has to be async. `fetchBlob` is a no-op when the
  // bytes are already here.
  const openAttachment = async (a: { url: string; is_image: boolean; original_name: string }) => {
    let url = await resolveAsset(a.url);
    if (!url && a.url.startsWith("local:")) {
      const blob = await fetchBlob(a.url.slice(6));
      if (blob) url = URL.createObjectURL(blob);
    }
    if (!url) {
      setPreview(null);
      toast("附件内容不在这台设备上，联网后会自动补齐", "error");
      return;
    }
    if (a.is_image) setPreview({ url, name: a.original_name });
    else window.open(url, "_blank");
  };

  // The printed sticker has to point at the *server*, so the QR is rendered
  // from a URL the server handed us rather than from a deep link into this
  // app. In local mode that URL is still available while the device is paired
  // with a server; without one there is nowhere for the sticker to lead, and
  // the card says so instead of printing a code that does nothing.
  const [stick, setStick] = useState<
    { url: string; token: string; host: string; reachable: boolean; lanOnly: boolean } | null
  >(null);
  const [qrSrc, setQrSrc] = useState("");
  // The label is regenerated from the server URL as well: printing the local
  // one would put a `homeledger://` QR on the sticker, which is exactly the
  // thing a sticker is supposed to avoid.
  const [labelSrc, setLabelSrc] = useState("");
  // 「先看后发」弹窗：二维码 / 标签共用一个预览出口（详见 ExportPreview）
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);
  // 「先看后发」的数据在点击时才构建：正常情况用页面里已有的矢量图（qrSrc /
  // labelSrc，指向服务器链接）；本机模式没有配对服务器时它们是空的——此前
  // 预览弹窗拿到空目标直接不渲染，菜单点了毫无反应。退化为资产编号文本的
  // 二维码（与标签页离线兜底同一策略），扫出来粘贴进查询页就能定位。
  const openExport = async (kind: "qr" | "label") => {
    if (!item) return;
    let dataUrl = kind === "qr" ? qrSrc : labelSrc;
    let offline = false;
    if (!dataUrl) {
      offline = true;
      const text = item.code || item.id;
      dataUrl =
        kind === "qr"
          ? await qrDataUrl(text)
          : await labelDataUrl({
              url: text,
              title: item.name || "",
              code: item.code || "",
              subtitle: item.location_path || "",
            });
    }
    setExportTarget({
      title: kind === "qr" ? "物品二维码" : "标签图片",
      dataUrl,
      fileName: kind === "qr"
        ? `homeledger-qr-${item.code || item.id}.png`
        : `homeledger-label-${item.code || item.id}.png`,
      printable: kind === "label",
      jobName: `HomeLedger 标签 · ${item.name || ""}`,
      rasterWidth: kind === "qr" ? 640 : 709,
      offline,
    });
  };
  const [loanOpen, setLoanOpen] = useState(false);
  const [loanForm, setLoanForm] = useState({ borrower_name: "", due_at: "", note: "" });
  const [batchForm, setBatchForm] = useState<BatchForm | null>(null);
  const [savingBatch, setSavingBatch] = useState(false);
  // 位置树按需加载：不打批次的人不该为一次 /locations 请求买单。
  const [locations, setLocations] = useState<Location[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await get<{ item: ItemDetail }>(`/items/${id}`);
      setItem(res.item);
    } catch {
      toast("物品不存在或无权访问", "error");
      nav("/items");
    } finally {
      setLoading(false);
    }
  }, [id, nav, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // 这一页上的一切都挂在同一个物品下面：物品本身、批次、维护、借还、附件。
  // 家里任何一个人动了其中一样，这里都该跟着变。
  useLiveRefresh(
    () => void load(),
    ["item", "batch", "maintenance", "loan", "attachment"]
  );

  useEffect(() => {
    let alive = true;
    setStick(null);
    setQrSrc("");
    setLabelSrc("");
    void (async () => {
      let link: { url: string; token: string; reachable?: boolean; lan_only?: boolean } | null = null;
      if (getMode() === "remote") {
        try {
          link = await get(`/items/${id}/qr-link`);
        } catch {
          link = null;
        }
      } else {
        link = await qrLinkFor(id);
      }
      if (!link || !alive) return;
      setStick({
        url: link.url,
        token: link.token,
        // "192.168.1.5:8000" — the part a person can compare with what the
        // server's own settings screen shows when a scan does not work.
        host: link.url.replace(/^https?:\/\//, "").replace(/\/api\/v1\/public\/q\/.*$/, ""),
        reachable: link.reachable !== false,
        lanOnly: link.lan_only !== false,
      });
      // Vector, not the server's PNG: a sticker printed at label size has to
      // scan on the first try.
      setQrSrc(await qrDataUrl(link.url));
      if (alive) {
        setLabelSrc(
          await labelDataUrl({
            url: link.url,
            title: item?.name || "",
            code: item?.code || "",
            subtitle: item?.location_path || "",
          })
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, item?.version]);

  const upload = async (files: FileList | null, kind = "photo", setCover = false) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("item_id", id);
        fd.append("kind", kind);
        fd.append("set_cover", String(setCover && file === files[0]));
        await api("/attachments", { form: fd });
      }
      toast(`已上传 ${files.length} 个文件`);
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const createLoan = async () => {
    if (!loanForm.borrower_name.trim()) return;
    try {
      await post("/loans", {
        item_id: id,
        borrower_name: loanForm.borrower_name.trim(),
        due_at: loanForm.due_at ? new Date(loanForm.due_at).toISOString() : undefined,
        note: loanForm.note,
      });
      toast("已登记借出");
      setLoanOpen(false);
      setLoanForm({ borrower_name: "", due_at: "", note: "" });
      await load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const openBatch = async (batch?: ItemBatch) => {
    if (!locations.length) {
      try {
        const res = await get<{ items: Location[] }>("/locations");
        setLocations(res.items);
      } catch {
        // 位置加载失败不该挡住录入：批次本身仍然可存，只是选不了存放位置。
      }
    }
    setBatchForm({
      id: batch?.id,
      batch_no: batch?.batch_no || "",
      quantity: String(batch?.quantity ?? 1),
      unit: batch?.unit || "",
      produced_on: batch?.produced_on || "",
      expires_on: batch?.expires_on || "",
      location_id: batch?.location_id || "",
      supplier: batch?.supplier || "",
      note: batch?.note || "",
    });
  };

  const saveBatch = async () => {
    if (!batchForm) return;
    const qty = Number(batchForm.quantity);
    if (!Number.isFinite(qty) || qty < 0) {
      toast("数量必须是不小于 0 的数字", "error");
      return;
    }
    setSavingBatch(true);
    const payload = {
      batch_no: batchForm.batch_no.trim(),
      quantity: qty,
      unit: batchForm.unit.trim(),
      produced_on: batchForm.produced_on || null,
      expires_on: batchForm.expires_on || null,
      location_id: batchForm.location_id || null,
      supplier: batchForm.supplier.trim(),
      note: batchForm.note,
    };
    try {
      if (batchForm.id) await patch(`/batches/${batchForm.id}`, payload);
      else await post(`/items/${id}/batches`, payload);
      const edited = Boolean(batchForm.id);
      setBatchForm(null);
      await load();
      toast(edited ? "批次已更新" : "批次已添加");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSavingBatch(false);
    }
  };

  const removeBatch = async (batch: ItemBatch) => {
    const ok = await confirm(`批次「${batch.batch_no || "未命名"}」会被删除，已记录的到期日也随之消失。`, {
      title: "删除这个批次",
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await del(`/batches/${batch.id}`);
      await load();
      toast("批次已删除");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  if (loading) {
    return (
      <div className="detail-grid">
        <div className="card">
          <div className="skeleton" style={{ height: 200 }} />
        </div>
        <div className="card">
          <div className="skeleton" style={{ height: 200 }} />
        </div>
      </div>
    );
  }
  if (!item) return null;

  const openLoan = item.loans.find((l) => l.is_open);
  const meta = STATUS_META[item.status] || { label: item.status, cls: "", icon: "box" };

  return (
    <div>
      {confirmDialog}
      <div className="row gap-8 mb-16" style={{ fontSize: 12.5 }}>
        <button className="btn btn-sm btn-ghost" onClick={() => nav("/items")}>
          <Icon name="chevron-left" size={13} />
          物品
        </button>
        <span className="faint">/</span>
        <span className="faint truncate">{item.code}</span>
      </div>

      <div className="detail-hero">
        <div
          className="detail-cover"
          style={{ "--cat": item.category?.color || "var(--brand)" } as CSSProperties}
        >
          {item.cover_url ? (
            <img src={assetUrl(item.cover_url)} alt={item.name} />
          ) : (
            <div
              className="ph"
              style={{ color: item.category?.color || "var(--text-3)", opacity: 0.6 }}
            >
              <Icon name={item.category?.icon || "package"} size={40} />
            </div>
          )}
          <span className="seal stamp detail-stamp" aria-hidden="true">
            {item.status === "lent"
              ? "借出"
              : item.status === "repair"
              ? "维修"
              : item.status === "lost"
              ? "遗失"
              : item.status === "disposed" || item.status === "archived"
              ? "销号"
              : "在册"}
          </span>
        </div>
        <div className="detail-head">
          <div className="row gap-8" style={{ marginBottom: 8 }}>
            <span className={`badge ${meta.cls}`}>
              <span className="dot" />
              {meta.label}
            </span>
            {item.condition !== "good" && (
              <span className="badge outline">成色 {CONDITION_LABEL[item.condition]}</span>
            )}
            {item.warranty_state === "active" && (
              <span className="badge ok">
                <Icon name="shield" size={11} />
                保修中
              </span>
            )}
            {item.warranty_state === "expiring" && (
              <span className="badge warn">
                <Icon name="alert" size={11} />
                保修将到期
              </span>
            )}
            {item.warranty_state === "expired" && <span className="badge">已过保</span>}
          </div>
          <div className="detail-title">{item.name}</div>
          <div className="row gap-8 mt-8" style={{ fontSize: 12.5, color: "var(--text-3)" }}>
            <span className="mono">{item.code}</span>
            {item.brand && (
              <>
                <span className="dot-sep">·</span>
                <span>{item.brand}</span>
              </>
            )}
            {item.model && (
              <>
                <span className="dot-sep">·</span>
                <span>{item.model}</span>
              </>
            )}
          </div>
          {item.tags.length > 0 && (
            <div className="detail-tags">
              {item.tags.map((t) => (
                <span className="tag" key={t}>
                  {t}
                </span>
              ))}
            </div>
          )}
          <div className="detail-actions">
            {can("item.update") && (
              <button className="btn btn-sm" onClick={() => nav(`/items/${item.id}/edit`)}>
                <Icon name="edit" size={13} />
                编辑
              </button>
            )}
            {can("item.loan") && (
              <button
                className="btn btn-sm"
                onClick={() => {
                  if (openLoan) {
                    post(`/loans/${openLoan.id}/return`).then(() => {
                      toast("已登记归还");
                      void load();
                    });
                  } else {
                    setLoanOpen(true);
                  }
                }}
              >
                <Icon name={openLoan ? "corner-down-right" : "arrow-up-right"} size={13} />
                {openLoan ? "登记归还" : "借出"}
              </button>
            )}
            <a
              className="btn btn-sm"
              href={`/api/v1/labels/sheet?item_ids=${item.id}`}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="printer" size={13} />
              打印标签
            </a>
            <div style={{ position: "relative" }}>
              <details>
                <summary
                  className="btn btn-sm btn-icon"
                  style={{ listStyle: "none", cursor: "pointer" }}
                >
                  <Icon name="more-h" size={15} />
                </summary>
                <div
                  className="card"
                  style={{
                    position: "absolute",
                    right: 0,
                    top: "calc(100% + 6px)",
                    width: 168,
                    padding: 5,
                    zIndex: 20,
                    boxShadow: "var(--shadow-lg)",
                  }}
                >
                  <div
                    className="nav-item"
                    style={{ fontSize: 12.5 }}
                    onClick={() => void openExport("label")}
                  >
                    <Icon name="download" size={14} />
                    下载标签图片
                  </div>
                  <div
                    className="nav-item"
                    style={{ fontSize: 12.5 }}
                    onClick={() => void openExport("qr")}
                  >
                    <Icon name="qr" size={14} />
                    下载二维码
                  </div>
                  {can("item.archive") && (
                    <div
                      className="nav-item"
                      style={{ fontSize: 12.5 }}
                      onClick={async () => {
                        await post(`/items/${item.id}/archive`);
                        toast("已归档");
                        void load();
                      }}
                    >
                      <Icon name="archive" size={14} />
                      归档物品
                    </div>
                  )}
                  {can("item.create") && (
                    <div
                      className="nav-item"
                      style={{ fontSize: 12.5 }}
                      onClick={async () => {
                        const res = await post<{ item: { id: string; name: string } }>(
                          `/items/${item.id}/clone`
                        );
                        toast(`已复制为「${res.item.name}」`);
                        nav(`/items/${res.item.id}`);
                      }}
                    >
                      <Icon name="copy" size={14} />
                      复制物品
                    </div>
                  )}
                  {can("item.archive") && item.archived_at && (
                    <div
                      className="nav-item"
                      style={{ fontSize: 12.5 }}
                      onClick={async () => {
                        await post(`/items/${item.id}/restore`);
                        toast("已恢复，物品回到列表");
                        void load();
                      }}
                    >
                      <Icon name="refresh" size={14} />
                      恢复物品
                    </div>
                  )}
                  {can("item.delete") && (
                    <div
                      className="nav-item"
                      style={{ fontSize: 12.5, color: "var(--danger)" }}
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Icon name="trash" size={14} />
                      删除物品
                    </div>
                  )}
                </div>
              </details>
            </div>
          </div>
        </div>
        <aside className="detail-aside" aria-label="物品信息">
          <div className="detail-aside-label">物品信息</div>
          <div className="detail-aside-row">
            <span>分类</span>
            <b>{item.category?.name || "未分类"}</b>
          </div>
          <div className="detail-aside-row">
            <span>位置</span>
            <b>{item.location_path || "未分配"}</b>
          </div>
          <div className="detail-aside-row">
            <span>购入</span>
            <b className="num">{fmtDate(item.purchase_date)}</b>
          </div>
          <div className="detail-aside-row">
            <span>保修</span>
            <b className="num">{fmtDate(item.warranty_until)}</b>
          </div>
        </aside>
      </div>

      <div className="detail-grid mt-16">
        <div className="card">
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { key: "overview", label: "概览" },
              { key: "files", label: "文档", count: item.attachments.length },
              { key: "maint", label: "维护", count: item.maintenance.length },
              { key: "batches", label: "批次", count: item.batches.length },
              { key: "timeline", label: "时间线", count: item.events.length },
              { key: "loans", label: "借还", count: item.loans.length },
            ]}
          />

          {tab === "overview" && (
            <div>
              <div className="info-grid">
                <div className="info-item">
                  <div className="k">分类</div>
                  <div className="v">{item.category?.name || "未分类"}</div>
                </div>
                <div className="info-item">
                  <div className="k">存放位置</div>
                  <div className="v">{item.location_path || "未分配"}</div>
                </div>
                <div className="info-item">
                  <div className="k">品牌</div>
                  <div className="v">{item.brand || "—"}</div>
                </div>
                <div className="info-item">
                  <div className="k">型号</div>
                  <div className="v">{item.model || "—"}</div>
                </div>
                <div className="info-item">
                  <div className="k">序列号</div>
                  <div className="v mono">{item.serial_number || "—"}</div>
                </div>
                <div className="info-item">
                  <div className="k">商品条码</div>
                  <div className="v mono">{item.barcode || "—"}</div>
                </div>
                <div className="info-item">
                  <div className="k">购入日期</div>
                  <div className="v num">{fmtDate(item.purchase_date)}</div>
                </div>
                <div className="info-item">
                  <div className="k">购入价格</div>
                  <div className="v num">{fmtMoney(item.purchase_price, item.currency)}</div>
                </div>
                <div className="info-item">
                  <div className="k">购买渠道</div>
                  <div className="v">{item.purchase_from || "—"}</div>
                </div>
                <div className="info-item">
                  <div className="k">保修截止</div>
                  <div className="v num">{fmtDate(item.warranty_until)}</div>
                </div>
                <div className="info-item">
                  <div className="k">数量</div>
                  <div className="v num">
                    {item.quantity} {item.unit}
                  </div>
                </div>
                <div className="info-item">
                  <div className="k">录入时间</div>
                  <div className="v num">{fmtDate(item.created_at)}</div>
                </div>
              </div>

              {item.description && (
                <>
                  <div className="divider" />
                  <div className="k" style={{ fontSize: 11.5, color: "var(--text-3)", marginBottom: 5 }}>
                    备注
                  </div>
                  <div
                    className="selectable"
                    style={{ fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap" }}
                  >
                    {item.description}
                  </div>
                </>
              )}

              {item.components.length > 0 && (
                <>
                  <div className="divider" />
                  <div className="row-between mb-8">
                    <span className="h4">组件与配件</span>
                    <span className="tiny faint">{item.components.length} 项</span>
                  </div>
                  <div className="col gap-6">
                    {item.components.map((c) => (
                      <div key={c.id} className="row gap-10" style={{ fontSize: 12.5 }}>
                        <Icon name="layers" size={13} style={{ color: "var(--text-3)" }} />
                        <span style={{ fontWeight: 500 }}>{c.name}</span>
                        {c.serial_number && (
                          <span className="mono faint" style={{ fontSize: 10.5 }}>
                            {c.serial_number}
                          </span>
                        )}
                        <span className="badge" style={{ marginLeft: "auto" }}>
                          ×{c.quantity}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {item.events.length > 0 && (
                <>
                  <div className="divider" />
                  <div className="row-between mb-8">
                    <span className="h4">最近动态</span>
                    <span
                      className="tiny faint"
                      style={{ cursor: "pointer" }}
                      onClick={() => setTab("timeline")}
                    >
                      查看全部 {item.events.length} 条
                    </span>
                  </div>
                  <div className="feed">
                    {item.events.slice(0, 4).map((e) => (
                      <div className="feed-row" key={e.id}>
                        <div className="feed-ic">
                          <Icon name={EVENT_ICON[e.event_type] || "edit"} size={13} />
                        </div>
                        <div className="feed-body">
                          <div className="feed-text">{e.summary}</div>
                          <div className="feed-time">
                            {e.actor_name} · {relativeTime(e.created_at)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {tab === "files" && (
            <div>
              <div className="row-between mb-12">
                <span className="small muted">
                  发票、保修卡、说明书、维修记录都可以放在这里
                </span>
                {can("doc.upload") && (
                  <button
                    className="btn btn-sm"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                  >
                    {uploading ? <Spinner size={13} /> : <Icon name="upload" size={13} />}
                    上传
                  </button>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(e) => void upload(e.target.files, "other")}
              />
              <div className="att-grid">
                {item.attachments.map((a) => (
                  <div
                    className="att-tile"
                    key={a.id}
                    onClick={() => void openAttachment(a)}
                  >
                    {a.is_image ? (
                      <img src={assetUrl(a.thumbnail_url || a.url)} alt={a.original_name} />
                    ) : (
                      <div className="file-ic">
                        <Icon name="file-text" size={24} />
                      </div>
                    )}
                    <div className="name">{a.original_name}</div>
                  </div>
                ))}
                {can("doc.upload") && (
                  <div className="upload-tile" onClick={() => fileRef.current?.click()}>
                    {uploading ? <Spinner size={18} /> : <Icon name="plus" size={18} />}
                    <span>添加文件</span>
                  </div>
                )}
              </div>
              {item.attachments.length === 0 && !can("doc.upload") && (
                <Empty icon="file" title="没有附件" desc="当前账号没有上传权限" />
              )}
            </div>
          )}

          {tab === "maint" && (
            <div>
              <div className="row-between mb-12">
                <span className="small muted">保养、检查与耗材更换计划</span>
                {can("maintenance.create") && (
                  <button className="btn btn-sm" onClick={() => nav(`/maintenance?item=${item.id}`)}>
                    <Icon name="plus" size={13} />
                    新建任务
                  </button>
                )}
              </div>
              {item.maintenance.length === 0 ? (
                <Empty
                  icon="wrench"
                  title="还没有维护计划"
                  desc="为需要定期保养的物品建立提醒，到期会自动通知家庭成员"
                />
              ) : (
                <div className="col">
                  {item.maintenance.map((t) => {
                    const days = t.next_due_at
                      ? Math.ceil((new Date(t.next_due_at).getTime() - Date.now()) / 86400000)
                      : null;
                    const due = dueLabel(days);
                    return (
                      <div className="maint-row" key={t.id} style={{ padding: "11px 0" }}>
                        <div className="maint-main">
                          <div className="maint-title">
                            {t.title}
                            {t.status === "done" && <span className="badge">已完成</span>}
                          </div>
                          <div className="maint-sub">
                            <span>{TASK_TYPE_LABEL[t.task_type] || t.task_type}</span>
                            {t.interval_days && (
                              <>
                                <span className="dot-sep">·</span>
                                <span>每 {t.interval_days} 天</span>
                              </>
                            )}
                            {t.next_due_at && (
                              <>
                                <span className="dot-sep">·</span>
                                <span>{fmtDate(t.next_due_at)}</span>
                              </>
                            )}
                          </div>
                        </div>
                        <div className={`maint-due ${due.cls}`}>{due.text}</div>
                        {can("maintenance.complete") && t.status === "pending" && (
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={async () => {
                              await post(`/maintenance/${t.id}/complete`, {});
                              toast("已完成，下次到期日已顺延");
                              void load();
                            }}
                          >
                            <Icon name="check" size={13} />
                            完成
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === "batches" && (
            <div>
              <div className="row-between mb-12">
                <span className="small muted">
                  同一物品分几次买、分开存放，就记几个批次；到期日按批次各算各的
                </span>
                {can("item.update") && (
                  <button className="btn btn-sm btn-primary" onClick={() => void openBatch()}>
                    <Icon name="plus" size={13} />
                    添加批次
                  </button>
                )}
              </div>

              {item.batches.length === 0 ? (
                <Empty
                  icon="tag"
                  title="还没有批次"
                  desc="食品、药品、耗材记上到期日，临期时首页会提醒"
                />
              ) : (
                <>
                  <div className="col gap-8">
                    {item.batches.map((b) => {
                      const unit = b.unit || item.unit;
                      return (
                        <div className="batch-row" key={b.id}>
                          <div className="batch-main">
                            <div className="batch-title">
                              <span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>
                                {b.batch_no || "未命名批次"}
                              </span>
                              <ExpiryBadge batch={b} />
                            </div>
                            <div className="batch-meta">
                              {[
                                `${b.quantity} ${unit}`,
                                b.expires_on
                                  ? `到期 ${fmtDate(b.expires_on)}${
                                      b.days_left !== null && b.days_left >= 0
                                        ? `（还剩 ${b.days_left} 天）`
                                        : ""
                                    }`
                                  : "无到期日",
                                b.produced_on ? `生产 ${fmtDate(b.produced_on)}` : null,
                                b.location_path,
                                b.supplier || null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                            {b.note && <div className="batch-note">{b.note}</div>}
                          </div>
                          {can("item.update") && (
                            <div className="row gap-4">
                              <button
                                className="icon-btn"
                                title="编辑批次"
                                onClick={() => void openBatch(b)}
                              >
                                <Icon name="edit" size={14} />
                              </button>
                              <button
                                className="icon-btn"
                                title="删除批次"
                                onClick={() => void removeBatch(b)}
                              >
                                <Icon name="trash" size={14} />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* 批次合计与物品登记数量不一致时只提示，不改任何一边：
                      物品数量是用户自己填的账面值，批次是流水，替用户决定哪个对
                      才是更糟的选择。 */}
                  {(() => {
                    const total = item.batches.reduce((s, b) => s + (b.quantity || 0), 0);
                    if (Math.abs(total - item.quantity) < 1e-6) return null;
                    return (
                      <div className="batch-hint">
                        <Icon name="info" size={13} />
                        <span>
                          批次合计 {total} {item.unit}，物品登记数量 {item.quantity}{" "}
                          {item.unit}。两者独立保存，不会互相覆盖。
                        </span>
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          )}

          {tab === "timeline" && (
            <div>
              {item.events.length === 0 ? (
                <Empty icon="history" title="还没有记录" desc="对物品的每次修改都会留在这里" />
              ) : (
                <div className="timeline">
                  {item.events.map((e) => (
                    <div className="tl-item" key={e.id}>
                      <div
                        className={`tl-dot ${
                          e.event_type === "created"
                            ? "brand"
                            : e.event_type === "maintenance_done"
                            ? "brand"
                            : e.event_type === "status_change"
                            ? "warn"
                            : ""
                        }`}
                      >
                        <Icon name={EVENT_ICON[e.event_type] || "edit"} size={8} />
                      </div>
                      <div className="tl-title">{e.summary}</div>
                      <div className="tl-meta">
                        <span>{e.actor_name}</span>
                        <span className="dot-sep">·</span>
                        <span>{relativeTime(e.created_at)}</span>
                        <span className="dot-sep">·</span>
                        <span>{fmtDateTime(e.created_at)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "loans" && (
            <div>
              {item.loans.length === 0 ? (
                <Empty
                  icon="arrow-up-right"
                  title="没有借出记录"
                  desc="借给邻居或朋友时登记一下，到期会自动提醒"
                  action={
                    can("item.loan") ? (
                      <button className="btn btn-sm" onClick={() => setLoanOpen(true)}>
                        登记借出
                      </button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="col">
                  {item.loans.map((l) => (
                    <div className="maint-row" key={l.id} style={{ padding: "11px 0" }}>
                      <div className="maint-main">
                        <div className="maint-title">
                          {l.borrower_name}
                          {l.is_open ? (
                            <span className="badge info">未归还</span>
                          ) : (
                            <span className="badge">已归还</span>
                          )}
                          {l.overdue && <span className="badge danger">逾期</span>}
                        </div>
                        <div className="maint-sub">
                          借出 {fmtDate(l.lent_at)}
                          {l.due_at && ` · 约定归还 ${fmtDate(l.due_at)}`}
                          {l.returned_at && ` · 归还于 ${fmtDate(l.returned_at)}`}
                        </div>
                      </div>
                      {l.is_open && can("item.loan") && (
                        <button
                          className="btn btn-sm"
                          onClick={async () => {
                            await post(`/loans/${l.id}/return`);
                            toast("已登记归还");
                            void load();
                          }}
                        >
                          归还
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="col gap-16">
          <div className="card">
            <div className="card-head">
              <div className="card-title">
                <Icon name="qr" size={15} />
                物品二维码
              </div>
              {stick && (
                <button
                  className="btn btn-sm btn-ghost"
                  title="作废后，已经贴出去的标签会全部失效"
                  onClick={async () => {
                    const ok = await confirm(
                      "已经贴在东西上的码会全部失效，需要重新打印。",
                      { title: "作废这个二维码", confirmText: "作废" }
                    );
                    if (!ok) return;
                    try {
                      // qr_links 只在服务器上：本机/同步模式经 api() 的
                      // DIRECT_REMOTE 白名单直达服务器裁决，localApi 没有这条路径。
                      await del(`/items/${item.id}/qr-link`);
                      toast("已作废，重新打开本页会生成新的码");
                      setStick(null);
                      setQrSrc("");
                    } catch (err) {
                      toast((err as Error).message, "error");
                    }
                  }}
                >
                  作废
                </button>
              )}
            </div>
            <div style={{ textAlign: "center" }}>
              {stick && qrSrc ? (
                <>
                  <img
                    src={qrSrc}
                    alt="二维码"
                    style={{
                      width: 148,
                      height: 148,
                      margin: "0 auto",
                      borderRadius: "var(--radius-xs)",
                      border: "1px solid var(--border)",
                      padding: 6,
                      background: "#fff",
                    }}
                  />
                  <div className="mono" style={{ fontSize: 12, marginTop: 10, color: "var(--text-2)" }}>
                    {item.code}
                  </div>
                  <div className="tiny faint mt-4" style={{ wordBreak: "break-all", lineHeight: 1.65 }}>
                    {stick.host}
                    <br />
                    手机相机直接扫，不用装 App
                  </div>
                  {!stick.reachable && (
                    <div
                      className="tiny mt-8"
                      style={{
                        color: "var(--danger)",
                        background: "var(--danger-soft)",
                        borderRadius: "var(--radius-xs)",
                        padding: "7px 9px",
                        lineHeight: 1.55,
                        textAlign: "left",
                      }}
                    >
                      服务器现在只听本机，手机扫了打不开。去「设置 → 同步」打开
                      「允许家庭内设备连接」，再回来重新打印这张码。
                    </div>
                  )}
                </>
              ) : (
                <>
                  <img
                    src={assetUrl(item.qr_url)}
                    alt="二维码"
                    style={{
                      width: 148,
                      height: 148,
                      margin: "0 auto",
                      borderRadius: "var(--radius-xs)",
                      border: "1px solid var(--border)",
                      padding: 6,
                      background: "#fff",
                    }}
                  />
                  <div className="mono" style={{ fontSize: 12, marginTop: 10, color: "var(--text-2)" }}>
                    {item.code}
                  </div>
                  <div className="tiny faint mt-4" style={{ lineHeight: 1.65 }}>
                    这台设备还没连服务器。
                    <br />
                    连上之后，这张码才能被任何手机扫开。
                  </div>
                </>
              )}
              <div className="row gap-6 mt-12" style={{ justifyContent: "center", flexWrap: "wrap" }}>
                <a
                  className="btn btn-sm"
                  href={labelSrc || assetUrl(item.label_url)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Icon name="download" size={13} />
                  标签图
                </a>
                {/* 没连服务器时没有可打开的分享链接，就复制编号本身——
                    它是群里唯一还有意义的东西。按钮自己在原地变成「已复制」，
                    不用再让用户去看屏幕底部的 toast。 */}
                <CopyButton
                  value={stick ? stick.url : item.code}
                  label={stick ? "复制链接" : "复制编号"}
                  title={stick ? "复制分享链接，可以发到家庭群里" : "未连服务器，只能复制物品编号"}
                />
              </div>
            </div>
        
            </div>

          <div className="card">
            <div className="card-title mb-12">
              <Icon name="user" size={15} />
              归属
            </div>
            <div className="col gap-12">
              <div className="kv">
                <span className="k">所有人</span>
                <span className="v">{item.owner?.display_name || "未指定"}</span>
              </div>
              <div className="kv">
                <span className="k">保管人</span>
                <span className="v">
                  {item.custodian
                    ? item.custodian.display_name +
                      (item.custodian.id === user?.id ? "（我）" : "")
                    : "同所有人"}
                </span>
              </div>
              <div className="kv">
                <span className="k">已归档</span>
                <span className="v">{item.archived_at ? fmtDate(item.archived_at) : "否"}</span>
              </div>
            </div>
          </div>

          {Object.entries(item.custom_fields || {}).length > 0 && (
            <div className="card">
              <div className="card-title mb-12">
                <Icon name="list" size={15} />
                自定义字段
              </div>
              <div className="col gap-12">
                {Object.entries(item.custom_fields).map(([k, v]) => (
                  <div className="kv" key={k}>
                    <span className="k">{k}</span>
                    <span className="v">{String(v ?? "")}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {item.attachments.length > 0 && (
            <div className="card">
              <div className="row-between mb-10">
                <div className="card-title">
                  <Icon name="image" size={15} />
                  最近文件
                </div>
                <span className="tiny faint" onClick={() => setTab("files")} style={{ cursor: "pointer" }}>
                  全部
                </span>
              </div>
              <div className="att-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
                {item.attachments.slice(0, 3).map((a) => (
                  <div
                    className="att-tile"
                    key={a.id}
                    onClick={() => void openAttachment(a)}
                  >
                    {a.is_image ? (
                      <img src={assetUrl(a.thumbnail_url || a.url)} alt="" />
                    ) : (
                      <div className="file-ic">
                        <Icon name="file-text" size={20} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="删除这件物品？"
        message={
          <>
            将删除「{item.name}」及其维护计划。此操作会记入审计日志，但物品本身会从列表中消失。
            <br />
            <br />
            如果只是想收起来，建议使用「归档」。
          </>
        }
        confirmText="删除"
        danger
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await del(`/items/${item.id}`);
          toast("已删除");
          nav("/items");
        }}
      />

      <Modal
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        title={preview?.name}
        size="wide"
      >
        {preview && (
          <img
            src={preview.url}
            alt={preview.name}
            style={{ width: "100%", borderRadius: "var(--radius-sm)" }}
          />
        )}
      </Modal>

      <Modal
        open={loanOpen}
        onClose={() => setLoanOpen(false)}
        title="登记借出"
        subtitle={`${item.name} · ${item.code}`}
        footer={
          <>
            <button className="btn" onClick={() => setLoanOpen(false)}>
              取消
            </button>
            <button className="btn btn-primary" onClick={createLoan}>
              确认借出
            </button>
          </>
        }
      >
        <div className="col gap-14" style={{ gap: 14 }}>
          <div className="field">
            <label className="label">
              借给谁 <span className="req">*</span>
            </label>
            <input
              className="input"
              value={loanForm.borrower_name}
              onChange={(e) => setLoanForm({ ...loanForm, borrower_name: e.target.value })}
              placeholder="姓名或称呼"
              autoFocus
            />
          </div>
          <div className="field">
            <label className="label">约定归还日期</label>
            <input
              className="input"
              type="date"
              value={loanForm.due_at}
              onChange={(e) => setLoanForm({ ...loanForm, due_at: e.target.value })}
            />
            <div className="hint">逾期会在提醒中心通知全家</div>
          </div>
          <div className="field">
            <label className="label">备注</label>
            <textarea
              className="textarea"
              value={loanForm.note}
              onChange={(e) => setLoanForm({ ...loanForm, note: e.target.value })}
              placeholder="例如：露营用，含电池两块"
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={batchForm !== null}
        onClose={() => setBatchForm(null)}
        title={batchForm?.id ? "编辑批次" : "添加批次"}
        subtitle={`${item.name} · ${item.code}`}
        footer={
          <>
            <button className="btn" onClick={() => setBatchForm(null)}>
              取消
            </button>
            <button
              className="btn btn-primary"
              onClick={() => void saveBatch()}
              disabled={savingBatch}
            >
              <ButtonLabel
                busy={savingBatch}
                idle={batchForm?.id ? "保存" : "添加"}
                busyLabel="保存中…"
              />
            </button>
          </>
        }
      >
        {batchForm && (
          <div className="col gap-14" style={{ gap: 14 }}>
            <div className="field">
              <label className="label">批次号</label>
              <input
                className="input"
                value={batchForm.batch_no}
                onChange={(e) => setBatchForm({ ...batchForm, batch_no: e.target.value })}
                placeholder="包装上的批号，或自己起个名字"
                autoFocus
              />
            </div>
            <div className="row gap-10">
              <div className="field grow">
                <label className="label">数量</label>
                <input
                  className="input"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  value={batchForm.quantity}
                  onChange={(e) => setBatchForm({ ...batchForm, quantity: e.target.value })}
                />
              </div>
              <div className="field grow">
                <label className="label">单位</label>
                <input
                  className="input"
                  value={batchForm.unit}
                  onChange={(e) => setBatchForm({ ...batchForm, unit: e.target.value })}
                  placeholder={item.unit}
                />
              </div>
            </div>
            <div className="row gap-10">
              <div className="field grow">
                <label className="label">生产日期</label>
                <input
                  className="input"
                  type="date"
                  value={batchForm.produced_on}
                  onChange={(e) => setBatchForm({ ...batchForm, produced_on: e.target.value })}
                />
              </div>
              <div className="field grow">
                <label className="label">到期日期</label>
                <input
                  className="input"
                  type="date"
                  value={batchForm.expires_on}
                  onChange={(e) => setBatchForm({ ...batchForm, expires_on: e.target.value })}
                />
              </div>
            </div>
            <div className="hint" style={{ marginTop: -6 }}>
              到期前 30 天会在首页和提醒中心出现，过期后标红
            </div>
            <div className="field">
              <label className="label">存放位置</label>
              <Select
                value={batchForm.location_id}
                onChange={(v) => setBatchForm({ ...batchForm, location_id: v })}
                ariaLabel={`存放位置：${
                  locations.find((l) => l.id === batchForm.location_id)?.name || "未指定"
                }`}
                placeholder="与物品相同（未指定）"
                options={[
                  { value: "", label: "与物品相同（未指定）" },
                  ...locations.map((l) => ({ value: l.id, label: l.path || l.name })),
                ]}
              />
              <div className="hint">同一物品分开存放时，按批次各记各的位置</div>
            </div>
            <div className="field">
              <label className="label">来源</label>
              <input
                className="input"
                value={batchForm.supplier}
                onChange={(e) => setBatchForm({ ...batchForm, supplier: e.target.value })}
                placeholder="超市、药店、网店…"
              />
            </div>
            <div className="field">
              <label className="label">备注</label>
              <textarea
                className="textarea"
                value={batchForm.note}
                onChange={(e) => setBatchForm({ ...batchForm, note: e.target.value })}
                placeholder="开封后冷藏、已拆一包…"
              />
            </div>
          </div>
        )}
      </Modal>

      <ExportPreview target={exportTarget} onClose={() => setExportTarget(null)} />
    </div>
  );
}
