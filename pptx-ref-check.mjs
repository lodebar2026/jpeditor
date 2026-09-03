// PPTX 导出的**成品回归**：把导出的 .pptx 拆开量几何，与 2019 年那批成品
// （`~/Documents/诗歌/500首/ppt500/`，原桌面版在 Windows 上导的）对同一套判据。
//
// 为什么不在页面树上量（那是 `pptx-check.mjs` 干的）：这一路查的恰恰是
// **排版字体（PingFang SC）与 .pptx 里写的字体（Microsoft YaHei）度量不一致**
// 那一层修正（见 `src/editor/pptx.ts` 的 TARGET_ADVANCE 一段）。页面树上看不出来。
//
// 用法：npm run build && node pptx-ref-check.mjs
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { serveDist, launchPage, loadApp } from "./scripts/harness.mjs";
import { CORPUS_ROOT } from "./scripts/node-harness.mjs";

const EM = 28; // 内置默认字号，导出的谱面也是这个
/** 全部量自 ppt500（28pt 上的 pt 值），换算成 em 比例写在括号里。 */
const REF = {
  digitWidth: 16.42,     // 0.5864 em —— YaHei 等宽数字
  dashWidth: 12.11,      // 0.4326 em
  descent: 7.33,         // 0.2617 em —— 基线到文本框底（anchor="b"）
  beamDy: 4.669,         // em/6      —— 基线到第一道减时线
  beamDy2: 7.935,        // + em·7/60 —— 第二道
  octaveUpDy: -27.55,    // −0.9839 em —— 基线到高音点**墨迹中心**
  beamWidth: 1.4,        // em/20     —— 减时线线宽
  augGap: 4.6,           // 0.165 em  —— 数字墨迹右缘到附点左缘（各数字应当一样宽）
  bandBottom: -27.07,    // −0.967 em —— 圆滑线外弧两端（弧的下缘）离基线多远；
                         //              fermata 的下缘也落在这一格（成品是 −26.04）
};
const TOL = 0.12;

const P = 12700;
const num = (s, k) => Number(new RegExp(`${k}="(-?\\d+)"`).exec(s)?.[1] ?? NaN) / P;

/** 我们自己导的片子里 spTree 是**平的**（没有 grpSp），所以正则够用。 */
function shapesOf(xmlText) {
  const out = [];
  for (const m of xmlText.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
    const sp = m[0];
    const off = /<a:off ([^/]*)\/>/.exec(sp)?.[1] ?? "";
    const ext = /<a:ext ([^/]*)\/>/.exec(sp)?.[1] ?? "";
    const text = [...sp.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join("");
    const szm = /<a:rPr[^>]*sz="(\d+)"/.exec(sp);
    const lnm = /<a:ln w="(\d+)"/.exec(sp);
    const segs = (sp.match(/<a:(moveTo|lnTo|cubicBezTo|close)/g) ?? []).length;
    out.push({
      x: num(off, "x"), y: num(off, "y"), w: num(ext, "cx"), h: num(ext, "cy"),
      text, size: szm ? Number(szm[1]) / 100 : null,
      strokeW: lnm ? Number(lnm[1]) / P : null, segs,
    });
  }
  return out;
}

const { port, close: closeServer } = await serveDist();
const { browser, page } = await launchPage({ viewport: { width: 1280, height: 900 }, quiet: true });
await loadApp(page, port, { reveal: true, wait: 1200 });

// 001 出数字/减时线/八度点/附点，044 另出圆滑线与 fermata。
const SONGS = ["001.圣哉，圣哉，圣哉", "044.真神妙爱"];
const decks = [];
for (const song of SONGS) {
const xml = await readFile(join(CORPUS_ROOT, "500", `${song}.musicxml`), "utf8");
const b64 = await page.evaluate(async (xml) => {
  const app = window.__app;
  const { buildPptx, pptxPainter } = await window.__pptx;
  app.importBytes(new TextEncoder().encode(xml), "song.musicxml");
  app.setPhraseLayout(true);
  const bytes = await buildPptx(pptxPainter(app));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}, xml);
  decks.push(unzipSync(new Uint8Array(Buffer.from(b64, "base64"))));
}
await browser.close();
closeServer();

const dec = new TextDecoder();
const slides = decks.flatMap((zip) =>
  Object.keys(zip)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .map((k) => zip[k]));

let fail = 0;
const check = (name, got, want, tol = TOL) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) { fail++; console.log(`  ✗ ${name}：${got.toFixed(3)}（应为 ${want}）`); }
  return ok;
};
const stats = { digits: 0, dashes: 0, beams: 0, dots: 0, augs: 0, arcs: 0 };

for (const s of slides) {
  const sh = shapesOf(dec.decode(s));
  const notes = sh.filter((q) => q.size === EM && /^[0-7]$/.test(q.text));
  const dashes = sh.filter((q) => q.size === EM && q.text === "-");
  // 小节线：竖的细长路径，上缘 = 基线 − em（PPT 档的 jpStaffTop）
  const bars = sh.filter((q) => q.w < 0.1 && Math.abs(q.h - EM * 4 / 3) < 0.2);
  const beams = sh.filter((q) => q.h < 0.1 && q.w > 1 && q.strokeW !== null);
  // 矢量圆（八度点/附点）：无描边的小正方形包围盒
  const dots = sh.filter((q) => q.strokeW === null && q.w < EM / 5 && Math.abs(q.w - q.h) < 0.01);
  const baselines = [...new Set(bars.map((b) => Math.round((b.y + EM) * 100) / 100))];
  const baseOf = (y) => baselines.reduce((a, b) => (Math.abs(b - y) < Math.abs(a - y) ? b : a), baselines[0]);

  for (const n of notes) {
    stats.digits++;
    check(`数字 "${n.text}" 宽`, n.w, REF.digitWidth);
    check(`数字 "${n.text}" 框底`, n.y + n.h - baseOf(n.y + n.h), REF.descent);
  }
  for (const d of dashes) { stats.dashes++; check("增时线宽", d.w, REF.dashWidth); }
  for (const b of beams) {
    const base = baseOf(b.y);
    // **只数同一条谱行里的**：换了断句之后，别的行也可能有一道减时线落在同一个 x 上，
    // 不限行的话第一道会被当成第二道（该 4.669 却按 7.935 判）。
    const lvl = beams.filter(
      (q) => Math.abs(q.x - b.x) < 0.1 && q.y < b.y - 0.1 && baseOf(q.y) === base,
    ).length;
    stats.beams++;
    check("减时线离基线", b.y - base, lvl === 0 ? REF.beamDy : REF.beamDy2);
    check("减时线线宽", b.strokeW, REF.beamWidth);
    // 两端必须正好接在数字盒上
    const l = notes.find((q) => Math.abs(q.x - b.x) < 0.15);
    const r = notes.find((q) => Math.abs(q.x + q.w - (b.x + b.w)) < 0.15);
    if (!l || !r) { fail++; console.log(`  ✗ 减时线两端没接上数字盒（x=${b.x.toFixed(2)}）`); }
  }
  // 弧（外弧是 4 条命令的填充月牙）与 fermata（转曲的 SMuFL 字形）：下缘落在同一格
  for (const c of sh) {
    if (!c.text && c.segs >= 4 && c.w > 6 && c.strokeW === null && c.h > 3) {
      const kind = c.segs === 4 ? "圆滑线" : "fermata";
      if (kind === "fermata" && c.w > EM) continue; // 只认音符上方那一枚
      stats.arcs++;
      check(`${kind}下缘离基线`, c.y + c.h - baseOf(c.y + c.h), REF.bandBottom, 1.2);
    }
  }
  for (const d of dots) {
    const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
    const base = baseOf(cy);
    const over = notes.find((q) => Math.abs(q.x + q.w / 2 - cx) < 0.15 && cy < base - EM * 0.6);
    if (!over) {
      // 附点：在数字右侧、与数字大致等高。判它离**数字墨迹右缘**多远——排版是拿
      // PingFang 量的墨迹，不修正的话 "1." 会比 "5." 挤掉一半（见 pptx.ts::augDotX）。
      const host = notes.find((q) => cx - (q.x + q.w / 2) > 0 && cx - (q.x + q.w / 2) < EM
        && Math.abs(cy - (q.y + q.h / 2)) < EM / 2);
      if (host) {
        stats.augs++;
        check(`附点离 "${host.text}" 墨迹右缘`, d.x - (host.x + 0.532 * EM), REF.augGap, 0.6);
      }
      continue;
    }
    stats.dots++;
    check("高音点离基线", cy - base, REF.octaveUpDy);
  }
}

console.log(`量了 ${slides.length} 页：数字 ${stats.digits}、增时线 ${stats.dashes}、` +
  `减时线 ${stats.beams}、高音点 ${stats.dots}、附点 ${stats.augs}、弧与 fermata ${stats.arcs}`);
console.log(fail ? `\n✗ ${fail} 项不过` : "\n✓ 全部通过（与 ppt500 同一套几何）");
process.exit(fail ? 1 : 0);
