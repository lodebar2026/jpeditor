// 识别 → 文本谱 回归：RecognizedScore 经 toPuText 出的原文，回解析后必须与识别结果逐项相等。
//
// 断言六条（两种方言各跑一遍）：
//   1. 产出的原文能被 sniffDialect 判回本方言（头部字段没写漏）；
//   2. parsePu 无 error 级诊断；
//   3. 回解析的音符序列（数字/八度/时值/附点/增时线数）与 flatten(rows[].nums) 逐项相等；
//   4. 逐音符各段歌词与 JpNum.lyrics 相等（对位不错行）；
//   5. meta.noteRanges[i] 切出的子串就是第 i 个音符 token（识别模式点选定位的正确性）；
//   6. 逐音符和弦（`"hx:…"`）与 JpNum.chord 相等，且总数不少一个。
//
// 用法：npm run build && node omr-pu-check.mjs [曲名子串...]（需本地 Edge）
import { readFile } from "node:fs/promises";

import { serveDist, launchPage, loadApp, findSongFixtures, mimeOf } from "./harness.mjs";

const songs = await findSongFixtures(process.argv.slice(2));
if (!songs.length) {
  console.log("testdata/ 下没找到可识别的歌谱文件夹");
  process.exit(0);
}
const { port, close: closeServer } = await serveDist();
const { browser, page } = await launchPage();

let fail = 0;
for (const song of songs) {
  // 同 measure-all.mjs：每首重载页面，免得 App/Score 在同一 page 里串味。
  await loadApp(page, port);
  const b64 = Buffer.from(await readFile(song.img)).toString("base64");
  const mime = mimeOf(song.img);
  let res;
  try {
    res = await page.evaluate(async ({ b64, mime }) => {
      const omr = await window.__omr;
      const pu = await window.__pu;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bin = await omr.decodeToBinary(bytes, mime);
      const rec = await omr.recognizeJianpu(bin, omr.paddleOcrBackend());
      const flat = rec.rows.flatMap((r) => r.nums);

      const out = {};
      for (const dialect of ["tomato", "shige"]) {
        const problems = [];
        const { text, meta } = omr.toPuText(rec, dialect);

        const sniff = pu.sniffDialect(text);
        if (sniff.dialect !== dialect) problems.push(`嗅探判成 ${sniff.dialect}（${sniff.reason}）`);

        const doc = pu.parsePu(text, { dialect });
        // 调号必须回得来：诗歌本的 `1=` 行只认「字母在前」，写反了会被读成别的调。
        // 经 puToScore 取 fifths（`bB` 与 `Bb` 在那里归一，比字面比对更贴实际用途）。
        const meta0 = doc.songs[0]?.metadata;
        const gotFifths = pu.puToScore(doc)?.parts?.[0]?.measures?.[0]?.key?.fifths ?? null;
        if (gotFifths !== rec.fifths) {
          problems.push(`调号回解析成「${meta0?.mode}」（fifths ${gotFifths}），识别为 fifths ${rec.fifths}`);
        }
        const wantMeter = `${rec.beats}/${rec.beatType}`;
        const gotMeter = meta0?.meters?.[0] ? `${meta0.meters[0].numerator}/${meta0.meters[0].denominator}` : "";
        if (gotMeter !== wantMeter) problems.push(`拍号回解析成「${gotMeter}」，识别为「${wantMeter}」`);
        // error 级一条都不许有；warning 里这几类说明产出的写法挂错了地方，同样不许有
        const BAD_WARN = ["orphan-annotation", "orphan-lyric-anchor", "unmatched-slur-end",
          "unmatched-volta-end", "bad-barline", "bad-mode", "bad-meter", "unknown-metadata"];
        for (const d of doc.diagnostics) {
          if (d.severity !== "error" && !BAD_WARN.includes(d.code)) continue;
          problems.push(`诊断 ${d.severity} ${d.code}: ${d.message}（行 ${d.source.line + 1}）`);
          if (problems.length > 6) break;
        }

        // 弧线（slur/tie 在文本谱里同为 `(...)`）、联合括号、注释：一并数出来核对
        let curveMarks = 0, joinBraces = 0, annotations = 0, adjacentBars = 0;
        // 回解析出的音符：按曲行顺序展平，并数每个音符后面跟了几条增时线
        const got = [];
        for (const pg of doc.songs[0]?.pages ?? []) {
          for (const g of pg.groups) {
            for (const v of g.voices) {
              // 跨行的弧线在每一行各留一条 mark，只数「不是承接上一行的」那些 = 弧线条数
              curveMarks += v.marks.filter((m) => m.type === "slur" && !m.continuationFromPrevious).length;
              joinBraces += v.lyrics.filter((l) => l.joinBrace).length;
              annotations += v.elements.filter((e) => e.annotation !== undefined).length;
              // 相邻两条小节线中间没音符：`:|` 紧接 `|:` 没合成 `:|:` 时会这样，谱面上画出两道线
              v.elements.forEach((e, i) => {
                if (e.kind === "barline" && v.elements[i + 1]?.kind === "barline") adjacentBars++;
              });
              const cursors = v.lyrics.map(() => 0);
              for (const el of v.elements) {
                if (el.kind === "sustain") {
                  if (got.length) {
                    got[got.length - 1].augment += 1;
                    // 增时线上方的和弦（长音里换和弦）：记下它挂在第几条增时线上
                    if (el.chord) got[got.length - 1].extras.push({ tok: el.chord, k: got[got.length - 1].augment });
                  }
                  continue;
                }
                if (el.kind !== "note") continue;
                const lyrics = [];
                if (el.lyricAnchor) {
                  v.lyrics.forEach((line, li) => {
                    const syl = line.syllables[cursors[li]++];
                    const t = syl ? (syl.text ?? "") + (syl.trailingPunctuation ?? "") : "";
                    if (t) lyrics[line.verseFrom - 1] = t;
                  });
                }
                got.push({
                  extras: [],
                  chord: el.chord,
                  digit: el.sound === "rest" ? 0 : el.pitch,
                  octave: el.octave,
                  div: Math.round(Math.log2(el.duration / 4)),
                  dot: el.dots,
                  augment: 0,
                  lyrics,
                });
              }
            }
          }
        }

        if (got.length !== flat.length) {
          problems.push(`音符数 ${got.length} ≠ 识别 ${flat.length}`);
        }
        let noteBad = 0, lyricBad = 0, rangeBad = 0, chordBad = 0;
        for (let i = 0; i < Math.min(got.length, flat.length); i++) {
          const a = flat[i], b = got[i];
          if (a.digit !== b.digit || a.octave !== b.octave || a.div !== b.div
              || a.dot !== b.dot || a.augment !== b.augment) {
            if (noteBad === 0) {
              problems.push(`音符 #${i} 不符：识别 ${a.digit}/o${a.octave}/u${a.div}/d${a.dot}/a${a.augment}`
                + ` → 回解析 ${b.digit}/o${b.octave}/u${b.div}/d${b.dot}/a${b.augment}`);
            }
            noteBad++;
          }
          for (let v = 0; v < (a.lyrics?.length ?? 0); v++) {
            const want = a.lyrics[v] ?? "";
            if (!want) continue;
            const has = b.lyrics[v] ?? "";
            if (has !== want) {
              if (lyricBad === 0) problems.push(`歌词 #${i} 段${v + 1}：识别「${want}」→ 回解析「${has}」`);
              lyricBad++;
            }
          }
          if ((a.chord ?? "") !== (b.chord ?? "")) {
            if (chordBad === 0) problems.push(`和弦 #${i}：识别「${a.chord ?? ""}」→ 回解析「${b.chord ?? ""}」`);
            chordBad++;
          }
          // 长音里换的和弦：识别侧的 extraChords 要原样落到对应那条增时线上（拍位不许漂）
          const wantExtra = (a.extraChords ?? []).map((e) => {
            const baseBeats = (1 / Math.pow(2, a.div)) * (a.dot > 0 ? 1.5 : 1);
            const k = Math.round(e.offset * (baseBeats + a.augment) - baseBeats) + 1;
            return `${e.tok}@${Math.min(Math.max(k, 1), a.augment)}`;
          }).join(",");
          const gotExtra = b.extras.map((e) => `${e.tok}@${e.k}`).join(",");
          if (wantExtra !== gotExtra) {
            if (chordBad === 0) problems.push(`增时线和弦 #${i}：识别「${wantExtra}」→ 回解析「${gotExtra}」`);
            chordBad++;
          }
          const r = meta.noteRanges[i];
          const token = r ? text.slice(r.from, r.to) : "";
          if (!/^[0-9]/.test(token)) {
            if (rangeBad === 0) problems.push(`meta.noteRanges[${i}] 指向「${token}」，不是音符 token`);
            rangeBad++;
          }
        }
        // 识别侧配得上对的弧线条数（先开先闭、休止符端点整条作废，同 topu.ts::pairCurves）
        let wantCurves = 0;
        {
          const q = [];
          for (const n of flat) {
            if (n.digit === 0) continue;
            for (let c = (n.slurStop ? 1 : 0) + (n.tieStop ? 1 : 0); c > 0; c--) {
              if (q.length) { q.shift(); wantCurves++; }
            }
            for (let o = (n.slurStart ? 1 : 0) + (n.tieStart ? 1 : 0); o > 0; o--) q.push(1);
          }
        }
        if (curveMarks !== wantCurves) problems.push(`弧线 ${curveMarks} 条，识别配对出 ${wantCurves} 条`);
        // 和弦：识别出的每一个都要出现在原文里、回解析后仍挂在同一个音符上（上面逐项比过）。
        // 这里再核一次总数，挡住「整批和弦被 emitter 漏写」这种回解析比不出来的情形。
        const wantChords = flat.reduce((a, n) => a + (n.chord ? 1 : 0) + (n.extraChords?.length ?? 0), 0);
        const gotChords = got.reduce((a, n) => a + (n.chord ? 1 : 0) + n.extras.length, 0);
        if (gotChords !== wantChords) problems.push(`和弦 ${gotChords} 个，识别有 ${wantChords} 个`);
        // 段落标记（Intro/副歌…）要挂成音符注释，不能丢
        const wantMarks = flat.filter((n) => n.sectionMark).length;
        if (annotations < wantMarks) problems.push(`段落标记 ${annotations} 个，识别有 ${wantMarks} 个`);
        // 歌词行末尾不该被读成「联合括号」——那是并字括号的收口被误认
        if (joinBraces) problems.push(`${joinBraces} 行歌词被读成联合括号（行末落单的 }）`);
        // 空小节：`:|` 紧接 `|:` 没合成 `:|:` 时会凭空多出来
        const empty = (pu.puToScore(doc)?.parts?.[0]?.measures ?? [])
          .filter((m) => !(m.entries ?? []).some((e) => e.notes?.length)).length;
        if (empty) problems.push(`${empty} 个空小节`);
        if (adjacentBars) problems.push(`${adjacentBars} 处两条小节线挨着（中间没音符）`);
        if (noteBad) problems.push(`音符不符共 ${noteBad} 个`);
        if (lyricBad) problems.push(`歌词不符共 ${lyricBad} 个`);
        if (rangeBad) problems.push(`区间不符共 ${rangeBad} 个`);
        if (chordBad) problems.push(`和弦不符共 ${chordBad} 个`);
        out[dialect] = { problems, notes: flat.length, chars: text.length, chords: wantChords };
      }
      return out;
    }, { b64, mime });
  } catch (e) {
    console.log(`✗ ${song.name}: 识别/校验异常 ${String(e).slice(0, 160)}`);
    fail++;
    continue;
  }

  for (const dialect of ["tomato", "shige"]) {
    const r = res[dialect];
    const tag = `${song.name} · ${dialect}`;
    if (r.problems.length) {
      fail++;
      console.log(`✗ ${tag}（${r.notes} 音符）`);
      for (const p of r.problems) console.log(`    ${p}`);
    } else {
      console.log(`✓ ${tag}（${r.notes} 音符${r.chords ? `，${r.chords} 和弦` : ""}，${r.chars} 字）`);
    }
  }
}

await browser.close();
closeServer();
console.log(fail ? `\n${fail} 项未通过` : `\n全部通过（${songs.length} 首 × 2 方言）`);
process.exit(fail ? 1 : 0);
