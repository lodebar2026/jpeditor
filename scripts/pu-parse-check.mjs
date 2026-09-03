// 文本谱解析回归：拿 testdata/pu/ref/ 下的参考渲染当权威答案，逐音符对拍。
//
// 参考 SVG 里每个音符/小节线都带元数据：
//   <use notepos="页_行_序号" code="源码token" time="拍数" audio="音高" xlink:href="#字形">
// 我们从中抽出 (kind, audio, time) 序列，与 window.__pu 的解析结果逐项比对。
// 比 `code` 可靠：`code` 是重排过的（源码 `(2/` 会写成 `2(/`），而
// kind/audio/time 是语义，正是解析器该负责的东西。
//
// 用法：npm run build && node pu-parse-check.mjs [曲名子串]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { serveDist, launchPage, loadApp } from "./harness.mjs";


/** 参考 SVG → 每行的 (kind, audio, time) 序列。 */
function referenceLines(svg) {
  const lines = new Map(); // "页_行" -> [{index, kind, audio, time}]
  const re = /<use\b[^>]*notepos="([^"]*)"[^>]*>/g;
  for (const m of svg.matchAll(re)) {
    const tag = m[0];
    const attr = (n) => {
      const a = new RegExp(`\\b${n}="([^"]*)"`).exec(tag);
      return a ? a[1] : "";
    };
    const [page, line, index] = m[1].split("_");
    const href = attr("xlink:href") || attr("href");
    let kind = "note";
    if (href.includes("xiaojiexian") || href.includes("xunhuan") || href.includes("jieshufu")) {
      kind = "barline";
    } else if (href.includes("yanyinfu")) kind = "sustain";
    else if (href.includes("shuzi_null")) kind = "hidden";
    const key = `${page}_${line}`;
    if (!lines.has(key)) lines.set(key, []);
    // 参考渲染会为「对齐各声部」自动补隐藏音符 `8`，那是排版决定不是解析结果；
    // `&bz`/`&dsb` 这类内联层标记也不在我们的元素序列里。两边一并剔除。
    if (kind === "hidden" || attr("code").startsWith("&")) continue;
    lines.get(key).push({
      index: Number(index),
      kind,
      audio: attr("audio"),
      time: attr("time"),
      code: attr("code"),
    });
  }
  for (const list of lines.values()) list.sort((a, b) => a.index - b.index);
  return lines;
}

/** 数字按参考渲染的写法规范化：两位小数、去掉多余的 0。 */
function fmtTime(beats) {
  return String(Math.round(beats * 100) / 100);
}

const filter = process.argv[2] ?? "";
const DIR = "testdata/pu";
const REF = join(DIR, "ref");
if (!existsSync(REF)) {
  console.error("没有 testdata/pu/ref/：缺少参考渲染，无法对拍");
  process.exit(1);
}
// 参考渲染有两种放法：谱面**同目录**下按页分开的 `<曲名>-1.svg`/`-2.svg`（首选），
// 或 `ref/<曲名>.svg`（单文件，多页用 `[fenye]` 一行分隔）。
const files = readdirSync(DIR);
const names = files
  .filter((f) => /\.(jps|pu)$/i.test(f))
  .map((f) => f.replace(/\.[^.]+$/, ""))
  .filter((n) => n.includes(filter))
  .filter((n) => files.some((f) => new RegExp(`^${n}-\\d+\\.svg$`).test(f)) || existsSync(join(REF, `${n}.svg`)));
if (names.length === 0) {
  console.error(`没有匹配 "${filter}" 且带参考渲染的谱面`);
  process.exit(1);
}

/** 一首曲子的参考渲染，按页返回 SVG 原文。 */
function refPagesOf(name) {
  const paged = files
    .filter((f) => new RegExp(`^${name}-\\d+\\.svg$`).test(f))
    .sort((a, b) => Number(/-(\d+)\.svg$/.exec(a)[1]) - Number(/-(\d+)\.svg$/.exec(b)[1]));
  if (paged.length > 0) return paged.map((f) => readFileSync(join(DIR, f), "utf8"));
  return readFileSync(join(REF, `${name}.svg`), "utf8").split("\n[fenye]\n");
}

const { port, close: closeServer } = await serveDist();
const { browser, page, pageErrors: errors } = await launchPage({ quiet: true });
await loadApp(page, port);

let fail = 0;
for (const name of names) {
  const srcFile = files.find((f) => new RegExp(`^${name}\\.(jps|pu)$`, "i").test(f));
  const source = readFileSync(join(DIR, srcFile), "utf8");
  const refPages = refPagesOf(name);
  const refLines = new Map();
  // 分页文件各自从第 1 行编号，页号取文件顺序；单文件里 notepos 自带页号
  refPages.forEach((svg, pi) => {
    for (const [k, v] of referenceLines(svg)) {
      refLines.set(refPages.length > 1 ? `${pi}_${k.split("_")[1]}` : k, v);
    }
  });

  // 我们的解析结果：按 页_行（与 notepos 对齐）
  const ours = await page.evaluate(async (src) => {
    const pu = await window.__pu;
    const doc = pu.parsePu(src, { dialect: "tomato" });
    const out = [];
    const allPages = doc.songs.flatMap((s) => s.pages);
    allPages.forEach((pg, pi) => {
      let lineNo = 0;
      for (const group of pg.groups) {
        for (const voice of group.voices) {
          lineNo += 1;
          const items = [];
          for (const el of voice.elements) {
            if (el.kind === "note") {
              items.push({
                kind: el.hidden ? "hidden" : el.sound === "rhythm" ? "note" : "note",
                pitch: el.pitch,
                octave: el.octave,
                duration: el.duration,
                dots: el.dots,
                hidden: el.hidden,
                code: el.code,
              });
              if (el.hidden) items.pop(); // 与参考口径一致：隐藏音符不参与对拍
            } else if (el.kind === "sustain") {
              items.push({ kind: "sustain", code: el.code });
            } else if (el.kind === "barline") {
              items.push({ kind: "barline", code: el.code });
            }
            // beat-boundary / inline-layer 不在参考的 notepos 序列里
          }
          out.push({ page: pi, line: lineNo, marks: voice.marks, items });
        }
      }
    });
    return { out, diagnostics: doc.diagnostics };
  }, source);

  // 参考渲染可能只导出了一部分页（`[fenye]` 之后那页没导），没覆盖到的页整页跳过
  const refPageSet = new Set([...refLines.keys()].map((k) => k.split("_")[0]));
  const problems = [];
  for (const d of ours.diagnostics) {
    problems.push(`诊断 ${d.code} 行${d.source.line + 1}: ${d.message}`);
  }

  for (const line of ours.out) {
    const key = `${line.page}_${line.line}`;
    const ref = refLines.get(key);
    if (!ref) {
      if (refPageSet.has(String(line.page))) {
        problems.push(`第 ${line.line} 行（页 ${line.page}）参考里没有对应行`);
      }
      continue;
    }
    // 多连音成员的时值要乘 2/3 之类的比例，先按 marks 标出来
    const tupletRatio = new Array(line.items.length).fill(1);
    for (const mk of line.marks) {
      if (mk.type !== "tuplet") continue;
      const n = mk.end - mk.start + 1;
      // 连音的音符数由括号内音符数自动计算：n 连音占 n-1 个基本时值（3 连音 → 2/3）
      const ratio = n <= 1 ? 1 : (n - 1) / n;
      for (let i = mk.start; i <= mk.end && i < tupletRatio.length; i++) tupletRatio[i] = ratio;
    }
    if (ref.length !== line.items.length) {
      problems.push(
        `第 ${line.line} 行元素数不符：我们 ${line.items.length}，参考 ${ref.length}` +
          `\n      我们: ${line.items.map((x) => x.code).join(" ")}` +
          `\n      参考: ${ref.map((x) => x.code).join(" ")}`,
      );
      continue;
    }
    for (let i = 0; i < ref.length; i++) {
      const r = ref[i];
      const o = line.items[i];
      const where = `第 ${line.line} 行第 ${i + 1} 个（参考 code=${r.code}，我们 code=${o.code}）`;
      if (r.kind !== o.kind) {
        problems.push(`${where} 种类不符：参考 ${r.kind}，我们 ${o.kind}`);
        continue;
      }
      if (o.kind === "barline" || o.kind === "sustain") continue;
      const audio =
        o.pitch === 9
          ? "9"
          : String(o.pitch) + (o.octave > 0 ? "'".repeat(o.octave) : ",".repeat(-o.octave));
      if (audio !== r.audio) {
        problems.push(`${where} 音高不符：参考 ${r.audio}，我们 ${audio}`);
      }
      const beats = (4 / o.duration) * (2 - Math.pow(2, -o.dots)) * tupletRatio[i];
      if (fmtTime(beats) !== r.time) {
        problems.push(`${where} 时值不符：参考 ${r.time}，我们 ${fmtTime(beats)}`);
      }
    }
  }

  if (problems.length === 0) {
    const notes = ours.out.reduce((n, l) => n + l.items.length, 0);
    console.log(`PASS ${name}（${ours.out.length} 行 / ${notes} 个符号）`);
  } else {
    fail++;
    console.log(`FAIL ${name}`);
    for (const p of problems.slice(0, 25)) console.log(`   ${p}`);
    if (problems.length > 25) console.log(`   …还有 ${problems.length - 25} 条`);
  }
}

if (errors.length > 0) {
  console.log("控制台错误：");
  for (const e of errors.slice(0, 5)) console.log("  " + e);
  fail++;
}
await browser.close();
closeServer();
process.exit(fail ? 1 : 0);
