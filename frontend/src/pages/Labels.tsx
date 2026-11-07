import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { get, getMode } from "../api/client";
import type { Category, Item, Location, Page } from "../api/types";
import { Icon } from "../components/icons";
import { Empty, Modal, Select, Skeleton, useToast } from "../components/ui";
import { fmtDate } from "../lib/format";
import { localSheetUrl } from "../lib/localsheet";
import { canShareImage, printHtml } from "../lib/native-share";
import {
  PrinterId,
  autoPrint,
  preferredPrinter,
  printers,
  printSheet,
  setAutoPrint,
  setPreferredPrinter,
  sheetUrl,
} from "../lib/print";
import { useAuth } from "../hooks/auth";

/**
 * 打印标签。
 *
 * 原来只有首页一个磁贴直接 `window.open('/api/v1/labels/sheet')`：全量导出，
 * 不能挑，也不能选打印机。这一页把那条路补全——先挑物品，再决定打不打。
 */
export function LabelsPage() {
  const nav = useNavigate();
  const toast = useToast();
  const { family } = useAuth();

  const [items, setItems] = useState<Item[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  const [q, setQ] = useState("");
  const [locationId, setLocationId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const [preview, setPreview] = useState<string | null>(null);
  const previewBlob = useRef<string | null>(null);
  const [printer, setPrinter] = useState<PrinterId>(preferredPrinter().id);
  const [skipAsk, setSkipAsk] = useState(autoPrint());

  /** blob: 标签纸用完要回收，否则每生成一次就漏一份文档。 */
  const setSheetPreview = (url: string | null) => {
    if (previewBlob.current && previewBlob.current !== url) {
      URL.revokeObjectURL(previewBlob.current);
    }
    previewBlob.current = url && url.startsWith("blob:") ? url : null;
    setPreview(url);
  };

  const load = useCallback(async () => {
    try {
      const [page, locs, cats] = await Promise.all([
        get<Page<Item>>("/items?page_size=200&sort=code"),
        get<{ items: Location[] }>("/locations"),
        get<{ items: Category[] }>("/categories"),
      ]);
      setItems(page.items);
      setLocations(locs.items);
      setCategories(cats.items);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((it) => {
      if (locationId && it.location_id !== locationId) return false;
      if (categoryId && it.category_id !== categoryId) return false;
      if (!needle) return true;
      return (
        it.name.toLowerCase().includes(needle) ||
        (it.code || "").toLowerCase().includes(needle)
      );
    });
  }, [items, q, locationId, categoryId]);

  const allPicked = filtered.length > 0 && filtered.every((it) => picked.has(it.id));

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (allPicked) for (const it of filtered) next.delete(it.id);
      else for (const it of filtered) next.add(it.id);
      return next;
    });
  };

  /** 生成 → 要么直接打，要么先把预览摆出来让人确认。 */
  const generate = async () => {
    if (!picked.size) {
      toast("先选几件物品", "error");
      return;
    }
    // 远程模式：标签页由服务器渲染（浏览器直接加载 HTML，带不了 Authorization
    // 头，token 走查询串）。本机/同步模式：没有任何东西能服务那个 URL，
    // 在页面里用同一套排版生成 blob 文档（lib/localsheet）。
    const url =
      getMode() === "remote"
        ? sheetUrl({ itemIds: [...picked], limit: Math.max(picked.size, 1) })
        : await localSheetUrl({
            items: items.filter((it) => picked.has(it.id)),
            locationName: locName,
            familyName: family?.name,
          });
    const chosen = printers().find((p) => p.id === printer) || preferredPrinter();
    setPreferredPrinter(chosen.id);
    setAutoPrint(skipAsk);

    if (skipAsk) {
      try {
        if (canShareImage()) {
          await mobilePrint(url);
        } else {
          await printSheet(url, chosen);
        }
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      } catch (err) {
        toast((err as Error).message, "error");
      }
      return;
    }
    setSheetPreview(url);
  };

  /**
   * 手机壳的打印出口：Android WebView 不接 window.print()，三种打印方式
   * 在那边全是 no-op。唯一的路是把预览文档整个交给壳，由 PrintManager 弹
   * 系统打印对话框（对话框里也能选「另存为 PDF」）。远程模式的预览是
   * 服务器 URL（authedUrl 已把 token 放进查询串），fetch 正文没有鉴权问题。
   */
  const mobilePrint = async (docUrl: string) => {
    const res = await fetch(docUrl);
    const html = await res.text();
    await printHtml(`HomeLedger 标签页 · ${picked.size} 件`, html);
  };

  const doPrint = async () => {
    if (!preview) return;
    try {
      if (canShareImage()) {
        await mobilePrint(preview);
      } else {
        const chosen = printers().find((p) => p.id === printer) || preferredPrinter();
        await printSheet(preview, chosen);
      }
      setSheetPreview(null);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const locName = (id: string | null) =>
    (id && locations.find((l) => l.id === id)?.name) || "";

  if (loading) {
    return (
      <div className="col gap-12">
        <Skeleton h={28} w={180} />
        <Skeleton h={220} />
      </div>
    );
  }

  return (
    <div className="labels-page">
      <div className="page-head">
        <div>
          <h1 className="h1">打印标签</h1>
          <div className="sub">
            挑出要贴的物品，生成 A4 标签页；生成后可以选择直接打印，或者先存成 PDF
          </div>
        </div>
        <button className="btn" onClick={() => nav("/items")}>
          <Icon name="package" size={15} />
          去物品列表
        </button>
      </div>

      <div className="card label-toolbar">
        <div className="input-group grow" style={{ minWidth: 180 }}>
          <Icon name="search" size={15} />
          <input
            className="input"
            placeholder="按名称或编号筛选"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Select
          value={locationId}
          onChange={setLocationId}
          placeholder="全部位置"
          style={{ width: 148 }}
          options={[
            { value: "", label: "全部位置" },
            ...locations.map((l) => ({ value: l.id, label: l.name })),
          ]}
        />
        <Select
          value={categoryId}
          onChange={setCategoryId}
          placeholder="全部分类"
          style={{ width: 148 }}
          options={[
            { value: "", label: "全部分类" },
            ...categories.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <button className="btn" onClick={toggleAll} disabled={!filtered.length}>
          <Icon name={allPicked ? "x" : "check"} size={14} />
          {allPicked ? "取消全选" : "全选"}
        </button>
      </div>

      {filtered.length === 0 ? (
        <Empty
          title="没有可打印的物品"
          desc={items.length ? "换个筛选条件试试" : "还没有登记任何物品"}
        />
      ) : (
        <div className="card label-list">
          {filtered.map((it) => (
            <label key={it.id} className={`label-row ${picked.has(it.id) ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={picked.has(it.id)}
                onChange={() => toggle(it.id)}
              />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="label-row-name truncate">{it.name}</div>
                <div className="label-row-meta">
                  <span className="mono">{it.code}</span>
                  {locName(it.location_id) && <span>· {locName(it.location_id)}</span>}
                  {it.warranty_until && <span>· 保修至 {fmtDate(it.warranty_until)}</span>}
                </div>
              </div>
            </label>
          ))}
        </div>
      )}

      <div className="labels-bar">
        <div className="grow">
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {picked.size ? `已选 ${picked.size} 件` : "还没选物品"}
          </div>
          <div className="tiny faint">
            {items.length >= 200
              ? "只加载了最近 200 件，更多的请去物品列表筛选"
              : `共 ${items.length} 件在库物品`}
          </div>
        </div>
        {picked.size > 0 && (
          <button className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>
            清空
          </button>
        )}
        <button className="btn btn-primary" onClick={() => void generate()} disabled={!picked.size}>
          <Icon name="printer" size={15} />
          生成标签
        </button>
      </div>

      <Modal
        open={preview !== null}
        onClose={() => setSheetPreview(null)}
        title="标签页已生成"
        subtitle="确认没问题就打出来，或者先存成 PDF"
        size="wide"
        footer={
          <>
            <label className="row gap-8 tiny muted" style={{ marginRight: "auto" }}>
              <input
                type="checkbox"
                checked={skipAsk}
                onChange={(e) => {
                  setSkipAsk(e.target.checked);
                  setAutoPrint(e.target.checked);
                }}
              />
              以后直接打印，不再问
            </label>
            <button className="btn" onClick={() => setSheetPreview(null)}>
              关闭
            </button>
            <button className="btn btn-primary" onClick={() => void doPrint()}>
              <Icon name="printer" size={15} />
              打印
            </button>
          </>
        }
      >
        <div className="col gap-12">
          <div className="field">
            <label className="label">打印方式</label>
            {canShareImage() ? (
              <div className="tiny" style={{ padding: "4px 0" }}>
                手机上直接弹<strong>系统打印</strong>（打印机、份数、另存为 PDF
                都在系统对话框里选）。
              </div>
            ) : (
              <>
                <Select
                  value={printer}
                  onChange={(v) => {
                    setPrinter(v as PrinterId);
                    setPreferredPrinter(v as PrinterId);
                  }}
                  options={printers().map((p) => ({ value: p.id, label: p.label }))}
                />
                <div className="tiny faint" style={{ marginTop: 6 }}>
                  {printers().find((p) => p.id === printer)?.hint}
                </div>
              </>
            )}
          </div>
          {preview && (
            <iframe
              title="标签预览"
              src={preview}
              className="label-preview"
              sandbox="allow-same-origin allow-modals allow-popups"
            />
          )}
        </div>
      </Modal>
    </div>
  );
}
