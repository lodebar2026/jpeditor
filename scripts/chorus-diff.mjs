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
import { openPdf, eachPage, loadCli, loadChorus, gtUsable, xmlLyricVerses } from "./node-harness.mjs";
import { acc, shiftOct, letters } from "./staff-metrics.mjs";
import { loadT2S } from "./staff-align.mjs";

const args = process.argv.slice(2);
const argOf = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const verbose = args.includes("--v");
const only = argOf("one");
const BASE = "testdata/合唱谱/raster-baseline.json";
const MAP = "testdata/合唱谱/staffmap.json";

/**
 * **人工的「印谱行 ↔ GT 谱表」映射**（`--genmap` 出草稿，再手改）。
 *
 * 为什么要人工：跨系统连接（`buildScore`）与识别是两件事，混在一个数里
 * 谁涨谁跌都看不清；而这份映射一首曲子只有几行，代价比反复调 `sameToken` 小得多。
 * 有映射时**不再贪心配对**，逐 staff 直比。
 *
 * 形状（键是「曲名/文件名」）：
 *   { "破碎/S014320OC.pdf": {
 *       "byRowCount": { "7": ["P1.1","P2.1",…], "5": […], "2": [null,null] },
 *       "systems":    { "12": [ … ] }        // 可选：按系统序号（0 起）覆盖
 *   } }
 * `null` = 这一行谱不入分母（伴奏行、GT 里没有的行）。
 */
let staffMap = null;
try {
  staffMap = JSON.parse(await readFile(MAP, "utf8"));
} catch {
  /* 没有映射表就走旧的贪心配对 */
}

const cli = await loadCli();
const look = new cli.RasterGlyphLookup(JSON.parse(await readFile("src/rasteromr/rasterglyphs.json", "utf8")));
// 谱号要拿模板再验一道（`bootstrapClefs`）：模板表从矢量路的字形字典来
look.templates = cli.outlineTemplates(JSON.parse(await readFile("src/staffomr/glyphmap.json", "utf8")));
/** 歌词条的 OCR 缓存（`gen-rasterlyrics.mjs` 的产物）。没有就跳过歌词那一档。 */
let lyricOcr = null;
try {
  lyricOcr = new Map(Object.entries(JSON.parse(await readFile("src/rasteromr/rasterlyrics.json", "utf8"))));
} catch {
  console.log("（没有 src/rasteromr/rasterlyrics.json，歌词档跳过——先跑 gen-rasterlyrics.mjs）");
}

/** 繁→简 + 只留汉字。**谱面是繁体、GT 是简体**，不归一逐字比全是差异
 *  （实测「寧靜的伯利恆」对「宁静的伯利恒」一个字都对不上）。 */
// 声部标签的 OCR 缓存（`gen-rasterlabels.mjs` 的产物）。没有就只是标签那一项不表态。
let labelOcr = null;
try {
  labelOcr = new Map(Object.entries(JSON.parse(await readFile("src/rasteromr/rasterlabels.json", "utf8"))));
} catch {
  /* 还没生成 */
}

const t2s = await loadT2S();
const cjk = (s0) => t2s(s0).replace(/[^\u4e00-\u9fff]/g, "");

/** 与识别侧 verse 1 对拍，兼容数字、缺省和 Sibelius 的 partNverse1。 */
const firstLyric = (note) => xmlLyricVerses(note).find((v) => v.verse === 1)?.chars ?? "";

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
      ly.push(firstLyric(seg));
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
 * GT musicxml → **逐小节、逐谱表**的音符与歌词。`gtSections` 从它推分段。
 */
function gtMeasures(xml) {
  const out = new Map(); // id -> Map(measure -> { seq, lyric, sounding })
  for (const m of xml.matchAll(/<part\s+id="([^"]+)"[\s\S]*?<\/part>/g)) {
    const pid = m[1];
    for (const mm of m[0].matchAll(/<measure\b[^>]*number="(\d+)"[^>]*>([\s\S]*?)<\/measure>/g)) {
      const num = Number(mm[1]);
      const byKey = new Map();
      for (const n of mm[2].matchAll(/<note[ >][\s\S]*?<\/note>/g)) {
        const seg = n[0];
        if (/<grace\s*\/?>/.test(seg)) continue;
        const st = /<staff>(\d+)<\/staff>/.exec(seg)?.[1] ?? "1";
        const v = /<voice>(\d+)<\/voice>/.exec(seg)?.[1] ?? "1";
        const key = st + "/" + v;
        const e = byKey.get(key) ?? { seq: [], lyric: "", sounding: false, chords: [] };
        // **和弦成员**：`<chord/>` 的音跟在主音之后，并进上一个和弦；其余各自成一个和弦。
        // 「只比最低音」的那条序列照旧（`seq`），和弦档另比一份（见 `chordTokens`）。
        if (/<chord\s*\/?>/.test(seg)) {
          const p = /<step>([A-G])<\/step>[\s\S]*?<octave>(-?\d+)<\/octave>/.exec(seg);
          if (p && e.chords.length) e.chords[e.chords.length - 1].push(p[1] + p[2]);
          byKey.set(key, e);
          continue;
        }
        {
          const p = /<step>([A-G])<\/step>[\s\S]*?<octave>(-?\d+)<\/octave>/.exec(seg);
          e.chords.push(/<rest\s*\/?>/.test(seg) ? ["R"] : p ? [p[1] + p[2]] : []);
        }
        if (/<rest\s*\/?>/.test(seg)) e.seq.push("R");
        else {
          const step = /<step>([A-G])<\/step>/.exec(seg)?.[1];
          const oct = /<octave>(-?\d+)<\/octave>/.exec(seg)?.[1];
          if (step && oct !== undefined) {
            e.seq.push(step + oct);
            e.sounding = true;
          }
        }
        e.lyric += firstLyric(seg);
        byKey.set(key, e);
      }
      // 每行谱只留声部号最小的那一路（与识别侧同口径）
      const best = new Map();
      for (const [key, e] of byKey) {
        const [st, v] = key.split("/");
        const cur = best.get(st);
        if (!cur || Number(v) < Number(cur.v)) best.set(st, { v, e });
      }
      for (const [st, { e }] of best) {
        const id = `${pid}.${st}`;
        const byM = out.get(id) ?? new Map();
        byM.set(num, e);
        out.set(id, byM);
      }
    }
  }
  return out;
}

/**
 * **从 GT 的 `<print>` 与 `<staff-details print-object>` 推出谱面版式。**
 *
 * 语义**照渲染那边的一份**（`src/mixed/loader.ts::applyStaffVisibility`，
 * 它移植自 musicpp `loader.cpp::processStaffDetails` + `updateSystemLayout` 的 `visPrev`）：
 *
 *   - 初值**可见**；`<attributes><staff-details print-object="no|yes">` 按小节**累积**地改；
 *   - `number="N"` 指的是**本声部的第 N 行谱**（钢琴可以只藏一行），缺省是第 1 行；
 *   - 可见性在**每个系统的首小节**取快照——系统中途的改动从下一个系统才生效；
 *   - `<print new-system="yes">` / `new-page="yes"`：这一小节起是新系统。
 *
 * 两处踩过的坑：
 *
 *   - **`<measure>` 的属性次序不固定**：首小节常写成 `<measure implicit="yes" number="1">`，
 *     正则要求 `number` 紧跟 `<measure ` 就会漏掉那一小节里的 `print-object`
 *     ——查了半天「为什么开头那个声部就印着」，就是这个。
 *   - 一度自己拍了条「首个标志是 yes 就说明之前是隐藏的」的推断。**不需要**：
 *     上面那个正则修好之后，开头的 `no` 本来就写在第一小节里；
 *     照渲染那边的初值（可见）+ 累积改动即可，不必另立判据。
 *
 * 推出来的分段与谱面分毫不差（破碎 2/3/4/2/5/7/2 行、宁静 2/3/4/2/4/5 行）。
 * 返回逐系统的 `{ m0, m1, staves, seqOf }`，`staves` 是**这个系统印出来的谱表**、自上而下。
 */
function gtSystems(xml) {
  const byId = gtMeasures(xml);
  const parts = [];
  const breaks = new Set([1]);
  let last = 1;
  for (const pm of xml.matchAll(/<part\s+id="([^"]+)"([\s\S]*?)<\/part>/g)) {
    const pid = pm[1];
    const staves = [...byId.keys()].filter((id) => id.startsWith(pid + ".")).sort();
    // 逐小节的可见性快照（初值可见，按小节累积；`number` 指本声部第几行）
    const vis = new Map(); // measure -> boolean[]（与 staves 同序）
    const cur = staves.map(() => true);
    for (const mm of pm[2].matchAll(/<measure\b[^>]*number="(\d+)"[^>]*>([\s\S]*?)<\/measure>/g)) {
      const n = Number(mm[1]);
      last = Math.max(last, n);
      if (/<print[^>]*new-(?:system|page)="yes"/.test(mm[2])) breaks.add(n);
      for (const at of mm[2].matchAll(/<attributes>[\s\S]*?<\/attributes>/g))
        for (const det of at[0].matchAll(/<staff-details\b([^>]*)\/?>/g)) {
          const po = /print-object="(yes|no)"/.exec(det[1]);
          if (!po) continue;
          const k = Number(/number="(\d+)"/.exec(det[1])?.[1] ?? 1) - 1;
          if (k >= 0 && k < cur.length) cur[k] = po[1] !== "no";
        }
      vis.set(n, cur.slice());
    }
    parts.push({ pid, staves, vis });
  }
  const starts = [...breaks].sort((a, b) => a - b);
  const out = [];
  starts.forEach((m0, i) => {
    const m1 = i + 1 < starts.length ? starts[i + 1] - 1 : last;
    const staves = [];
    for (const p of parts) {
      // **在系统的首小节取快照**（与渲染那边同一条：系统中途的改动下一个系统才生效）
      let snap = p.vis.get(m0);
      if (!snap) for (let m = m0; m >= 1 && !snap; m--) snap = p.vis.get(m);
      p.staves.forEach((id, k) => {
        if (!snap || snap[k]) staves.push(id);
      });
    }
    const seqOf = new Map();
    for (const id of staves) {
      const byM = byId.get(id);
      let seq = [];
      let lyric = "";
      let chords = [];
      for (let m = m0; m <= m1; m++) {
        const e = byM?.get(m);
        if (!e) continue;
        seq = seq.concat(e.seq);
        chords = chords.concat(e.chords ?? []);
        lyric += e.lyric;
      }
      seqOf.set(id, { seq, chords, lyric: cjk(lyric) });
    }
    out.push({ m0, m1, staves, seqOf });
  });
  return out;
}

/**
 * 我们的系统 ↔ GT 的系统：**一趟 DP 对齐，一对一**。
 *
 * 两边都是按乐曲时间排好的系统序列（GT 那边由 `<print new-system>` 给出，见 `gtSystems`），
 * 所以是一个标准的序列对齐：行数一样才配得上，两边都允许跳过
 * （谱面上多认出来的系统、GT 里我们没认出来的系统）。**一个 GT 系统只配一个**
 * ——不限的话 DP 会把我们所有系统都塞进少数几个行数相同的 GT 系统里（实测配出来全是 0%）。
 */
function alignSections(systems, sections) {
  const N = systems.length;
  const M = sections.length;
  const best = Array.from({ length: N + 1 }, () => new Int32Array(M + 1).fill(-1));
  const from = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(null));
  best[0][0] = 0;
  for (let i = 0; i <= N; i++)
    for (let j = 0; j <= M; j++) {
      const cur = best[i][j];
      if (cur < 0) continue;
      if (i < N && cur > best[i + 1][j]) {
        best[i + 1][j] = cur;
        from[i + 1][j] = [i, j, false];
      }
      if (j < M && cur > best[i][j + 1]) {
        best[i][j + 1] = cur;
        from[i][j + 1] = [i, j, false];
      }
      if (i < N && j < M && sections[j].staves.length === systems[i].rows.length) {
        const v = cur + systems[i].rows.reduce((a, r) => a + r.seq.length, 0);
        if (v > best[i + 1][j + 1]) {
          best[i + 1][j + 1] = v;
          from[i + 1][j + 1] = [i, j, true];
        }
      }
    }
  const pairs = [];
  let i = N;
  let j = M;
  let skipped = 0;
  while (i > 0 || j > 0) {
    const f = from[i][j];
    if (!f) break;
    if (f[2]) pairs.push({ sys: systems[f[0]], sec: sections[f[1]] });
    else if (f[0] !== i) skipped++;
    i = f[0];
    j = f[1];
  }
  pairs.reverse();
  return { pairs, skipped };
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
  // 内容剖面（有没有词、音域中位数、谱面印的声部标签）交给 `buildScore` 做全局指派，
  // 见 `score.ts::assignSlots`
  const prof = new Map();
  for (const e of entries)
    for (const n of e.notes) {
      const p = prof.get(n.staff) ?? { lyric: false, ps: [], label: null };
      if (n.lyrics?.length) p.lyric = true;
      if (!n.rest && !n.grace && n.step) p.ps.push("CDEFGAB".indexOf(n.step) + 7 * n.octave);
      prof.set(n.staff, p);
    }
  for (const e of entries)
    for (const [idx, name] of e.labels ?? []) {
      const st = e.page.staves[idx];
      if (!st) continue;
      const p = prof.get(st) ?? { lyric: false, ps: [], label: null };
      p.label = name;
      prof.set(st, p);
    }
  const score = cli.buildScore(
    entries.map((e) => ({ page: e.page, ctx: e.ctx })),
    {
      profileOf: (st) => {
        const p = prof.get(st);
        if (!p) return { lyric: false, pitch: null };
        const ps = p.ps.slice().sort((a, b) => a - b);
        return { lyric: p.lyric, pitch: ps.length ? ps[ps.length >> 1] : null, label: p.label };
      },
    },
  );
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

/**
 * 识别结果 → **逐系统逐行**的序列，不经 `buildScore`。
 *
 * 与 `gotParts` 的分别：那边的一条序列是「跨系统连起来的一条谱表」，连错了
 * 准确率就跟着塌；这边只交出「第几个系统的第几行」，怎么连起来交给人工映射
 * ——把**识别**与**跨系统连接**两件事拆开量。
 */
function gotRows(entries) {
  const byStaff = new Map();
  for (const e of entries) for (const n of e.notes) {
    const a = byStaff.get(n.staff) ?? [];
    a.push(n);
    byStaff.set(n.staff, a);
  }
  const out = [];
  for (const e of entries)
    for (const sys of [...e.page.systems].sort((a, b) => a.box.top - b.box.top)) {
      const rows = [...sys.staves].sort((a, b) => a.box.top - b.box.top).map((stf) => {
        const seq = [];
        const chords = [];
        // `src[i]` 与 `seq[i]` 一一对应：错误要落回页面坐标才谈得上查错因（`--errors`）
        const src = [];
        let lyric = "";
        const mv = minVoice(stf, byStaff);
        for (const n of (byStaff.get(stf) ?? []).filter((x) => !x.grace && x.voice === mv)) {
          // 和弦附加音并进上一个和弦；「只比最低音」那条序列照旧只收主音
          if (n.chordExtra) {
            if (chords.length && !n.rest) chords[chords.length - 1].push(n.step + n.octave);
            continue;
          }
          seq.push(n.rest ? "R" : n.step + n.octave);
          chords.push(n.rest ? ["R"] : [n.step + n.octave]);
          src.push({ page: e.pageNo, box: n.sym?.box ?? null, code: n.sym?.code ?? null, rest: !!n.rest, base: n.base, dots: n.dots });
          for (const l of n.lyrics ?? []) if (l.verse === 1) lyric += l.text;
        }
        return { seq, chords, src, lyric };
      });
      out.push({ rows, pageNo: e.pageNo, top: sys.box.top });
    }
  return out;
}

/**
 * 人工映射 → 逐 GT 谱表的序列。返回 `{ byId, unmapped }`，
 * `unmapped` 是没落到任何 GT 谱表上的音（系统没配映射、或那一行标了 `null`），
 * 记进「含游离」那一档的分母。
 */
function applyStaffMap(systems, mapOf) {
  const byId = new Map();
  let unmapped = 0;
  systems.forEach((sys, si) => {
    const ids = mapOf.systems?.[String(si)] ?? mapOf.byRowCount?.[String(sys.rows.length)] ?? null;
    sys.rows.forEach((r, k) => {
      const cell = ids?.[k] ?? null;
      if (!cell) {
        unmapped += r.seq.length;
        return;
      }
      // 一行谱可以罩着**好几个 GT 谱表**（破碎那三个女高在五行系统里合印成一行 "Soprano"）。
      // 写成 `"P1.1|P2.1|P3.1"`：那一行的序列同时算给这几个谱表。
      // 这不是拿度量蒙分——谱面上就只印了这一行，识别再准也只能交出这一条。
      for (const id of String(cell).split("|")) {
        const cur = byId.get(id) ?? { id, seq: [], lyric: "" };
        cur.seq.push(...r.seq);
        cur.lyric += r.lyric;
        byId.set(id, cur);
      }
    });
  });
  return { byId, unmapped };
}

/** 两条序列的对齐：返回配上的下标对（编辑距离最优路径里「相等」的那些位置）。
 *  与 `chorus-symbols.mjs` 里那一份同一套——和弦档要在「音高对上的位置」上比成员。 */
function alignPairs(a, b) {
  const n = a.length;
  const m = b.length;
  const d = Array.from({ length: n + 1 }, (_, i) => new Int32Array(m + 1).fill(0).map((_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      d[i][j] = Math.min(d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), d[i - 1][j] + 1, d[i][j - 1] + 1);
  const out = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      if (a[i - 1] === b[j - 1]) out.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (d[i][j] === d[i - 1][j] + 1) i--;
    else j--;
  }
  return out.reverse();
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
/** `--errors` 的逐条错误清单。 */
const errorRows = [];
/** 哪些 `曲名/文件` 是真扫描件（错因排行只看这一档）。 */
const scanFiles = new Set();
for (const song of (await loadChorus()).filter((s) => !only || s.name.includes(only))) {
  if (!song.gt) continue;
  const gt = gtParts(await readFile(song.gt, "utf8"));
  for (const pdf of song.pdfs) {
    // 同一曲里个别 PDF 不是全谱（节选），不进准确率——见 `node-harness.mjs::GT_PARTIAL_PDF`
    if (!gtUsable(pdf)) continue;
    const file = pdf.split("/").pop();
    const { doc, OPS } = await openPdf(pdf);
    const entries = [];
    let carry, bars = 0, full = 0, unknown = 0, staves = 0, cleanPages = 0, allPages = 0;
    const lyricStats = { rows: 0, hit: 0, parity: 0 };
    await eachPage(doc, Array.from({ length: doc.numPages }, (_, i) => i + 1), async (page, pn) => {
      const r = await cli.recognizeRasterPage(page, OPS, look, pn, { carryTime: carry, lyricOcr, labelOcr });
      carry = r.carryTime;
      if (!r.hasStaff) return;
      allPages++;
      for (const key of Object.keys(lyricStats)) lyricStats[key] += r.lyricStats[key];
      // **分档**：干净位图（排版软件贴的图）线宽不到线距的两成；真扫描件（Xerox/手机拍）
      // 线更粗、还带倾斜。判据与 `gen-rasterglyphs.mjs` 建库那道闸同口径。
      // **分档按底本的数据形态**（`raster.kind`），不拿「线宽/线距」当代理量
      // ——那个比值随谱线判据一动就翻（见 `rasterpage.ts` 的说明）。
      if (r.raster?.kind === "mask") cleanPages++;
      entries.push({ page: r.page, ctx: r.ctx, notes: r.notes, labels: r.staffLabels, pageNo: pn });
      bars += r.bars.length;
      full += r.bars.filter((b) => b.full).length;
      unknown += r.unknown;
      staves += r.page.staves.length;
    });
    if (!entries.length) continue;
    const got = gotParts(entries);
    const nParts = scoreParts(entries);
    // ── 按 staff 对比（人工映射）────────────────────────────────────────
    const systems = gotRows(entries);
    const mapOf = staffMap?.[`${song.name}/${file}`] ?? null;
    let sm = null;
    if (args.includes("--genmap")) {
      console.log(`"${song.name}/${file}": ${JSON.stringify(draftMap(systems, gt), null, 2)},`);
    }
    if (mapOf) {
      const { byId, unmapped } = applyStaffMap(systems, mapOf);
      let n = 0, l = 0, d = 0, y = 0, yd = 0;
      const miss = [];
      for (const g of gt) {
        const r = byId.get(g.id);
        if (!r) {
          miss.push(g.id);
          continue; // 映射里没提到的 GT 谱表：不入分母，另行报数
        }
        let a = acc(r.seq, g.seq, 24, true);
        for (const k of [-1, 1]) a = Math.max(a, acc(shiftOct(r.seq, k), g.seq, 24, true));
        n += a * g.seq.length;
        l += acc(letters(r.seq), letters(g.seq), 24, true) * g.seq.length;
        d += g.seq.length;
        if ((g.lyric ?? "").length >= 8) {
          y += acc([...cjk(r.lyric ?? "")], [...g.lyric]) * g.lyric.length;
          yd += g.lyric.length;
        }
        if (verbose) {
          // **GT 开头连续的休止要先剔掉**，与准确率那一路（`skipLeadRests`）同口径：
          // 合唱谱的 GT 是全谱，声部没进来时也写休止，而谱面上那一行谱根本不印
          // （破碎的女低、男低各有 49 个）。不剔的话「漏掉」里会凭空多出几十个休止,
          // 看上去像检出的锅——实测破碎因此把「休止漏检」误判成头号病灶（621 vs 真实 121）。
          const gg = g.seq.slice(g.seq.findIndex((z) => z !== "R"));
          const t = errKinds(r.seq, gg);
          console.log(`  [staff] ${g.id}(GT ${g.seq.length} / 识别 ${r.seq.length})  音符 ${(a * 100).toFixed(1)}%  ` +
            `错型 读错${t.sub} 漏${t.del} 多${t.ins}` +
            ((g.lyric ?? "").length >= 8 ? `  歌词 ${(acc([...cjk(r.lyric ?? "")], [...g.lyric]) * 100).toFixed(1)}%` : ""));
        }
      }
      sm = {
        noteAcc: d ? (n / d) * 100 : 0,
        letterAcc: d ? (l / d) * 100 : 0,
        noteAccAll: d + unmapped ? (n / (d + unmapped)) * 100 : 0,
        lyricAcc: yd && lyricOcr ? (y / yd) * 100 : null,
        lyricChars: yd, unmapped, miss,
      };
    }
    // ── 按**GT 推出来的谱行**比（不用人工映射）──────────────────────────
    //
    // 合唱谱的版式规矩是死的：一个声部长段不唱就不印那一行，一唱就印
    // ——所以「这一段谱面该印几行、哪几行」是 GT 自己算得出来的量（`gtSections`）。
    // 我们的系统按**行数**与它对齐，第 k 行就对第 k 条在印的谱表。
    //
    // 这一档比人工映射硬：**没印出来的那些小节不进分母**（合唱谱的 GT 是全谱，
    // 声部没进来时照写休止，而谱面上那一行根本不印），而人工映射只能整条谱表
    // 记给某一行，写错了还看不出来——实测破碎那份的人工映射把五行系统的女高
    // 写成了 P1，真身是 **P3**（限定小节区间比，相似度 92% 对 0%）。
    let sec = null;
    {
      const sections = gtSystems(await readFile(song.gt, "utf8"));
      const { pairs: sp, skipped } = alignSections(systems, sections);
      if (args.includes("--sections")) {
        for (const sc of sections) console.log(`    段 m${sc.m0}-${sc.m1}（${sc.staves.length} 行）: ${sc.staves.join(" ")}`);
        console.log(`    系统行数: ${systems.map((y) => y.rows.length).join(" ")}`);
      }
      const byIdSec = new Map(); // id -> { got: [], gt: [], lyricGot, lyricGt }
      for (const { sys, sec: sc } of sp) {
        sys.rows.forEach((r, k) => {
          const id = sc.staves[k];
          if (!id) return;
          const cur = byIdSec.get(id) ?? { got: [], gt: [], src: [], gotCh: [], gtCh: [], lyricGot: "", lyricGt: "", secs: new Set() };
          cur.got.push(...r.seq);
          cur.src.push(...(r.src ?? []));
          cur.gotCh.push(...(r.chords ?? []));
          cur.lyricGot += r.lyric;
          cur.secs.add(sc);
          byIdSec.set(id, cur);
        });
      }
      // GT 侧只取**对齐上的那些段**
      for (const [id, cur] of byIdSec)
        for (const sc of cur.secs) {
          const e = sc.seqOf.get(id);
          if (!e) continue;
          cur.gt.push(...e.seq);
          cur.gtCh.push(...(e.chords ?? []));
          cur.lyricGt += e.lyric;
        }
      // ── 逐系统下钻（`--secdump=P6.1`）：把某一行谱的错误定位到具体系统 ──
      const secdump = argOf("secdump");
      if (secdump) {
        for (const { sys, sec: sc } of sp) {
          const k = sc.staves.indexOf(secdump);
          if (k < 0) continue;
          const e = sc.seqOf.get(secdump);
          if (!e) continue;
          const A = sys.rows[k].seq, B = e.seq;
          let a2 = acc(A, B, 24, true);
          for (const kk of [-1, 1]) a2 = Math.max(a2, acc(shiftOct(A, kk), B, 24, true));
          const t2 = errKinds(A, B.slice(B.findIndex((z) => z !== "R")));
          console.log(`    [sec] p${sys.pageNo} top${sys.top.toFixed(0)} m${sc.m0}-${sc.m1} GT${B.length}/识别${A.length} ${(a2 * 100).toFixed(1)}% 读错${t2.sub}漏${t2.del}多${t2.ins}`);
          if (args.includes("--dump")) console.log("      " + alignText(A, B, 400));
        }
      }
      // ── `--errors`：把每一个错误落回页面坐标，按类型归因 ────────────────
      //
      // **不猜错因**：逐音对齐之后，读错的记下 GT→识别的级差与那个音的盒，
      // 漏掉的记下它在哪一行谱的哪一段，多出的记下盒。级差本身就把大类分开了
      // （±7/±14 是八度、±1 是吸错格、休↔音是休止误判），剩下的散着的才要人去看。
      if (args.includes("--errors"))
        for (const [id, cur] of byIdSec) {
          if (!cur.gt.length) continue;
          for (const e of errorList(cur.got, cur.gt, cur.src))
            errorRows.push({ song: song.name, file, staff: id, ...e });
        }

      let sn = 0, sl = 0, sd = 0, sy = 0, syd = 0;
      let chHit = 0, chGt = 0, chGot = 0, chExact = 0, chN = 0;
      const rows = [];
      for (const [id, cur] of [...byIdSec].sort()) {
        if (!cur.gt.length) continue;
        let a = acc(cur.got, cur.gt, 24, true);
        for (const k of [-1, 1]) a = Math.max(a, acc(shiftOct(cur.got, k), cur.gt, 24, true));
        sn += a * cur.gt.length;
        sl += acc(letters(cur.got), letters(cur.gt), 24, true) * cur.gt.length;
        sd += cur.gt.length;
        const gl = cjk(cur.lyricGt);
        if (gl.length >= 8) {
          sy += acc([...cjk(cur.lyricGot)], [...gl]) * gl.length;
          syd += gl.length;
        }
        // ── 和弦档：把和弦当**集合**比，不只比最低音 ──────────────────────
        //
        // 逐谱行摊开之后，钢琴两行是仅剩的大洞（75~80%），而钢琴几乎全是和弦。
        // 只比最低音时，「和弦少认了一个成员」与「整个和弦没认出来」看不出区别，
        // 「我们拆出来的最低音不是 GT 那个」也只显示成读错。
        // 所以另比一份：先按最低音那条序列对齐（`alignPairs` 同一套），
        // 再在**对上的位置**上比两个和弦的**成员集合**。
        {
          const A = cur.gotCh.map((c) => c[0] ?? "?");
          const B = cur.gtCh.map((c) => c[0] ?? "?");
          for (const [ai, bi] of alignPairs(A, B)) {
            const a2 = new Set(cur.gotCh[ai].filter((x) => x !== "R"));
            const b2 = new Set(cur.gtCh[bi].filter((x) => x !== "R"));
            if (!b2.size && !a2.size) continue;
            chN++;
            chGt += b2.size;
            chGot += a2.size;
            let hit = 0;
            for (const x of b2) if (a2.has(x)) hit++;
            chHit += hit;
            if (hit === b2.size && a2.size === b2.size) chExact++;
          }
        }
        const t = errKinds(cur.got, cur.gt.slice(cur.gt.findIndex((z) => z !== "R")));
        rows.push(`${id}(GT ${cur.gt.length}/识别 ${cur.got.length}) ${(a * 100).toFixed(1)}% 读错${t.sub}漏${t.del}多${t.ins}` +
          (gl.length >= 8 ? ` 歌词${(acc([...cjk(cur.lyricGot)], [...gl]) * 100).toFixed(0)}%` : ""));
      }
      sec = { chord: { hit: chHit, gt: chGt, got: chGot, exact: chExact, n: chN }, noteAcc: sd ? (sn / sd) * 100 : 0, letterAcc: sd ? (sl / sd) * 100 : 0, lyricAcc: syd && lyricOcr ? (sy / syd) * 100 : null, notes: sd, skipped: skipped.length, rows };
    }

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
        // 错型：读错（替换）/ 漏掉（GT 有识别没有）/ 多出（识别有 GT 没有）
        const t = errKinds(got[p.i].seq, g.slice(g.findIndex((z) => z !== "R")));
        console.log(`    错型: 读错 ${t.sub}  漏掉 ${t.del}  多出 ${t.ins}  （对上 ${t.eq}）`);
        if (t.sub) console.log(`    读错级差: ${[...t.steps.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${typeof k === "number" && k > 0 ? "+" + k : k} ${v}`).join("　")}`);
      }
    }
    // **游离音符**：没配上任何 GT 谱表的那些识别谱表里的音。
    //
    // 只看 `noteAcc` 会**奖励碎片化**：跨系统连接一断，一条谱表碎成好几条，
    // 贪心配对给每个 GT 谱表挑一段最像的，剩下那些碎片一个音都不付代价
    // ——实测破碎碎成 13 条时 64.2%，正确连成 8 条反而 58.8%。
    // 把游离的音记进分母，「碎着蒙分」这条路就堵死了：
    // 一份好的输出应当**每个音都在，且都在对的那一路上**。
    const pairedGot = new Set(pairs.map((p) => p.i));
    const strayNotes = got.reduce((a, p, i) => a + (pairedGot.has(i) ? 0 : p.seq.length), 0);
    const row = {
      song: song.name, file, staves, clean: cleanPages >= allPages * 0.8,
      gtParts: gt.length, gotParts: got.length, scoreParts: nParts, paired: pairs.length,
      gtNotes: gtTotal, gotNotes: gotTotal, strayNotes,
      pairedGtNotes: wd,
      noteAcc: wd ? (wn / wd) * 100 : 0, letterAcc: wd ? (wl / wd) * 100 : 0,
      noteAccAll: wd + strayNotes ? (wn / (wd + strayNotes)) * 100 : 0,
      barFull: bars ? (full / bars) * 100 : 0, bars, unknown, lyricStats,
      lyricAcc: wyd && lyricOcr ? (wy / wyd) * 100 : null,
      lyricChars: wyd,
      // **哪些谱表算「有中文歌词 GT」**：合唱谱的 GT 里，伴奏谱表常沾着一两个
      // 表情字（`cjk` 之后剩下的），拿「非空」当闸会把它们也算成有词声部，
      // 歌词覆盖率的分母就虚高。八个汉字大约是一个乐句，实测这批语料上
      // 正好把伴奏谱表与真正的唱词谱表分开。
      gtLyricChars: gt.reduce((n, p) => n + (p.lyric.length >= 8 ? p.lyric.length : 0), 0),
      // 按 staff（人工映射）那一档：没有映射表时为 null
      smNoteAcc: sm ? sm.noteAcc : null,
      smLetterAcc: sm ? sm.letterAcc : null,
      smNoteAccAll: sm ? sm.noteAccAll : null,
      smLyricAcc: sm ? sm.lyricAcc : null,
      smUnmapped: sm ? sm.unmapped : null,
      smMiss: sm ? sm.miss.length : null,
      // 按 GT 推出来的谱行那一档
      secNoteAcc: sec ? sec.noteAcc : null,
      secLetterAcc: sec ? sec.letterAcc : null,
      secLyricAcc: sec ? sec.lyricAcc : null,
      secNotes: sec ? sec.notes : null,
    };
    rows.push(row);
    if (!row.clean) scanFiles.add(`${song.name}/${file}`);
    console.log(`${row.clean ? "[干净]" : "[扫描]"} ${song.name}/${file}  谱行${staves} 声部 ${got.length}↔${gt.length}(配上${pairs.length}，buildScore ${nParts})  ` +
      `音符 ${gotTotal}/${gtTotal}  准确率 ${row.noteAcc.toFixed(1)}%（含游离 ${row.noteAccAll.toFixed(1)}%，游离 ${strayNotes}）  音级 ${row.letterAcc.toFixed(1)}%  ` +
      `小节自检 ${row.barFull.toFixed(1)}%（${bars} 小节）` +
      (row.lyricAcc != null ? `  歌词 ${row.lyricAcc.toFixed(1)}%（GT ${row.lyricChars} 字）` : ""));
    // **这一档是识别侧的正式尺子**：版式从 GT 的 `<print>` / `<staff-details print-object>`
    // 直接读出来（见 `gtSystems`），没印出来的谱表不进分母，也不用人工映射。
    // 与人工映射互证：宁静 86.4% 对 86.1%（两条路吻合）；破碎 84.1% 对 80.9%
    // ——差的那几点正是人工映射还没修干净的版式账。
    if (sec)
      console.log(`         └ 按谱行（GT 推导）：音符 ${sec.noteAcc.toFixed(1)}%  音级 ${sec.letterAcc.toFixed(1)}%` +
        (sec.lyricAcc != null ? `  歌词 ${sec.lyricAcc.toFixed(1)}%` : "") + `  （GT ${sec.notes} 音）` +
        (sec.chord.gt ? `\n           和弦档：对上的 ${sec.chord.n} 处里，成员命中 ${sec.chord.hit}/${sec.chord.gt}（识别给出 ${sec.chord.got}），整枚全对 ${sec.chord.exact}` : "") +
        (verbose ? `\n           ${sec.rows.join("  ")}` : ""));
    if (sm)
      console.log(`         └ 按 staff（人工映射）：音符 ${sm.noteAcc.toFixed(1)}%（含未映射 ${sm.noteAccAll.toFixed(1)}%，未映射 ${sm.unmapped} 音）  ` +
        `音级 ${sm.letterAcc.toFixed(1)}%` + (sm.lyricAcc != null ? `  歌词 ${sm.lyricAcc.toFixed(1)}%（GT ${sm.lyricChars} 字）` : "") +
        (sm.miss.length ? `  ——映射里没提到的 GT 谱表：${sm.miss.join(",")}` : ""));
  }
}

// 无 GT 的那几首只出不靠 GT 的自检
for (const song of (await loadChorus()).filter((s) => !only || s.name.includes(only))) {
  for (const pdf of song.pdfs) {
    if (song.gt && gtUsable(pdf)) continue; // 有 GT 且能用的，上面那一段已经量过
    const { doc, OPS } = await openPdf(pdf);
    let carry, notes = 0, bars = 0, full = 0, staves = 0, unknown = 0, cleanPages = 0, allPages = 0;
    await eachPage(doc, Array.from({ length: doc.numPages }, (_, i) => i + 1), async (page, pn) => {
      const r = await cli.recognizeRasterPage(page, OPS, look, pn, { carryTime: carry });
      carry = r.carryTime;
      if (!r.hasStaff) return;
      allPages++;
      // **分档按底本的数据形态**（`raster.kind`），不拿「线宽/线距」当代理量
      // ——那个比值随谱线判据一动就翻（见 `rasterpage.ts` 的说明）。
      if (r.raster?.kind === "mask") cleanPages++;
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
// **分档汇总**：干净位图与真扫描件**各记各的**，但**两档都守**。
//
// 一度只守干净那一档（真扫描件倾斜三四个像素、谱线找不齐，混进同一个平均
// 会把干净那一档的涨跌淹掉）。分档记账解决了「淹掉」，守门却一直没跟上
// ——于是「干净档涨、扫描件塌」的改动可以一路绿灯过去（实测收竖笔画的宽度闸
// 就是这样：干净 92.31% → 92.74%，扫描件 29.6% → 19.8%）。
// 现在两档都进 `summary`（扫描件那几个键带 `scan` 前缀），任一档退步都拦下来。
const clean = rows.filter((r) => r.clean);
const scan = rows.filter((r) => !r.clean);
const avg = (a, k) => (a.length ? +(a.reduce((x, r) => x + r[k], 0) / a.length).toFixed(2) : 0);
const withGt = clean.filter((r) => r.noteAcc !== null);
const summary = {
  clean: clean.length,
  noteAcc: avg(withGt, "noteAcc"),
  // **把游离音符记进分母的那一档**：跨系统连接对不对，看这个数，别看 `noteAcc`
  // ——后者会奖励碎片化（见 `strayNotes` 那段说明）。
  noteAccAll: avg(withGt, "noteAccAll"),
  letterAcc: avg(withGt, "letterAcc"),
  barFull: avg(clean, "barFull"),
  lyricAcc: avg(clean.filter((r) => r.lyricAcc != null), "lyricAcc"),
};
// 按 staff（人工映射）那一档：只在**每一份都配了映射**时进汇总，
// 否则平均值里混着口径不同的份，涨跌看不出来。
const smClean = clean.filter((r) => r.smNoteAcc != null);
const smSummary = smClean.length
  ? {
      smNoteAcc: avg(smClean, "smNoteAcc"),
      smNoteAccAll: avg(smClean, "smNoteAccAll"),
      smLetterAcc: avg(smClean, "smLetterAcc"),
      smLyricAcc: avg(smClean.filter((r) => r.smLyricAcc != null), "smLyricAcc"),
    }
  : null;
if (smSummary) Object.assign(summary, smSummary);
console.log(`\n【干净位图】${clean.length} 份（有 GT ${withGt.length} 份）：音符 ${summary.noteAcc}%（含游离 ${summary.noteAccAll}%）、音级 ${summary.letterAcc}%；小节自检 ${summary.barFull}%` +
  (summary.lyricAcc ? `；歌词 ${summary.lyricAcc}%` : ""));
const secClean = clean.filter((r) => r.secNoteAcc != null);
const secSummary = secClean.length
  ? {
      secNoteAcc: avg(secClean, "secNoteAcc"),
      secLetterAcc: avg(secClean, "secLetterAcc"),
      secLyricAcc: avg(secClean.filter((r) => r.secLyricAcc != null), "secLyricAcc"),
    }
  : null;
if (secSummary) {
  Object.assign(summary, secSummary);
  console.log(`【按谱行·GT 推导】${secClean.length} 份：音符 ${secSummary.secNoteAcc}%、音级 ${secSummary.secLetterAcc}%` +
    (secSummary.secLyricAcc ? `；歌词 ${secSummary.secLyricAcc}%` : ""));
}
if (smSummary)
  console.log(`【按 staff·人工映射】${smClean.length} 份：音符 ${smSummary.smNoteAcc}%（含未映射 ${smSummary.smNoteAccAll}%）、音级 ${smSummary.smLetterAcc}%` +
    (smSummary.smLyricAcc ? `；歌词 ${smSummary.smLyricAcc}%` : ""));
if (scan.length) {
  const sg = scan.filter((r) => r.noteAcc !== null);
  Object.assign(summary, {
    scan: scan.length,
    scanNoteAcc: avg(sg, "noteAcc"),
    scanNoteAccAll: avg(sg, "noteAccAll"),
    scanLetterAcc: avg(sg, "letterAcc"),
    scanBarFull: avg(scan, "barFull"),
    scanLyricAcc: avg(sg.filter((r) => r.lyricAcc != null && r.lyricChars > 0), "lyricAcc"),
  });
  const lyrics = sg.filter((r) => r.lyricAcc != null && r.lyricChars > 0);
  const gtLyrics = sg.filter((r) => r.gtLyricChars > 0);
  console.log(`【真扫描件】${scan.length} 份（有 GT ${sg.length} 份）：音符 ${summary.scanNoteAcc}%（含游离 ${summary.scanNoteAccAll}%）、音级 ${summary.scanLetterAcc}%；小节自检 ${summary.scanBarFull}%；歌词 ${summary.scanLyricAcc}%（配对覆盖 ${lyrics.length}/${gtLyrics.length} 份有中文歌词 GT 的 PDF）`);
}

// ── `--errors` 汇总：按错因大类排行，并把逐条清单落盘（带页面坐标，可直接裁图） ──
if (args.includes("--errors")) {
  const scanRows = errorRows.filter((e) => scanFiles.has(`${e.song}/${e.file}`));
  const tally = new Map();
  for (const e of scanRows) tally.set(e.why, (tally.get(e.why) ?? 0) + 1);
  const tot = scanRows.length;
  console.log(`\n【扫描件错因排行】共 ${tot} 处（按谱行档，已剔掉未印出的小节）`);
  for (const [why, n] of [...tally].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(5)}  ${((100 * n) / Math.max(1, tot)).toFixed(1).padStart(5)}%  ${why}`);
  await mkdir("staff-out", { recursive: true });
  await writeFile("staff-out/chorus-errors.json", JSON.stringify(errorRows, null, 1));
  console.log(`→ staff-out/chorus-errors.json（${errorRows.length} 条，带页码与盒）`);
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
    // `clean` / `scan` 是**份数**，不是准确率，不参与比较（语料增删时它们会变）
    const worse = Object.keys(summary).filter((k) => k !== "clean" && k !== "scan" && k !== "songs" && base[k] != null && summary[k] < base[k] - 0.005);
    console.log(`基线：${Object.entries(base).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    if (worse.length) {
      console.log(`✗ 比基线差的档：${worse.map((k) => `${k} ${base[k]}→${summary[k]}`).join("，")}`);
      process.exitCode = 1;
    } else console.log("✓ 各档不低于基线");
  }
}

/**
 * `--genmap`：出一份人工映射的**草稿**。
 *
 * 按「系统的谱行数」分类——同一首曲子里，人声陆续进来，系统的行数会从 2 变到 7，
 * 而**行数一样的系统，各行的身份也一样**（实测破碎、宁静都成立）。
 * 每一类里把「第 k 行」跨系统连起来，再与 GT 谱表贪心配一次，配出来的就是草稿。
 *
 * **草稿只是起点，必须人工过一遍**：一行谱写着两个 GT 声部的地方（破碎的 "Men"
 * 一行罩着 GT 的男高与男低），机器只能挑一个，另一个要人手标 `null` 或改掉。
 */
function draftMap(systems, gt) {
  const byCount = new Map();
  for (const sys of systems) {
    const a = byCount.get(sys.rows.length) ?? [];
    a.push(sys);
    byCount.set(sys.rows.length, a);
  }
  const out = {};
  for (const [cnt, list] of [...byCount.entries()].sort((a, b) => a[0] - b[0])) {
    const cols = Array.from({ length: cnt }, (_, k) => list.flatMap((sys) => sys.rows[k].seq));
    const cand = [];
    for (let k = 0; k < cnt; k++)
      for (let j = 0; j < gt.length; j++) {
        let a = acc(cols[k], gt[j].seq, 24, true);
        for (const o of [-1, 1]) a = Math.max(a, acc(shiftOct(cols[k], o), gt[j].seq, 24, true));
        cand.push({ k, j, a });
      }
    cand.sort((x, y) => y.a - x.a);
    const ids = new Array(cnt).fill(null);
    const usedK = new Set(), usedJ = new Set();
    for (const c of cand) {
      if (usedK.has(c.k) || usedJ.has(c.j) || c.a < 0.15) continue;
      usedK.add(c.k);
      usedJ.add(c.j);
      ids[c.k] = gt[c.j].id;
    }
    out[cnt] = ids;
  }
  return { byRowCount: out };
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

/**
 * 逐音对齐后**逐个错误**的清单（`--errors`）：类型、GT 与识别各是什么、
 * 级差、以及那个音在页面上的盒。归因不靠猜——盒在手上，可以直接裁图核对。
 */
function errorList(A, B, src) {
  const a = A, b = B;
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  const op = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(""));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const c = [[d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), "m"], [d[i - 1][j] + 1, "x"], [d[i][j - 1] + 1, "n"]].sort((p1, p2) => p1[0] - p2[0])[0];
      d[i][j] = c[0];
      op[i][j] = c[1];
    }
  const dia = (p) => (p === "R" ? null : "CDEFGAB".indexOf(p[0]) + 7 * Number(p.slice(1)));
  const out = [];
  let i = a.length, j = b.length;
  while (i > 0 || j > 0) {
    const o = i > 0 && j > 0 ? op[i][j] : i > 0 ? "x" : "n";
    if (o === "m") {
      if (a[i - 1] !== b[j - 1]) {
        const [g, ex] = [dia(a[i - 1]), dia(b[j - 1])];
        const step = g == null || ex == null ? null : g - ex;
        out.push({ kind: "读错", got: a[i - 1], gt: b[j - 1], step, why: whyStep(a[i - 1], b[j - 1], step), src: src?.[i - 1] ?? null });
      }
      i--; j--;
    } else if (o === "x") {
      out.push({ kind: "多出", got: a[i - 1], gt: null, step: null, why: a[i - 1] === "R" ? "多出休止" : "多出音符", src: src?.[i - 1] ?? null });
      i--;
    } else {
      // 漏掉的音没有盒，但它**夹在两个认出来的音之间**——把左右邻居的盒记下来，
      // 那一段页面就定位得到（`raster-gap.mjs` 拿它去问账本：那里的墨归了谁）。
      out.push({
        kind: "漏掉", got: null, gt: b[j - 1], step: null,
        why: b[j - 1] === "R" ? "漏休止" : "漏音符", src: null,
        prev: src?.[i - 1] ?? null, next: src?.[i] ?? null,
      });
      j--;
    }
  }
  return out.reverse();
}

/** 级差 → 错因大类。散着的归「未分类」，那些才要人去裁图看。 */
function whyStep(got, gt, step) {
  if (got === "R") return "音→休（读成休止）";
  if (gt === "R") return "休→音（休止读成音）";
  if (step === null) return "未分类";
  const s = Math.abs(step);
  if (s % 7 === 0) return `八度错 ${step > 0 ? "+" : "-"}${s / 7}`;
  if (s === 1) return "吸错一格";
  if (s === 2) return "差一线（两格）";
  return "未分类";
}

/** 逐音对齐后的错型统计。 */
function errKinds(A, B) {
  const a = A, b = B;
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  const op = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(""));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const c = [[d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), "m"], [d[i - 1][j] + 1, "x"], [d[i][j - 1] + 1, "n"]].sort((p1, p2) => p1[0] - p2[0])[0];
      d[i][j] = c[0];
      op[i][j] = c[1];
    }
  let i = a.length, j = b.length;
  // `steps`：读错的那些音**差几个音级**（GT → 识别，全音阶级差，休止另计）。
  // 光看「读错多少个」看不出该改哪儿：整条差 +2 是谱号错，±1 是线间吸错格，
  // ±7 是八度点/加线，散得没形状才是符头本身没找准。
  const t = { eq: 0, sub: 0, del: 0, ins: 0, steps: new Map() };
  const dia = (p) => (p === "R" ? null : "CDEFGAB".indexOf(p[0]) + 7 * Number(p.slice(1)));
  while (i > 0 || j > 0) {
    const o = i > 0 && j > 0 ? op[i][j] : i > 0 ? "x" : "n";
    if (o === "m") {
      if (a[i - 1] === b[j - 1]) t.eq++;
      else {
        t.sub++;
        const [g, e] = [dia(a[i - 1]), dia(b[j - 1])];
        const k = g == null || e == null ? (a[i - 1] === "R" ? "音→休" : "休→音") : g - e;
        t.steps.set(k, (t.steps.get(k) ?? 0) + 1);
      }
      i--; j--;
    }
    else if (o === "x") { t.ins++; i--; }
    else { t.del++; j--; }
  }
  return t;
}
