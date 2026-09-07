// 五线谱识别的**逐曲错误诊断报告**（HTML）。参照简谱那条路的 `gen-song-analysis.mjs`：
// 报告的价值不在指标，而在指标之外——一眼看得见错在哪一块墨上、错在管线的哪一步。
//
//   npm run build:cli && node scripts/chorus-diff.mjs --errors --one=宁静
//   node scripts/gen-staff-analysis.mjs 宁静                 # 位图路（合唱谱）
//   node scripts/gen-staff-analysis.mjs 宁静 --pdf=1         # 只出第二份底本（扫描件）
//   node scripts/staff-diff.mjs --errors --one=赞美之泉
//   node scripts/gen-staff-analysis.mjs 赞美之泉 --zmzq      # 矢量路（赞美之泉）
//
// 产物是**一个目录**（不是单文件 HTML）：`staff-out/analysis-<曲名>/index.html` +
// `img/*.png`。整页图与逐步中间过程图都放得下，也方便单独拿一张图去比对。
//
// **一个准确率数字都不新算**：错误清单读 `chorus-diff.mjs --errors` /
// `staff-diff.mjs --errors` 的产物（`staff-out/*-errors.json`），错因归类用
// `staff-errors.mjs` 那一份判据，漏音病因用同一处的 `blameGap`。
// 指标仍以 `chorus-diff.mjs` / `staff-diff.mjs` 为准，这里只管「看得见」。
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { openPdf, eachPage, loadCli, loadChorus, gtUsable, gtClefs, writePng, binToGray, ZMZQ_PDF, ZMZQ_GT_DIR } from "./node-harness.mjs";
import { blameGap, gapBoxOf } from "./staff-errors.mjs";

const args = process.argv.slice(2);
const argOf = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const name = args.find((a) => !a.startsWith("--"));
const zmzq = args.includes("--zmzq");
if (!name) {
  console.log("用法: node scripts/gen-staff-analysis.mjs <曲名子串> [--pdf=N] [--zmzq] [--out=目录] [--refresh]");
  process.exit(1);
}
const OUT = argOf("out") ?? `staff-out/analysis-${name}`;
/**
 * 一页一类最多出几张裁图（`--max=0` 不限）。扫描件一份能有一千五百多处错，
 * 张张出图就是二十几兆、开都开不动；超出的仍进表格与底图叠加，只是不单独出图。
 */
const MAXSHOT = Number(argOf("max") ?? 12);
/** 一份底本一个子目录（`<OUT>/<底本>/index.html` + `img/`）；多份时 `<OUT>/index.html` 是索引页。 */
const dirOf = (file) => `${OUT}/${file.replace(/\.pdf$/i, "").replace(/[/\\]/g, "_")}`;

// ── 错误清单：读既有产物，不在这里重算 ──────────────────────────────────────
const ERRFILE = zmzq ? "staff-out/staff-errors.json" : "staff-out/chorus-errors.json";
let allErrors = [];
if (existsSync(ERRFILE)) allErrors = JSON.parse(await readFile(ERRFILE, "utf8"));
// 符号那几档（谱号/时值/附点/临时升降/圆滑线）出自另一个脚本，文件按「干净/扫描 × 单曲」
// 分了好几份（`chorus-symbol-errors[-scan][-<曲名>].json`）——**全读进来再按曲名过滤**，
// 省得让人记住自己上次是带哪个参数跑的。
if (!zmzq) {
  const { readdir } = await import("node:fs/promises");
  try {
    for (const f of (await readdir("staff-out")).filter((x) => /^chorus-symbol-errors.*\.json$/.test(x)))
      allErrors.push(...JSON.parse(await readFile(`staff-out/${f}`, "utf8")));
  } catch { /* 没有就只出音符与歌词档 */ }
}
if (!allErrors.length)
  console.log(
    `（没读到错例清单，只出中间过程——先跑 ` +
      `node scripts/${zmzq ? "staff-diff" : "chorus-diff"}.mjs --errors --one=${name}` +
      `${zmzq ? "" : ` 与 node scripts/chorus-symbols.mjs --errors --one=${name}`}）`,
  );

const cli = await loadCli();
// 全清重来：上一轮的图（这一轮已经不出了、或底本换了名）会一直残着
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

/**
 * 一份底本一份报告。同一曲的干净位图与真扫描件是**两件不同的东西**
 * （病灶不同、页数不同、错例不同），挤进一个文件只会互相盖住。
 * 每项：`{ dir, file, partial, errs, lost, sections, orphans }`。
 */
const reports = [];
/** 当前这一份底本的页素材（一份跑完就收进 `reports`）。 */
let sections = [];
/**
 * GT 那一侧的谱号（`<part id>.<staff>` → 谱号与声部名）。
 * **只看 GT**：识别侧的谱号自己也可能读错，拿它解释音高等于用嫌疑人作证。
 */
let clefs = new Map();
/**
 * 落不到任何页上的错误：序列开头就漏（没有左邻居）、或左右邻居分处两页。
 * **不能悄悄丢掉**——它们照样是错，只是这份报告定位不到，得单列出来说清楚。
 */
let orphans = [];

/**
 * 错误类型 → 颜色。**一处定义**，底图叠加框、裁图里的标记框、错例块的边条共用同一套：
 * 三处颜色对不上，报告就得靠人两边对着数。
 */
const ERR_KIND = {
  漏掉: { key: "miss", css: "#e88a00", rgb: [232, 138, 0], hint: "GT 有、识别没有" },
  多出: { key: "ins", css: "#0a72d8", rgb: [10, 114, 216], hint: "识别多出来的" },
  读错: { key: "sub", css: "#e11", rgb: [225, 17, 17], hint: "音高读错" },
};
const OTHER_KIND = { key: "other", css: "#909", rgb: [153, 0, 153], hint: "其它" };
const kindOf = (e) => ERR_KIND[e.kind] ?? OTHER_KIND;

/**
 * 错例裁图的取景框：**纵向一律扩到整行谱**（五条线 + 上下各三格的加线区）。
 * 只框符头附近的那一小块看不出音高——不知道那个头骑在第几线上，就没法判断读错没读错。
 * 横向只取符头两侧几格：整行谱那么宽，全铺出来反而找不到人。
 *
 * @param staves `page.staves`（有 `box`）；找不到落点就退回围着盒子放宽几格
 */
function shotBox(staves, box, sp) {
  const cy = box.y + box.h / 2;
  let best = null, bestD = Infinity;
  for (const st of staves) {
    const d = cy < st.box.top ? st.box.top - cy : cy > st.box.bottom ? cy - st.box.bottom : 0;
    if (d < bestD) { bestD = d; best = st; }
  }
  const halfW = Math.max(box.w / 2 + sp * 2, sp * 3);
  const x = box.x + box.w / 2 - halfW;
  // 离最近的谱行还有五格远，多半不在谱行上（页眉、歌词带），别硬扩
  if (!best || bestD > sp * 5) return { x, y: box.y - sp * 1.5, w: halfW * 2, h: box.h + sp * 3 };
  // **取景框必须包住标记框**：那个音骑在高音加线上、或落在谱行下方的歌词带时，
  // 光按谱行取景会把标记圈挤到图外——看见了五条线却看不见错在哪个音，白搭。
  const y0 = Math.min(best.box.top - sp * 3, box.y - sp);
  const y1 = Math.max(best.box.bottom + sp * 3, box.y + box.h + sp);
  return { x, y: y0, w: halfW * 2, h: y1 - y0 };
}

/** 错误清单按页归组，同时把定位不到的挑出来。 */
function groupErrors(errs) {
  // 同一条错例可能被读进来两次（`--scan` 与不带 `--scan` 各出一份文件），按内容去重
  const seen = new Set();
  errs = errs.filter((e) => {
    const k = JSON.stringify([e.cat ?? "note", e.staff, e.kind, e.gt, e.got, e.why, e.at, e.src?.page, e.src?.box]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const byPage = new Map();
  const lost = [];
  for (const e of errs) {
    const pn = e.src?.page ?? e.prev?.page ?? null;
    if (pn == null) lost.push(e);
    else byPage.set(pn, [...(byPage.get(pn) ?? []), e]);
  }
  return { byPage, lost, total: errs.length };
}

// ══ 位图路 ═════════════════════════════════════════════════════════════════
async function runRaster() {
  const song = (await loadChorus()).find((s) => s.name.includes(name));
  if (!song) {
    console.log(`没有这首。可选：\n  ` + (await loadChorus()).map((s) => s.name).join("\n  "));
    process.exit(1);
  }
  const look = new cli.RasterGlyphLookup(JSON.parse(await readFile("src/rasteromr/rasterglyphs.json", "utf8")));
  look.templates = cli.outlineTemplates(JSON.parse(await readFile("src/staffomr/glyphmap.json", "utf8")));
  let lyricOcr = null, labelOcr = null;
  try {
    lyricOcr = new Map(Object.entries(JSON.parse(await readFile("src/rasteromr/rasterlyrics.json", "utf8"))));
  } catch { /* 没缓存就少歌词那一档 */ }
  try {
    labelOcr = new Map(Object.entries(JSON.parse(await readFile("src/rasteromr/rasterlabels.json", "utf8"))));
  } catch { /* 同上 */ }

  if (song.gt) clefs = gtClefs(await readFile(song.gt, "utf8"));
  const only = argOf("pdf");
  const pdfs = only !== undefined ? [song.pdfs[Number(only)]].filter(Boolean) : song.pdfs;
  for (const pdf of pdfs) {
    const file = pdf.split("/").pop();
    const errs = allErrors.filter((e) => e.song === song.name && e.file === file);
    const { byPage, lost, total } = groupErrors(errs);
    sections = [];
    orphans = lost.map((e) => ({ ...e, file }));
    const dir = dirOf(file);
    await mkdir(`${dir}/img`, { recursive: true });
    const { doc, OPS } = await openPdf(pdf);
    let carry;
    await eachPage(doc, Array.from({ length: doc.numPages }, (_, i) => i + 1), async (page, pn) => {
      const r = await cli.recognizeRasterPage(page, OPS, look, pn, { carryTime: carry, lyricOcr, labelOcr, debug: true });
      carry = r.carryTime;
      if (!r.hasStaff || !r.raster) return;
      sections.push(await rasterSection(r, dir, pn, byPage.get(pn) ?? []));
    });
    console.log(`  ${file}: ${sections.length} 页、错例 ${total}`);
    reports.push({ song: song.name, dir, file, partial: !gtUsable(pdf), errs: total, lost: lost.length, sections, orphans });
  }
}

/** 一页位图的素材：整页图 + 各层叠加框 + 这一页的错例裁图。 */
async function rasterSection(r, dir, pn, mine) {
  const tag = `p${pn}`;
  const bin = r.raster.bin;
  const sp = r.unit?.space ?? 10;
  const put = async (suffix, b) => {
    const g = binToGray(b);
    await writePng(`${dir}/img/${tag}-${suffix}.png`, g.gray, g.w, g.h);
    return `img/${tag}-${suffix}.png`;
  };
  const imgs = { bin: await put("bin", bin) };
  if (r.debugNl) imgs.nolines = await put("nolines", r.debugNl);
  if (r.debugRest) imgs.rest = await put("rest", r.debugRest);

  // ── 叠加层（页面坐标 = 位图像素，SVG 直接用）──────────────────────────
  const B = (b) => ({ x: b.left, y: b.top, w: b.right - b.left, h: b.bottom - b.top });
  const layers = {
    staff: r.page.staves.map((s) => B(s.box)),
    head: r.page.symbols.filter((s) => s.ownerStaff).map((s) => B(s.box)),
    bar: r.page.segsWithTag("BarLine").map((s) => ({ x: s.cx - 2, y: s.top, w: 4, h: s.bottom - s.top })),
    stem: r.page.segsWithTag("Stem").map((s) => ({ x: s.cx - 1.5, y: s.top, w: 3, h: s.bottom - s.top })),
    beam: r.beams.map((b) => B(b.box)),
    leger: r.page.segs.filter((s) => s.hasTag?.("Leger")).map((s) => ({ x: s.left, y: s.cy - 2, w: s.right - s.left, h: 4 })),
    lyric: r.lyricStrips.flatMap((s) => s.cells.map((c) => c.box)),
    // 线性记号（弧 / 松叶 / 力度）：识别出来的那些，画出来才知道认到了哪几条
    arc: r.slurs.map((a) => ({ x: Math.min(a.lx, a.rx), y: Math.min(a.ly, a.ry) - sp * 0.5, w: Math.abs(a.rx - a.lx), h: Math.abs(a.ry - a.ly) + sp })),
    wedge: r.wedges.map((w) => ({ x: w.x0, y: w.cy - sp, w: w.x1 - w.x0, h: sp * 2 })),
    dyn: r.dynamics.map((d) => ({ x: d.px - 2, y: d.py - sp, w: sp * (1 + d.text.length), h: sp * 2 })),
    // 无主 contour：口径同 `raster-unclaimed.mjs`（账本里没人认领的那些团）
    unclaimed: (r.ledger?.unclaimed() ?? []).filter((c) => c.bbox.w > sp * 0.3 && c.bbox.h > sp * 0.3).map((c) => c.bbox),
  };

  // ── 这一页的错例：裁图 + 病因 ───────────────────────────────────────────
  const boxOf = (e) => (e.src?.box ? B(e.src.box) : null);
  const errors = [];
  /** 这一页各类别已经出了几张图（`MAXSHOT` 的计数器）。 */
  const shotN = new Map();
  for (const [k, e] of mine.entries()) {
    // `mark` = 底图上高亮的那一小块（就是这个音）；`crop` = 裁图的取景框（含整行谱线）
    const row = { ...e, img: null, blame: null, mark: null };
    const bx = boxOf(e);
    if (bx) row.mark = bx;
    else if (e.kind === "漏掉" && e.prev?.box && e.next?.box && e.prev.page === e.next.page) {
      const gb = gapBoxOf(e.prev.box, e.next.box, sp);
      row.mark = { x: gb.x0, y: gb.y0, w: gb.x1 - gb.x0, h: gb.y1 - gb.y0 };
      // 漏掉的音没有盒，病因去问认领账本（判据同 `raster-gap.mjs`，共用 `blameGap`）
      if (r.ledger && r.contours) row.blame = blameGap(r, e);
    }
    if (row.mark && (!MAXSHOT || (shotN.get(row.cat ?? "note") ?? 0) < MAXSHOT)) {
      shotN.set(row.cat ?? "note", (shotN.get(row.cat ?? "note") ?? 0) + 1);
      const box = shotBox(r.page.staves, row.mark, sp);
      const Z = 4;
      const g = binToGray(bin, box, Z);
      // **裁图里要圈出是哪一个音**：一个取景框里好几个音符，不圈就得靠猜。
      // 框按错误类型着色，与底图叠加层、下面的错例块同一套颜色。
      const rgb = markUp(g, { x: (row.mark.x - box.x) * Z, y: (row.mark.y - box.y) * Z, w: row.mark.w * Z, h: row.mark.h * Z }, kindOf(row).rgb);
      await writePng(`${dir}/img/${tag}-e${k}.png`, rgb, g.w, g.h);
      row.img = `img/${tag}-e${k}.png`;
    }
    errors.push(row);
  }

  return {
    kind: "raster",
    pn, tag,
    w: bin.w, h: bin.h,
    imgs, layers, errors,
    facts: [
      ["底本形态", `${r.raster.kind}（${r.raster.kind === "mask" ? "干净位图" : "真扫描件"}）`],
      ["尺寸", `${bin.w}×${bin.h} px`],
      ["线距 / 线宽", r.unit ? `${r.unit.space.toFixed(1)} / ${r.unit.lineThick.toFixed(1)} px` : "—"],
      ["谱行 / 系统", `${r.page.staves.length} / ${r.page.systems.length}`],
      ["归属符号", String(layers.head.length)],
      ["未定字形", String(r.unknown)],
      ["小节自检", `${r.bars.filter((b) => b.full).length}/${r.bars.length} 平`],
      ["歌词条", `切 ${r.lyricStats.rows} 命中 ${r.lyricStats.hit} 格数相符 ${r.lyricStats.parity}`],
      ["声部标签", [...r.staffLabels.entries()].map(([i, n]) => `${i}:${n}`).join(" ") || "—"],
      ["无主墨团", String(layers.unclaimed.length)],
    ],
    bars: r.bars.filter((b) => !b.full).map((b) => ({ staff: r.page.staves.indexOf(b.staff), index: b.index, sum: b.sum, expect: b.expect, count: b.count })),
    strips: r.lyricStrips,
  };
}

/** 灰度图转 RGB，并在上面描一个 2px 的彩色框（框在图外的部分自然被裁掉）。 */
function markUp(g, box, [R, G, Bb]) {
  const out = new Uint8Array(g.w * g.h * 3);
  for (let i = 0; i < g.w * g.h; i++) {
    out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = g.gray[i];
  }
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= g.w || y >= g.h) return;
    const i = (y * g.w + x) * 3;
    out[i] = R;
    out[i + 1] = G;
    out[i + 2] = Bb;
  };
  const x0 = Math.round(box.x), y0 = Math.round(box.y);
  const x1 = Math.round(box.x + box.w), y1 = Math.round(box.y + box.h);
  for (let t = 0; t < 2; t++) {
    for (let x = x0 - t; x <= x1 + t; x++) { set(x, y0 - t); set(x, y1 + t); }
    for (let y = y0 - t; y <= y1 + t; y++) { set(x0 - t, y); set(x1 + t, y); }
  }
  return out;
}

// ══ 矢量路 ═════════════════════════════════════════════════════════════════
async function runVector() {
  const { alignSongs } = await import("./staff-align.mjs");
  const CACHE = "staff-out/spans.json";
  let spans = null;
  if (!args.includes("--refresh") && existsSync(CACHE)) spans = JSON.parse(await readFile(CACHE, "utf8"));
  if (!spans) {
    console.log("跑一遍全书对齐（约 70 秒，结果缓存到 staff-out/spans.json，下次直接读）…");
    const { results } = await alignSongs({ quiet: true });
    spans = results.map((r) => ({ id: r.song.id, zh: r.song.zh, en: r.song.en, file: r.song.file, from: r.from, to: r.to }));
    await mkdir("staff-out", { recursive: true });
    await writeFile(CACHE, JSON.stringify(spans, null, 1));
  }
  const hit = spans.find((s) => (s.zh ?? "").includes(name) || (s.en ?? "").includes(name) || s.id === name || s.file.includes(name));
  if (!hit) {
    console.log(`没有这首（在 ${spans.length} 首对上的曲子里）。试试 --refresh，或换个子串。`);
    process.exit(1);
  }
  try {
    const gtXml = await readFile(`${ZMZQ_GT_DIR}/${hit.file}`, "utf8");
    // 矢量路的 GT 是单声部主旋律，错例的 `staff` 恒为 `melody`，谱号就取第一个谱表的
    const first = [...gtClefs(gtXml).values()][0];
    if (first) clefs = new Map([["melody", first]]);
  } catch { /* GT 读不到就不标谱号 */ }
  const errs = allErrors.filter((e) => e.id === hit.id);
  const { byPage, lost, total } = groupErrors(errs);
  const file = `p${hit.from}-${hit.to}`;
  const dir = dirOf(file);
  await mkdir(`${dir}/img`, { recursive: true });
  orphans = lost.map((e) => ({ ...e, file }));
  console.log(`  ${hit.id} ${hit.zh || hit.en}：页 ${hit.from}-${hit.to}，错例 ${errs.length}`);

  const look = cli.makeLookup(JSON.parse(await readFile("src/staffomr/glyphmap.json", "utf8")));
  let textLookup = null;
  try {
    textLookup = new cli.TextGlyphLookup(JSON.parse(await readFile("src/staffomr/lyricglyphs.json", "utf8")));
  } catch { /* 没有正文字形字典也能跑 */ }
  const pages = [];
  for (let p = hit.from; p <= hit.to; p++) pages.push(p);
  const { doc, OPS } = await openPdf(ZMZQ_PDF);
  let carry;
  await eachPage(doc, pages, async (page, pn) => {
    const r = await cli.recognizeStaffPage(page, OPS, look, pn, { textLookup: textLookup ?? undefined, carryTime: carry });
    carry = r.carryTime;
    if (!r.hasStaff) return;
    sections.push(vectorSection(r, pn, byPage.get(pn) ?? []));
  });
  // 底图靠浏览器光栅化（矢量路手里没有位图）。**先识别再光栅化**：错例的盒要等识别出来，
  // 裁图也在浏览器那一趟顺手做掉（Node 这边没有 PNG 解码器，裁不了已成图的整页）。
  const crops = {};
  for (const sec of sections)
    crops[sec.pn] = sec.errors.filter((e) => e.crop).map((e) => ({ box: e.crop, mark: e.mark, color: kindOf(e).css }));
  const shot = await rasterizePdfPages(dir, pages, crops);
  for (const sec of sections) {
    sec.imgs.bin = shot.pages.get(sec.pn) ?? null;
    let k = 0;
    for (const e of sec.errors) if (e.crop) e.img = shot.crops.get(`${sec.pn}-${k++}`) ?? null;
  }
  reports.push({ song: `${hit.id} ${hit.zh || hit.en}`, dir, file, partial: false, errs: total, lost: lost.length, sections, orphans });
}

/** 一页矢量谱的素材：整页底图（浏览器光栅化）+ 对象层叠加框。 */
function vectorSection(r, pn, mine) {
  const B = (b) => ({ x: b.left, y: b.top, w: b.right - b.left, h: b.bottom - b.top });
  const layers = {
    staff: r.page.staves.map((s) => B(s.box)),
    head: r.page.symbols.filter((s) => s.ownerStaff).map((s) => B(s.box)),
    bar: r.page.segsWithTag("BarLine").map((s) => ({ x: s.cx - 1, y: s.top, w: 2, h: s.bottom - s.top })),
    stem: r.page.segsWithTag("Stem").map((s) => ({ x: s.cx - 1, y: s.top, w: 2, h: s.bottom - s.top })),
    beam: r.beams.map((b) => B(b.box)),
    unclaimed: r.page.objs.filter((o) => !o.sym && !o.run && o.box).map((o) => B(o.box)).slice(0, 400),
  };
  const sp = r.page.normalStaffSpace || r.page.space || 8;
  const errors = mine.map((e) => {
    let mark = e.src?.box ? B(e.src.box) : null;
    // 矢量路没有认领账本（那是位图那条的东西），但「漏掉的音该在哪一段」照样算得出
    if (!mark && e.kind === "漏掉" && e.prev?.box && e.next?.box && e.prev.page === e.next.page) {
      const gb = gapBoxOf(e.prev.box, e.next.box, sp);
      mark = { x: gb.x0, y: gb.y0, w: gb.x1 - gb.x0, h: gb.y1 - gb.y0 };
    }
    return { ...e, img: null, blame: null, mark, crop: mark ? shotBox(r.page.staves, mark, sp) : null };
  });
  return {
    kind: "vector",
    pn, tag: `p${pn}`,
    w: r.page.width, h: r.page.height,
    imgs: { bin: null },
    layers, errors,
    facts: [
      ["页面尺寸", `${r.page.width.toFixed(0)}×${r.page.height.toFixed(0)} pt`],
      ["谱行 / 系统", `${r.page.staves.length} / ${r.page.systems.length}`],
      ["归属符号", String(layers.head.length)],
      ["没有归属的对象", String(r.unknown)],
      ["小节自检", `${r.bars.filter((b) => b.full).length}/${r.bars.length} 平`],
      ["弧 / 八度段 / 房号", `${r.slurs.length} / ${r.octaves.length} / ${r.voltas.length}`],
    ],
    bars: r.bars.filter((b) => !b.full).map((b) => ({ staff: r.page.staves.indexOf(b.staff), index: b.index, sum: b.sum, expect: b.expect, count: b.count })),
    strips: [],
  };
}

/**
 * 用本地 Edge + pdfjs 把这几页光栅化成 PNG（引导照 `scripts/staff-crop.mjs`），
 * 顺手把 `crops[页号]` 里那些盒各裁一张放大图出来。
 */
async function rasterizePdfPages(dir, pages, crops = {}) {
  const { createServer } = await import("node:http");
  const { dirname, basename, join, normalize } = await import("node:path");
  const { mimeOf, launchPage } = await import("./harness.mjs");
  const pdfDir = dirname(ZMZQ_PDF), pdfName = basename(ZMZQ_PDF);
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent((req.url ?? "/").split("?")[0]);
      const root = p.startsWith("/corpus/") ? pdfDir : process.cwd();
      if (p.startsWith("/corpus/")) p = "/" + p.slice(8);
      // **先读文件再发头**：读不到就走 404，头已经发出去了就没法改了
      const file = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ""));
      const body = await readFile(file);
      res.writeHead(200, { "content-type": mimeOf(file) });
      res.end(body);
    } catch {
      res.writeHead(404).end("nope");
    }
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const { page, browser } = await launchPage({ quiet: true });
  await page.goto(`http://127.0.0.1:${port}/index.html`).catch(() => {});
  await page.setContent("<body style='margin:0;background:#fff'></body>");
  const out = { pages: new Map(), crops: new Map() };
  const b64s = await page.evaluate(
    async ({ port, pdfName, pages, crops }) => {
      const base = `http://127.0.0.1:${port}`;
      const pdfjs = await import(`${base}/node_modules/pdfjs-dist/build/pdf.mjs`);
      pdfjs.GlobalWorkerOptions.workerSrc = `${base}/node_modules/pdfjs-dist/build/pdf.worker.min.mjs`;
      const doc = await pdfjs.getDocument({ url: `${base}/corpus/${encodeURIComponent(pdfName)}`, wasmUrl: `${base}/node_modules/pdfjs-dist/wasm/` }).promise;
      const res = { pages: {}, crops: {} };
      for (const pn of pages) {
        const p = await doc.getPage(pn);
        // scale=2：识别坐标是 scale=1 的设备坐标，SVG 用 viewBox 映射，图本身出大一倍看得清
        const vp = p.getViewport({ scale: 2 });
        const c = document.createElement("canvas");
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        const g = c.getContext("2d");
        g.fillStyle = "#fff";
        g.fillRect(0, 0, c.width, c.height);
        await p.render({ canvasContext: g, viewport: vp }).promise;
        res.pages[pn] = c.toDataURL("image/png").split(",")[1];
        // 错例裁图：识别坐标 ×2（底图就是 scale=2 画的），再放大 4 倍看笔画
        (crops[pn] ?? []).forEach(({ box: b, mark, color }, k) => {
          const S = 2, Z = 3, pad = 4;
          const cc = document.createElement("canvas");
          cc.width = Math.max(1, Math.round((b.w + 2 * pad) * S * Z));
          cc.height = Math.max(1, Math.round((b.h + 2 * pad) * S * Z));
          const gg = cc.getContext("2d");
          gg.imageSmoothingEnabled = false;
          gg.fillStyle = "#fff";
          gg.fillRect(0, 0, cc.width, cc.height);
          gg.drawImage(c, (b.x - pad) * S, (b.y - pad) * S, (b.w + 2 * pad) * S, (b.h + 2 * pad) * S, 0, 0, cc.width, cc.height);
          // 圈出是哪一个音（颜色与底图叠加层、错例块同一套）
          if (mark) {
            gg.strokeStyle = color;
            gg.lineWidth = 2;
            gg.strokeRect((mark.x - b.x + pad) * S * Z, (mark.y - b.y + pad) * S * Z, mark.w * S * Z, mark.h * S * Z);
          }
          res.crops[`${pn}-${k}`] = cc.toDataURL("image/png").split(",")[1];
        });
      }
      return res;
    },
    { port, pdfName, pages, crops },
  );
  await browser.close();
  server.close();
  for (const [pn, b64] of Object.entries(b64s.pages)) {
    await writeFile(`${dir}/img/p${pn}.png`, Buffer.from(b64, "base64"));
    out.pages.set(Number(pn), `img/p${pn}.png`);
  }
  for (const [key, b64] of Object.entries(b64s.crops)) {
    await writeFile(`${dir}/img/e${key}.png`, Buffer.from(b64, "base64"));
    out.crops.set(key, `img/e${key}.png`);
  }
  return out;
}

if (zmzq) await runVector();
else await runRaster();
if (!reports.some((r) => r.sections.length)) {
  console.log("这首没有认出谱表的页，出不了报告");
  process.exit(1);
}

// ══ HTML ═══════════════════════════════════════════════════════════════════
// 骨架与配色照 `gen-song-analysis.mjs`（简谱那份），好让两条路的报告看起来是一套东西。
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** 判语里的 `**…**` 是给终端看的，进 HTML 换成真的加粗。 */
const bold = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
/** 这一行谱的 GT 谱号（数线判音高全靠它）。GT 里没有就不标，别瞎猜。 */
function clefText(staff) {
  const c = clefs.get(staff);
  if (!c) return "";
  return `<span class="clef">（${esc(c.text)}${c.name ? ` · ${esc(c.name)}` : ""}）</span>`;
}

/** 认领人列表按种类计数：一团大墨能被二十条符杠认领，逐个列出等于没说。 */
function countUp(list) {
  const m = new Map();
  for (const k of list) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(" ");
}

/** 错例的类别。分类的理由与错因排行一样：**各类的分母不是一回事**
 *  （一个数音、一个数字、一个数谱行），混一张表占比就没有意义。 */
const CATS = [
  ["note", "音符"],
  ["lyric", "歌词"],
  ["duration", "时值"],
  ["dots", "附点"],
  ["accidental", "临时升降"],
  ["slur", "圆滑线"],
  ["tie", "连音线"],
  ["wedge", "松叶"],
  ["dynamic", "力度"],
  ["clef", "谱号"],
];
const catLabel = (c) => CATS.find(([k]) => k === c)?.[1] ?? c ?? "音符";

const LAYERS = [
  ["staff", "谱行", "#39f"],
  ["head", "归属符号", "#e11"],
  ["stem", "符干", "#0a0"],
  ["beam", "符杠", "#f80"],
  ["bar", "小节线", "#909"],
  ["leger", "加线", "#0aa"],
  ["lyric", "歌词字格", "#c60"],
  ["arc", "弧（slur/tie）", "#c0f"],
  ["wedge", "松叶", "#0aa"],
  ["dyn", "力度", "#a60"],
  ["unclaimed", "无主墨", "#888"],
];

/** 错例配色的图例（底图叠加框 / 裁图里的圈 / 错例块边条，三处共用一套）。 */
const ERR_LEGEND =
  Object.entries(ERR_KIND)
    .map(([k, v]) => `<span style="color:${v.css};font-weight:bold">■ ${k}</span>（${v.hint}）`)
    .join("　") + `　<span style="color:${OTHER_KIND.css};font-weight:bold">■ 其它</span>（${OTHER_KIND.hint}）`;

/** 按 `why` 排一张错因表。「未分类」置顶——那些才是要人去看图的。 */
function whyTable(rows) {
  const t = new Map();
  for (const e of rows) t.set(e.why, (t.get(e.why) ?? 0) + 1);
  const order = [...t].sort((a, b) => (a[0] === "未分类" ? -1 : b[0] === "未分类" ? 1 : b[1] - a[1]));
  return `<table class="sum"><tr><th>错因</th><th>处数</th><th>占比</th></tr>
  ${order.map(([why, n]) => `<tr><td class="l why${why === "未分类" ? " bad" : ""}">${esc(why)}</td><td>${n}</td><td>${((100 * n) / rows.length).toFixed(1)}%</td></tr>`).join("")}
  </table>`;
}

/** 一页的底图 + SVG 叠加层。图是外部文件，坐标一律用识别坐标（viewBox 负责映射）。 */
function stage(sec) {
  const rects = (key, color) =>
    (sec.layers[key] ?? [])
      .map((b) => `<rect class="l-${key}" x="${(b.x ?? b.left).toFixed(1)}" y="${(b.y ?? b.top).toFixed(1)}" width="${(b.w ?? 0).toFixed(1)}" height="${(b.h ?? 0).toFixed(1)}" stroke="${color}"/>`)
      .join("");
  // 错例编号要与「逐条错误」的 #N 对得上：编号按 sec.errors 的下标，不是按有盒的那些重排
  const nCat = new Map(), nKind = new Map();
  const errRects = sec.errors
    .map((e, i) => {
      if (!e.mark) return "";
      const { css: c, key } = kindOf(e);
      const cat = e.cat ?? "note";
      nCat.set(cat, (nCat.get(cat) ?? 0) + 1);
      nKind.set(key, (nKind.get(key) ?? 0) + 1);
      const at = `class="ec" data-cat="${cat}" data-kind="${key}"`;
      return `<rect ${at} x="${e.mark.x.toFixed(1)}" y="${e.mark.y.toFixed(1)}" width="${e.mark.w.toFixed(1)}" height="${e.mark.h.toFixed(1)}" stroke="${c}"/><text ${at} x="${e.mark.x.toFixed(1)}" y="${(e.mark.y - 3).toFixed(1)}" fill="${c}">${i + 1}</text>`;
    })
    .join("");
  // **错例两组开关，取交集**：一组筛类别（这一页的时值错都落在哪儿？），
  // 一组筛性质（漏的那些是不是挤在同一段墨上？）。混在一起就只能一条条数。
  const catToggles = CATS.filter(([k]) => nCat.get(k))
    .map(([k, label]) => `<label><input type="checkbox" data-cat="${k}" checked> ${label} ${nCat.get(k)}</label>`)
    .join("");
  const kindToggles = [...Object.entries(ERR_KIND), ["其它", OTHER_KIND]]
    .filter(([, v]) => nKind.get(v.key))
    .map(([label, v]) => `<label style="color:${v.css}"><input type="checkbox" data-kind="${v.key}" checked> ${label} ${nKind.get(v.key)}</label>`)
    .join("");
  const toggles = LAYERS.filter(([k]) => (sec.layers[k] ?? []).length)
    .map(([k, label, c]) => `<label style="color:${c}"><input type="checkbox" data-l="${k}"${k === "head" || k === "staff" ? " checked" : ""}> ${label}</label>`)
    .join("");
  return `<div class="ctl" data-for="${sec.tag}">${toggles}
  ${catToggles ? `<span class="sep">｜类别</span>${catToggles}` : ""}
  ${kindToggles ? `<span class="sep">｜性质</span>${kindToggles}` : ""}
  <label class="zoom">缩放 <input type="range" min="30" max="300" value="100" data-zoom></label></div>
  <div class="stage" id="st-${sec.tag}" style="width:100%">
    ${sec.imgs.bin ? `<img src="${sec.imgs.bin}" loading="lazy">` : '<div class="muted">（没有底图）</div>'}
    <svg viewBox="0 0 ${sec.w} ${sec.h}" preserveAspectRatio="none">${LAYERS.map(([k, , c]) => rects(k, c)).join("")}${errRects}</svg>
  </div>`;
}

/** 一条错例。裁图超出 `--max` 时只出文字，不出图。 */
function errBox(e, i) {
  const c = kindOf(e).css;
  let h = `<div class="errbox" style="border-color:${c};border-left-width:6px"><b style="color:${c}">#${i + 1} ${esc(e.kind)}</b>
    <span class="cat">${esc(catLabel(e.cat))}</span>　
    GT=<span class="ok">${esc(e.gt ?? "—")}</span> → 识别 <span class="bad">${esc(e.got ?? "—")}</span>
    ${e.step != null ? `　级差 ${e.step > 0 ? "+" : ""}${e.step}` : ""}
    ${e.pitch ? `　音 ${esc(e.pitch)}` : ""}
    　错因 <span class="why">${esc(e.why)}</span>　谱行 ${esc(e.staff ?? "—")}${clefText(e.staff)}
    ${e.mark ? `　位置 ${e.mark.x | 0},${e.mark.y | 0}` : ""}`;
  if (e.blame)
    h += `<div>病因（<code>blameGap</code>，同 <code>raster-gap.mjs</code>）：${bold(e.blame.size)}${
      e.blame.w != null ? `　这团墨 ${e.blame.w.toFixed(1)}×${e.blame.h.toFixed(1)} 格` : ""
    }${e.blame.claims?.length ? `　被 <code>${esc(countUp(e.blame.claims))}</code> 认走` : e.blame.contour ? "　<b>没人认领</b>" : ""}</div>`;
  if (e.img) h += `<img src="${e.img}" alt="错例 ${i + 1}" loading="lazy">`;
  else if (!e.mark) h += `<div class="muted">（这一处没有盒，定位不到——多半跨页，或左右邻居不在同一页）</div>`;
  else h += `<div class="muted">（超出 <code>--max=${MAXSHOT}</code>，只标在底图上没单独出图）</div>`;
  return h + `</div>`;
}

/** 出一份底本的报告：一张总览 + 逐页面板，顶上一条导航切换。 */
async function writeReport(rep) {
  const { sections, orphans } = rep;
  const allErr = sections.flatMap((s) => s.errors);
  const byCat = new Map();
  for (const e of allErr) byCat.set(e.cat ?? "note", [...(byCat.get(e.cat ?? "note") ?? []), e]);

  // ── 总览面板 ──────────────────────────────────────────────────────────
  let ov = `<table class="sum"><tr><th>底本</th><th>错例</th><th>落到页上</th><th>页</th><th>说明</th></tr>
  <tr><td class="l">${esc(rep.file)}</td><td>${rep.errs}</td><td>${rep.errs - rep.lost}</td><td>${sections.length}</td><td>${rep.partial ? "节选，不进准确率分母" : "—"}</td></tr>
  </table>`;

  if (!allErrors.length)
    ov += `<p class="muted">（没读到错例清单，只出中间过程。先跑 <code>node scripts/${zmzq ? "staff-diff" : "chorus-diff"}.mjs --errors --one=${esc(name)}</code>${
      zmzq ? "" : ` 与 <code>node scripts/chorus-symbols.mjs --errors --one=${esc(name)}</code>`
    }）</p>`;
  else if (!allErr.length) ov += `<p class="ok">✓ 这份底本与 GT 一致，没有错例。下面是中间过程。</p>`;
  else {
    ov += `<h2>各类错例</h2>
    <p class="muted">判据在 <code>scripts/staff-errors.mjs</code>（与 <code>${zmzq ? "staff-diff" : "chorus-diff"} --errors</code>、
    <code>chorus-symbols --errors</code> 的排行同一份）。<b>各类分开数</b>——一个数音、一个数字、一个数谱行，
    混一张表占比就没有意义。</p>
    <table class="sum"><tr><th>类别</th><th>处数</th><th>头号错因</th></tr>
    ${CATS.filter(([k]) => byCat.get(k)?.length)
      .map(([k, label]) => {
        const rows = byCat.get(k);
        const t = new Map();
        for (const e of rows) t.set(e.why, (t.get(e.why) ?? 0) + 1);
        const top = [...t].sort((a, b) => b[1] - a[1])[0];
        return `<tr><td class="l"><a href="#" data-goto="cat-${k}">${esc(label)}</a></td><td>${rows.length}</td><td class="l why">${esc(top[0])} ${top[1]}</td></tr>`;
      })
      .join("")}
    </table>`;
    for (const [k, label] of CATS) {
      const rows = byCat.get(k);
      if (!rows?.length) continue;
      ov += `<h3 id="cat-${k}">${esc(label)} · ${rows.length} 处</h3>${whyTable(rows)}`;
    }
  }

  if (orphans.length)
    ov += `<h2>定位不到的 ${orphans.length} 处</h2>
    <p class="muted">这些照样是错，只是这份报告落不到页上：<b>序列开头就漏</b>（没有左邻居可参照）、
    左右邻居分处两页，或那个符号根本没认出来（谱号认不出就没有盒）。</p>
    <table class="sum"><tr><th>类别</th><th>类型</th><th>GT</th><th>识别</th><th>错因</th><th>谱行</th></tr>
    ${orphans.map((e) => `<tr><td>${esc(catLabel(e.cat))}</td><td>${esc(e.kind)}</td><td>${esc(e.gt ?? "—")}</td><td>${esc(e.got ?? "—")}</td><td class="l why">${esc(e.why)}</td><td>${esc(e.staff ?? "—")}${clefText(e.staff)}</td></tr>`).join("")}
    </table>`;

  // ── 逐页面板 ──────────────────────────────────────────────────────────
  const panels = sections.map((sec) => {
    let h = `<table class="sum"><tr>${sec.facts.map(([k]) => `<th>${esc(k)}</th>`).join("")}</tr>
    <tr>${sec.facts.map(([, v]) => `<td>${esc(v)}</td>`).join("")}</tr></table>
    ${stage(sec)}`;

    if (sec.imgs.nolines || sec.imgs.rest) {
      h += `<h3>中间过程 · 抹掉原语之后</h3>
      <p class="muted"><b>被当原语抹掉的墨就是这里丢的</b>：谱线、符干、符杠抹掉之后剩下的才送去找块。
      对着上面那张原图看——原图上有、这里没有的，就是抹过头了。</p>`;
      if (sec.imgs.nolines) h += `<div class="stage" style="width:100%"><img src="${sec.imgs.nolines}" loading="lazy"></div>`;
      if (sec.imgs.rest) h += `<h4>休止符那一路的余图</h4><div class="stage" style="width:100%"><img src="${sec.imgs.rest}" loading="lazy"></div>`;
    }

    if (sec.bars.length)
      h += `<h3>小节自检不平的 ${sec.bars.length} 处</h3>
      <p class="muted">不靠 GT 的自检（<code>checkBars</code>）：一小节里音符时值之和对不上拍号，那一小节多半读错了。</p>
      <table class="sum"><tr><th>谱行</th><th>第几小节</th><th>时值和</th><th>该是</th><th>音符数</th></tr>
      ${sec.bars.map((b) => `<tr><td>${b.staff}</td><td>${b.index + 1}</td><td class="bad">${b.sum.toFixed(3)}</td><td>${b.expect.toFixed(3)}</td><td>${b.count}</td></tr>`).join("")}
      </table>`;

    // 逐条错误**按类别分组**，组内保持 sec.errors 的下标（与底图上的编号一致）
    const idx = new Map(sec.errors.map((e, i) => [e, i]));
    for (const [k, label] of CATS) {
      const rows = sec.errors.filter((e) => (e.cat ?? "note") === k);
      if (!rows.length) continue;
      h += `<h3>${esc(label)} · ${rows.length} 处</h3>` + rows.map((e) => errBox(e, idx.get(e))).join("");
    }
    return { pn: sec.pn, tag: sec.tag, html: h, errs: sec.errors.length };
  });

  const nav =
    `<a href="#" class="on" data-panel="ov">总览</a>` +
    panels.map((p) => `<a href="#" data-panel="${p.tag}">p${p.pn}${p.errs ? `<b>·${p.errs}</b>` : ""}</a>`).join("");

  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>五线谱识别诊断 · ${esc(rep.song)} · ${esc(rep.file)}</title>
<style>
 body{font:15px/1.75 -apple-system,"PingFang SC",sans-serif;max-width:1180px;margin:0 auto;padding:0 24px 40px;color:#1a1a1a}
 h1{font-size:24px;margin:20px 0 8px} h2{margin-top:36px;border-bottom:2px solid #39f;padding-bottom:6px;color:#136}
 h3{margin-top:26px;color:#345} h4{margin:18px 0 6px;color:#456}
 .muted{color:#777} code{background:#f2f4f7;padding:1px 5px;border-radius:4px}
 .flow{background:#eef6ff;border-left:4px solid #39f;padding:10px 16px;border-radius:0 6px 6px 0;margin:12px 0}
 nav{position:sticky;top:0;z-index:9;background:#fff;border-bottom:1px solid #dde;padding:8px 0;margin-bottom:8px;display:flex;flex-wrap:wrap;gap:4px}
 nav a{display:inline-block;padding:3px 10px;border:1px solid #ccd;border-radius:5px;color:#136;text-decoration:none;font-size:13px}
 nav a:hover{background:#eef6ff} nav a.on{background:#136;color:#fff;border-color:#136}
 nav a b{color:#e88a00;font-weight:bold} nav a.on b{color:#ffd}
 table.sum{border-collapse:collapse;margin:10px 0;font-size:14px}
 .sum th,.sum td{border:1px solid #ccc;padding:4px 10px;text-align:center} .sum th{background:#f0f4f8}
 .sum td.l{text-align:left}
 .errbox{background:#fafafa;border:1px solid #ccc;border-radius:8px;padding:12px 16px;margin:14px 0}
 .errbox img{display:block;border:1px solid #ccc;background:#fff;image-rendering:pixelated;max-width:100%;margin:8px 0}
 .errbox .cat{background:#eef;border-radius:4px;padding:1px 7px;font-size:13px;color:#446}
 .stage{position:relative;display:inline-block;border:1px solid #ddd;background:#fff}
 .stage img{display:block;width:100%}
 .stage svg{position:absolute;inset:0;width:100%;height:100%}
 .stage svg rect{fill:none;stroke-width:1.6;vector-effect:non-scaling-stroke}
 .stage svg text{font:bold 11px sans-serif}
 .ctl{margin:10px 0 4px;font-size:13px} .ctl label{margin-right:14px;white-space:nowrap}
 .ctl .sep{color:#999;margin-right:10px}
 .bad{color:#e11;font-weight:bold} .ok{color:#080;font-weight:bold}
 .why{font-family:ui-monospace,monospace}
 .clef{color:#0a7;font-weight:bold}
 .panel{display:none} .panel.on{display:block}
</style></head><body>
<nav>${nav}</nav>
<h1>五线谱识别诊断 · ${esc(rep.song)}<span class="muted"> · ${esc(rep.file)}</span></h1>
<div class="flow"><b>这份报告不出指标</b>——准确率以 <code>${zmzq ? "staff-diff.mjs" : "chorus-diff.mjs / chorus-symbols.mjs"}</code> 为准。
这里回答的是另一个问题：<b>错在哪一块墨上、错在管线的哪一步</b>。<br>
识别管线（<code>src/${zmzq ? "staffomr" : "rasteromr"}/</code>）：${
    zmzq
      ? "矢量对象 → 字形字典认符号 → 谱表/符头/符干/符杠 → 小节与时值 → 声部与弧 → MusicXML"
      : "取图二值 → 谱线与线距 → 抹原语找块 → contour 与认领账本 → 符头判别器 → 字形字典 → 小节与时值 → 歌词条"
  }。<br>
<b>错例配色</b>（底图叠加框 / 裁图里的圈 / 错例块边条，三处同一套）：${ERR_LEGEND}<br>
裁图<b>纵向取整行谱</b>（五条线 + 上下三格的加线区），不然看不出那个头骑在第几线上；框圈的就是出错的那个音。
每条错例标着<b>那一行谱的 GT 谱号</b>，数线判音高用。</div>
<div class="panel on" id="pl-ov">${ov}</div>
${panels.map((p) => `<div class="panel" id="pl-${p.tag}"><h2>第 ${p.pn} 页</h2>${p.html}</div>`).join("")}
<script>
// 导航：一次只显示一个面板。整份底本上千处错，全渲染出来页面开都开不动。
const show = (id) => {
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("on", p.id === "pl-" + id));
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.panel === id));
  window.scrollTo(0, 0);
};
document.querySelectorAll("nav a").forEach((a) =>
  a.addEventListener("click", (ev) => { ev.preventDefault(); show(a.dataset.panel); }));
document.querySelectorAll("[data-goto]").forEach((a) =>
  a.addEventListener("click", (ev) => { ev.preventDefault(); document.getElementById(a.dataset.goto)?.scrollIntoView(); }));
// 叠加层开关：图层各管各的；错例要**类别与性质都勾上**才显示（两组取交集）。
document.querySelectorAll(".ctl").forEach((ctl) => {
  const st = document.getElementById("st-" + ctl.dataset.for);
  const sync = () => {
    ctl.querySelectorAll("input[data-l]").forEach((cb) => {
      st.querySelectorAll(".l-" + cb.dataset.l).forEach((el) => { el.style.display = cb.checked ? "" : "none"; });
    });
    const cats = new Set([...ctl.querySelectorAll("input[data-cat]")].filter((c) => c.checked).map((c) => c.dataset.cat));
    const kinds = new Set([...ctl.querySelectorAll("input[data-kind]")].filter((c) => c.checked).map((c) => c.dataset.kind));
    st.querySelectorAll(".ec").forEach((el) => {
      el.style.display = cats.has(el.dataset.cat) && kinds.has(el.dataset.kind) ? "" : "none";
    });
  };
  ctl.addEventListener("input", (ev) => {
    if (ev.target.dataset.zoom !== undefined) st.style.width = ev.target.value + "%";
    else sync();
  });
  sync();
});
</script></body></html>`;

  await writeFile(`${rep.dir}/index.html`, html);
  const rel = rep.dir.slice(OUT.length + 1);
  console.log(`  → ${rep.dir}/index.html（${sections.length} 页，错例 ${allErr.length} 处，HTML ${(html.length / 1024).toFixed(0)}KB）`);
  const t = new Map();
  for (const e of allErr) t.set(e.why, (t.get(e.why) ?? 0) + 1);
  const top = [...t].sort((a, b) => b[1] - a[1])[0];
  return {
    rel,
    pages: sections.length,
    errs: allErr.length,
    kind: sections[0]?.facts.find((f) => f[0] === "底本形态" || f[0] === "页面尺寸")?.[1] ?? "—",
    top: top ? `${top[0]} ${top[1]}` : "—",
  };
}

const done = [];
for (const rep of reports) done.push({ ...(await writeReport(rep)), rep });

// **每份底本各出各的**，再给一张索引页把它们串起来：同一曲的干净位图与真扫描件
// 病灶不同、页数不同、错例不同，挤进一个文件只会互相盖住。
// 只有一份时索引页照出——报告一律在子目录里，进 `<OUT>/` 总得有个入口。
{
  const idx = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>五线谱识别诊断 · ${esc(name)}</title>
<style>body{font:15px/1.9 -apple-system,"PingFang SC",sans-serif;max-width:820px;margin:0 auto;padding:32px}
 h1{font-size:24px} table{border-collapse:collapse;margin:16px 0;font-size:14px}
 th,td{border:1px solid #ccc;padding:6px 12px;text-align:center} th{background:#f0f4f8} td.l{text-align:left}
 a{color:#136}</style></head><body>
<h1>五线谱识别诊断 · ${esc(name)}</h1>
<p>这一曲有 ${done.length} 份底本，<b>各出各的报告</b>——干净位图与真扫描件病灶不同、页数不同、错例不同，
挤进一个文件只会互相盖住。</p>
<table><tr><th>底本</th><th>形态</th><th>页</th><th>错例</th><th>头号错因</th><th>说明</th></tr>
${done.map((d) => `<tr><td class="l"><a href="${encodeURI(d.rel)}/index.html">${esc(d.rep.file)}</a></td><td>${esc(d.kind)}</td><td>${d.pages}</td><td>${d.errs}</td><td class="l">${esc(d.top)}</td><td>${d.rep.partial ? "节选，不进准确率分母" : "—"}</td></tr>`).join("")}
</table></body></html>`;
  await writeFile(`${OUT}/index.html`, idx);
  console.log(`索引页 → ${OUT}/index.html（${done.length} 份底本）`);
}
