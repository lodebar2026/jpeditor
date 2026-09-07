// 五线谱识别 ↔ GT musicxml 的逐首对拍。骨架照 500 首那条路的 `pdf-diff.mjs`。
//
//   npm run build:cli && node staff-diff.mjs              # 全书
//   node staff-diff.mjs --one=赞美之泉                    # 只跑标题含该串的曲子
//   node staff-diff.mjs --bless                           # 重写基线
//   node staff-diff.mjs --errors [--one=…]                # 逐条错误清单（带页码与盒）
//
// **基准一律是 GT 的 musicxml**。识别与曲目对齐都在 `scripts/staff-align.mjs`
// （与 gen-stafflyrics.mjs 共用），这里只留对拍与记账。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { alignSongs } from "./staff-align.mjs";
// **对拍判据只写在 staff-metrics.mjs 一处**，位图路那条（chorus-diff.mjs）共用同一份
import { acc, shiftOct, shiftStep, shiftPitch, keyShift, letters, lyricNorm as lyricNorm0 } from "./staff-metrics.mjs";
// 错误清单与错因归类也只写一处（位图路那条共用同一份）
import { errorList } from "./staff-errors.mjs";
const lyricNorm = (s) => lyricNorm0(t2s, s);

const args = process.argv.slice(2);
const argOf = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const verbose = args.includes("--v");
const only = argOf("one");

const { results, songs, t2s } = await alignSongs();

/** `--errors` 的逐条错误清单（口径同位图路的 `chorus-diff.mjs --errors`）。 */
const errorRows = [];

// ── 对拍 ────────────────────────────────────────────────────────────────────
let sumN = 0, sumT = 0, sumL = 0, sumS = 0, sumP = 0, sumV = 0, nV = 0, nMismatch = 0, exact = 0, shifted = 0;
const rows = [];
for (const r of results) {
  if (only && !r.song.file.includes(only) && !r.song.en.includes(only)) continue;
  // 音符档：允许**整首**平移一个八度再比（谱面与 GT 的记谱档次可能不同，
  // 实测 238 首 How Great Thou Art 整首差一个八度，属「表述不一致」不属读错）
  // 调号差蕴含的整首移调：先把谱面这一侧平移回 GT 的调，再按老规矩比。
  const ks = keyShift(r.fifths, r.song.keyFifths);
  const rNotes = shiftStep(r.notes, ks);
  const rPitches = shiftPitch(r.pitches, ks, r.fifths, r.song.keyFifths);
  let an = acc(rNotes, r.song.notes);
  let oct = 0;
  for (const n of [-1, 1]) {
    const a2 = acc(shiftOct(rNotes, n), r.song.notes);
    if (a2 > an) { an = a2; oct = n; }
  }
  if (oct) shifted++;
  const al = acc(letters(rNotes), letters(r.song.notes));
  const at = acc(r.types, r.song.types);
  const as = acc(r.slurs, r.song.slurs);
  // 含升降的音高：允许整首八度平移（与音符档同一条理由）
  let ap = acc(rPitches, r.song.pitches);
  for (const k of [-1, 1]) ap = Math.max(ap, acc(shiftOct(rPitches, k), r.song.pitches));
  // 歌词比 GT 的第一段，**谱面那侧取最像的一段**。
  //
  // 不能死认第一段：这本书每首歌印两遍（中文歌词版 + 英文歌词版），
  // 而且同一页上常常中英文各一行；「第几段」是按谱行下方的上下顺序编的，
  // 与 GT 的段号对不上。取最像的一段量的才是**识别质量**，不是段号对齐。
  const gtV = lyricNorm(r.song.verses.find((v) => v.verse === 1)?.chars ?? "");
  let gotV = "";
  let av = null;
  if (gtV) {
    av = 0;
    for (const t of Object.values(r.verses)) {
      const cand = lyricNorm(t);
      const a = acc([...cand], [...gtV]);
      if (a > av) { av = a; gotV = cand; }
    }
  }
  // **分两档记**：谱面这一段的歌词是英文（这本书每首印两遍，中文版与英文版），
  // 而 GT 的歌词是中文——那是「谱面与 GT 不是同一版」，不是读错。
  //
  // 光看汉字占比不够：钢琴伴奏谱那几首（232 p683-688、234 p715-722）整段**一句歌词都没有**，
  // 页面上仅有的汉字是标题与版权行，占比却过了两成，于是以 0~3% 混进歌词分母、
  // 一首就把平均压掉两个点。再加一条：谱面这一段的中文**长度不到 GT 的四成**，
  // 那就不是「中文歌词版」——是伴奏谱或英文版，同样另记。
  // （真读坏的曲子不会掉到这一档：缺字最多的一档也有九成长度，见文档「歌词」一节。）
  const gotLen = [...gotV].length;
  const scriptMismatch = av !== null && (r.cjkRatio < 0.2 || gotLen < gtV.length * 0.4);
  if (av !== null && !scriptMismatch) { sumV += av; nV++; }
  if (scriptMismatch) nMismatch++;
  // ── `--errors`：把每一个错误落回页面坐标，按类型归因 ────────────────
  // **比的是与准确率同一条序列**（已按调号/八度对齐过的 `rNotes`），
  // 否则清单里会冒出整首平移那种假错。
  if (args.includes("--errors"))
    for (const e of errorList(shiftOct(rNotes, oct), r.song.notes, r.src))
      errorRows.push({ song: r.song.zh || r.song.en, id: r.song.id, file: r.song.file, staff: "melody", ...e });
  sumN += an; sumT += at; sumL += al; sumS += as; sumP += ap;
  if (an === 1) exact++;
  rows.push({ id: r.song.id, zh: r.song.zh, en: r.song.en, p: `${r.from}-${r.to}`, gt: r.song.notes.length, got: r.notes.length, an, al, at, as, ap, av, oct, gtM: r.song.measures, gotM: r.measures,
    gtRep: r.song.repeats.repeats.length, gotRep: r.repeats,
    gtBar: r.song.repeats.barStyles.length, gotBar: r.barStyles,
    gtEnd: r.song.repeats.endings.length, gotEnd: r.endings,
    gtV: gtV.slice(0, 24), gotV: gotV.slice(0, 24), scriptMismatch, cjkRatio: r.cjkRatio, ks, fifths: r.fifths, gtFifths: r.song.keyFifths,
    gtSlur: r.song.slurs.filter((t) => t.includes("s")).length, gotSlur: r.slurs.filter((t) => t.includes("s")).length });
}
rows.sort((a, b) => a.an - b.an);

// **口径分档**（照 500 首那本的四类记账）：谱面与 GT 的音符数差得远，多半不是读错，
// 而是**两边结构不同**——谱面用反复记号、GT 写成两遍；或者页范围切到了别的曲子。
// 这种进「表述或结构不一致」，不进准确率的分母；否则一首反复曲能把平均拉低十几个点。
const SAME_SIZE = 0.1; // 音符数相差一成以内算「数目相当」
const sized = rows.filter((r) => Math.abs(r.got - r.gt) <= r.gt * SAME_SIZE);
const structural = rows.filter((r) => !sized.includes(r));
const avg = (a, k) => (a.length ? (a.reduce((x, r) => x + r[k], 0) / a.length) * 100 : 0);
const withV = rows.filter((r) => r.av !== null);
console.log(`\n【数目相当】${sized.length} 首：音符 ${avg(sized, "an").toFixed(1)}%  音级 ${avg(sized, "al").toFixed(1)}%  ` +
  `音高（含升降）${avg(sized, "ap").toFixed(1)}%  时值 ${avg(sized, "at").toFixed(1)}%`);
/**
 * **「同一版」这一档才回答「给一份新谱能读到多准」**。
 *
 * 「数目相当」只保证两边长度接近，里头还混着**版本不同**的曲子：这本书有一批只印了
 * 英文歌词版，而 GT 是中文版，两版的编配本来就有出入（多一段间奏、尾句写法不同），
 * 那些差异不是识别错。分辨办法是**歌词**：谱面与 GT 同为中文、且歌词对得上八成以上，
 * 基本可以断定是同一份谱，剩下的差异才是识别的账。
 * 实测两档差得很清楚：同一版 61 首音符 98.6%，无中文歌词那 20 首只有 94.6%。
 */
const sameEd = sized.filter((r) => r.av !== null && !r.scriptMismatch && r.av >= 0.8);
const noZh = sized.filter((r) => r.scriptMismatch);
console.log(`【同一版】${sameEd.length} 首（谱面与 GT 同为中文、歌词 ≥80%）：` +
  `音符 ${avg(sameEd, "an").toFixed(1)}%  音级 ${avg(sameEd, "al").toFixed(1)}%  ` +
  `音高 ${avg(sameEd, "ap").toFixed(1)}%  时值 ${avg(sameEd, "at").toFixed(1)}%  ` +
  `弧线 ${avg(sameEd, "as").toFixed(1)}%（音符全对 ${sameEd.filter((r) => r.an === 1).length} 首）`);
console.log(`　　对照：谱面没有中文歌词的 ${noZh.length} 首（英文版 / 伴奏谱，版本存疑）` +
  `音符 ${avg(noZh, "an").toFixed(1)}%  时值 ${avg(noZh, "at").toFixed(1)}%`);
const mOk = sized.filter((r) => r.gotM === r.gtM).length;
console.log(`小节数：对上 ${mOk}/${sized.length} 首（GT 合计 ${sized.reduce((a, r) => a + r.gtM, 0)} / 识别 ${sized.reduce((a, r) => a + r.gotM, 0)}）`);
console.log(`反复记号：GT 合计 ${sized.reduce((a, r) => a + r.gtRep, 0)} / 识别 ${sized.reduce((a, r) => a + r.gotRep, 0)}；` +
  `结构性小节线（终止/复纵）GT ${sized.reduce((a, r) => a + r.gtBar, 0)} / 识别 ${sized.reduce((a, r) => a + r.gotBar, 0)}`);
console.log(`房号：GT 合计 ${sized.reduce((a, r) => a + r.gtEnd, 0)} / 识别 ${sized.reduce((a, r) => a + r.gotEnd, 0)}`);
console.log(`弧线（逐音的起讫标记）：${avg(sized, "as").toFixed(1)}%；` +
  `GT 合计 ${rows.reduce((a, r) => a + r.gtSlur, 0)} 条 / 识别 ${rows.reduce((a, r) => a + r.gotSlur, 0)} 条`);
console.log(`歌词：${(nV ? (sumV / nV) * 100 : 0).toFixed(1)}%（${nV} 首，谱面与 GT 同为中文）；` +
  `另有 ${nMismatch} 首谱面没有对应的中文歌词（英文版 / 钢琴伴奏谱），与中文 GT 不是同一版，不入分母；` +
  `真读不出来的（< 20%）${withV.filter((r) => !r.scriptMismatch && r.av < 0.2).length} 首`);
console.log(`【表述或结构不一致】${structural.length} 首（谱面用反复记号 / 页范围切错 / 编配不同），另记不入分母`);

const n = rows.length || 1;
console.log(`\n对上的 ${rows.length} 首：音符 ${(sumN / n * 100).toFixed(1)}%（全对 ${exact} 首）  音级 ${(sumL / n * 100).toFixed(1)}%  时值 ${(sumT / n * 100).toFixed(1)}%`);
console.log(`其中整首差一个八度（记谱档次不同，不计入读错）${shifted} 首；` +
  `整首移调（书上印的调与 GT 不同，按调号差平移后再比）${rows.filter((r) => r.ks).length} 首`);
if (args.includes("--lyric")) {
  console.log("\n歌词最差的 15 首（GT ‖ 识别）：");
  for (const r of withV.filter((r) => !r.scriptMismatch).sort((a, b) => a.av - b.av).slice(0, 15))
    console.log(`  ${r.id} ${r.zh} p${r.p} ${(r.av * 100).toFixed(0)}%\n     GT ${r.gtV}\n     识 ${r.gotV}`);
}
console.log("\n【数目相当】里最差的：");
for (const r of sized.slice(0, 10))
  console.log(`  ${r.id} ${r.zh}/${r.en} p${r.p} GT${r.gt}→${r.got} 音符${(r.an * 100).toFixed(1)}% 时值${(r.at * 100).toFixed(1)}%`);
console.log("\n最差的 20 首：");
for (const r of rows.slice(0, 20))
  console.log(`  ${r.id} ${r.zh}/${r.en} p${r.p} GT${r.gt}→${r.got} 音符${(r.an * 100).toFixed(1)}% 时值${(r.at * 100).toFixed(1)}%`);
await mkdir("staff-out", { recursive: true });
await writeFile("staff-out/staff-diff.json", JSON.stringify(rows, null, 1));
if (verbose) console.log("→ staff-out/staff-diff.json");

// ── 基线 ────────────────────────────────────────────────────────────────────
// 照 `line-check.mjs` 的规矩：任一档比基线差就失败。`--bless` 重写基线。
const BASELINE = "testdata/赞美之泉/staff-baseline.json";
const now = {
  matched: rows.length,
  sized: sized.length,
  noteAcc: +avg(sized, "an").toFixed(2),
  letterAcc: +avg(sized, "al").toFixed(2),
  typeAcc: +avg(sized, "at").toFixed(2),
  slurAcc: +avg(sized, "as").toFixed(2),
  pitchAcc: +avg(sized, "ap").toFixed(2),
  lyricAcc: +(nV ? (sumV / nV) * 100 : 0).toFixed(2),
  // 「同一版」那一档（见上）：这几个数才是「给一份新谱能读到多准」的答案
  sameEd: sameEd.length,
  sameNoteAcc: +avg(sameEd, "an").toFixed(2),
  sameTypeAcc: +avg(sameEd, "at").toFixed(2),
  sameSlurAcc: +avg(sameEd, "as").toFixed(2),
  samePitchAcc: +avg(sameEd, "ap").toFixed(2),
  // 小节数与反复只记**合计**，不进「不许变差」的门槛：
  // 逐首完全相同的只有个位数，噪声比信号大（见文档「现状与待办」）。
};
// ── `--errors` 汇总：按错因大类排行，逐条清单落盘（带页码与盒，可直接裁图） ──
if (args.includes("--errors")) {
  // **只收「数目相当」那一档**，与准确率的分母同口径：谱面用反复记号、GT 写成两遍的
  // 那些曲子（GT125→179）逐音对齐必然满屏「多出音符」，那是表述不一致不是读错，
  // 混进排行就把真正的错因淹掉了（实测占到 71%）。
  const sizedIds = new Set(sized.map((r) => r.id));
  const rowsE = errorRows.filter((e) => sizedIds.has(e.id));
  const tally = new Map();
  for (const e of rowsE) tally.set(e.why, (tally.get(e.why) ?? 0) + 1);
  console.log(`\n【错因排行】共 ${rowsE.length} 处（${sized.length} 首「数目相当」的曲子；另有 ${errorRows.length - rowsE.length} 处出自结构不一致的曲子，不计）`);
  for (const [why, n] of [...tally].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(5)}  ${((100 * n) / Math.max(1, rowsE.length)).toFixed(1).padStart(5)}%  ${why}`);
  await mkdir("staff-out", { recursive: true });
  await writeFile("staff-out/staff-errors.json", JSON.stringify(rowsE, null, 1));
  console.log(`→ staff-out/staff-errors.json（${rowsE.length} 条，带页码与盒）`);
}

if (args.includes("--bless") || only) {
  if (!only) {
    await mkdir("testdata/赞美之泉", { recursive: true });
    await writeFile(BASELINE, JSON.stringify(now, null, 1));
    console.log("基线已重写 →", BASELINE);
  }
} else {
  let base = null;
  try {
    base = JSON.parse(await readFile(BASELINE, "utf8"));
  } catch {
    await mkdir("testdata/赞美之泉", { recursive: true });
    await writeFile(BASELINE, JSON.stringify(now, null, 1));
    console.log("首次建立基线 →", BASELINE);
  }
  if (base) {
    const worse = Object.keys(now).filter((k) => now[k] < base[k]);
    console.log(`\n基线：${Object.entries(base).map(([k, v]) => k + "=" + v).join(" ")}`);
    if (worse.length) {
      console.log("✗ 比基线差的档：" + worse.map((k) => `${k} ${base[k]}→${now[k]}`).join("，"));
      process.exitCode = 1;
    } else {
      console.log("✓ 各档不低于基线");
    }
  }
}
