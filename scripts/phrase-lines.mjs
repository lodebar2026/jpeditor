// 查看某首歌的「按乐句排版」分行：每行的小节数/格数/歌词。
// 用法：node phrase-lines.mjs <歌谱文件夹名子串>
// 首次会跑 OMR 并把 musicxml 缓存到 .phrase-cache/，之后直接复用（改 phrase.ts 后重跑很快）；
// PHRASE_FRESH=1 强制重新识别。
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { serveDist, launchPage, loadApp, mimeOf } from "./harness.mjs";

const TESTDATA = join(process.cwd(), "testdata");
const CACHE = process.env.PHRASE_CACHE ?? join(process.cwd(), ".phrase-cache");
const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp"]);

const filter = process.argv[2] ?? "";
const dirs = (await readdir(TESTDATA, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name.includes(filter));
if (!dirs.length) { console.log("没找到歌谱"); process.exit(1); }
await mkdir(CACHE, { recursive: true });

const { port, close: closeServer } = await serveDist();
const { browser, page } = await launchPage({ viewport: { width: 1280, height: 900 } });
await loadApp(page, port);

for (const d of dirs) {
  const dir = join(TESTDATA, d.name);
  const files = await readdir(dir);
  const img = files.find((f) => IMG_EXT.has(extname(f).toLowerCase())) ?? files.find((f) => extname(f).toLowerCase() === ".pdf");
  if (!img) continue;
  const cacheFile = join(CACHE, d.name + ".musicxml");
  // 无参跑（回归基线那 15 首）时跳过没缓存的目录：testdata 下还放着 500 首矢量语料、
  // 文本谱语料这类**不是单曲歌谱**的文件夹，照直送去 OMR 只会崩在解码上。
  // 要给新曲子建缓存就指定歌名子串（`node phrase-lines.mjs 脚步`）。
  if (!filter && !existsSync(cacheFile)) continue;
  let xml;
  if (existsSync(cacheFile) && !process.env.PHRASE_FRESH) {
    xml = await readFile(cacheFile, "utf8");
  } else {
    const b64 = Buffer.from(await readFile(join(dir, img))).toString("base64");
    const mime = mimeOf(img);
    xml = await page.evaluate(async ({ b64, mime }) => {
      const omr = await window.__omr;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bin = await omr.decodeToBinary(bytes, mime);
      const score = await omr.recognizeJianpu(bin, omr.paddleOcrBackend());
      return omr.toMusicXml(score);
    }, { b64, mime });
    await writeFile(cacheFile, xml, "utf8");
  }
  const out = await page.evaluate(async (xml) => {
    window.__app.importBytes(new TextEncoder().encode(xml), "omr.musicxml");
    const orig = window.__app.getText();
    window.__app.setPhraseLayout(true);
    return { orig, phrase: window.__app.getText() };
  }, xml);
  console.log("=".repeat(70));
  console.log(d.name);
  report(out.phrase);
}
await browser.close(); closeServer();

// 逐「排版行」（以 $(..) 结尾）报小节数/格数/歌词。
// 歌词按 .Words 的 `W<v>@<小节>,<音符>:` 锚点顺序铺到音符上（`/` = 续记号，占一个音符位）。
function report(text) {
  const lines = text.split(/\r?\n/);
  let inV = false, inW = false;
  const voice = [], wlines = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (t.startsWith(".")) { inV = /^\.voice/i.test(t); inW = /^\.words/i.test(t); continue; }
    if (inV && t) voice.push(ln);
    if (inW && t) wlines.push(t);
  }
  // 逐音符展开 .Voice：记每个音符所属排版行、所属小节序号（跨行连续计数）
  const noteLine = [], noteMeas = [];
  let mi = 1;
  voice.forEach((ln, li) => {
    const body = ln.replace(/\$\([^)]*\)\s*$/, "");
    const re = /([0-7])[',]*[_.]*|\[\|\]|\|[\]:]?|:\|/g; let m;
    while ((m = re.exec(body))) {
      if (m[1] === undefined) { mi++; continue; }
      noteLine.push(li); noteMeas.push(mi);
    }
    if (!/[|\]]\s*$/.test(body.trim())) mi++; // 行末无小节线 → 行内换行，小节继续
  });
  // 每小节的首音符下标
  const firstOf = new Map();
  noteMeas.forEach((m, i) => { if (!firstOf.has(m)) firstOf.set(m, i); });
  // 解析 W1 段
  const lyr = new Array(noteLine.length).fill("");
  let cur = null;
  const punc = ".,;'!?。：，；！？“”｡､、";
  for (const ln of wlines) {
    const h = ln.match(/^W(\d+)(-\d+)?(?:@(\d+),(\d+))?:?$/);
    const h2 = ln.match(/^W(\d+)(-\d+)?(?:@(\d+),(\d+))?:(.*)$/);
    if (h2) {
      if (h2[1] !== "1") { cur = null; continue; }
      const m0 = Number(h2[3] ?? 1), n0 = Number(h2[4] ?? 1);
      cur = (firstOf.get(m0) ?? 0) + n0 - 1;
      if (h2[5]) cur = fill(h2[5], cur);
      continue;
    }
    if (cur == null) continue;
    cur = fill(ln, cur);
  }
  function fill(s, idx) {
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === " " || c === "\t") continue;
      let unit = c;
      while (i + 1 < s.length && punc.includes(s[i + 1])) { unit += s[++i]; }
      if (idx < lyr.length) lyr[idx] = unit === "/" ? "·" : unit;
      idx++;
    }
    return idx;
  }
  voice.forEach((ln, i) => {
    const body = ln.replace(/\$\([^)]*\)\s*$/, "");
    const bars = (body.match(/\[\|\]|\|[\]:]?|:\|/g) || []).length;
    let cells = 0;
    const re = /([0-7])[',]*[_.]*|(-)/g; let m;
    while ((m = re.exec(body))) cells += m[2] ? 0.7 : 1;
    const txt = lyr.filter((_, k) => noteLine[k] === i).join("");
    console.log(`${String(i + 1).padStart(2)} 小节${String(bars).padStart(2)} 格${cells.toFixed(1).padStart(5)} ${ln.match(/\$\([^)]*\)/)?.[0] ?? ""}  ${txt}`);
    console.log(`     ${body.trim()}`);
  });
}
