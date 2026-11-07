import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, get } from "../api/client";
import type { Item } from "../api/types";
import { Icon } from "../components/icons";
import { Empty, Spinner, useToast } from "../components/ui";
import { STATUS_META } from "../lib/format";
import { prefersManualLookup } from "../lib/platform";
import { canScan, createFrameScanner, hasNativeDetector } from "../lib/scan";

interface LookupResult {
  found: boolean;
  query: string;
  matched_by?: string;
  ambiguous?: boolean;
  message?: string;
  hint?: string | null;
  archived?: boolean;
  item?: { id: string; name: string; code: string; archived?: boolean };
  candidates?: {
    id: string;
    name: string;
    code: string;
    match: string;
    status: string;
    location_id: string | null;
  }[];
}

const MATCH_LABEL: Record<string, string> = {
  asset_code: "物品编号",
  barcode: "商品条码",
  serial: "序列号",
  name: "名称匹配",
};

/**
 * 等第一帧真的解码出来。
 *
 * `video.play()` 的 promise resolve 只说明播放开始了，不代表已经有像素：
 * Android WebView 上常见几帧之内 `videoWidth` 还是 0。如果这时把画布交给
 * jsQR，它每帧都在读一张空图，界面看着"相机开着"，实际什么都扫不到。
 */
async function waitForFirstFrame(video: HTMLVideoElement, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
}

export function ScanPage() {
  // 桌面端没有"拿手机对着货架扫"这个场景，只有输入查询。相机相关的一切
  // 在桌面壳里都不渲染——不是隐藏，是不挂载，否则 getUserMedia 仍会被调用。
  const manualOnly = prefersManualLookup();
  const nav = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);

  const [camOn, setCamOn] = useState(false);
  const [camBusy, setCamBusy] = useState(false);
  const [camError, setCamError] = useState("");
  const [manual, setManual] = useState(params.get("code") || "");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocr, setOcr] = useState<{
    fields: Record<string, string | number>;
    confidence: number;
    message: string;
    provider: string;
    provider_info?: { leaves_device: boolean; privacy_notice: string };
  } | null>(null);
  const ocrRef = useRef<HTMLInputElement>(null);

  const stopCam = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamOn(false);
  }, []);

  useEffect(() => {
    setSupported(canScan());
    return () => stopCam();
  }, [stopCam]);

  const lookup = useCallback(
    async (code: string) => {
      const value = code.trim();
      if (!value) return;
      setBusy(true);
      try {
        const res = await get<LookupResult>(`/scan/lookup?code=${encodeURIComponent(value)}`);
        setResult(res);
        if (res.found && res.item && !res.ambiguous) {
          stopCam();
          // An archived item still resolves on purpose: telling the user
          // "not found" would push them to create a duplicate.
          toast(
            res.archived ? `已找到（已归档）：${res.item.name}` : `已找到：${res.item.name}`,
            res.archived ? "info" : "success"
          );
        }
      } catch (err) {
        toast((err as Error).message, "error");
      } finally {
        setBusy(false);
      }
    },
    [stopCam, toast]
  );

  useEffect(() => {
    const code = params.get("code");
    if (code) {
      setManual(code);
      void lookup(code);
    }
  }, [params, lookup]);

  const startCam = async () => {
    if (camBusy) return;
    setCamError("");
    setCamBusy(true);
    try {
      const md = navigator.mediaDevices;
      if (!md?.getUserMedia) {
        // 非安全上下文（http://192.168.x.x 这种）里 getUserMedia 直接不存在，
        // 说"没有摄像头"会把人带到完全错误的方向。
        throw Object.assign(new Error("insecure"), { name: "NotSupportedError" });
      }

      let stream: MediaStream;
      try {
        stream = await md.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (err) {
        // 有些设备不愿意同时给 720p 和后置摄像头，降级成"随便给我一路视频"。
        if ((err as Error).name !== "OverconstrainedError") throw err;
        stream = await md.getUserMedia({ video: true, audio: false });
      }

      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error("video-missing");
      }
      streamRef.current = stream;
      // 顺序是关键：先拿到 <video> 节点再绑流。之前 <video> 只在 camOn 为真时
      // 才渲染，绑流那一刻 ref 还是 null，于是相机开着、预览永远黑屏。
      video.srcObject = stream;
      video.muted = true;
      video.setAttribute("playsinline", "true");
      video.setAttribute("webkit-playsinline", "true");
      try {
        await video.play();
      } catch {
        /* 静音视频正常不会被拦；真被拦了，下面的首帧检测会把它变成一句人话 */
      }
      setCamOn(true);

      // play() 返回不代表有画面：Android WebView 会先报 readyState=0、
      // videoWidth=0 好几帧。这时候开始扫，jsQR 拿到的是空画布，
      // 表现就是"相机开着但什么也扫不出来"。
      if (!(await waitForFirstFrame(video))) {
        if (streamRef.current) {
          setCamError(
            "相机已经授权，但一直没有画面。把应用切到后台再切回来，或者换一个摄像头再试。"
          );
        }
        return;
      }
      if (!streamRef.current) return;

      const scanner = await createFrameScanner();
      if (!scanner) {
        setCamError("这个环境读不了二维码，请手动输入编号。");
        return;
      }

      let lastValue = "";
      let lastAt = 0;
      // jsQR is much slower than the native detector. Throttle it to ~8 fps so
      // the preview stays smooth and the phone does not heat up on a shelf.
      let nextAt = 0;
      const tick = async () => {
        if (!videoRef.current || !streamRef.current) return;
        const now = performance.now();
        if (now >= nextAt) {
          nextAt = now + (hasNativeDetector() ? 0 : 120);
          try {
            const raw = await scanner(videoRef.current);
            if (raw && raw !== lastValue) {
              lastValue = raw;
              lastAt = Date.now();
              if (navigator.vibrate) navigator.vibrate(40);
              setManual(raw);
              stopCam();
              void lookup(raw);
              return;
            }
            if (raw === lastValue && Date.now() - lastAt < 2000) {
              /* debounce repeats */
            }
          } catch {
            /* transient detect errors are fine */
          }
        }
        rafRef.current = requestAnimationFrame(() => void tick());
      };
      void tick();
    } catch (err) {
      const name = (err as Error).name;
      setCamError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "相机权限被拒绝。到系统设置 → 应用 → HomeLedger → 权限里打开相机，再回来试一次。也可以手动输入编号。"
          : name === "NotFoundError"
            ? "这台设备没有可用的摄像头，手动输入编号吧。"
            : name === "NotReadableError" || name === "AbortError"
              ? "相机被别的应用占用了。关掉那个应用（视频通话、相机、扫一扫），再点一次。"
              : name === "NotSupportedError"
                ? "这个页面拿不到相机：浏览器只允许 https 或本机地址调用摄像头。局域网 IP 请改用 HTTPS 访问。"
                : "无法启动相机，请检查设备是否有摄像头。"
      );
      stopCam();
    } finally {
      setCamBusy(false);
    }
  };

  useEffect(() => () => stopCam(), [stopCam]);

  const runOcr = async (file: File) => {
    setOcrBusy(true);
    setOcr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", "receipt");
      const up = await api<{ attachment: { id: string } }>("/attachments", { form: fd });
      const res = await api<{
        fields: Record<string, string | number>;
        confidence: number;
        message: string;
        provider: string;
        provider_info?: { leaves_device: boolean; privacy_notice: string };
      }>("/scan/ocr", { method: "POST", body: { attachment_id: up.attachment.id } });
      setOcr(res);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setOcrBusy(false);
      if (ocrRef.current) ocrRef.current.value = "";
    }
  };

  const ocrToNew = () => {
    const f = ocr?.fields || {};
    const params = new URLSearchParams();
    if (f.name) params.set("name", String(f.name));
    if (f.barcode) params.set("barcode", String(f.barcode));
    if (f.brand) params.set("brand", String(f.brand));
    if (f.model) params.set("model", String(f.model));
    if (f.purchase_price) params.set("price", String(f.purchase_price));
    nav(`/items/new?${params.toString()}`);
  };

  return (
    <div className="scan-page">
      <div className="page-head">
        <div>
          <h1 className="h1">{manualOnly ? "查询" : "扫码"}</h1>
          <div className="sub">
            {manualOnly
              ? "输入物品编号、商品条码、序列号或名称，回车即查"
              : "扫描物品标签上的二维码，或直接输入编号 / 条码"}
          </div>
        </div>
      </div>

      {!manualOnly && (
      <>
      <div className={`scan-viewport ${camOn ? "is-live" : ""}`}>
        {/* <video> 必须常驻。之前只在 camOn 为真时才渲染，点"打开相机"的那一刻
            ref 还是 null，流绑不上去，预览就永远是一块黑。 */}
        <video ref={videoRef} muted playsInline autoPlay />
        {camOn ? (
          <>
            <div className="scan-frame" />
            <div className="scan-laser" />
            <div className="scan-hint">将二维码放入框内，会自动识别</div>
          </>
        ) : (
          <div className="scan-idle">
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: "var(--radius-sm)",
                background: "rgba(255,255,255,.06)",
                display: "grid",
                placeItems: "center",
                margin: "0 auto 14px",
                color: "rgba(255,255,255,.55)",
              }}
            >
              <Icon name="scan" size={28} />
            </div>
            <div style={{ color: "rgba(255,255,255,.8)", fontSize: 13, marginBottom: 4 }}>
              扫描物品标签
            </div>
            <div style={{ color: "rgba(255,255,255,.4)", fontSize: 11.5, marginBottom: 18 }}>
              支持二维码与常见一维条码
            </div>
            <button className="btn btn-primary" onClick={startCam} disabled={camBusy}>
              {camBusy ? <Spinner size={14} /> : <Icon name="camera" size={15} />}
              {camBusy ? "正在启动相机…" : "打开相机"}
            </button>
            {!supported && (
              <div style={{ color: "rgba(255,255,255,.4)", fontSize: 11, marginTop: 12 }}>
                当前浏览器不支持自动识别，建议使用 Chrome 或 Edge
              </div>
            )}
          </div>
        )}
      </div>

      {camOn && (
        <div className="row gap-8 mt-12" style={{ justifyContent: "center" }}>
          <button className="btn btn-sm" onClick={stopCam}>
            <Icon name="stop" size={13} />
            停止扫描
          </button>
        </div>
      )}

      {camError && (
        <div
          className="row gap-8 mt-12"
          style={{
            fontSize: 12.5,
            color: "var(--amber)",
            background: "var(--amber-soft)",
            padding: "10px 12px",
            borderRadius: "var(--radius-xs)",
          }}
        >
          <Icon name="alert" size={14} />
          {camError}
        </div>
      )}
      </>
      )}

      <div className="scan-manual">
        <div className="input-group grow">
          <Icon name="qr" size={16} />
          <input
            className="input mono"
            placeholder={
              manualOnly
                ? "输入编号、条码、序列号，或直接打名字"
                : "输入物品编号（HL-000001）或商品条码"
            }
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && lookup(manual)}
          />
        </div>
        <button className="btn btn-primary" onClick={() => lookup(manual)} disabled={busy}>
          {busy ? <Spinner /> : <Icon name="search" size={15} />}
          查询
        </button>
      </div>

      {result && (
        <div className="scan-result">
          {result.found ? (
            <>
              <div className="row-between mb-10">
                <span className="badge brand">
                  <Icon name="check-circle" size={11} />
                  已找到
                </span>
                <span className="tiny faint">
                  匹配方式：{MATCH_LABEL[result.matched_by || ""] || result.matched_by}
                </span>
              </div>
              {(result.candidates || []).map((c) => (
                <div
                  key={c.id}
                  className="row gap-10"
                  style={{
                    padding: "10px 0",
                    borderTop: "1px solid var(--border)",
                    cursor: "pointer",
                  }}
                  onClick={() => nav(`/items/${c.id}`)}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: "var(--radius-xs)",
                      background: "var(--brand-soft)",
                      color: "var(--brand)",
                      display: "grid",
                      placeItems: "center",
                      flex: "0 0 auto",
                    }}
                  >
                    <Icon name="package" size={16} />
                  </div>
                  <div className="grow">
                    <div style={{ fontSize: 13, fontWeight: 550 }}>{c.name}</div>
                    <div className="tiny faint mono">{c.code}</div>
                  </div>
                  <span className={`badge ${STATUS_META[c.status]?.cls || ""}`}>
                    {STATUS_META[c.status]?.label || c.status}
                  </span>
                  <Icon name="chevron-right" size={15} style={{ color: "var(--text-3)" }} />
                </div>
              ))}
              {result.hint && (
                <div className="hint mt-10" style={{ display: "flex", gap: 6 }}>
                  <Icon name="info" size={13} style={{ flex: "0 0 auto", marginTop: 1 }} />
                  {result.hint}
                </div>
              )}
            </>
          ) : (
            <Empty
              icon="search"
              title="没有找到对应物品"
              desc={result.message}
              action={
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() =>
                    nav(
                      `/items/new?barcode=${encodeURIComponent(result.query)}${
                        result.query.startsWith("HL-") ? `&name=` : ""
                      }`
                    )
                  }
                >
                  <Icon name="plus" size={13} />
                  以「{result.query}」新建
                </button>
              }
            />
          )}
        </div>
      )}

      <div className="card mt-16">
        <div className="card-head">
          <div className="card-title">
            <Icon name="sparkles" size={15} />
            拍照识别小票 / 保修卡
          </div>
          <span className="badge">AI 辅助</span>
        </div>
        <div className="hint" style={{ marginBottom: 12 }}>
          上传小票或保修卡，自动提取名称、品牌、价格、保修期等字段。识别结果仅作为建议，
          需要人工确认后才会写入。
        </div>
        <input
          ref={ocrRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => e.target.files?.[0] && runOcr(e.target.files[0])}
        />
        <div className="row gap-8">
          <button className="btn" onClick={() => ocrRef.current?.click()} disabled={ocrBusy}>
            {ocrBusy ? <Spinner size={14} /> : <Icon name="camera" size={14} />}
            选择照片识别
          </button>
          {ocr && (
            <button className="btn btn-primary" onClick={ocrToNew}>
              <Icon name="plus" size={14} />
              用识别结果新建
            </button>
          )}
        </div>

        {ocr && (
          <div style={{ marginTop: 14 }}>
            {ocr.provider_info?.leaves_device && (
              <div
                className="row gap-8"
                style={{
                  fontSize: 11.5,
                  color: "var(--amber)",
                  background: "var(--amber-soft)",
                  padding: "8px 10px",
                  borderRadius: "var(--radius-xs)",
                  marginBottom: 10,
                  alignItems: "flex-start",
                }}
              >
                <Icon name="alert" size={12} style={{ marginTop: 1, flex: "0 0 auto" }} />
                {ocr.provider_info.privacy_notice}
              </div>
            )}
            {Object.keys(ocr.fields).length > 0 ? (
              <div className="col gap-6">
                {Object.entries(ocr.fields).map(([k, v]) => (
                  <div key={k} className="row gap-8" style={{ fontSize: 12.5 }}>
                    <span className="faint" style={{ width: 76 }}>{k}</span>
                    <span style={{ fontWeight: 500 }}>{String(v)}</span>
                  </div>
                ))}
                <div className="tiny faint" style={{ marginTop: 4 }}>
                  置信度 {(ocr.confidence * 100).toFixed(0)}% · {ocr.message}
                </div>
              </div>
            ) : (
              <div className="hint">{ocr.message}</div>
            )}
          </div>
        )}
      </div>

      <div
        className="card mt-16"
        style={{ background: "var(--surface-2)", borderStyle: "dashed" }}
      >
        <div className="row gap-10" style={{ alignItems: "flex-start" }}>
          <Icon name="info" size={15} style={{ color: "var(--text-3)", marginTop: 2 }} />
          <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.7 }}>
            <b>三种码不要混淆：</b>
            <br />
            物品编号（HL-000123）由 HomeLedger 生成，一物一码；商品条码（EAN/UPC）标识的是商品型号，
            同一款可能有多件；序列号由厂商分配，用于保修查询。
          </div>
        </div>
      </div>
    </div>
  );
}
