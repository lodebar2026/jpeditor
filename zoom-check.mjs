// 谱面区的**纸张宽度与双指缩放/平移**回归。
//
//   npm run build && node zoom-check.mjs
//
// 守四条：
//   Z1 四档（PPT/简谱/五线谱/混排）纸宽一致——混排从前单独写 620px
//   Z2 缩放确实作用在纸上（zoom ×2 / ×0.5 纸宽同比例）——`--score-zoom` 是设在
//      `#score-pane` 上的，把整条 calc 挪进 `:root` 会让它恒取回退值 1，缩放整个失效
//   Z3 触控板捏合（ctrl+wheel）改缩放，且按手指位置锚定（滚动跟着走）；捏回去能复原
//   Z4 不带 ctrl 的滚轮是**平移**（原生滚动），不许改缩放
//   Z5 WebKit/WKWebView（Tauri macOS）那一路的 `gesture*` 事件同样改缩放
import { readFile } from "node:fs/promises";
import { serveDist, launchPage, loadApp } from "./scripts/harness.mjs";

const XML = process.argv[2]
  ?? "/Users/jonah/Documents/诗歌/Praise as One/拥戴我主为君/拥戴我主为君.xml";

let bad = 0;
const ok = (cond, name, detail) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? `　${detail}` : ""}`);
  if (!cond) bad++;
};

const { port, close } = await serveDist();
const { browser, page } = await launchPage({ viewport: { width: 1500, height: 950 }, quiet: true });
await loadApp(page, port, { reveal: true });

const geom = () => page.evaluate(() => {
  const el = document.querySelector(".score-page-wrap");
  const r = el.getBoundingClientRect();
  const p = document.getElementById("score-pane");
  return { zoom: window.__app.zoom, w: Math.round(r.width), sl: Math.round(p.scrollLeft), st: Math.round(p.scrollTop) };
});
const center = await page.evaluate(() => {
  const r = document.getElementById("score-pane").getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});
const setZoom = async (z) => {
  await page.evaluate((v) => window.__app.setZoom(v), z);
  await page.waitForTimeout(200);
};

console.log("【Z2】缩放作用在纸上");
const z1 = await geom();
await setZoom(2);
const z2 = await geom();
await setZoom(0.5);
const z05 = await geom();
ok(Math.abs(z2.w - z1.w * 2) <= 2, "zoom 2 → 纸宽 ×2", `${z1.w} → ${z2.w}`);
ok(Math.abs(z05.w - z1.w * 0.5) <= 2, "zoom 0.5 → 纸宽 ÷2", `${z1.w} → ${z05.w}`);
await setZoom(1);

console.log("【Z3】触控板捏合（ctrl+wheel）");
await page.mouse.move(center.x, center.y);
const before = await geom();
await page.keyboard.down("Control");
for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -60);
await page.keyboard.up("Control");
await page.waitForTimeout(300);
const pinchIn = await geom();
ok(pinchIn.zoom > before.zoom * 1.5, "捏合放大改了缩放", `${before.zoom} → ${pinchIn.zoom.toFixed(2)}`);
ok(pinchIn.sl > 0 || pinchIn.st > 0, "按手指位置锚定（滚动跟着走）", `scroll ${pinchIn.sl},${pinchIn.st}`);
await page.keyboard.down("Control");
for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 60);
await page.keyboard.up("Control");
await page.waitForTimeout(300);
const pinchOut = await geom();
ok(Math.abs(pinchOut.zoom - before.zoom) < 0.02, "捏回去复原", `${pinchOut.zoom.toFixed(3)}`);

console.log("【Z4】不带 ctrl 的滚轮是平移");
await setZoom(2);
const p0 = await geom();
await page.mouse.wheel(0, 300);
await page.waitForTimeout(200);
const p1 = await geom();
ok(p1.st > p0.st, "滚动了", `scrollTop ${p0.st} → ${p1.st}`);
ok(p1.zoom === p0.zoom, "缩放没变", String(p1.zoom));

console.log("【Z5】WebKit 的 gesture* 事件");
await setZoom(1);
await page.evaluate(({ x, y }) => {
  const pane = document.getElementById("score-pane");
  const mk = (t, scale) => {
    const e = new Event(t, { bubbles: true, cancelable: true });
    e.scale = scale; e.clientX = x; e.clientY = y;
    return e;
  };
  pane.dispatchEvent(mk("gesturestart", 1));
  pane.dispatchEvent(mk("gesturechange", 1.8));
  pane.dispatchEvent(mk("gestureend", 1.8));
}, center);
await page.waitForTimeout(300);
const g = await geom();
ok(Math.abs(g.zoom - 1.8) < 0.02, "scale 1.8 → zoom 1.8", g.zoom.toFixed(3));

console.log("【Z1】四档纸宽一致");
await setZoom(1);
const xml = await readFile(XML, "utf-8");
const modes = await page.evaluate(async (x) => {
  const app = window.__app;
  const w = () => Math.round(document.querySelector(".score-page-wrap").getBoundingClientRect().width);
  const o = {};
  app.adoptStaffXml(x); await new Promise((r) => setTimeout(r, 900)); o.混排 = w();
  await app.setViewMode("staff"); await new Promise((r) => setTimeout(r, 400)); o.五线谱 = w();
  await app.setViewMode("jianpu"); await new Promise((r) => setTimeout(r, 400)); o.简谱 = w();
  await app.setViewMode("ppt"); await new Promise((r) => setTimeout(r, 400)); o.PPT = w();
  return o;
}, xml);
const widths = Object.values(modes);
ok(new Set(widths).size === 1, "四档同宽", JSON.stringify(modes));

await browser.close();
close();
console.log(bad === 0 ? "\n✓ 全部通过" : `\n✗ ${bad} 项不过`);
process.exit(bad === 0 ? 0 : 1);
