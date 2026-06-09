// Export: PNG (rasterize page SVG), MIDI (SMF). PPTX added later.
import type { App } from "./app";
import { scoreToMidi } from "../score/midi";
import { buildPptx } from "./pptx";
import { saveBytes } from "./fileio";

const SVG_NS = "http://www.w3.org/2000/svg";

let bravuraDataUrlPromise: Promise<string> | null = null;
async function bravuraDataUrl(): Promise<string> {
  if (!bravuraDataUrlPromise) {
    bravuraDataUrlPromise = fetch("/redist/Bravura.woff2")
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
  const svg = app.pageEls[app.pageIndex];
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
  item("PNG（当前页）", () => exportCurrentPagePng(app));
  item("PPTX（矢量）", () => exportPptx(app));
  item("MIDI", () => exportMidi(app));

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
