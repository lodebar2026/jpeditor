// 差异标记版 PDF：把 pdf-diff 找出的每一处差异盖回**原件**上。
//
//   npm run build:cli && node pdf-diff.mjs && node pdf-mark.mjs
//   node pdf-mark.mjs 279 135        # 只出这几首所在的页
//   node pdf-mark.mjs --all          # 全书 666 页（默认只出有标记的页）
//   node pdf-mark.mjs --out=x.pdf
//
// 三种标记（颜色对应 pdf-diff 报告里的三档）：
//   **红** —— 页面上这个对象与 GT 不符（录错，或页面多出 GT 没有的）。做法是把该对象的
//             轮廓原样用红色再画一遍，正好盖住原来的黑字，所以「这个字变红了」。
//   **黄** —— GT 有、页面没有的内容，按原位补在旁边（黄底黑字，插在左邻居右侧）。
//   **橙** —— 字形没读出来（`�`）。是本工具的局限，不是录错，故与红分开。
//
// 位置从 `pdf-diff-marks.json` 来，那里只记「哪一页、inv.objs 里第几个」；
// 轮廓要现取——本脚本重跑一遍 extract+classify（只跑要标的页，快），
// 按下标拿回对象再 `toSvgPath`。**不把 d 串写进 json**：全书三千多处，写进去就是几 MB。
//
// 纯 Node，不起浏览器。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadCli, openPdf, CORPUS_PDF } from "./scripts/node-harness.mjs";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")));
const only = new Set(args.filter((a) => !a.startsWith("--")));
const OUT = flags.out ?? "pdf-out/diff-marked.pdf";
const MARKS = "pdf-diff-marks.json";

const { PDFDocument, rgb } = await import("pdf-lib");
const fontkit = (await import("@pdf-lib/fontkit")).default;
const { extractTtc } = await import("./scripts/ttc.mjs");

const RED = rgb(0.85, 0.05, 0.05);
const ORANGE = rgb(1, 0.5, 0);
const YELLOW = rgb(1, 0.9, 0.25);
const INK = rgb(0.15, 0.1, 0);

const data = JSON.parse(await readFile(MARKS, "utf8"));
let pages = Object.entries(data.pages).map(([p, ms]) => ({ page: Number(p), marks: ms }));
if (only.size) pages = pages.filter((p) => p.marks.some((m) => only.has(m.id)));
pages.sort((a, b) => a.page - b.page);
if (!pages.length) {
  console.log("没有要标的页");
  process.exit(0);
}
const marksOf = new Map(pages.map((p) => [p.page, p.marks]));

const cli = await loadCli();
const { doc: src, OPS } = await openPdf();

// 采样页推 profile：与 pdf-diff 一模一样，否则归类会有出入、对象下标对不上
const sample = [];
for (let p = 40; p <= 200; p += 4) {
  const g = await src.getPage(p);
  sample.push(await cli.extractVectorPage(g, OPS));
  g.cleanup();
}
const profile = cli.detectProfile(sample, "hymn500");

const orig = await PDFDocument.load(await readFile(CORPUS_PDF));
const out = await PDFDocument.create();
out.registerFontkit(fontkit);
const FONT = flags.font ?? "/System/Library/Fonts/Supplemental/Songti.ttc";
const FACE = flags.face ?? "Songti SC Regular";
const font = await out.embedFont(/\.ttc$/i.test(FONT) ? await extractTtc(FONT, FACE) : new Uint8Array(await readFile(FONT)), { subset: true });
out.setTitle("诗歌500首 · 识别差异标记");
out.setCreator("jpeditor 矢量 PDF 识别 · pdf-mark.mjs");

const keep = flags.all !== undefined ? orig.getPageIndices() : pages.map((p) => p.page - 1);
const copied = await out.copyPages(orig, keep);
copied.forEach((p) => out.addPage(p));

// 字体缺字（`♭` 之类）退回 ASCII 写法，别整条丢掉
const FALLBACK = { "♭": "b", "＃": "#" };
const canEncode = new Map();
const drawable = (ch) => {
  let ok = canEncode.get(ch);
  if (ok === undefined) {
    try {
      font.encodeText(ch);
      ok = true;
    } catch {
      ok = false;
    }
    canEncode.set(ch, ok);
  }
  return ok;
};
const encodable = (t) =>
  [...t]
    .map((ch) => (drawable(ch) ? ch : (FALLBACK[ch] ?? (drawable(FALLBACK[ch] ?? "") ? FALLBACK[ch] : ""))))
    .join("");

let drawn = 0;
let lost = 0;
for (let k = 0; k < keep.length; k++) {
  const pageNo = keep[k] + 1;
  const ms = marksOf.get(pageNo);
  if (!ms?.length) continue;
  const pg = out.getPage(k);
  const { height: H } = pg.getSize();

  const g = await src.getPage(pageNo);
  const vp = await cli.extractVectorPage(g, OPS);
  g.cleanup();
  const inv = cli.classifyPage(vp, profile);

  for (const m of ms) {
    if (m.kind === "missing") {
      const [x, y, , h] = m.box;
      const text = encodable(m.text ?? "");
      if (!text) {
        lost++;
        continue;
      }
      const size = Math.max(h * 0.9, 4);
      // 整段没印时补的字很长，别冲出版心；黄底半透明，压住的原文仍看得见
      const room = pg.getWidth() - x - 10;
      let show = text;
      while (show.length > 1 && font.widthOfTextAtSize(show + "…", size) > room) show = show.slice(0, -1);
      if (show !== text) show += "…";
      const w = font.widthOfTextAtSize(show, size);
      pg.drawRectangle({ x: x - 0.5, y: H - (y + h), width: w + 1, height: h, color: YELLOW, opacity: 0.75 });
      pg.drawText(show, { x, y: H - (y + h * 0.86), size, font, color: INK });
      drawn++;
      continue;
    }
    // 红 / 橙：把该对象的轮廓原样再画一遍盖住原字。**连描边一起盖**——
    // 书里每个字都画了 fill 与 stroke 两份，只填色会留一圈黑边。
    const o = inv.objs[m.idx];
    const color = m.kind === "unread" ? ORANGE : RED;
    // 轮廓存的是**局部坐标**，要带上对象自己的 ctm 才落到页面上（同 pdflayout/spec.ts）
    const d = o && cli.toSvgPathTransformed(o.obj.data, o.obj.ctm);
    if (d) {
      pg.drawSvgPath(d, { x: 0, y: H, color, borderColor: color, borderWidth: 0.45 });
      drawn++;
    } else {
      const [x, y, w, h] = m.box;
      pg.drawRectangle({ x, y: H - (y + h), width: w, height: h, borderColor: color, borderWidth: 0.6 });
      drawn++;
    }
  }

  // 页脚小注：这一页标了些什么
  const n = (kind) => ms.filter((m) => m.kind === kind).length;
  const ids = [...new Set(ms.map((m) => m.id))].join(" ");
  const legend = `p${pageNo} ${ids}　红 录错/多出 ${n("wrong")}　黄 GT有页面无 ${n("missing")}　橙 未读出 ${n("unread")}`;
  pg.drawRectangle({ x: 8, y: 6, width: font.widthOfTextAtSize(legend, 7) + 6, height: 11, color: rgb(1, 1, 1), opacity: 0.85 });
  pg.drawText(encodable(legend), { x: 11, y: 9, size: 7, font, color: RED });
}

await mkdir(OUT.replace(/\/[^/]*$/, ""), { recursive: true });
await writeFile(OUT, await out.save());
const bytes = (await import("node:fs")).statSync(OUT).size;
console.log(
  `标记版 PDF → ${OUT}（${out.getPageCount()} 页，${(bytes / 1048576).toFixed(1)} MB）\n` +
    `标记 ${drawn} 处：红 ${data.marks && ""}` +
    `${pages.reduce((a, p) => a + p.marks.filter((m) => m.kind === "wrong").length, 0)} / ` +
    `黄 ${pages.reduce((a, p) => a + p.marks.filter((m) => m.kind === "missing").length, 0)} / ` +
    `橙 ${pages.reduce((a, p) => a + p.marks.filter((m) => m.kind === "unread").length, 0)}` +
    `${lost ? `，字体缺字跳过 ${lost} 处` : ""}`,
);
