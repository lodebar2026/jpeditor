// 实测 musicpp 方案准确率：Edge 跑真实 src/omr（本地 tesseract.js OCR），结果转 jpwabc，
// 与 GT jpwabc 同一 normalizer 出 token，算 Levenshtein。用法：node measure-musicpp.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = join(process.cwd(), "dist");
const IMG = "testdata/日光之下/日光之下简谱.jpg";
const GT = "testdata/日光之下/日光之下.jpwabc";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".wasm": "application/wasm" };

function decodeJpwabc(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return Buffer.from(buf.slice(2)).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) { const s = Buffer.from(buf.slice(2)); s.swap16(); return s.toString("utf16le"); }
  return buf.toString("utf8");
}
function voiceTokens(text) {
  const lines = text.split(/\r?\n/); let inV = false; const toks = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (t.startsWith(".")) { inV = /^\.voice/i.test(t); continue; }
    if (!inV || !t) continue;
    const s = ln.replace(/\$\([^)]*\)/g, " ").replace(/[()\]]/g, " ");
    for (const raw of s.split(/\s+/)) {
      if (!raw) continue;
      if (raw === "|") { toks.push("|"); continue; }
      const m = raw.match(/^([0-7])([',]*)?(_*)(-*)(\.*)/);
      if (!m) continue;
      const oct = (m[2] || "").split("").reduce((a, c) => a + (c === "'" ? 1 : -1), 0);
      toks.push(`N${m[1]}o${oct}u${(m[3] || "").length}`);
      for (let i = 0; i < (m[4] || "").length; i++) toks.push("-");
    }
  }
  return toks;
}
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) { const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur; }
  return prev[n];
}

const server = createServer(async (req, res) => {
  try { let p = decodeURIComponent((req.url ?? "/").split("?")[0]); if (p === "/") p = "/index.html";
    const data = await readFile(join(ROOT, normalize(p)));
    res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" }); res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const jpgB64 = Buffer.from(await readFile(IMG)).toString("base64");
const rec = await page.evaluate(async ({ b64 }) => {
  const omr = await window.__omr;
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bin = await omr.decodeToBinary(bytes, "image/jpeg");
  const score = await omr.recognizeJianpu(bin, omr.localOcrBackend());
  const stats = { rows: score.rows.length, notes: score.rows.reduce((a, r) => a + r.nums.length, 0), bars: score.rows.reduce((a, r) => a + r.barlineXs.length, 0) };
  const xml = omr.toMusicXml(score);
  window.__app.importBytes(new TextEncoder().encode(xml), "omr.musicxml");
  return { jpw: window.__app.getText(), stats };
}, { b64: jpgB64 });

const gtToks = voiceTokens(decodeJpwabc(await readFile(GT)));
const recToks = voiceTokens(rec.jpw);
const acc = 1 - lev(gtToks, recToks) / Math.max(gtToks.length, recToks.length, 1);
const dOnly = (t) => t.map((x) => (x === "|" || x === "-" ? x : x.replace(/o-?\d+u\d+$/, "")));
const accD = 1 - lev(dOnly(gtToks), dOnly(recToks)) / Math.max(gtToks.length, recToks.length, 1);

console.log("结构:", JSON.stringify(rec.stats));
console.log("GT tokens:", gtToks.length, " 识别 tokens:", recToks.length);
console.log("完整 token 准确率:", (acc * 100).toFixed(1) + "%");
console.log("仅数字+小节线准确率:", (accD * 100).toFixed(1) + "%");
console.log("GT 前24 :", gtToks.slice(0, 24).join(" "));
console.log("识别前24:", recToks.slice(0, 24).join(" "));
if (errors.length) console.log("ERRORS:", errors.filter((e) => !/favicon/.test(e)).slice(0, 3).join(" | "));

await browser.close();
server.close();
