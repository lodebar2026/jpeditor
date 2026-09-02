// 浏览器侧入口：PDF 字节 → MusicXML。**只有这个文件碰 pdfjs 的浏览器构建**，
// `src/staffomr/` 其余部分一律不碰 DOM（要能进 `src/cli/index.ts` 那条 Node 链）。
//
// 与简谱那条路（`src/omr/decode.ts`）的分界：那边把 PDF **光栅化**成位图再走连通域；
// 这边直接读文字层与矢量对象，不栅格化。判「该走哪条路」的是 `isStaffPdf`。
import type { OpsEnum } from "../omr/vector";
import { extractTextPage } from "../omr/vectext";
import { musicFamily } from "./symbolmap";
import { StaffGlyphLookup, type StaffGlyphDict } from "./staffglyphs";
import { TextGlyphLookup, type TextGlyphDict } from "./textglyphs";
import { recognizeStaffPage } from "./index";
import { buildScore } from "./score";
import { scoreToMusicXml } from "./toxml";
import type { StaffNote } from "./notedata";
import type { Staff } from "./model";

/**
 * 打开 PDF。
 *
 * **`disableFontFace: true` 不是可选项**：它让 worker 走 `buildFontPaths`，
 * 把字形轮廓以 commonObjs 送出来——`vectext.ts` 的紧包围盒与形状签名全靠它
 * （理由见 docs/实现/五线谱识别.md）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function openStaffPdf(bytes: Uint8Array): Promise<{ pdf: any; OPS: OpsEnum }> {
  const pdfjs = await import("pdfjs-dist");
  const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const wasmUrl = `${import.meta.env.BASE_URL}redist/pdfjs/`;
  // getDocument 会 detach 传入的 buffer，复制一份避免污染调用方字节。
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), wasmUrl, disableFontFace: true }).promise;
  return { pdf, OPS: pdfjs.OPS as unknown as OpsEnum };
}

/**
 * 这份 PDF 是不是「文字层完整的五线谱」——也就是该不该走 `src/staffomr/` 这条路。
 *
 * 判据：取样几页，页面上要有**音乐字体的文字**（Maestro/Opus/Anastasia 一系）。
 * 没有文字层的（500 首那种全部转曲的）与只有正文字体的（歌词页）都不算。
 * 与 `vector.ts::isVectorPdf` 互补：那条判的是「转曲矢量谱」。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function isStaffPdf(pdf: any, OPS: OpsEnum, sampleCount = 5): Promise<boolean> {
  const n = pdf.numPages as number;
  const picks: number[] = [];
  for (let k = 1; k <= sampleCount; k++) picks.push(Math.max(1, Math.min(n, Math.round((n * k) / (sampleCount + 1)))));
  let musicGlyphs = 0;
  for (const pn of picks) {
    const page = await pdf.getPage(pn);
    const runs = await extractTextPage(page, OPS, { scale: 1, withOutlines: false });
    for (const r of runs) if (musicFamily(r.font)) musicGlyphs += r.glyphs.length;
    page.cleanup?.();
    if (musicGlyphs > 50) return true;
  }
  return false;
}

export interface StaffPdfResult {
  musicxml: string;
  pages: number;
  notes: number;
  parts: number;
  /** 没有谱表的页（封面/目录/歌词页）。 */
  skipped: number;
}

/**
 * PDF → MusicXML（整本或指定页范围）。
 *
 * 字形字典（`glyphmap.json` 与 `lyricglyphs.json`）由 Vite 打成单独的 chunk，
 * 只在真跑这条路时才加载。
 */
export async function recognizeStaffPdf(
  bytes: Uint8Array,
  opts: { pages?: number[]; title?: string; onProgress?: (done: number, total: number) => void } = {},
): Promise<StaffPdfResult> {
  const { pdf, OPS } = await openStaffPdf(bytes);
  // 字形字典**动态 import**：Vite 会单独切一个 chunk，只在真跑五线谱识别时加载，
  // 而且永远与 `src/staffomr/*.json` 同步（拷进 public/ 会走味）。
  const [glyphDict, lyricDict] = await Promise.all([
    import("./glyphmap.json").then((m) => m.default as unknown as StaffGlyphDict),
    import("./lyricglyphs.json").then((m) => m.default as unknown as TextGlyphDict),
  ]);
  const look = new StaffGlyphLookup(glyphDict);
  const textLookup = new TextGlyphLookup(lyricDict);

  const list = opts.pages ?? Array.from({ length: pdf.numPages as number }, (_, i) => i + 1);
  const entries: { page: Parameters<typeof buildScore>[0][number]["page"]; ctx: Parameters<typeof buildScore>[0][number]["ctx"] }[] = [];
  const notesByStaff = new Map<Staff, StaffNote[]>();
  let carryTime: { beats: number; beatType: number } | undefined;
  let skipped = 0;
  let done = 0;
  for (const pn of list) {
    const page = await pdf.getPage(pn);
    const r = await recognizeStaffPage(page, OPS, look, pn, { textLookup, carryTime });
    carryTime = r.carryTime;
    if (r.hasStaff) {
      entries.push({ page: r.page, ctx: r.ctx });
      for (const n of r.notes) {
        const a = notesByStaff.get(n.staff) ?? [];
        a.push(n);
        notesByStaff.set(n.staff, a);
      }
    } else skipped++;
    page.cleanup?.();
    opts.onProgress?.(++done, list.length);
  }
  const score = buildScore(entries);
  const musicxml = scoreToMusicXml(score, (st) => notesByStaff.get(st) ?? [], { title: opts.title });
  let notes = 0;
  for (const v of notesByStaff.values()) notes += v.length;
  return { musicxml, pages: list.length, notes, parts: score.parts.length, skipped };
}
