// Node 管线 vs 浏览器管线的**逐字符一致性**校验：同一张图，两边各跑一遍简谱 OMR，
// 比文本谱原文（诗歌本/番茄两种方言）与结构统计。两边共用同一份 src/omr 源码，
// 差异只可能来自后端（图片解码、推理运行时），故这条脚本就是 Node CLI 的验收依据。
//
// 用法（从仓库根跑）：node scripts/omr-node-check.mjs [曲名子串...]
// 需先 npm run build（浏览器侧 dist）与 npm run build:cli（Node 侧 dist-cli/omr.js）。
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { serveDist, launchPage, loadApp, findSongFixtures, imageArg, mimeOf } from "./harness.mjs";

const filters = process.argv.slice(2);
const cli = await import(new URL("../dist-cli/omr.js", import.meta.url).href);

const songs = await findSongFixtures(filters);
const { port, close } = await serveDist("dist");
const { page, close: closeBrowser } = await launchPage({ quiet: true });

const rows = [];
for (const s of songs) {
  // PDF 只有浏览器那条路认（Node CLI 只吃位图，见 src/omr/decode.node.ts）。
  if (extname(s.img).toLowerCase() === ".pdf") { rows.push({ name: s.name, skip: "PDF" }); continue; }
  await loadApp(page, port);
  const arg = await imageArg(s.img);
  const web = await page.evaluate(async ({ b64, mime }) => {
    const omr = await window.__omr;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bin = await omr.decodeToBinary(bytes, mime);
    const score = await omr.recognizeJianpu(bin, omr.paddleOcrBackend());
    return {
      shige: omr.toPuText(score, "shige").text,
      tomato: omr.toPuText(score, "tomato").text,
      w: bin.w, h: bin.h,
      rows: score.rows.length,
      notes: score.rows.reduce((a, r) => a + r.nums.length, 0),
    };
  }, arg);

  const bytes = new Uint8Array(await readFile(s.img));
  const t = performance.now();
  const d = await cli.recognizeMusicppDetailed(bytes, mimeOf(s.img));
  const ms = performance.now() - t;
  const node = {
    shige: cli.toPuText(d.score, "shige").text,
    tomato: cli.toPuText(d.score, "tomato").text,
    w: d.bin.w, h: d.bin.h,
    rows: d.score.rows.length,
    notes: d.score.rows.reduce((a, r) => a + r.nums.length, 0),
  };

  const same = web.shige === node.shige && web.tomato === node.tomato;
  const diffs = [];
  if (web.w !== node.w || web.h !== node.h) diffs.push(`尺寸 ${web.w}×${web.h} vs ${node.w}×${node.h}`);
  if (web.rows !== node.rows) diffs.push(`行 ${web.rows} vs ${node.rows}`);
  if (web.notes !== node.notes) diffs.push(`音 ${web.notes} vs ${node.notes}`);
  if (!same) {
    for (const k of ["shige", "tomato"]) {
      if (web[k] === node[k]) continue;
      const a = web[k], b = node[k];
      let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
      diffs.push(`${k} 首处差异 @${i}: 网页「${a.slice(i, i + 24).replace(/\n/g, "⏎")}」 Node「${b.slice(i, i + 24).replace(/\n/g, "⏎")}」`);
    }
  }
  rows.push({ name: s.name, same, diffs, ms, notes: node.notes });
  console.log(`${same ? "✓" : "✗"} ${s.name}  ${node.rows}行/${node.notes}音  Node ${ms.toFixed(0)}ms`);
  for (const d2 of diffs) console.log(`    ${d2}`);
}
await closeBrowser(); close();

const done = rows.filter((r) => !r.skip);
const ok = done.filter((r) => r.same).length;
const skipped = rows.filter((r) => r.skip);
console.log(`\n一致 ${ok}/${done.length} 首` + (skipped.length ? `（跳过 ${skipped.map((r) => `${r.name}[${r.skip}]`).join("、")}）` : ""));
if (done.length) {
  const tot = done.reduce((a, r) => a + r.ms, 0);
  console.log(`Node 识别合计 ${(tot / 1000).toFixed(1)}s，平均 ${(tot / done.length).toFixed(0)}ms/首`);
}
process.exit(ok === done.length ? 0 : 1);
