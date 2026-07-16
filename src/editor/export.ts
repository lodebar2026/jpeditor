// Export: PNG (rasterize page SVG), MIDI (SMF), PPTX, Mixed PDF.
import type { App } from "./app";
import { scoreToMidi } from "../score/midi";
import { buildPptx } from "./pptx";
import { isTauriRuntime, saveBytes } from "./fileio";
import { asset } from "../common/asset";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgSize(svg: SVGSVGElement): { width: number; height: number } {
  const viewBox = svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }
  const width = Number.parseFloat(svg.getAttribute("width") ?? "");
  const height = Number.parseFloat(svg.getAttribute("height") ?? "");
  if (width > 0 && height > 0) return { width, height };
  const rect = svg.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height };
  throw new Error("无法读取乐谱页面尺寸");
}

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
  const { width: w, height: h } = svgSize(svg);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
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
  const svg = wrap?.querySelector("svg") as SVGSVGElement | null;
  if (!svg) throw new Error("当前页面没有可导出的乐谱");
  const bytes = await svgToBytes(svg, 2);
  await saveBytes(bytes, `${baseName(app)}-第${app.pageIndex + 1}页.png`, "image/png");
}

export async function exportMidi(app: App): Promise<void> {
  const bytes = scoreToMidi(app.painter.score, { partVolumes: app.partVolumes });
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

/** Export staff pages to a directly downloadable PDF. */
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
    const { jsPDF } = await import("jspdf");
    const orientation = wPt >= hPt ? "landscape" : "portrait";
    const pdf = new jsPDF({ unit: "pt", format: [wPt, hPt], orientation, compress: true });
    for (let i = 0; i < painter.pageCount; i++) {
      const svg = painter.renderPage(i);
      const png = await svgToBytes(svg, 2);
      if (i > 0) pdf.addPage([wPt, hPt], orientation);
      pdf.addImage(png, "PNG", 0, 0, wPt, hPt, undefined, "FAST");
    }
    const bytes = new Uint8Array(pdf.output("arraybuffer"));
    await saveBytes(bytes, `${painter.title || "五线谱"}.pdf`, "application/pdf");
  }
}

export function showExportDialog(app: App): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  const title = document.createElement("div");
  title.className = "modal-title";
  title.textContent = app.mode === "mixed" ? "导出 · 五线谱" : "导出 · 简谱";
  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:8px";
  const error = document.createElement("div");
  error.style.cssText = "display:none;color:var(--error,#f3727f);font-size:12px;line-height:1.4";

  const close = () => overlay.remove();
  const item = (label: string, fn: () => void | Promise<void>) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText = "padding:8px 12px;text-align:left;cursor:pointer";
    btn.onclick = async () => {
      btn.disabled = true;
      error.style.display = "none";
      try {
        await fn();
        close();
      } catch (e) {
        console.error(e);
        error.textContent = "导出失败：" + (e instanceof Error ? e.message : String(e));
        error.style.display = "block";
        btn.disabled = false;
      }
    };
    list.append(btn);
  };
  if (app.mode === "mixed") {
    item("PNG", () => exportCurrentPagePng(app));
    item("PDF", () => exportMixedPdf(app));
    item("MIDI", () => exportMidi(app));
  } else {
    item("PPTX", () => exportPptx(app));
    item("MIDI", () => exportMidi(app));
  }

  const footer = document.createElement("div");
  footer.className = "modal-footer";
  const cancel = document.createElement("button");
  cancel.textContent = "取消";
  cancel.onclick = close;
  footer.append(cancel);

  box.append(title, list, error, footer);
  overlay.append(box);
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  document.body.append(overlay);
}
