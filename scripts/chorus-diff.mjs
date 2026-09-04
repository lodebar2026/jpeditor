// 合唱谱（位图路）识别 ↔ GT musicxml 的**逐声部**对拍。
//
//   npm run build:cli && node scripts/chorus-diff.mjs
//   node scripts/chorus-diff.mjs --one=宁静 --v
//   node scripts/chorus-diff.mjs --bless             # 重写基线
//
// 与赞美之泉那条（`staff-diff.mjs`）的两处不同：
//   1. 那本是**一本大 PDF 切成很多首**，要先找首页、切曲目、与 GT 配对；
//      合唱谱是一曲一个目录、一份 PDF，配对是现成的，省掉整个 `staff-align.mjs`。
//   2. 那本 GT 是单声部领唱谱，一首一条音符序列；合唱谱 GT 是 SATB + 钢琴的全谱，
//      **必须逐声部比**。识别侧的声部由 `buildScore` 给出（跨系统连接），
//      与 GT 的 `<part>` 按「最像的配最像的」贪心配对。
//
// 判据一律来自 `staff-metrics.mjs`（与矢量路共用一份），别在这里另写。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { openPdf, eachPage, loadCli, loadChorus } from "./node-harness.mjs";
import { acc, shiftOct, letters } from "./staff-metrics.mjs";
import { loadT2S } from "./staff-align.mjs";

const args = process.argv.slice(2);
const argOf = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const verbose = args.includes("--v");
const only = argOf("one");
const BASE = "testdata/合唱谱/raster-baseline.json";

const cli = await loadCli();
const look = new cli.RasterGlyphLookup(JSON.parse(await readFile("src/rasteromr/rasterglyphs.json", "utf8")));
/** 歌词条的 OCR 缓存（`gen-rasterlyrics.mjs` 的产物）。没有就跳过歌词那一档。 */
let lyricOcr = null;
try {
  lyricOcr = new Map(Object.entries(JSON.parse(await readFile("src/rasteromr/rasterlyrics.json", "utf8"))));
} catch {
  console.log("（没有 src/rasteromr/rasterlyrics.json，歌词档跳过——先跑 gen-rasterlyrics.mjs）");
}

/** 繁→简 + 只留汉字。**谱面是繁体、GT 是简体**，不归一逐字比全是差异
 *  （实测「寧靜的伯利恆」对「宁静的伯利恒」一个字都对不上）。 */
const t2s = await loadT2S();
const cjk = (s0) => t2s(s0).replace(/[^\u4e00-\u9fff]/g, "");

/** GT musicxml → 第一段歌词的汉字串（旧口径，已不用）。 */
function gtLyric(xml) {
  const out = [];
  for (const m of xml.matchAll(/<lyric\b[^>]*>[\s\S]*?<\/lyric>/g)) {
    const num = /number="(\d+)"/.exec(m[0])?.[1] ?? "1";
    if (num !== "1") continue;
    for (const t of m[0].matchAll(/<text>([^<]*)<\/text>/g)) out.push(t[1]);
  }
  return out.join("").replace(/[^\u4e00-\u9fff]/g, "");
}

/**
 * GT musicxml → **逐谱表**的音符序列（`<part>` × `<staff>`）。
 *
 * **不能按 `<part>` 整个拼**：钢琴那种一个声部两行谱的，MusicXML 是
 * 「本小节第一行、`<backup>`、本小节第二行」**逐小节交替**写的，
 * 整个拼起来是两行交织的序列，与识别侧「一行谱一条序列」根本不是一回事。
 * 实测宁静的钢琴声部因此只对上 29%，而按谱表拆开之后，
 * 开头逐音都对得上（GT `A4 B4 R C5 C5 C5 E4` / `A2 E3 A3 B3`，
 * 识别 `A4 B4 C5 C5 E4` / `R A2 E3 A3 B3`）。
 *
 * `<chord/>` 附音与 `<grace/>` 倚音都不占格（与识别侧口径一致，
 * 见 `node-harness.mjs` 里那几个 `xmlXxx` 的说明）。
 */
function gtParts(xml) {
  const out = [];
  for (const m of xml.matchAll(/<part\s+id="([^"]+)"[\s\S]*?<\/part>/g)) {
    const byStaff = new Map();
    const lyrOf = new Map();
    for (const n of m[0].matchAll(/<note[ >][\s\S]*?<\/note>/g)) {
      const seg = n[0];
      if (/<grace\s*\/?>/.test(seg) || /<chord\s*\/?>/.test(seg)) continue;
      const k = /<staff>(\d+)<\/staff>/.exec(seg)?.[1] ?? "1";
      const v = /<voice>(\d+)<\/voice>/.exec(seg)?.[1] ?? "1";
      const key = k + "/" + v;
      const seq = byStaff.get(key) ?? [];
      // 第一段歌词跟着这一路走（与识别侧同口径：歌词挂在音符上）
      const ly = lyrOf.get(key) ?? [];
      for (const t of seg.matchAll(/<lyric\b[^>]*number="1"[^>]*>[\s\S]*?<\/lyric>/g))
        for (const x of t[0].matchAll(/<text>([^<]*)<\/text>/g)) ly.push(x[1]);
      lyrOf.set(key, ly);
      if (/<rest\s*\/?>/.test(seg)) seq.push("R");
      else {
        const step = /<step>([A-G])<\/step>/.exec(seg)?.[1];
        const oct = /<octave>(-?\d+)<\/octave>/.exec(seg)?.[1];
        if (step && oct !== undefined) seq.push(step + oct);
      }
      byStaff.set(key, seq);
    }
    // 每行谱只留**声部号最小**的那一路（与识别侧同口径，见 `gotParts`）
    const best = new Map();
    for (const [key, seq] of byStaff) {
      const [st, v] = key.split("/");
      const cur = best.get(st);
      if (!cur || Number(v) < Number(cur.v)) best.set(st, { v, seq });
    }
    for (const [st, { v, seq }] of [...best.entries()].sort())
      if (seq.length) out.push({ id: `${m[1]}.${st}`, seq, lyric: cjk((lyrOf.get(st + "/" + v) ?? []).join("")) });
  }
  return out;
}

/**
 * 识别结果 → **逐谱表**的音符序列，与 GT 那侧同口径。
 *
 * 谱表由 `buildScore` 的跨系统连接给出（`Part` → `ScoreStaff`，一个 `ScoreStaff`
 * 就是「各系统里同一位置的那行谱」串起来的一条谱表）。
 *
 * 试过按「在系统里排第几行」分，**更差**（音符 25% → 13%）：合唱谱的系统行数
 * 并不整齐——宁静 p1 是「钢琴前奏 2 行、2 行，然后人声加钢琴 3 行、3 行」，
 * 「第 k 行」在不同系统里根本不是同一个声部。
 */
function gotParts(entries) {
  const score = cli.buildScore(entries.map((e) => ({ page: e.page, ctx: e.ctx })));
  const byStaff = new Map();
  for (const e of entries) for (const n of e.notes) {
    const a = byStaff.get(n.staff) ?? [];
    a.push(n);
    byStaff.set(n.staff, a);
  }
  const out = [];
  score.parts.forEach((p, i) => {
    p.scoreStaves.forEach((ss, k) => {
      let lyric = "";
      // **两边都只取第一声部**。一行谱上写两个声部时，MusicXML 是
      // 「本小节第一声部、`<backup>`、本小节第二声部」写的，而识别侧的音符是按 x 排的
      // ——把两个声部都收进来，两边的序列就交织成不同的样子，比出来的是排列差异
      // 不是识别差异（实测这么做音符从 28.6% 掉到 22.2%）。
      const seq = [];
      for (const stf of ss.staves) {
        if (!stf) continue;
        for (const n of (byStaff.get(stf) ?? []).filter((x) => !x.chordExtra && !x.grace && x.voice === minVoice(stf, byStaff))) {
          seq.push(n.rest ? "R" : n.step + n.octave);
          for (const l of n.lyrics ?? []) if (l.verse === 1) lyric += l.text;
        }
      }
      if (seq.length) out.push({ id: `P${i + 1}.${k + 1}`, seq, lyric: cjk(lyric) });
    });
  });
  return out;
}

/** 这行谱上最小的声部号（`splitVoice` 从 1 起编，没拆过的就都是 1）。 */
function minVoice(stf, byStaff) {
  const a = byStaff.get(stf) ?? [];
  return a.length ? Math.min(...a.map((n) => n.voice)) : 1;
}

/** `buildScore` 分出来的声部数——跨系统连接的指标，与准确率量的不是一回事。 */
function scoreParts(entries) {
  try {
    return cli.buildScore(entries.map((e) => ({ page: e.page, ctx: e.ctx }))).parts.length;
  } catch {
    return -1;
  }
}

/** 贪心配对：每次挑「相似度最高」的一对，配掉就不再参与。 */
function pair(got, gt) {
  const pairs = [];
  const usedA = new Set();
  const usedB = new Set();
  const cand = [];
  for (let i = 0; i < got.length; i++)
    for (let j = 0; j < gt.length; j++) {
      let a = acc(got[i].seq, gt[j].seq, 24, true);
      for (const k of [-1, 1]) a = Math.max(a, acc(shiftOct(got[i].seq, k), gt[j].seq, 24, true));
      cand.push({ i, j, a });
    }
  cand.sort((x, y) => y.a - x.a);
  for (const c of cand) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i);
    usedB.add(c.j);
    pairs.push(c);
  }
  return pairs;
}

const rows = [];
for (const song of (await loadChorus()).filter((s) => !only || s.name.includes(only))) {
  if (!song.gt) continue;
  const gt = gtParts(await readFile(song.gt, "utf8"));
  for (const pdf of song.pdfs) {
    const file = pdf.split("/").pop();
    const { doc, OPS } = await openPdf(pdf);
    const entries = [];
    let carry, bars = 0, full = 0, unknown = 0, staves = 0, cleanPages = 0, allPages = 0;
    await eachPage(doc, Array.from({ length: doc.numPages }, (_, i) => i + 1), async (page, pn) => {
      const r = await cli.recognizeRasterPage(page, OPS, look, pn, { carryTime: carry, lyricOcr });
      carry = r.carryTime;
      if (!r.hasStaff) return;
      allPages++;
      // **分档**：干净位图（排版软件贴的图）线宽不到线距的两成；真扫描件（Xerox/手机拍）
      // 线更粗、还带倾斜。判据与 `gen-rasterglyphs.mjs` 建库那道闸同口径。
      if (r.unit && r.unit.lineThick <= r.unit.space * 0.2) cleanPages++;
      entries.push({ page: r.page, ctx: r.ctx, notes: r.notes });
      bars += r.bars.length;
      full += r.bars.filter((b) => b.full).length;
      unknown += r.unknown;
      staves += r.page.staves.length;
    });
    if (!entries.length) continue;
    const got = gotParts(entries);
    const nParts = scoreParts(entries);
    const pairs = pair(got, gt);
    const gtTotal = gt.reduce((a, p) => a + p.seq.length, 0);
    const gotTotal = got.reduce((a, p) => a + p.seq.length, 0);
    // 逐声部准确率，按 GT 的音符数加权
    let wn = 0, wl = 0, wd = 0, wy = 0, wyd = 0;
    for (const p of pairs) {
      const g = gt[p.j].seq;
      wn += p.a * g.length;
      wl += acc(letters(got[p.i].seq), letters(g), 24, true) * g.length;
      wd += g.length;
      // 歌词：逐声部比，按 GT 的字数加权。识别侧的歌词是 `attachLyrics` 挂在音符上的，
      // 与音符走同一条谱表，所以配对现成。字数太少的谱表（钢琴行）不入分母。
      const gy = gt[p.j].lyric ?? "";
      if (gy.length >= 8) {
        wy += acc([...(got[p.i].lyric ?? "")], [...gy]) * gy.length;
        wyd += gy.length;
      }
      if (verbose) {
        console.log(`  ${got[p.i].id}(${got[p.i].seq.length}) ↔ ${gt[p.j].id}(${g.length})  音符 ${(p.a * 100).toFixed(1)}%`);
        if (args.includes("--dump")) console.log("    " + alignText(got[p.i].seq, g, 80));
        // 分段看：准确率是开头就低，还是越往后越漂
        const seg = [];
        for (let t = 0; t < 4; t++) {
          const n = Math.ceil(g.length / 4);
          seg.push((acc(got[p.i].seq.slice(t * n, (t + 1) * n), g.slice(t * n, (t + 1) * n), 24, true) * 100).toFixed(0) + "%");
        }
        console.log(`    四等分: ${seg.join(" ")}`);
      }
    }
    const row = {
      song: song.name, file, staves, clean: cleanPages >= allPages * 0.8,
      gtParts: gt.length, gotParts: got.length, scoreParts: nParts, paired: pairs.length,
      gtNotes: gtTotal, gotNotes: gotTotal,
      noteAcc: wd ? (wn / wd) * 100 : 0, letterAcc: wd ? (wl / wd) * 100 : 0,
      barFull: bars ? (full / bars) * 100 : 0, bars, unknown,
      lyricAcc: wyd && lyricOcr ? (wy / wyd) * 100 : null,
      lyricChars: wyd,
    };
    rows.push(row);
    console.log(`${row.clean ? "[干净]" : "[扫描]"} ${song.name}/${file}  谱行${staves} 声部 ${got.length}↔${gt.length}(配上${pairs.length}，buildScore ${nParts})  ` +
      `音符 ${gotTotal}/${gtTotal}  准确率 ${row.noteAcc.toFixed(1)}%  音级 ${row.letterAcc.toFixed(1)}%  ` +
      `小节自检 ${row.barFull.toFixed(1)}%（${bars} 小节）` +
      (row.lyricAcc != null ? `  歌词 ${row.lyricAcc.toFixed(1)}%（GT ${row.lyricChars} 字）` : ""));
  }
}

// 无 GT 的那几首只出不靠 GT 的自检
for (const song of (await loadChorus()).filter((s) => !only || s.name.includes(only))) {
  if (song.gt) continue;
  for (const pdf of song.pdfs) {
    const { doc, OPS } = await openPdf(pdf);
    let carry, notes = 0, bars = 0, full = 0, staves = 0, unknown = 0, cleanPages = 0, allPages = 0;
    await eachPage(doc, Array.from({ length: doc.numPages }, (_, i) => i + 1), async (page, pn) => {
      const r = await cli.recognizeRasterPage(page, OPS, look, pn, { carryTime: carry });
      carry = r.carryTime;
      if (!r.hasStaff) return;
      allPages++;
      if (r.unit && r.unit.lineThick <= r.unit.space * 0.2) cleanPages++;
      notes += r.notes.length;
      bars += r.bars.length;
      full += r.bars.filter((b) => b.full).length;
      staves += r.page.staves.length;
      unknown += r.unknown;
    });
    if (!bars) continue;
    rows.push({ song: song.name, file: pdf.split("/").pop(), staves, clean: cleanPages >= allPages * 0.8, gtParts: 0, gotParts: 0, paired: 0, gtNotes: 0, gotNotes: notes, noteAcc: null, letterAcc: null, barFull: (full / bars) * 100, bars, unknown });
    console.log(`${cleanPages >= allPages * 0.8 ? "[干净]" : "[扫描]"} ${song.name}/${pdf.split("/").pop()}  谱行${staves} 音符${notes} 小节自检 ${((full / bars) * 100).toFixed(1)}%（${bars} 小节）  无 GT`);
  }
}

await mkdir("staff-out", { recursive: true });
await writeFile("staff-out/chorus-diff.json", JSON.stringify(rows, null, 1));

// ── 基线守门 ────────────────────────────────────────────────────────────────
// **分档汇总**：基线只守**干净位图**那一档（排版软件贴的图，本轮的目标）。
// 真扫描件（破碎.pdf 是 Xerox 300dpi、主，差遣我是 JPEG 200dpi）倾斜三四个像素、
// 谱线找不齐，混进平均会把干净那一档的涨跌淹掉——它们另记，不入基线。
const clean = rows.filter((r) => r.clean);
const scan = rows.filter((r) => !r.clean);
const avg = (a, k) => (a.length ? +(a.reduce((x, r) => x + r[k], 0) / a.length).toFixed(2) : 0);
const withGt = clean.filter((r) => r.noteAcc !== null);
const summary = {
  clean: clean.length,
  noteAcc: avg(withGt, "noteAcc"),
  letterAcc: avg(withGt, "letterAcc"),
  barFull: avg(clean, "barFull"),
  lyricAcc: avg(clean.filter((r) => r.lyricAcc != null), "lyricAcc"),
};
console.log(`\n【干净位图】${clean.length} 份（有 GT ${withGt.length} 份）：音符 ${summary.noteAcc}%、音级 ${summary.letterAcc}%；小节自检 ${summary.barFull}%` +
  (summary.lyricAcc ? `；歌词 ${summary.lyricAcc}%` : ""));
if (scan.length) {
  const sg = scan.filter((r) => r.noteAcc !== null);
  console.log(`【真扫描件】${scan.length} 份（有 GT ${sg.length} 份）：音符 ${avg(sg, "noteAcc")}%、音级 ${avg(sg, "letterAcc")}%；小节自检 ${avg(scan, "barFull")}%　——另记，不入基线`);
}

if (args.includes("--bless")) {
  await mkdir("testdata/合唱谱", { recursive: true });
  await writeFile(BASE, JSON.stringify(summary, null, 1));
  console.log(`基线已重写 → ${BASE}`);
} else {
  let base = null;
  try {
    base = JSON.parse(await readFile(BASE, "utf8"));
  } catch {
    console.log("（还没有基线，`--bless` 立一个）");
  }
  if (base) {
    const worse = Object.keys(summary).filter((k) => k !== "clean" && k !== "songs" && summary[k] < base[k] - 0.005);
    console.log(`基线：${Object.entries(base).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    if (worse.length) {
      console.log(`✗ 比基线差的档：${worse.map((k) => `${k} ${base[k]}→${summary[k]}`).join("，")}`);
      process.exitCode = 1;
    } else console.log("✓ 各档不低于基线");
  }
}

/** 逐音对齐的可读串（排查用，`--v --dump`）。`[a→b]` 读错、`(多 a)` 多出、`(缺 b)` 漏掉。 */
function alignText(A, B, n) {
  const a = A.slice(0, n), b = B.slice(0, n);
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  const op = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(""));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const c = [[d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), "m"], [d[i - 1][j] + 1, "d"], [d[i][j - 1] + 1, "i"]].sort((x, y) => x[0] - y[0])[0];
      d[i][j] = c[0];
      op[i][j] = c[1];
    }
  let i = a.length, j = b.length;
  const out = [];
  while (i > 0 || j > 0) {
    const o = i > 0 && j > 0 ? op[i][j] : i > 0 ? "d" : "i";
    if (o === "m") { out.push(a[i - 1] === b[j - 1] ? a[i - 1] : `[${a[i - 1]}→${b[j - 1]}]`); i--; j--; }
    else if (o === "d") { out.push(`(多${a[i - 1]})`); i--; }
    else { out.push(`(缺${b[j - 1]})`); j--; }
  }
  return out.reverse().join(" ");
}
