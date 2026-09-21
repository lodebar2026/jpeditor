// Export: PNG (rasterize page SVG), MIDI (SMF), PPTX, Mixed PDF.
import type { App } from "./app";
import { toMidi } from "../score/midi";
import { buildPptx } from "./pptx";
import { ExpandedPainter } from "../jianpu/expanded";
import { encodeJpwabc, isTauriRuntime, saveBytes } from "./fileio";
import { emitJpwabc } from "../model/tojpw";
import { asset } from "../common/asset";
import { scoreDocToMusicXml } from "../model/toxml";
import { loadScoreDoc } from "../model/fromxml";
import { jpwToScoreDoc } from "../model/fromjpw";
import { JpwFile } from "../jpword/jpwfile";
import { engraveScoreDoc } from "../mixed/engrave";
import { colorToCss } from "../common/geom";

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

const musicFontDataUrls = new Map<string, Promise<string>>();
async function musicFontDataUrl(file: string): Promise<string> {
  if (!musicFontDataUrls.has(file)) {
    musicFontDataUrls.set(file, fetch(asset(`redist/${file}`))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        let bin = "";
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return `data:font/woff2;base64,${btoa(bin)}`;
      }));
  }
  return musicFontDataUrls.get(file)!;
}

/** 给一页 SVG 铺上纸张底色（插一个满幅 rect 到最底层）。
 *  页面树里没有背景这一层——屏幕上靠 CSS 铺（见 App._applyPageBg），
 *  而 SVG 一旦离开浏览器（直出 PDF）就只剩透明底，所以导出时要显式铺一次。
 *  白底不铺：PDF 的纸本来就是白的，少一个无用图元。 */
function paintBg(svg: SVGSVGElement, bgColor: number): void {
  if (((bgColor >>> 0) & 0xffffff) === 0xffffff) return;
  const { width: w, height: h } = svgSize(svg);
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("x", "0");
  rect.setAttribute("y", "0");
  rect.setAttribute("width", String(w));
  rect.setAttribute("height", String(h));
  rect.setAttribute("fill", colorToCss(bgColor));
  svg.insertBefore(rect, svg.firstChild);
}

/** Serialize a page <svg> with Bravura embedded so it rasterizes faithfully.
 *  `bg` 是纸张底色（CSS 颜色）——SVG 自身是透明的，不铺底导出的 PNG 会是透明背景。 */
async function svgToBytes(svg: SVGSVGElement, scale: number, bg = "#fff"): Promise<Uint8Array> {
  const { width: w, height: h } = svgSize(svg);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  clone.removeAttribute("style");

  const style = document.createElementNS(SVG_NS, "style");
  const [bravura, bravuraText] = await Promise.all([
    musicFontDataUrl("Bravura.woff2"),
    musicFontDataUrl("BravuraText.otf"),
  ]);
  style.textContent =
    `@font-face{font-family:"Bravura";src:url("${bravura}") format("woff2");}` +
    `@font-face{font-family:"Bravura Text";src:url("${bravuraText}") format("opentype");}`;
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
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!blob) throw new Error("toBlob failed");
  return new Uint8Array(await blob.arrayBuffer());
}

function baseName(app: App): string {
  // 五线谱/混排档不重排简谱那侧（在这两档里打开的文档，简谱排版器还停在上一份），标题取混排排版器的
  const mixedTitle = app.mode === "mixed" ? app.mixedPainter?.title.split("\n")[0] : "";
  if (mixedTitle) return mixedTitle;
  if (app.adapter.caps.layout === "scoredoc") {
    const t = app.puScore()?.title.split("\n")[0];
    if (t) return t;
  }
  return app.painter.score.title.split("\n")[0] || "未命名";
}

export async function exportCurrentPagePng(app: App): Promise<void> {
  const wrap = app.pageEls[app.pageIndex];
  const svg = wrap?.querySelector("svg") as SVGSVGElement | null;
  if (!svg) throw new Error("当前页面没有可导出的乐谱");
  const bytes = await svgToBytes(svg, 2, colorToCss(app.bgColor));
  await saveBytes(bytes, `${baseName(app)}-第${app.pageIndex + 1}页.png`, "image/png");
}

export async function exportMidi(app: App): Promise<void> {
  const src = app.playable();
  if (!src) throw new Error("这份谱里没有可导出的曲行");
  const bytes = toMidi(src, app.playback.options());
  await saveBytes(bytes, `${baseName(app)}.mid`, "audio/midi");
}

export async function exportPptx(app: App): Promise<void> {
  // 一律按**展开档**出片（两种格式同一个 ExpandedPainter）：屏幕在原样档也导得出 PPT 观感，
  // 切到展开档预览则是所见即所得。字号/纸张取展开档那一套设置。
  const bytes = await buildPptx(pptxPainter(app), app.colorsOf("expanded").bg);
  await saveBytes(
    bytes,
    `${baseName(app)}.pptx`,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
}

/** 按展开档另排一份。屏幕已在展开档时直接用屏幕那个，省一次排版。
 *  **设置取展开档那一套**（`App.expandedOptions`），不是屏幕上原样档的那套——
 *  否则导出的投影片会带着原样档的字号与颜色。 */
export function pptxPainter(app: App): ExpandedPainter {
  if (app.painter instanceof ExpandedPainter) return app.painter;
  const score = app.adapter.caps.layout === "scoredoc" ? app.puScore(true) : app.painter.score;
  if (!score) throw new Error("这份文本谱里没有可导出的曲行");
  const p = new ExpandedPainter(app.expandedOptions());
  p.load(score, app.adapter.caps.layout === "scoredoc" ? null : app.breakDesc);
  return p;
}

const MUSICXML_MIME = "application/vnd.recordare.musicxml+xml";

/** 导出 MusicXML（简谱档与混排档）。 */
export async function exportMusicXml(app: App): Promise<void> {
  await saveBytes(
    new TextEncoder().encode(await buildMusicXml(app)),
    `${baseName(app)}.musicxml`,
    MUSICXML_MIME,
  );
}

/** 当前文档 → MusicXML 文本。**保存回 `.musicxml` 原文件与「导出 MusicXML」共用这一条**。
 *
 *  只有两条路：混排预览有底本 → 底本原样；否则由唯一写出端
 *  `toxml.ts::scoreDocToMusicXml` 整份重写——`.jpwabc` 先经 `jpwToScoreDoc` 进模型，速度、房号（由 `.Repeat` 反推）、
 *  绝对音高都由投影层 `xmlproject.ts` 补（与 123/文本谱同一条路）。 */
export async function buildMusicXml(app: App): Promise<string> {
  const base = app.mixedDoc?.source;
  // `.musicxml` 的混排：底本即五线谱原文，原样给出（文本格式的混排底本是由下面这条派生的，不算原文）
  if (base && app.docFormat === "musicxml" && app.mode === "mixed") return base;
  return sourceMusicXml(app);
}

/** 当前**源文**经唯一写出端投成 MusicXML（不看混排底本），带上给第三方软件看的版面坐标：
 *  由五线谱引擎按设置里的纸排一遍、坐标写回模型（`mixed/engrave.ts`），与屏幕上的五线谱同一套分行。
 *  谱里自带版面的原样不动。 */
export async function sourceMusicXml(app: App): Promise<string> {
  const doc = loadScoreDoc(sourceMusicXmlBare(app));
  await engraveScoreDoc(doc, app.staffPage);
  return scoreDocToMusicXml(doc);
}

/** 同上，但**不带版面坐标**。文本格式进五线谱/混排走这一份（`App._ensureMixedDoc` 写出后再读回成 `mixedDoc`）：
 *  排版器见了坐标就照用，不带坐标才自己铺排（`layoutpass.ts`，五线谱识别的产物也走这条）。 */
export function sourceMusicXmlBare(app: App): string {
  // 换行照简谱视图实际排出的行（五线谱自动铺排拿它当优选断点）；`.jpwabc` 用排版器那份模型，元素 id 才对得上
  const lineStarts = app.jianpuLineStarts();
  if (app.docFormat === "jpwabc") {
    const f = JpwFile.fromString(app.getText());
    if (!f) throw new Error("这份 .jpwabc 读不出来");
    return scoreDocToMusicXml(app.jpwDoc ?? jpwToScoreDoc(f), { lineStarts });
  }
  const doc = app.currentScoreDoc();
  if (!doc) throw new Error("这份谱里没有可导出的曲行");
  return scoreDocToMusicXml(doc, { lineStarts });
}

/** 文本谱/123/ABC → MusicXML。`.musicxml` 那一档文档里就是 XML（原文或 `editScoreDoc` 整份重写过的），原样给出。 */
export async function exportPuMusicXml(app: App): Promise<void> {
  const text = app.docFormat === "musicxml" ? app.getText() : await buildMusicXml(app);
  await saveBytes(new TextEncoder().encode(text), `${baseName(app)}.musicxml`, MUSICXML_MIME);
}

/** 文本谱 → `.jpwabc`。JP-Word 的 .Voice 只有单声部，多声部时只导第一声部。 */
export async function exportPuJpwabc(app: App): Promise<void> {
  const doc = app.currentScoreDoc();
  const text = doc ? emitJpwabc(doc) : null;
  if (text === null) throw new Error("这份文本谱里没有可导出的曲行");
  if (app.partCount > 1) {
    app.setStatus(`.jpwabc 只支持单声部，已导出第一声部（原谱有 ${app.partCount} 个）`);
  }
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
      paintBg(svg, app.bgColor);
      pages.push(new XMLSerializer().serializeToString(svg));
    }
    await invoke("export_pdf_cmd", { pagesSvg: pages, widthPt: wPt, heightPt: hPt, outPath });
  } else {
    const { jsPDF } = await import("jspdf");
    const orientation = wPt >= hPt ? "landscape" : "portrait";
    const pdf = new jsPDF({ unit: "pt", format: [wPt, hPt], orientation, compress: true });
    for (let i = 0; i < painter.pageCount; i++) {
      const svg = painter.renderPage(i);
      const png = await svgToBytes(svg, 2, colorToCss(app.bgColor));
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
/** 走 `ScoreDoc` 排版的格式（文本谱、123、ABC）：导出项与简谱那档不同。 */
const isPu = (app: App): boolean => app.adapter.caps.layout === "scoredoc" && !isMixed(app);
const isJp = (app: App): boolean => !isPu(app) && !isMixed(app);
/** 另存为源格式：文本格式在五线谱/混排档也有源文可存；`.musicxml` 的混排档走「转成 … 编辑」。 */
const canSaveAsText = (app: App): boolean => !isMixed(app) || app.docFormat !== "musicxml";

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
  // `.musicxml` 没有代码区：转成文本格式的**新文档**再编辑（原文件不动）
  {
    label: "转成 123 编辑",
    available: (app) => app.docFormat === "musicxml",
    run: (app) => app.convertToTextDoc("123"),
  },
  {
    label: "转成 ABC 编辑",
    available: (app) => app.docFormat === "musicxml",
    run: (app) => app.convertToTextDoc("abc"),
  },
  {
    label: "转成 JPWABC 编辑",
    available: (app) => app.docFormat === "musicxml",
    run: (app) => app.convertToTextDoc("jpwabc"),
  },
  // 源格式之间的另存为。**保存前会列出目标格式装不下的东西**（`model/capability.ts`），
  // 确认了才写——这条路与上面那些「导出成别的媒介」不同，它换的是源格式本身。
  {
    label: "123（简谱源格式）",
    available: (app) => canSaveAsText(app) && app.docFormat !== "123",
    run: (app) => app.saveAsFormat("123"),
  },
  {
    label: "ABC（记谱源格式）",
    available: (app) => canSaveAsText(app) && app.docFormat !== "abc",
    run: (app) => app.saveAsFormat("abc"),
  },
];

export function showExportDialog(app: App): void {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const box = document.createElement("div");
  box.className = "modal-box";
  const title = document.createElement("div");
  title.className = "modal-title";
  // 不加「· 五线谱」「· 简谱」之类的后缀：会被读成「导出成五线谱」。PNG/PDF 导出的就是当前谱面视图。
  title.textContent = "导出";
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
