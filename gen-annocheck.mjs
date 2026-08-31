// 注解对比册：原件裁图 ↕ 识别文本，一条一块，供人工挑错。
//
//   npm run build:cli && node gen-annocheck.mjs            # 全部 169 条
//   node gen-annocheck.mjs --issues                        # 只出还有缺字的
//   node gen-annocheck.mjs --one=022,078                   # 指定曲号
//
// 上半是**原件**（从原 PDF 里把这一框的矩形区域整块嵌进来，矢量、不栅格化），
// 下半是**识别文本**——读不出的字画成 `□`，一眼看得见漏在哪儿；
// `bookmeta` 那条正路把读不出的位置留空（绝不写问号，那会跟着排进成品 PDF），
// 所以这里另给一个 override，只为看。
//
// **纯 Node，不起浏览器。**
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadCli, CORPUS_PDF } from "./scripts/node-harness.mjs";
import { openDb, loadGlyphFixes } from "./scripts/checkdb.mjs";
import { resolveBookFonts } from "./scripts/fontres.mjs";

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

// 正文字体：书里 story 角色那一份（与重排同一份字节）
const style = cli.defaultBookStyle();
const { fonts } = await resolveBookFonts(style);
const bodyId = style.roles.story?.font ?? Object.keys(fonts)[0];
const body = await out.embedFont(fonts[bodyId].bytes, { subset: true });
const label = await out.embedFont(fonts[bodyId].bytes, { subset: true });

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 32;
const GAP = 18;
const SIZE = 9;
const LEAD = SIZE * 1.45;
const INNER = PAGE_W - MARGIN * 2;

/** 有的字这套字体没有（Bravura 才有的音乐符号之类），画不出来会崩，先换成 □。 */
const drawable = (t) =>
  [...t]
    .map((ch) => {
      try {
        body.widthOfTextAtSize(ch, SIZE);
        return ch;
      } catch {
        return "□";
      }
    })
    .join("");
const wrap = (text, width) => {
  const outLines = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const ch of drawable(para)) {
      if (body.widthOfTextAtSize(line + ch, SIZE) > width && line) {
        outLines.push(line);
        line = "";
      }
      line += ch;
    }
    outLines.push(line);
  }
  return outLines;
};

let page = out.addPage([PAGE_W, PAGE_H]);
let y = PAGE_H - MARGIN;
const embedded = new Map(); // `${page}|${box}` → embedded page
for (const r of rows) {
  const srcPage = src.getPage(r.page - 1);
  const ph = srcPage.getSize().height;
  const pad = 6;
  const clip = {
    left: Math.max(0, r.box.x - pad),
    right: Math.min(srcPage.getSize().width, r.box.x + r.box.w + pad),
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
  const lines = wrap(r.text, INNER);
  const need = 13 + imgH + 6 + lines.length * LEAD + GAP;
  if (y - need < MARGIN) {
    page = out.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  }
  const head = `${r.songId ?? "??"}　原书 p${r.page}　${r.frame}框　字号 ${r.size}　缺字 ${r.holes}`;
  page.drawText(drawable(head), { x: MARGIN, y: y - 10, size: 8, font: label, color: r.holes ? rgb(0.8, 0.1, 0.1) : rgb(0.35, 0.35, 0.35) });
  y -= 13;
  page.drawPage(emb, { x: MARGIN, y: y - imgH, xScale: scale, yScale: scale });
  y -= imgH + 6;
  page.drawLine({ start: { x: MARGIN, y: y + 2 }, end: { x: PAGE_W - MARGIN, y: y + 2 }, thickness: 0.3, color: rgb(0.75, 0.75, 0.75) });
  for (const l of lines) {
    page.drawText(l, { x: MARGIN, y: y - SIZE, size: SIZE, font: body, color: rgb(0, 0, 0) });
    y -= LEAD;
  }
  y -= GAP;
}

await mkdir("pdf-out", { recursive: true });
const bytes = await out.save();
await writeFile(OUT, bytes);
console.log(`→ ${OUT}（${out.getPageCount()} 页，${(bytes.length / 1e6).toFixed(1)} MB）`);
