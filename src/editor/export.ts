// Export: PNG (rasterize page SVG), MIDI (SMF), PPTX, Mixed PDF.
import type { App } from "./app";
import { scoreToMidi } from "../score/midi";
import { buildPptx } from "./pptx";
import { JinpuPainter } from "../layout/painter";
import { applyPptxStyle } from "../layout/pptxstyle";
import { encodeJpwabc, isTauriRuntime, saveBytes } from "./fileio";
import { scoreToJpwabc } from "../score/jpscore";
import { puToMusicXml } from "../pu";
import { asset } from "../common/asset";
import { scoreToMusicXml } from "../score/musicxmlout";
import { patchMusicXml } from "../score/musicxmlpatch";
import { annotateLayout } from "../score/musicxmllayout";

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
  if (app.docFormat === "pu") {
    const t = app.puScore()?.title.split("\n")[0];
    if (t) return t;
  }
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
  const score = app.docFormat === "pu" ? app.puScore() : app.painter.score;
  if (!score) throw new Error("这份文本谱里没有可导出的曲行");
  const bytes = scoreToMidi(score, app.playback.options());
  await saveBytes(bytes, `${baseName(app)}.mid`, "audio/midi");
}

export async function exportPptx(app: App): Promise<void> {
  // 文本谱用它自己的排版器出片（PPT 版面）；简谱**另排一遍 PPT 档**，
  // 不吃屏幕上那个 painter——这样屏幕在原版档也导得出 PPT 观感，
  // 切到 PPT 档预览则是所见即所得。字号/纸张仍取用户设置。
  const pu = app.docFormat === "pu" ? app.puPainter : null;
  if (app.docFormat === "pu" && !pu) throw new Error("这份文本谱还没有排出可导出的页面");
  const bytes = await buildPptx(pu ?? pptxPainter(app));
  await saveBytes(
    bytes,
    `${baseName(app)}.pptx`,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
}

/** 按 PPT 档另排一份简谱。屏幕已在 PPT 档时直接用屏幕那个，省一次排版。 */
function pptxPainter(app: App): JinpuPainter {
  if (app.jpProfile === "pptx") return app.painter;
  const p = new JinpuPainter(app.fontSize);
  const opt = p.layout.options;
  opt.smuflMeta = app.painter.layout.options.smuflMeta;
  opt.color = app.painter.layout.options.color;
  opt.titleSize = app.painter.layout.options.titleSize;
  opt.creditSize = app.painter.layout.options.creditSize;
  applyPptxStyle(opt); // 契约：构造之后、resize 之前
  p.score = app.painter.score;
  p.resize(app.pageW, app.pageH, app.breakDesc);
  return p;
}

const MUSICXML_MIME = "application/vnd.recordare.musicxml+xml";

/** 导出 MusicXML。有底本（OMR/ABC/导入的 musicxml）就在底本上做增量修改，只有纯 .jpwabc
 *  才整体重生成——.jpwabc 承载的信息比 MusicXML 少，重生成等于把底本降采样。 */
export async function exportMusicXml(app: App): Promise<void> {
  const base = app.mixedXmlText;
  if (app.mode === "mixed" && base) { // 混排：底本即五线谱原文，原样给出
    await saveBytes(new TextEncoder().encode(base), `${baseName(app)}.musicxml`, MUSICXML_MIME);
    return;
  }
  let xml: string;
  if (base && app.importUnchanged) {
    xml = base; // 一字未改：零损耗
  } else if (base) {
    let r: { xml: string; fallback: boolean } | null = null;
    try {
      r = patchMusicXml(base, app.painter.score);
    } catch (e) {
      console.error("MusicXML 增量修改失败，改走整体重生成", e);
    }
    if (!r || r.fallback) {
      app.setStatus("改动过大，MusicXML 已按当前谱面重新生成（原图行结构等细节会丢失）");
      xml = scoreToMusicXml(app.painter.score);
    } else {
      xml = r.xml;
    }
  } else {
    xml = scoreToMusicXml(app.painter.score);
  }
  await finishMusicXml(app, xml);
}

/** MusicXML 导出的共同收尾：解析校验 → 补版面 → 序列化 → 补回 XML 声明 → 落盘。
 *  XMLSerializer 不输出 XML 声明（DOCTYPE 会保留），不补回部分软件拒绝打开。 */
async function finishMusicXml(app: App, xml: string): Promise<void> {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("生成的 MusicXML 无法解析");
  annotateLayout(doc); // 分行沿用底本 <print>，版面参数用 A4 常量表
  let out = new XMLSerializer().serializeToString(doc);
  if (!out.startsWith("<?xml")) out = `<?xml version="1.0" encoding="UTF-8"?>\n${out}`;
  await saveBytes(new TextEncoder().encode(out), `${baseName(app)}.musicxml`, MUSICXML_MIME);
}

/** 文本谱 → MusicXML。直接从 AST 生成（不经 Score），和弦、力度、渐强渐弱都保住。 */
export async function exportPuMusicXml(app: App): Promise<void> {
  const puDoc = app.puDoc();
  if (!puDoc) throw new Error("这份文本谱里没有可导出的曲行");
  await finishMusicXml(app, puToMusicXml(puDoc));
}

/** 文本谱 → `.jpwabc`。JP-Word 的 .Voice 只有单声部，多声部时只导第一声部。 */
export async function exportPuJpwabc(app: App): Promise<void> {
  const score = app.puScore();
  if (!score) throw new Error("这份文本谱里没有可导出的曲行");
  if (score.parts.length > 1) {
    app.setStatus(`.jpwabc 只支持单声部，已导出第一声部（原谱有 ${score.parts.length} 个）`);
  }
  const text = scoreToJpwabc(score);
  await saveBytes(encodeJpwabc(text), `${baseName(app)}.jpwabc`, "application/octet-stream");
}

/** Export staff pages to a directly downloadable PDF. */
export async function exportMixedPdf(app: App): Promise<void> {
  const painter = app.mixedPainter;
  if (!painter || app.mode !== "mixed") return;
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

/** 一个导出项：显示名 + 在什么状态下可用 + 怎么导。
 *  以前这份规则散在 6 处（对话框里按 (docFormat, mode) 元组分三支，每个 exporter 内部
 *  又各自重判一次），加一种导出格式要挨个找齐。 */
interface ExportItem {
  label: string;
  available(app: App): boolean;
  run(app: App): Promise<void>;
}

const isMixed = (app: App): boolean => app.mode === "mixed";
const isPu = (app: App): boolean => app.docFormat === "pu" && !isMixed(app);
const isJp = (app: App): boolean => !isPu(app) && !isMixed(app);

/** 顺序即对话框里的顺序。 */
const EXPORT_ITEMS: readonly ExportItem[] = [
  // 文本谱（非混排预览）：走 pu 自己的排版器与直出路径
  { label: "PPTX", available: isPu, run: exportPptx },
  { label: "MIDI", available: isPu, run: exportMidi },
  { label: "MusicXML", available: isPu, run: exportPuMusicXml },
  { label: "JPWABC（简谱）", available: isPu, run: exportPuJpwabc },
  // 混排（五线谱预览）
  { label: "PNG", available: isMixed, run: exportCurrentPagePng },
  { label: "PDF", available: isMixed, run: exportMixedPdf },
  { label: "MIDI", available: isMixed, run: exportMidi },
  { label: "MusicXML", available: isMixed, run: exportMusicXml },
  // 简谱
  { label: "PPTX", available: isJp, run: exportPptx },
  { label: "MIDI", available: isJp, run: exportMidi },
  { label: "MusicXML", available: isJp, run: exportMusicXml },
];

export function showExportDialog(app: App): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  const title = document.createElement("div");
  title.className = "modal-title";
  // 文本谱这一档不加后缀：「导出 · 文本谱」会被读成「导出成文本谱」，而条目里
  // 一个文本谱格式都没有。
  title.textContent =
    app.docFormat === "pu" ? "导出" : app.mode === "mixed" ? "导出 · 五线谱" : "导出 · 简谱";
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
  for (const it of EXPORT_ITEMS) {
    if (it.available(app)) item(it.label, () => it.run(app));
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
