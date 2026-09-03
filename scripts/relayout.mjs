// 从版面规格把 PDF 排回去，两种模式：
//
//   node relayout.mjs --mode=outline 55-62   保真复现：按字符查回**原件的原始字形轮廓**画路径。
//                                            不依赖任何外部字体，用来做**对象级核对**——
//                                            它把「版面规格是否记全了」变成可判定的。
//   node relayout.mjs --mode=text 55-62      文字版：位置照原件，把曲线换成真文字。
//
// **两种模式都是纯 Node，不起浏览器。** text 模式经 DrawList 交 scripts/pdfwrite.mjs 出 PDF：
// 字号取同类型中位数（testdata/500/bookstyle.json，由 gen-bookstyle.mjs 统计），
// 按角色分别嵌字体，读不出的字形先按 GT 回填（testdata/500/backfill.json）。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadCli, openPdf, parsePageRange, csvRow } from "./node-harness.mjs";
import { writePdf } from "./pdfwrite.mjs";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")));
const rangeSpec = args.find((a) => !a.startsWith("--")) ?? "";
const MODE = flags.mode ?? "outline";
const OUTDIR = flags.out ?? "pdf-out";
const OUTNAME = flags.name ?? "诗歌500首-文字版.pdf";
const TOL = Number(flags.tol ?? 0.5); // 位置容差（pt）

const cli = await loadCli();
const { doc, OPS } = await openPdf();
const dict = JSON.parse(await readFile("testdata/500/glyphdict.json", "utf8"));
const style = cli.validateBookStyle(JSON.parse(await readFile(flags.style ?? "testdata/500/bookstyle.json", "utf8"))).style;
/** 读不出的字形按形状键回填（GT 对齐的结果，见 backfill.ts）。没有这份文件也能跑。 */
const backfill = await readFile(flags.backfill ?? "testdata/500/backfill.json", "utf8").then(JSON.parse).catch(() => ({ byKey: {} }));
// 字典里同一字形的分身都指向代表键（`g`），补字表按代表键存，查的时候先折过去。
const fallbackChar = (key) => backfill.byKey?.[dict.classes[key]?.g ?? key] ?? null;
const pm = JSON.parse(await readFile("testdata/500/pagemap.json", "utf8"));
const byKey = new Map(Object.entries(dict.classes));
const charOf = new Map();
for (const c of byKey.values()) if (c.char) charOf.set(c.key, c.char);
/** 字符 → 一个代表字形（取实例最多的那个类），重排 outline 模式按字取回原轮廓。 */
const glyphOfChar = new Map();
for (const c of byKey.values()) {
  if (!c.char || !c.d || !c.bbox) continue;
  const cur = glyphOfChar.get(c.char);
  if (!cur || c.count > cur.count) glyphOfChar.set(c.char, c);
}

const sample = [];
for (let p = 40; p <= 200; p += 4) {
  const g = await doc.getPage(p);
  sample.push(await cli.extractVectorPage(g, OPS));
  g.cleanup();
}
const profile = cli.detectProfile(sample, "hymn500");
const entriesByPage = new Map();
for (const m of pm.map) {
  const a = entriesByPage.get(m.page) ?? [];
  a.push(m);
  entriesByPage.set(m.page, a);
}

const pages = parsePageRange(rangeSpec, doc.numPages);
await mkdir(OUTDIR, { recursive: true });

/** 把一个字形按目标 bbox 摆好，产出 SVG <path>。 */
function placeGlyph(cls, x, yBottom, size, fill = "#000") {
  const [gx0, gy0, gx1, gy1] = cls.bbox;
  const gh = Math.max(gy1 - gy0, 0.01);
  const s = size / gh;
  // PDF 的 y 轴朝上、SVG 朝下，故 scale(s, -s)
  return `<path transform="translate(${x.toFixed(2)},${yBottom.toFixed(2)}) scale(${s.toFixed(4)},${(-s).toFixed(4)}) translate(${(-gx0).toFixed(2)},${(-gy0).toFixed(2)})" d="${cls.d}" fill="${fill}"/>`;
}

const report = [];
const drawPages = [];
const unreadTally = new Map();
for (const pn of pages) {
  const g = await doc.getPage(pn);
  const vec = await cli.extractVectorPage(g, OPS);
  g.cleanup();
  const inv = cli.classifyPage(vec, profile);
  const spec = cli.buildPageSpec(vec, inv, (o) => { const key = cli.shapeKey(o.obj.data);
  // lyricYi 是按几何认出来的「一」，它的轮廓在字典里跟扁横条撞键，不能查字典
  return { ch: o.cls === "lyricYi" ? "一" : charOf.get(key) ?? null, key };
}, entriesByPage.get(pn) ?? []);

  const [W, H] = spec.size;

  // text 模式：规格 → DrawList，位置照原件、样式来自 bookstyle（见 src/pdflayout/drawlist.ts）
  if (MODE === "text") {
    const r = cli.specToDrawPage(spec, style, { fallbackChar });
    drawPages.push(r.page);
    for (const u of r.unreadKeys) {
      const cur = unreadTally.get(u.key) ?? { shape_key: u.key, instances: 0, first_page: pn, role: u.role, song_no: spec.songs[0]?.id ?? null };
      cur.instances++;
      unreadTally.set(u.key, cur);
    }
    report.push({
      page: pn,
      kind: spec.kind,
      w: W,
      h: H,
      objects: inv.objs.filter((o) => !o.dup).length,
      chars: r.page.items.reduce((a, i) => a + (i.t === "text" ? [...i.text].length : 0), 0),
      filled: r.filled,
      unread: r.unread,
      keptOwnSize: r.keptOwnSize,
    });
    continue;
  }

  const parts = [];
  const placed = []; // 重排出来的对象（用于核对）

  // 1) 结构：线框原样画（它们不是字，直接照抄几何）
  for (const f of spec.frames) {
    if (f.type === "image" || f.type === "shading") continue; // 位图/渐变另行处理
    const d = f.dash?.length ? ` stroke-dasharray="${f.dash.join(",")}"` : "";
    parts.push(
      `<rect x="${f.box.x.toFixed(2)}" y="${f.box.y.toFixed(2)}" width="${Math.max(f.box.w, 0.1).toFixed(2)}" height="${Math.max(f.box.h, 0.1).toFixed(2)}" fill="#000"${d}/>`,
    );
    placed.push({ kind: "frame", box: f.box });
  }
  // 乐谱记号（减时线、增时线、小节线、弧、点）：从**版面规格**里取，不再回头翻 inv——
  // 规格必须自足，否则「规格是否记全了」就无从判定。
  for (const m of spec.marks) {
    if (m.d) {
      parts.push(`<path d="${m.d}" fill="#000"/>`);
    } else {
      parts.push(
        `<rect x="${m.box.x.toFixed(2)}" y="${m.box.y.toFixed(2)}" width="${Math.max(m.box.w, 0.15).toFixed(2)}" height="${Math.max(m.box.h, 0.15).toFixed(2)}" fill="#000"/>`,
      );
    }
    placed.push({ kind: m.cls, box: m.box });
  }

  // 2) 文字
  const runs = [
    spec.header,
    spec.footer,
    ...spec.textLines,
    ...spec.storyBoxes.flatMap((b) => b.lines),
    ...spec.songs.flatMap((s) => [s.numberRun, s.titleRun, s.keyMeterRun, ...s.creditRuns, ...s.systems.flatMap((y) => [...y.chordLines, ...y.lyricLines])]),
  ].filter(Boolean);
  const noteRuns = spec.songs.flatMap((s) =>
    s.systems.map((y) => ({ size: y.noteBottom - y.noteTop, baselineY: y.noteBottom, chars: y.notes })),
  );

  const esc = (t) => t.replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" })[c]);
  let missingGlyph = 0;
  const textEls = [];
  for (const r of [...runs, ...noteRuns]) {
    if (MODE === "text") {
      // **一行一个 `<text>`，用 x 坐标列表逐字定位**（SVG 的 x 支持给一串值）。
      // 简谱歌词要逐字对齐音符，不能交给 PDF 自动排版；但也不能每个字单开一个 <text>——
      // 那样 pdfjs 提取时会在字与字之间插空格，「全然向祢」就搜不出来了。
      const txt = r.chars.map((c) => (c.ch === "\ufffd" ? " " : c.ch)).join("");
      if (txt.trim()) {
        textEls.push({
          y: r.baselineY,
          x: r.chars[0].x,
          svg: `<text x="${r.chars.map((c) => c.x.toFixed(2)).join(" ")}" y="${r.baselineY.toFixed(2)}" font-size="${r.size.toFixed(2)}">${esc(txt)}</text>`,
        });
      }
      for (const ch of r.chars) placed.push({ kind: "glyph", box: { x: ch.x, y: ch.y, w: ch.w, h: ch.h } });
      continue;
    }
    for (const ch of r.chars) {
      {
        // 保真复现：按**形状键**取回原件的那条轮廓。
        // 不走「字符 → 代表字形」——读不出的字压根没有代表字形，
        // 同一个字的不同字号也会互相串（那一版缺字形 673，全等于读不出的字数）。
        const cls = byKey.get(ch.key) ?? glyphOfChar.get(ch.ch);
        if (!cls?.d || !cls?.bbox) {
          missingGlyph++;
          continue;
        }
        // 用**这个字自己的** y/h，不用整行的中位数：标点只占字格下部，
        // 歌词里的「一」悬在字格中部，拿行中位数摆会差出好几个点。
        parts.push(placeGlyph(cls, ch.x, ch.y + ch.h, ch.h));
      }
      placed.push({ kind: "glyph", box: { x: ch.x, y: ch.y, w: ch.w, h: ch.h } });
    }
  }
  // 文字元素按阅读顺序（先上后下、再左到右）输出，PDF 里的文本顺序才是顺的
  textEls.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const t of textEls) parts.push(t.svg);

  const fontCss =
    MODE === "text"
      ? `<style>text{font-family:"Songti SC","STSong",serif;fill:#000}</style>`
      : "";
  // 尺寸带 pt 单位：这样 1 个用户单位就是 1pt，与 PDF 原件同尺度，
  // 打印出来的页面才和原件一样大（Chromium 默认把无单位数值当 CSS px，会缩掉四分之一）。
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}pt" height="${H}pt" viewBox="0 0 ${W} ${H}">` +
    `<rect width="100%" height="100%" fill="#fff"/>${fontCss}${parts.join("")}</svg>`;
  await writeFile(`${OUTDIR}/p${String(pn).padStart(3, "0")}.svg`, svg);

  // 3) 对象级核对（只在 outline 模式有意义：字形同源才配得上）
  const orig = inv.objs.filter((o) => !o.dup).map((o) => o.obj.bbox);
  const used = new Array(placed.length).fill(false);
  let matched = 0;
  let displaced = 0;
  const offsets = [];
  for (const ob of orig) {
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < placed.length; k++) {
      if (used[k]) continue;
      const pb = placed[k].box;
      const d = Math.hypot(ob.x - pb.x, ob.y + ob.h - (pb.y + pb.h));
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0 && bestD < 6) {
      used[best] = true;
      matched++;
      offsets.push(bestD);
      if (bestD > TOL) displaced++;
    }
  }
  offsets.sort((a, b) => a - b);
  if (process.env.DIAG) {
    const pc = {};
    for (const q of placed) pc[q.kind] = (pc[q.kind] ?? 0) + 1;
    const oc = {};
    for (const o of inv.objs) if (!o.dup) oc[o.cls] = (oc[o.cls] ?? 0) + 1;
    console.log(`  p${pn} 重排:`, JSON.stringify(pc));
    console.log(`  p${pn} 原件:`, JSON.stringify(oc));
  }
  report.push({
    page: pn,
    kind: spec.kind,
    w: W,
    h: H,
    marks: spec.marks,
    texts: MODE === "text" ? [...runs, ...noteRuns] : [],
    objects: orig.length,
    emitted: placed.length,
    matched,
    unplaced: orig.length - matched,
    spurious: placed.length - matched,
    displaced,
    p95: offsets.length ? offsets[Math.floor(offsets.length * 0.95)] : 0,
    missingGlyph,
    unread: spec.coverage.unread,
  });
}

// text 模式：DrawList → PDF（scripts/pdfwrite.mjs，A/B 两路共用的唯一写 PDF 处）。
if (MODE === "text") {
  const out = `${OUTDIR}/${OUTNAME}`;
  const res = await writePdf({ style, source: "relayout", pages: drawPages }, { out, title: "诗歌500首（原位文字版）", strict: "strict" in flags });
  const sumOf = (f) => report.reduce((a, r) => a + f(r), 0);
  const miss = new Map();
  for (const m of res.missing) miss.set(m.ch, (miss.get(m.ch) ?? 0) + 1);
  const stat = { pages: res.pages, bytes: res.bytes, chars: sumOf((r) => r.chars), filled: sumOf((r) => r.filled), unread: sumOf((r) => r.unread), keptOwnSize: sumOf((r) => r.keptOwnSize), fontMissing: res.missing.length };
  await writeFile(`${OUTDIR}/relayout-report.json`, JSON.stringify({ mode: MODE, style: style.id, ...stat, missingFonts: res.missingFonts, missingChars: [...miss].sort((a, b) => b[1] - a[1]).slice(0, 50), missingDetail: res.missing.slice(0, 20) }, null, 2));
  await writeFile(
    `${OUTDIR}/relayout.csv`,
    "\ufeff" + [csvRow(["页", "类型", "对象数", "字数", "回填", "未读出", "保留原字号"]), ...report.map((r) => csvRow([r.page, r.kind, r.objects, r.chars, r.filled, r.unread, r.keptOwnSize]))].join("\n"),
  );
  console.log(
    `文字版 PDF → ${out}（${res.pages} 页，${(res.bytes / 1048576).toFixed(1)} MB）\n` +
      `字 ${stat.chars}，GT 回填 ${stat.filled}，仍读不出 ${stat.unread}，保留原字号的行 ${stat.keptOwnSize}，字体缺字 ${stat.fontMissing}` +
      (res.missingFonts.length ? `\n⚠ 字体找不到：${res.missingFonts.map((f) => `${f.id}(${f.family})`).join(" ")}` : ""),
  );
  console.log(`→ ${OUTDIR}/relayout-report.json, ${OUTDIR}/relayout.csv`);

  if ("db" in flags) {
    const { openDb, newRunId, recordRun, recordMetrics, recordUnread } = await import("./checkdb.mjs");
    const db = openDb();
    const runId = newRunId("relayout");
    recordRun(db, { run_id: runId, route: "relayout", config: style.id, artifact: out, page_count: res.pages, byte_size: res.bytes, cmd: `relayout.mjs --mode=text ${rangeSpec}`.trim() });
    recordMetrics(db, runId, {
      chars: stat.chars, filled: stat.filled, unread: stat.unread,
      kept_own_size: stat.keptOwnSize, font_missing: stat.fontMissing, pages: res.pages,
    });
    recordUnread(db, [...unreadTally.values()].sort((a, b) => b.instances - a.instances));
    db.close();
    console.log(`→ 校对.db：批次 ${runId}，未读字形 ${unreadTally.size} 类`);
  }
  process.exit(process.exitCode ?? 0);
}

const sum = (f) => report.reduce((a, r) => a + f(r), 0);
console.log(`模式 ${MODE}，${report.length} 页`);
console.log(`原件对象 ${sum((r) => r.objects)}，重排 ${sum((r) => r.emitted)}，配上 ${sum((r) => r.matched)}`);
console.log(`**unplaced ${sum((r) => r.unplaced)}**（原件有、重排没有）  **spurious ${sum((r) => r.spurious)}**（重排多出）`);
console.log(`位置偏差 >${TOL}pt 的 ${sum((r) => r.displaced)}，缺字形 ${sum((r) => r.missingGlyph)}，读不出的字 ${sum((r) => r.unread)}`);
const worst = [...report].sort((a, b) => b.unplaced + b.spurious - (a.unplaced + a.spurious)).slice(0, 6);
console.log("最差页:", worst.map((r) => `p${r.page}(缺${r.unplaced}/多${r.spurious})`).join(" "));
console.log(`→ ${OUTDIR}/p<页>.svg${MODE === "text" ? " + .pdf" : ""}`);
