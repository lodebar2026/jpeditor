// 文本谱「按乐句重排」回归：重排只该改行结构，音符、歌词对位、小节都不许动。
//
// 断言（对 testdata 下每一份文本谱）：
//   1. 重排前后经 puToScore 得到的曲子完全一致——逐声部的音符（音高/八度/临时记号/时值/休止）、
//      逐音符的各段歌词、小节数；
//   2. 诊断条数不增加（没有把原文切坏）；
//   3. 幂等：对重排结果再排一次，一字不变。
// 用法：npm run build && node scripts/pu-phrase-check.mjs [文件名子串]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { serveDist, launchPage, loadApp } from "./harness.mjs";

const filter = process.argv[2] ?? "";
const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(pu|jps)$/i.test(f)) files.push(p);
  }
};
walk("testdata");
const targets = files.filter((f) => f.includes(filter)).sort();
if (targets.length === 0) { console.log("没有可测的文本谱"); process.exit(1); }

const { port, close: closeServer } = await serveDist();
const { browser, page } = await launchPage({ quiet: true });
await loadApp(page, port);

let fail = 0;
for (const file of targets) {
  const src = readFileSync(file, "utf8");
  const r = await page.evaluate(async (text) => {
    const pu = await window.__pu;
    // 曲子的「内容指纹」：行结构之外的一切。两条路都经 puToScore，口径与展开档一致。
    const fingerprint = (doc) => {
      const out = [];
      for (let i = 0; i < doc.songs.length; i++) {
        const score = pu.puToScore(doc, { song: i });
        if (!score) { out.push("null"); continue; }
        for (const part of score.parts) {
          out.push(`#${part.measures.length}`);
          for (const m of part.measures) {
            for (const e of m.entries) {
              if (!e.notes) continue;
              const n = e.notes[0];
              const lrc = n.lyrics.map((l) => `${l.number}=${l.text}`).join("/");
              out.push(`${n.number}${n.jpOctave}${n.jpAlter.trim()}:${e.beats}.${e.dot}${e.rest ? "r" : ""}[${lrc}]`);
            }
          }
        }
      }
      return out.join(" ");
    };
    const doc = pu.parsePu(text);
    const relaid = pu.relayoutPuText(text, doc, {});
    const doc2 = pu.parsePu(relaid);
    const again = pu.relayoutPuText(relaid, doc2, {});
    const a = fingerprint(doc);
    const b = fingerprint(doc2);
    let diff = -1;
    if (a !== b) {
      const xa = a.split(" "), xb = b.split(" ");
      for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
        if (xa[i] !== xb[i]) { diff = i; break; }
      }
      return { ok: false, diff, a: a.split(" ").slice(Math.max(0, diff - 3), diff + 4).join(" "),
               b: b.split(" ").slice(Math.max(0, diff - 3), diff + 4).join(" ") };
    }
    return {
      ok: true,
      diag: doc.diagnostics.length,
      diag2: doc2.diagnostics.length,
      worse: doc2.diagnostics.filter((d) => d.code !== "lyric-without-music").length
           - doc.diagnostics.filter((d) => d.code !== "lyric-without-music").length,
      codes: doc2.diagnostics.map((d) => d.code).join(","),
      idem: again === relaid,
      lines: relaid.split("\n").length,
    };
  }, src);
  const name = file.replace(/^testdata\//, "");
  if (!r.ok) {
    fail++;
    console.log(`✗ ${name}  第 ${r.diff} 个音符起不一致`);
    console.log(`    原 ${r.a}`);
    console.log(`    新 ${r.b}`);
    continue;
  }
  const bad = [];
  if (r.worse > 0) bad.push(`诊断 ${r.diag}→${r.diag2}（${r.codes}）`);
  if (!r.idem) bad.push("不幂等");
  if (bad.length) { fail++; console.log(`✗ ${name}  ${bad.join("；")}`); }
  else console.log(`✓ ${name}`);
}
console.log(fail === 0 ? `全部通过（${targets.length} 份）` : `${fail}/${targets.length} 份不通过`);
await browser.close(); closeServer();
process.exit(fail === 0 ? 0 : 1);
