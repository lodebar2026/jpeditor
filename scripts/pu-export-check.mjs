// 文本谱互通回归：pu → Score → MusicXML / .jpwabc，核对结构不丢。
//
// 断言的是「同一份原文，经两条路得出同一首曲子」：
//   直接解析出的音符序列  vs  转成 Score 后再读回来的音符序列
// 用法：npm run build && node pu-export-check.mjs [曲名子串]
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { serveDist, launchPage, loadApp } from "./harness.mjs";


const filter = process.argv[2] ?? "";
const DIR = "testdata/pu";
const files = readdirSync(DIR).filter((f) => /\.(pu|jps)$/i.test(f) && f.includes(filter));
const { port, close: closeServer } = await serveDist();
const { browser, page, pageErrors: errors } = await launchPage({ quiet: true });
await loadApp(page, port);

let fail = 0;
for (const file of files) {
  const name = file.replace(/\.[^.]+$/, "");
  const src = readFileSync(join(DIR, file), "utf8");
  const r = await page.evaluate(async (text) => {
    const pu = await window.__pu;
    const xo = await window.__xmlout;
    const doc = pu.parsePu(text);
    const score = pu.puToScore(doc);
    if (!score) return { err: "puToScore 返回 null" };

    // 直接从 AST 数出的「有声音符」序列。口径必须与 puToScore 一致：
    //   按**声部**把全曲接起来（不是按 system 逐声部走），且不收内联层（临时伴奏）的音符。
    const song = doc.songs[0];
    const voices = [];
    for (const pg of song.pages) {
      for (const g of pg.groups) {
        for (const v of g.voices) if (!voices.includes(v.voice)) voices.push(v.voice);
      }
    }
    const astNotes = [];
    for (const voice of voices.length ? voices : [1]) {
      for (const pg of song.pages) {
        for (const g of pg.groups) {
          for (const v of g.voices) {
            if (v.voice !== voice) continue;
            for (const el of v.elements) {
              if (el.kind === "note" && el.sound === "note") {
                astNotes.push(String(el.pitch) + ":" + el.octave);
              }
            }
          }
        }
      }
    }
    // Score 侧同样口径
    const scoreNotes = [];
    for (const part of score.parts) {
      for (const m of part.measures) {
        for (const e of m.entries) {
          if (!e.notes || e.rest) continue;
          const nt = e.notes[0];
          scoreNotes.push(nt.number + ":" + nt.jpOctave);
        }
      }
    }
    const jpw = xo.scoreToJpwabc(score);
    // MusicXML 走 AST 直出（保住和弦/力度），这里同时校验它能被解析且不含空小节
    const xml = pu.puToMusicXml(doc);
    const xdoc = new DOMParser().parseFromString(xml, "application/xml");
    const parseErr = xdoc.querySelector("parsererror")?.textContent?.slice(0, 120) ?? "";
    const emptyMeasures = [];
    for (const part of xdoc.querySelectorAll("part")) {
      for (const m of part.querySelectorAll("measure")) {
        if (m.querySelectorAll("note").length === 0) {
          emptyMeasures.push(`${part.id}#${m.getAttribute("number")}`);
        }
      }
    }
    // 倚音也带 <pitch>，但不占时值，不算进「有声音符」
    const xmlNotes = [...xdoc.querySelectorAll("note")].filter(
      (n) => n.querySelector("pitch") && !n.querySelector("grace"),
    ).length;
    return {
      astNotes, scoreNotes, xmlNotes, parseErr, emptyMeasures,
      harmony: (xml.match(/<harmony>/g) || []).length,
      parts: score.parts.length,
      jpwOk: jpw.includes(".Voice") && jpw.includes(".Title"),
      diagnostics: doc.diagnostics.filter((d) => d.severity === "error").length,
    };
  }, src);

  const problems = [];
  if (r.err) problems.push(r.err);
  else {
    if (r.astNotes.join(" ") !== r.scoreNotes.join(" ")) {
      const a = r.astNotes, b = r.scoreNotes;
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      problems.push(
        `音符序列不符（AST ${a.length} 个 / Score ${b.length} 个，第 ${i + 1} 个起：` +
          `AST=${a.slice(i, i + 4).join(",")} Score=${b.slice(i, i + 4).join(",")}）`,
      );
    }
    if (r.parseErr) problems.push(`MusicXML 无法解析：${r.parseErr}`);
    if (r.emptyMeasures.length) {
      problems.push(`MusicXML 有空小节：${r.emptyMeasures.slice(0, 5).join(" ")}`);
    }
    if (r.xmlNotes !== r.scoreNotes.length) {
      problems.push(`MusicXML 的 <pitch> 数 ${r.xmlNotes} ≠ 有声音符 ${r.scoreNotes.length}`);
    }
    if (!r.jpwOk) problems.push(".jpwabc 缺少 .Voice / .Title 段");
  }

  if (problems.length === 0) {
    console.log(
      `PASS ${name}（${r.parts} 声部 / ${r.scoreNotes.length} 个有声音符` +
        (r.harmony ? ` / ${r.harmony} 个和弦` : "") + `）`,
    );
  } else {
    fail++;
    console.log(`FAIL ${name}`);
    for (const p of problems) console.log("   " + p);
  }
}

if (errors.length) {
  console.log("控制台错误：");
  for (const e of errors.slice(0, 5)) console.log("  " + e);
  fail++;
}
await browser.close();
closeServer();
process.exit(fail ? 1 : 0);
