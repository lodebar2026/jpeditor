// 「简谱」/「PPT」两档版面的回归。
//
// PPT 档原本是 2a8aa85（观感大改 29ae9dd 的父提交）的**逐点复刻**，如今有两处**刻意背离**
// （用户口径，见 src/layout/pptxstyle.ts）：小节线的上下缘改用简谱档那一份（老档矮三分之一，
// 投影上看不出是小节线；拍号比例跟着回默认，画出来仍与老档等大），
// 以及附点/高音点/低音点三种点统一成同一个半径（附点从字形改成矢量圆）。
// 其余笔画（小节线宽、减时线、弧、旧式纵向栅格）仍按 2a8aa85 的实测值写死在 EXPECT 里。
//
// 简谱档这边是另一套观感（不是 PPT 档的「前身」）：多段歌词**叠排**在同一条谱行下
// （`lyricStack`）、整首排成**一张连续长纸**（`continuousPage`，宽 1000、高由内容定）、
// 标题排在纸顶、没有页眉页脚。所以下面页脚那一节只查 PPT 档。
//
// 用法：npm run build && node pptx-check.mjs
import { serveDist, launchPage, loadApp } from "./scripts/harness.mjs";

/** 2a8aa85 在内置示例谱（圣哉，圣哉，圣哉 / 28pt / 960×540）上实测到的笔画。 */
const EXPECT = {
  // 简谱档：一张连续长纸（标题在纸顶，4 段歌词叠在一条谱行下）
  normalPages: 1,
  normalLeaves: 288,
  // PPT 档：逐段展开，一段一页（1 张标题页 + 4 段）
  pages: 5,
  leaves: 550,
  // 小节线的上下缘：**改用简谱档那一份**（−1 em / +1/3 em），不再是老档的 −23/28、+5/28
  jpStaffTop: -28,
  jpStaffBottom: 9.333,
  barlineWidth: 1.5,
  finalBarlineWidth: 3.5,
  jpBeamWidth: 1.25,
  jpBeamTop: 3.5,
  slurTieThickness: 4,
  slurOutlineWidth: 0,
  // 竖线（小节线）与横线（减时线）各自的线宽直方图，取第 2 页
  barlineStrokes: { 1.5: 16, 3.5: 0 },
  beamStrokes: { 1.25: 4 },
  // 页脚：曲名 + 页码。这两样**新旧本来就一致**，这里是防它被改坏。
  footerSize: 22.4,
  footerTitleX: 390.398,
  footerY: 498,
  footerPageNoX: 818,
};

const { port, close: closeServer } = await serveDist();
const { browser, page, errors } = await launchPage({ viewport: { width: 1280, height: 900 }, quiet: true });
await loadApp(page, port, { reveal: true, wait: 1200 });

const probe = async () =>
  page.evaluate(() => {
    const p = window.__app.painter;
    const o = p.layout.options;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const leaves = [];
    const walk = (item, pg) => {
      const pos = item.pos(null);
      if (typeof item.text === "string") {
        leaves.push({ k: "text", pg, x: r3(pos.x), y: r3(pos.y), t: item.text, sz: r3(item.font?.size) });
      } else if (item.p0 && item.p1) {
        leaves.push({ k: "line", pg, x: r3(pos.x), y: r3(pos.y), sw: r3(item.strokeWidth), horiz: Math.abs(item.p1.x) > 0.01 });
      } else if (Array.isArray(item.segs)) {
        leaves.push({ k: "path", pg, x: r3(pos.x), y: r3(pos.y) });
      }
      for (const c of item.children ?? []) walk(c, pg);
    };
    p.layout.pages.forEach((g, i) => walk(g, i));
    return {
      pages: p.layout.pages.length,
      leaves,
      opt: {
        jpStaffTop: r3(o.jpStaffTop), jpStaffBottom: r3(o.jpStaffBottom),
        barlineWidth: o.barlineWidth, finalBarlineWidth: o.finalBarlineWidth,
        jpBeamWidth: o.jpBeamWidth, jpBeamTop: r3(o.jpBeamTop),
        slurTieThickness: o.slurTieThickness, slurOutlineWidth: o.slurOutlineWidth,
        jpGridLegacy: o.jpGridLegacy,
      },
    };
  });

// 默认档已经是 PPT（编辑器的「排版」四档里 PPT 打头），原版档要显式切过去。
await page.evaluate(() => window.__app.setJpProfile("normal"));
await page.waitForTimeout(800);
const normal = await probe();
await page.evaluate(() => window.__app.setJpProfile("pptx"));
await page.waitForTimeout(800);
const pptx = await probe();

let bad = 0;
const fail = (m) => { console.log("  ✗ " + m); bad++; };
const eq = (got, want, what) => { if (got !== want) fail(`${what}：${got}（应为 ${want}）`); };

console.log("【原版档】不该受 PPT 档影响");
eq(normal.opt.jpGridLegacy, false, "jpGridLegacy");
eq(normal.opt.jpBeamWidth, 1.5, "减时线宽");
eq(normal.opt.barlineWidth, 2, "小节线宽");
eq(normal.pages, EXPECT.normalPages, "页数");
eq(normal.leaves.length, EXPECT.normalLeaves, "叶子数");

console.log("【PPT 档】笔画（除小节线高度与三种点外，仍是 2a8aa85 那一套）");
for (const k of ["jpStaffTop", "jpStaffBottom", "barlineWidth", "finalBarlineWidth",
                 "jpBeamWidth", "jpBeamTop", "slurTieThickness", "slurOutlineWidth"]) {
  eq(pptx.opt[k], EXPECT[k], k);
}
eq(pptx.opt.jpGridLegacy, true, "jpGridLegacy");
eq(pptx.pages, EXPECT.pages, "页数");
eq(pptx.leaves.length, EXPECT.leaves, "叶子数");

// 第 2 页的线宽直方图：竖的是小节线、横的是减时线
const hist = (pred) => {
  const m = {};
  for (const e of pptx.leaves) if (e.k === "line" && e.pg === 1 && pred(e)) m[e.sw] = (m[e.sw] ?? 0) + 1;
  return m;
};
const vert = hist((e) => !e.horiz), horiz = hist((e) => e.horiz);
eq(vert[1.5] ?? 0, EXPECT.barlineStrokes[1.5], "第2页小节线（1.5pt）条数");
eq(horiz[1.25] ?? 0, EXPECT.beamStrokes[1.25], "第2页减时线（1.25pt）条数");

// 页脚：两档都得与老版一致
console.log("【页脚】曲名 + 页码（只有 PPT 档有；简谱档是连续长纸，没有页眉页脚）");
for (const [name, d] of [["PPT", pptx]]) {
  const foot = d.leaves.filter((e) => e.k === "text" && e.pg === 1 && e.y === EXPECT.footerY);
  if (foot.length !== 2) { fail(`${name}档第2页页脚元素 ${foot.length} 个（应为 2）`); continue; }
  eq(foot[0].sz, EXPECT.footerSize, `${name}档页脚字号`);
  eq(foot[0].x, EXPECT.footerTitleX, `${name}档页脚曲名 x`);
  eq(foot[1].x, EXPECT.footerPageNoX, `${name}档页码 x`);
  eq(foot[1].t, "1/4", `${name}档页码文字`);
}

const real = errors.filter((e) => !/favicon/.test(e));
if (real.length) { console.log("控制台报错：\n" + real.join("\n")); bad++; }
console.log(bad === 0 ? "\n✓ 全部通过" : `\n✗ ${bad} 项不过`);
await browser.close();
closeServer();
process.exit(bad === 0 ? 0 : 1);
