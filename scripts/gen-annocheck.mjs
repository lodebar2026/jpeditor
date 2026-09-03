// 注解对比册：原件裁图 ↕ 识别文本，一条一块，供人工挑错。
//
//   npm run build:cli && node gen-annocheck.mjs            # 全部 169 条
//   node gen-annocheck.mjs --issues                        # 只出还有缺字的
//   node gen-annocheck.mjs --one=022,078                   # 指定曲号
//
// 上半是**原件**（从原 PDF 里把这一框的矩形区域整块嵌进来，矢量、不栅格化），
// 下半是**重排的样子**——框与文字都走 `bookparts.ts::annotationBlock`，
// 与 `rebuild.mjs` 同一个实现、同一份度量，连花边母题都按 `frame_style` 取这一框那八片；
// **框宽与原件一样**（用原书那一框的宽度），上下对齐着看。
// 读不出的字画成 `□`，一眼看得见漏在哪儿——`bookmeta` 那条正路是把它留空的
//（绝不写问号，那会跟着排进成品 PDF），所以这里另给一个 override，只为看。
//
// **纯 Node，不起浏览器。**
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadCli, CORPUS_PDF } from "./node-harness.mjs";
import { openDb, loadGlyphFixes, readTable } from "./checkdb.mjs";
import { resolveBookFonts } from "./fontres.mjs";
import { makeMetrics } from "./textmetrics.mjs";

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
);
const ONLY = flags.one ? String(flags.one).split(",").map((s) => s.trim().padStart(3, "0")) : null;
const ISSUES = "issues" in flags;
const OUT = flags.out ?? "pdf-out/注解对比.pdf";
const UNREAD = "�";

const cli = await loadCli();
const layout = JSON.parse(await readFile(flags.layout ?? "pdf-layout.json", "utf8"));
const dict = JSON.parse(await readFile(flags.dict ?? "testdata/500/glyphdict.json", "utf8"));
const pm = JSON.parse(await readFile("testdata/500/pagemap.json", "utf8"));
const db = openDb();
const fixes = loadGlyphFixes(db);
// 花边母题逐框各不相同（全书 106 套），按 frame_style 取这一框的八片——与 rebuild 同源。
const tilesByStyle = new Map();
for (const t of readTable(db, "ornament_tile")) {
  const a = tilesByStyle.get(t.style_id) ?? [];
  a.push({ slot: t.slot, w: t.w, h: t.h, pitch: t.pitch, ox: t.ox ?? 0, oy: t.oy ?? 0, path: t.path });
  tilesByStyle.set(t.style_id, a);
}
db.close();

const repOf = (k) => dict.classes[k]?.g ?? k;
/** 与 gen-bookmeta 同一套补字，**只有读不出的那一步不同**：留个 □ 给人看。 */
const override = (key, current) => fixes[key] ?? fixes[repOf(key)] ?? (current === UNREAD ? "□" : current);

const entriesByPage = new Map();
for (const m of pm.map) {
  const a = entriesByPage.get(m.page) ?? [];
  a.push(m);
  entriesByPage.set(m.page, a);
}
const meta = cli.buildBookMeta(layout.pages, { override, entriesByPage, noteH: cli.noteHeightOf(layout.profile) });

let rows = meta.annotations.map((a) => ({ ...a, holes: (a.text.match(/□/g) ?? []).length }));
if (ONLY) rows = rows.filter((r) => ONLY.includes(r.songId ?? ""));
if (ISSUES) rows = rows.filter((r) => r.holes > 0);
rows.sort((a, b) => b.holes - a.holes || (a.songId ?? "").localeCompare(b.songId ?? ""));
console.log(`注解 ${meta.annotations.length} 条，要出的 ${rows.length} 条（还有缺字的 ${meta.annotations.filter((a) => /□/.test(a.text)).length} 条）`);
if (!rows.length) process.exit(0);

// ── 组页
const { PDFDocument, rgb } = await import("pdf-lib");
const fontkit = (await import("@pdf-lib/fontkit")).default;
const src = await PDFDocument.load(await readFile(CORPUS_PDF));
const out = await PDFDocument.create();
out.registerFontkit(fontkit);

// 正文字体：书里 story 角色那一份（与重排同一份字节、同一份度量）
const style = JSON.parse(await readFile(flags.style ?? "testdata/500/bookstyle.json", "utf8"));
const tm = await makeMetrics(style);
const measure = tm.advance;
const { fonts } = await resolveBookFonts(style);
const bodyId = style.roles.story?.font ?? Object.keys(fonts)[0];
const body = await out.embedFont(fonts[bodyId].bytes, { subset: true });
const label = await out.embedFont(fonts[bodyId].bytes, { subset: true });

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 32;
const GAP = 20;
const INNER = PAGE_W - MARGIN * 2;
/** 注解正文的行距比例（与 rebuild 同口径：框高 ÷ (行数−1) ÷ 字号，取全书中位数）。 */
const GAP_RATIO = (() => {
  const rs = [];
  for (const a of meta.annotations) {
    const n = a.text.split("\n").length;
    if (a.framed && n > 2 && a.box.h > 0 && a.size > 2) rs.push((a.box.h - 10) / (n - 1) / a.size);
  }
  rs.sort((x, y) => x - y);
  return rs.length ? Number(rs[Math.floor(rs.length / 2)].toFixed(3)) : 1.5;
})();
const STORY_SIZE = style.roles.story.size;

/** 这一块的八片母题；样式认不出来退回任意一套（框宽都一样）。 */
const tilesOf = (id) => tilesByStyle.get(id) ?? tilesByStyle.values().next().value ?? [];

// **逐字回退**：这套书的正文字体没有弯引号，只嵌一份的话「“」「”」会画成空白
//（pdf-lib 静默画 .notdef）。与 pdfwrite 同一条思路：角色主字体 → 同书其它字体。
const faces = new Map();
for (const [id, f] of Object.entries(fonts)) faces.set(id, fontkit.create(Buffer.from(f.bytes)));
// **用到才嵌**：嵌了却一个字都没画的 CFF 字体，子集是空的，保存时会崩在编码上
//（pdfwrite 那边也记着这一条）；`mode:"path"` 的那几套本来就不该嵌。
const embeds = new Map();
const embedOf = (id) => {
  if (!embeds.has(id)) embeds.set(id, out.embedFont(fonts[id].bytes, { subset: true }));
  return embeds.get(id);
};
const hasGlyph = (id, ch) => {
  const cp = ch.codePointAt(0);
  try {
    return cp !== undefined && (faces.get(id)?.hasGlyphForCodePoint?.(cp) ?? true);
  } catch {
    return false;
  }
};
const pickId = (role, ch) => {
  const main = style.roles[role]?.font ?? bodyId;
  for (const id of [main, ...Object.keys(fonts).filter((k) => k !== main)]) if (hasGlyph(id, ch)) return id;
  return null;
};
/** `mode:"path"` 的字体不嵌入、改用轮廓画（与 pdfwrite 同一条纪律）；
 *  这套书的弯引号只有那几套里有，不走这条就画成空白。 */
const outlineOf = (id, ch, size, penX, baselineY) => {
  const g = faces.get(id)?.layout(ch)?.glyphs?.[0];
  if (!g?.path) return null;
  const k = size / (faces.get(id).unitsPerEm || 1000);
  return g.path.transform(k, 0, 0, -k, penX, baselineY).toSVG();
};
const labelFont = body;
/** 这套字体没有的字（Bravura 才有的音乐符号之类）画不出来会崩，先换成 □。 */
const drawable = (t, font, size) =>
  [...t]
    .map((ch) => {
      try {
        font.widthOfTextAtSize(ch, size);
        return ch;
      } catch {
        return "□";
      }
    })
    .join("");

/** DrawItem → pdf-lib。只有注解块会用到 text / rect / path 三类。 */
const paint = async (pg, items, dx, dyTop, pageH) => {
  for (const it of items) {
    if (it.t === "text") {
      const font = fontOf(it.role);
      // **逐字落笔，笔位取自 `textmetrics.run`**——与 `wrapText` 折行、与 pdfwrite 落字
      // 同一个 `compressRun`。半身式下压过的标点笔位自己会左挪半格，
      // 光按 advance 累加的话「“」会跟后一个字叠在一起（022 首字那儿一眼可见）。
      const chars = [...it.text];
      const cr = tm.run(it.role, it.text, it.size);
      const lead = (tm.ink(it.role, chars[0] ?? " ", it.size)?.left ?? 0) + (cr.xs[0] ?? 0);
      const x0 = (it.xs?.[0] ?? it.box?.x ?? 0) + dx - lead;
      const yy = pageH - (dyTop + it.y);
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        const x = x0 + (cr.xs[i] ?? 0);
        const id = pickId(it.role, ch);
        if (id && style.fonts[id]?.mode === "path") {
          const d = outlineOf(id, ch, it.size, x, dyTop + it.y);
          if (d) pg.drawSvgPath(cli.quadToCubic ? cli.quadToCubic(d) : d, { x: 0, y: pageH, color: rgb(0, 0, 0) });
        } else {
          const f = id ? await embedOf(id) : font;
          pg.drawText(drawable(ch, f, it.size), { x, y: yy, size: it.size, font: f, color: rgb(0, 0, 0) });
        }
      }
    } else if (it.t === "rect") {
      pg.drawRectangle({ x: it.x + dx, y: pageH - (dyTop + it.y) - it.h, width: it.w, height: it.h, color: rgb(0, 0, 0) });
    } else if (it.t === "path") {
      try {
        pg.drawSvgPath(cli.quadToCubic ? cli.quadToCubic(it.d) : it.d, { x: dx, y: pageH - dyTop, color: rgb(0, 0, 0) });
      } catch {
        /* 一条纹样画不出不该炸整册 */
      }
    }
  }
};
const fontCache = new Map();
const fontOf = (role) => {
  const id = style.roles[role]?.font ?? bodyId;
  if (!fontCache.has(id)) fontCache.set(id, body); // 对比册只用正文那一份，够看
  return fontCache.get(id);
};

let page = out.addPage([PAGE_W, PAGE_H]);
let y = PAGE_H - MARGIN; // y 从页顶往下量
const embedded = new Map();
for (const r of rows) {
  const srcPage = src.getPage(r.page - 1);
  const { width: pw, height: ph } = srcPage.getSize();
  const pad = 6;
  const clip = {
    left: Math.max(0, r.box.x - pad),
    right: Math.min(pw, r.box.x + r.box.w + pad),
    // 版面规格的 y 朝下，PDF 的朝上
    bottom: Math.max(0, ph - (r.box.y + r.box.h) - pad),
    top: Math.min(ph, ph - r.box.y + pad),
  };
  const key = `${r.page}|${clip.left}|${clip.bottom}|${clip.right}|${clip.top}`;
  let emb = embedded.get(key);
  if (!emb) {
    emb = await out.embedPage(srcPage, clip);
    embedded.set(key, emb);
  }
  const scale = Math.min(1, INNER / emb.width);
  const imgH = emb.height * scale;

  // **框宽照原件**：left/right 给原书那一框的左右缘，重排出来的块就和上面一样宽
  const block = cli.annotationBlock(style, {
    text: r.text,
    framed: r.framed,
    frame: r.frame,
    frameOuter: r.frameOuterWidth || undefined,
    frameInner: r.frameInnerWidth || undefined,
    frameGap: r.frameGap || undefined,
    left: 0,
    right: r.box.w,
    top: 0,
    lineGap: STORY_SIZE * GAP_RATIO,
    tiles: r.frame === "tile" ? tilesOf(r.frameStyle) : [],
    frameEdges: r.frameEdges || undefined,
    measure,
    size: STORY_SIZE,
  });

  const need = 13 + imgH + 10 + block.height + GAP;
  if (y - need < MARGIN) {
    page = out.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  }
  const head = `${r.songId ?? "??"}　原书 p${r.page}　${r.frame}框　原字号 ${r.size}　缺字 ${r.holes}`;
  page.drawText(drawable(head, labelFont, 8), { x: MARGIN, y: y - 10, size: 8, font: labelFont, color: r.holes ? rgb(0.8, 0.1, 0.1) : rgb(0.35, 0.35, 0.35) });
  y -= 13;
  page.drawPage(emb, { x: MARGIN, y: y - imgH, xScale: scale, yScale: scale });
  y -= imgH + 10;
  // `y` 是 PDF 坐标（从页底量），`paint` 要的是「从页顶往下」的块顶
  await paint(page, block.items, MARGIN, PAGE_H - y, PAGE_H);
  y -= block.height + GAP;
}

await mkdir("pdf-out", { recursive: true });
const bytes = await out.save();
await writeFile(OUT, bytes);
console.log(`→ ${OUT}（${out.getPageCount()} 页，${(bytes.length / 1e6).toFixed(1)} MB）`);
