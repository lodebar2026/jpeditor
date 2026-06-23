// Export: PNG (rasterize page SVG), MIDI (SMF), PPTX, Mixed PDF.
import type { App } from "./app";
import { scoreToMidi } from "../score/midi";
import { buildPptx } from "./pptx";
import { isTauriRuntime, saveBytes } from "./fileio";
import { asset } from "../common/asset";

const SVG_NS = "http://www.w3.org/2000/svg";

let bravuraDataUrlPromise: Promise<string> | null = null;
async function bravuraDataUrl(): Promise<string> {
  if (!bravuraDataUrlPromise) {
    bravuraDataUrlPromise = fetch(asset("redist/Bravura.woff2"))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        let bin = "";
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return `data:font/woff2;base64,${btoa(bin)}`;
      });
  }
  return bravuraDataUrlPromise;
}

/** Serialize a page <svg> with Bravura embedded so it rasterizes faithfully. */
async function svgToBytes(svg: SVGSVGElement, scale: number): Promise<Uint8Array> {
  const w = Number(svg.getAttribute("width"));
  const h = Number(svg.getAttribute("height"));
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", SVG_NS);
  clone.removeAttribute("style");

  const style = document.createElementNS(SVG_NS, "style");
  style.textContent =
    `@font-face{font-family:"Bravura";src:url("${await bravuraDataUrl()}") format("woff2");}`;
  clone.insertBefore(style, clone.firstChild);

  const svgText = new XMLSerializer().serializeToString(clone);
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);

  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error("svg image load failed"));
    img.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!blob) throw new Error("toBlob failed");
  return new Uint8Array(await blob.arrayBuffer());
}

function baseName(app: App): string {
  return app.painter.score.title.split("\n")[0] || "未命名";
}

export async function exportCurrentPagePng(app: App): Promise<void> {
  const wrap = app.pageEls[app.pageIndex];
  if (!wrap) return;
  const svg = wrap.querySelector("svg") as SVGSVGElement | null;
  if (!svg) return;
  const bytes = await svgToBytes(svg, 2);
  await saveBytes(bytes, `${baseName(app)}-第${app.pageIndex + 1}页.png`, "image/png");
}

export async function exportMidi(app: App): Promise<void> {
  const bytes = scoreToMidi(app.painter.score);
  await saveBytes(bytes, `${baseName(app)}.mid`, "audio/midi");
}

export async function exportPptx(app: App): Promise<void> {
  const bytes = await buildPptx(app.painter);
  await saveBytes(
    bytes,
    `${baseName(app)}.pptx`,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
}

/** Export mixed-mode pages to PDF via Tauri svg2pdf command or browser print dialog. */
export async function exportMixedPdf(app: App): Promise<void> {
  if (!app["_mixedPainter"] || app.mode !== "mixed") return;
  const painter = app["_mixedPainter"] as import("../mixed/painter").MixedPainter;
  const wPt = painter.pageWidthPt;
  const hPt = painter.pageHeightPt;

  if (isTauriRuntime()) {
    // Tauri path: serialize SVGs and invoke Rust export_pdf command
    const { invoke } = await import("@tauri-apps/api/core");
    const { save } = await import("@tauri-apps/plugin-dialog");
    const title = painter.title || "混排";
    const outPath = await save({ defaultPath: `${title}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!outPath) return;
    const pages: string[] = [];
    for (let i = 0; i < painter.pageCount; i++) {
      const svg = painter.renderPage(i);
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      svg.setAttribute("width", `${wPt}pt`);
      svg.setAttribute("height", `${hPt}pt`);
      pages.push(new XMLSerializer().serializeToString(svg));
    }
    await invoke("export_pdf_cmd", { pagesSvg: pages, widthPt: wPt, heightPt: hPt, outPath });
  } else {
    // Browser path: open print window with embedded font
    const bravuraUrl = await bravuraDataUrl();
    const win = window.open("", "_blank", "width=800,height=900");
    if (!win) return;
    const d = win.document;
    const wMm = (wPt * 25.4 / 72).toFixed(1);
    const hMm = (hPt * 25.4 / 72).toFixed(1);
    d.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
@font-face{font-family:"Bravura";src:url("${bravuraUrl}") format("woff2");}
@page{size:${wMm}mm ${hMm}mm;margin:0}
body{margin:0;padding:0;background:#fff}
svg{display:block;width:100%;page-break-after:always}
</style></head><body>`);
    for (let i = 0; i < painter.pageCount; i++) {
      const svg = painter.renderPage(i);
      svg.setAttribute("xmlns", SVG_NS);
      svg.setAttribute("width", `${wPt}pt`);
      svg.setAttribute("height", `${hPt}pt`);
      d.write(new XMLSerializer().serializeToString(svg));
    }
    d.write("</body></html>");
    d.close();
    setTimeout(() => win.print(), 500);
  }
}

export function showExportDialog(app: App): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  const title = document.createElement("div");
  title.className = "modal-title";
  title.textContent = "导出";
  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:8px";

  const close = () => overlay.remove();
  const item = (label: string, fn: () => void | Promise<void>) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText = "padding:8px 12px;text-align:left;cursor:pointer";
    btn.onclick = async () => {
      close();
      try {
        await fn();
      } catch (e) {
        console.error(e);
      }
    };
    list.append(btn);
  };
  if (app.mode === "mixed") {
    item("混排 PDF", () => exportMixedPdf(app));
  } else {
    item("PNG（当前页）", () => exportCurrentPagePng(app));
    item("PPTX（矢量）", () => exportPptx(app));
    item("MIDI", () => exportMidi(app));
  }

  const footer = document.createElement("div");
  footer.className = "modal-footer";
  const cancel = document.createElement("button");
  cancel.textContent = "取消";
  cancel.onclick = close;
  footer.append(cancel);

  box.append(title, list, footer);
  overlay.append(box);
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  document.body.append(overlay);
}
