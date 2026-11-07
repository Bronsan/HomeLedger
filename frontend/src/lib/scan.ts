/**
 * Reading a code out of a camera frame, on whatever engine we happen to be on.
 *
 * The native `BarcodeDetector` is the right first choice: it is hardware
 * accelerated, knows a dozen symbologies, and costs nothing to ship. The
 * problem is availability — Chrome on Android has it, but *Android WebView*
 * (which is what a packaged app runs in) does not, and neither does the
 * WebKitGTK build most Linux desktops ship. Relying on it alone means the
 * camera opens and then politely informs the user that scanning is not
 * supported, on the one device where scanning matters.
 *
 * So there is a fallback: draw the frame to a canvas at a sane size and run
 * jsQR over the pixels. It only knows QR codes, and it is slower, but a QR
 * code is exactly what HomeLedger prints on its stickers.
 */

export type FrameScanner = (video: HTMLVideoElement) => Promise<string | null>;

type NativeDetector = {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
};

export function hasNativeDetector(): boolean {
  return typeof window !== "undefined" && "BarcodeDetector" in window;
}

/** True for anything this device can read at all. Used to word the UI. */
export function canScan(): boolean {
  return hasNativeDetector() || typeof HTMLCanvasElement !== "undefined";
}

export async function createFrameScanner(): Promise<FrameScanner | null> {
  if (hasNativeDetector()) {
    const ctor = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => NativeDetector })
      .BarcodeDetector;
    const detector = new ctor({
      formats: ["qr_code", "ean_13", "ean_8", "code_128", "upc_a", "code_39", "itf"],
    });
    return async (video) => {
      try {
        const found = await detector.detect(video);
        return found?.[0]?.rawValue || null;
      } catch {
        return null;
      }
    };
  }

  // jsQR is ~30 kB gzipped and pure JavaScript. Loading it lazily keeps it out
  // of the first paint on devices that will never scan anything.
  const mod = await import("jsqr");
  const jsQR = (mod as unknown as { default: typeof import("jsqr").default }).default;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  return async (video) => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    // 640 px on the long edge is enough for a 25 mm sticker held at arm's
    // length, and roughly 20× cheaper than scanning a 4K frame.
    const scale = Math.min(1, 640 / Math.max(vw, vh));
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, w, h);
    const frame = ctx.getImageData(0, 0, w, h);
    const hit = jsQR(frame.data, w, h, { inversionAttempts: "dontInvert" });
    return hit?.data || null;
  };
}
