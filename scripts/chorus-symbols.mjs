// 合唱谱（位图路）**逐符号**的识别准确率：谱号 / 拍号 / 时值（符头+符尾）/ 临时升降号。
//
//   npm run build:cli && node scripts/chorus-symbols.mjs
//   node scripts/chorus-symbols.mjs --one=宁静 --v
//
// 与 `chorus-diff.mjs` 的分工：那边量的是**音高序列**对不对（音符准确率、音级准确率），
// 这边量**别的符号**。两边共用同一套声部配对（`buildScore` → 与 GT 的 `<part>`×`<staff>`
// 贪心配对），配上之后：
//   - **时值 / 符尾 / 临时升降号**要逐音比，所以先把两条音高序列对齐
//     （与 `--dump` 那个 `alignText` 同一套 Needleman-Wunsch），**只在对上的位置比**
//     ——音高就没配上的位置比时值没有意义，那是漏检不是时值错。
//   - **谱号**逐**谱行**比：GT 一条谱表的谱号通常自始至终不变，取它的主导谱号，
//     看这条谱表下面那些谱行认出来的谱号有几行对得上。这是位图路的真实病灶
//     （谱号认不出 → `buildScore` 连不上跨系统的同一行谱，一个声部碎成好几条）。
//   - **拍号**逐**系统**比：GT 的 `<time>` 按小节号排出一条「从第几小节起是几几拍」，
//     识别侧按谱行认出来的拍号数字排一条，比**出现的拍号本身**（不比小节号——
//     位图路的小节号本来就不可靠）。
import { readFile } from "node:fs/promises";
import { openPdf, eachPage, loadCli, loadChorus } from "./node-harness.mjs";
import { acc, shiftOct } from "./staff-metrics.mjs";

const args = process.argv.slice(2);
const argOf = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const verbose = args.includes("--v");
const only = argOf("one");

const cli = await loadCli();
const look = new cli.RasterGlyphLookup(JSON.parse(await readFile("src/rasteromr/rasterglyphs.json", "utf8")));
look.templates = cli.outlineTemplates(JSON.parse(await readFile("src/staffomr/glyphmap.json", "utf8")));

/** MusicXML 的 `<type>` → 时值（全音符 = 1）。 */
const TYPE_DUR = { maxima: 8, long: 4, breve: 2, whole: 1, half: 0.5, quarter: 0.25, eighth: 0.125, "16th": 0.0625, "32nd": 0.03125, "64th": 0.015625 };
/** 时值 → 给人看的名字。 */
const durName = (d) => Object.entries(TYPE_DUR).find(([, v]) => Math.abs(v - d) < 1e-9)?.[0] ?? String(d);
/** MusicXML 的 `<accidental>` → 半音数。**不是 `<alter>`**：那是发声的升降（含调号），
 *  这里要的是谱面上**印出来的**那个记号。 */
const ACC_ALTER = { sharp: 1, flat: -1, natural: 0, "double-sharp": 2, "flat-flat": -2, "sharp-sharp": 2 };

/** GT → 逐谱表的音符明细（与 `chorus-diff.mjs::gtParts` 同口径，只是多带几个字段）。 */
function gtParts(xml) {
  const out = [];
  for (const m of xml.matchAll(/<part\s+id="([^"]+)"[\s\S]*?<\/part>/g)) {
    const byStaff = new Map();
    const clefOf = new Map();
    const times = [];
    for (const t of m[0].matchAll(/<time[ >][\s\S]*?<\/time>/g)) {
      const beats = /<beats>([^<]+)<\/beats>/.exec(t[0])?.[1];
      const bt = /<beat-type>([^<]+)<\/beat-type>/.exec(t[0])?.[1];
      if (beats && bt) times.push(`${beats}/${bt}`);
    }
    for (const c of m[0].matchAll(/<clef\b[^>]*>[\s\S]*?<\/clef>/g)) {
      const st = /number="(\d+)"/.exec(c[0])?.[1] ?? "1";
      const sign = /<sign>([^<]+)<\/sign>/.exec(c[0])?.[1];
      if (!sign) continue;
      const a = clefOf.get(st) ?? [];
      a.push(sign);
      clefOf.set(st, a);
    }
    for (const n of m[0].matchAll(/<note[ >][\s\S]*?<\/note>/g)) {
      const seg = n[0];
      if (/<grace\s*\/?>/.test(seg) || /<chord\s*\/?>/.test(seg)) continue;
      const k = /<staff>(\d+)<\/staff>/.exec(seg)?.[1] ?? "1";
      const v = /<voice>(\d+)<\/voice>/.exec(seg)?.[1] ?? "1";
      const key = k + "/" + v;
      const seq = byStaff.get(key) ?? [];
      const type = /<type>([^<]+)<\/type>/.exec(seg)?.[1];
      const dots = (seg.match(/<dot\s*\/?>/g) ?? []).length;
      const accid = /<accidental[^>]*>([^<]+)<\/accidental>/.exec(seg)?.[1];
      const rest = /<rest\s*\/?>/.test(seg);
      const slurStart = /<slur[^>]*type="start"/.test(seg);
      const step = /<step>([A-G])<\/step>/.exec(seg)?.[1];
      const oct = /<octave>(-?\d+)<\/octave>/.exec(seg)?.[1];
      if (!rest && (!step || oct === undefined)) continue;
      seq.push({
        pitch: rest ? "R" : step + oct,
        rest,
        base: type && TYPE_DUR[type] !== undefined ? TYPE_DUR[type] : null,
        dots,
        accidental: accid && ACC_ALTER[accid] !== undefined ? ACC_ALTER[accid] : null,
        slurStart,
      });
      byStaff.set(key, seq);
    }
    // **`<direction>` 里的松叶与力度**（按 staff 收，`<staff>` 缺省是 1）。
    // 只收起头的松叶（`crescendo`/`diminuendo`），`stop` 不进序列——识别侧的一条松叶
    // 就是「一个记号」，两边要同一个口径。
    const wedgeOf = new Map();
    const dynOf = new Map();
    for (const d of m[0].matchAll(/<direction[ >][\s\S]*?<\/direction>/g)) {
      const st = /<staff>(\d+)<\/staff>/.exec(d[0])?.[1] ?? "1";
      const wt = /<wedge[^>]*type="(crescendo|diminuendo)"/.exec(d[0])?.[1];
      if (wt) {
        const a = wedgeOf.get(st) ?? [];
        a.push(wt);
        wedgeOf.set(st, a);
      }
      const dy = /<dynamics[^>]*>\s*<([a-z-]+)\s*\/?>/.exec(d[0])?.[1];
      if (dy) {
        const a = dynOf.get(st) ?? [];
        a.push(dy === "other-dynamics" ? "?" : dy);
        dynOf.set(st, a);
      }
    }
    const best = new Map();
    for (const [key, seq] of byStaff) {
      const [st, v] = key.split("/");
      const cur = best.get(st);
      if (!cur || Number(v) < Number(cur.v)) best.set(st, { v, seq });
    }
    for (const [st, { seq }] of [...best.entries()].sort())
      if (seq.length)
        out.push({ id: `${m[1]}.${st}`, seq, clefs: clefOf.get(st) ?? [], times, wedges: wedgeOf.get(st) ?? [], dynamics: dynOf.get(st) ?? [] });
  }
  return out;
}

/** 识别侧 → 逐谱表的音符明细 + 这条谱表下的各行谱（谱号要逐行比）。 */
function gotParts(entries) {
  const score = cli.buildScore(entries.map((e) => ({ page: e.page, ctx: e.ctx })));
  const byStaff = new Map();
  const ctxOf = new Map();
  for (const e of entries) {
    for (const n of e.notes) {
      const a = byStaff.get(n.staff) ?? [];
      a.push(n);
      byStaff.set(n.staff, a);
    }
    for (const [stf, c] of e.ctx) ctxOf.set(stf, c);
  }
  const out = [];
  score.parts.forEach((p, i) => {
    p.scoreStaves.forEach((ss, k) => {
      const seq = [];
      const rows = [];
      const wedges = [];
      const dynamics = [];
      for (const stf of ss.staves) {
        if (!stf) continue;
        rows.push(ctxOf.get(stf) ?? null);
        const mv = minVoice(stf, byStaff);
        for (const n of (byStaff.get(stf) ?? []).filter((x) => !x.chordExtra && !x.grace && x.voice === mv))
          seq.push({ pitch: n.rest ? "R" : n.step + n.octave, rest: n.rest, base: n.base, dots: n.dots, accidental: n.accidental, beams: n.beams, slurStart: !!n.slurStart });
        // 松叶与力度挂在音符上（`attachWedges` / `attachDynamicTexts`），按音符次序取出来。
        // **只取起头的松叶**，与 GT 侧同口径。
        for (const n of byStaff.get(stf) ?? []) {
          if (n.wedgeStart) wedges.push(n.wedgeStart);
          if (n.dynamic) dynamics.push(n.dynamic);
        }
      }
      if (seq.length) out.push({ id: `P${i + 1}.${k + 1}`, seq, rows, wedges, dynamics });
    });
  });
  return out;
}

function minVoice(stf, byStaff) {
  const a = byStaff.get(stf) ?? [];
  return a.length ? Math.min(...a.map((n) => n.voice)) : 1;
}

/** 两条音高序列的对齐：返回配上的下标对（编辑距离最优路径里的「替换/相等」那些位置）。 */
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

/** 贪心配对，与 `chorus-diff.mjs::pair` 同一套（那边比的是同样的音高序列）。 */
function pairParts(got, gt) {
  const cand = [];
  for (let i = 0; i < got.length; i++)
    for (let j = 0; j < gt.length; j++) {
      const A = got[i].seq.map((x) => x.pitch);
      const B = gt[j].seq.map((x) => x.pitch);
      let a = acc(A, B, 24, true);
      for (const k of [-1, 1]) a = Math.max(a, acc(shiftOct(A, k), B, 24, true));
      cand.push({ i, j, a });
    }
  cand.sort((x, y) => y.a - x.a);
  const usedA = new Set();
  const usedB = new Set();
  const pairs = [];
  for (const c of cand) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i);
    usedB.add(c.j);
    pairs.push(c);
  }
  return pairs;
}

/** SMuFL 谱号名 → GT 的 `<sign>`。 */
const clefSign = (code) => (code?.startsWith("gClef") ? "G" : code?.startsWith("fClef") ? "F" : code?.startsWith("cClef") ? "C" : null);

const tally = { durN: 0, durOk: 0, accN: 0, accOk: 0, accFalse: 0, clefN: 0, clefOk: 0, clefMiss: 0, timeN: 0, timeOk: 0, dotsN: 0, dotsOk: 0, wedgeN: 0, wedgeGot: 0, wedgeAcc: 0, wedgeStaves: 0, dynN: 0, dynGot: 0, dynAcc: 0, dynStaves: 0, slurN: 0, slurOk: 0, slurFalse: 0 };
const confuse = new Map();

for (const song of (await loadChorus()).filter((s) => (!only || s.name.includes(only)) && s.gt)) {
  const gt = gtParts(await readFile(song.gt, "utf8"));
  for (const pdf of song.pdfs) {
    const file = pdf.split("/").pop();
    const { doc, OPS } = await openPdf(pdf);
    const entries = [];
    let carry;
    let cleanPages = 0;
    let allPages = 0;
    const gotTimes = [];
    await eachPage(doc, Array.from({ length: doc.numPages }, (_, i) => i + 1), async (page, pn) => {
      const r = await cli.recognizeRasterPage(page, OPS, look, pn, { carryTime: carry });
      carry = r.carryTime;
      if (!r.hasStaff) return;
      allPages++;
      // **分档按底本的数据形态**（`raster.kind`），不拿「线宽/线距」当代理量
      // ——那个比值随谱线判据一动就翻（见 `rasterpage.ts` 的说明）。
      if (r.raster?.kind === "mask") cleanPages++;
      entries.push({ page: r.page, ctx: r.ctx, notes: r.notes });
      for (const [, c] of r.ctx) if (c.time?.length) gotTimes.push(c.time.map((s) => s.code).join(","));
    });
    if (!entries.length) continue;
    if (cleanPages < allPages * 0.8) continue; // 只量干净位图那一档（与基线同口径）
    const got = gotParts(entries);
    const pairs = pairParts(got, gt);

    const sub = { durN: 0, durOk: 0, accN: 0, accOk: 0, accFalse: 0, clefN: 0, clefOk: 0, clefMiss: 0, dotsN: 0, dotsOk: 0, wedgeN: 0, wedgeGot: 0, dynN: 0, dynGot: 0, slurN: 0, slurOk: 0, slurFalse: 0 };
    for (const p of pairs) {
      const G = got[p.i];
      const T = gt[p.j];
      // 谱号：逐**谱行**比这条谱表的主导谱号
      const want = T.clefs.length ? T.clefs.sort((a, b) => T.clefs.filter((x) => x === a).length - T.clefs.filter((x) => x === b).length).pop() : null;
      if (want) {
        for (const c of G.rows) {
          sub.clefN++;
          const sign = clefSign(c?.clef?.code);
          if (!sign) sub.clefMiss++;
          else if (sign === want) sub.clefOk++;
        }
      }
      // 松叶与力度：位置不比（位图路的小节号本来就不可靠），比**出现的序列**
      // ——与拍号那一档同一个口径。数量另记，那是检出率。
      sub.wedgeN += T.wedges.length;
      sub.wedgeGot += G.wedges.length;
      if (T.wedges.length) {
        tally.wedgeAcc += acc(G.wedges, T.wedges, 4);
        tally.wedgeStaves++;
      }
      sub.dynN += T.dynamics.length;
      sub.dynGot += G.dynamics.length;
      if (T.dynamics.length) {
        tally.dynAcc += acc(G.dynamics, T.dynamics, 4);
        tally.dynStaves++;
      }
      // 时值 / 附点 / 临时升降：只在**音高对上的**位置比
      const pr = alignPairs(G.seq.map((x) => x.pitch), T.seq.map((x) => x.pitch));
      for (const [gi, ti] of pr) {
        const a = G.seq[gi];
        const b = T.seq[ti];
        if (b.base != null) {
          sub.durN++;
          if (Math.abs((a.base ?? -1) - b.base) < 1e-9) sub.durOk++;
          else {
            const k = `${durName(b.base)}→${a.base == null ? "?" : durName(a.base)}`;
            confuse.set(k, (confuse.get(k) ?? 0) + 1);
          }
          sub.dotsN++;
          if ((a.dots ?? 0) === b.dots) sub.dotsOk++;
        }
        // 圆滑线：只在音高对上的位置比（与时值同口径）。GT 说这里起一条，我们起了没有。
        if (b.slurStart) {
          sub.slurN++;
          if (a.slurStart) sub.slurOk++;
        } else if (a.slurStart) sub.slurFalse++;
        if (b.accidental != null) {
          sub.accN++;
          if (a.accidental === b.accidental) sub.accOk++;
        } else if (a.accidental != null) sub.accFalse++;
      }
    }
    // 拍号：比**出现过的拍号**（识别侧的拍号数字对 → 几几拍）
    const gtTime = [...new Set(gt.flatMap((x) => x.times))];
    const gotTime = [...new Set(gotTimes)];
    tally.timeN += gtTime.length;
    const digit = (s) => /timeSig(\d)/.exec(s)?.[1];
    const gotAsTime = new Set();
    for (const t of gotTimes) {
      const ds = t.split(",").map(digit).filter(Boolean);
      if (ds.length >= 2) gotAsTime.add(`${ds[0]}/${ds[ds.length - 1]}`);
      if (t.includes("timeSigCommon")) gotAsTime.add("4/4");
      if (t.includes("timeSigCutCommon")) gotAsTime.add("2/2");
    }
    for (const t of gtTime) if (gotAsTime.has(t)) tally.timeOk++;

    for (const k of Object.keys(sub)) tally[k] += sub[k];
    const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "—");
    console.log(
      `${song.name}/${file}\n` +
        `  谱号 ${pct(sub.clefOk, sub.clefN)}（${sub.clefOk}/${sub.clefN} 行，其中认不出 ${sub.clefMiss}）\n` +
        `  时值 ${pct(sub.durOk, sub.durN)}（${sub.durOk}/${sub.durN}，只在音高对上的位置比）  附点 ${pct(sub.dotsOk, sub.dotsN)}\n` +
        `  临时升降 ${pct(sub.accOk, sub.accN)}（GT ${sub.accN} 个）  凭空多出 ${sub.accFalse}\n` +
        `  拍号 GT ${gtTime.join(" ") || "—"}  识别 ${[...gotAsTime].join(" ") || "—"}\n` +
        `  松叶 认出 ${sub.wedgeGot}（GT ${sub.wedgeN}）　力度 认出 ${sub.dynGot}（GT ${sub.dynN}）\n` +
        `  圆滑线 ${pct(sub.slurOk, sub.slurN)}（GT ${sub.slurN} 起，凭空多出 ${sub.slurFalse}）`,
    );
    if (verbose) {
      for (const p of pairs) {
        if (gt[p.j].dynamics.length || got[p.i].dynamics.length)
          console.log(`    ${got[p.i].id}↔${gt[p.j].id} 力度 识别[${got[p.i].dynamics.join(" ")}] GT[${gt[p.j].dynamics.join(" ")}]`);
        if (gt[p.j].wedges.length || got[p.i].wedges.length)
          console.log(`    ${got[p.i].id}↔${gt[p.j].id} 松叶 识别[${got[p.i].wedges.map((w)=>w[0]).join("")}] GT[${gt[p.j].wedges.map((w)=>w[0]).join("")}]`);
      }
      for (const p of pairs) console.log(`    ${got[p.i].id}(${got[p.i].seq.length}) ↔ ${gt[p.j].id}(${gt[p.j].seq.length}) 音高 ${(p.a * 100).toFixed(1)}%`);
    }
  }
}

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "—");
console.log(
  `\n【干净位图合计】谱号 ${pct(tally.clefOk, tally.clefN)}（${tally.clefN} 行，认不出 ${tally.clefMiss}）　` +
    `时值 ${pct(tally.durOk, tally.durN)}（${tally.durN}）　附点 ${pct(tally.dotsOk, tally.dotsN)}　` +
    `临时升降 ${pct(tally.accOk, tally.accN)}（${tally.accN}，多出 ${tally.accFalse}）　拍号 ${pct(tally.timeOk, tally.timeN)}`,
);
console.log(
  `　　松叶 检出 ${tally.wedgeGot}/${tally.wedgeN}（序列 ${tally.wedgeStaves ? ((tally.wedgeAcc / tally.wedgeStaves) * 100).toFixed(1) + "%" : "—"}）　` +
    `力度 检出 ${tally.dynGot}/${tally.dynN}（序列 ${tally.dynStaves ? ((tally.dynAcc / tally.dynStaves) * 100).toFixed(1) + "%" : "—"}）　` +
    `圆滑线 ${tally.slurN ? ((tally.slurOk / tally.slurN) * 100).toFixed(1) + "%" : "—"}（${tally.slurN} 起，多出 ${tally.slurFalse}）`,
);
console.log("时值错法（GT→识别）前十：" + [...confuse.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${v}`).join("　"));
