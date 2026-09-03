// 对比 OMR 识别结果的分行与 GT 分行是否对得上。用法：node cmp-lines.mjs [名称过滤...]
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { serveDist, launchPage, loadApp, decodeJpwabc, mimeOf } from "./harness.mjs";

const TESTDATA = join(process.cwd(), "testdata");
const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp"]);
const filters = process.argv.slice(2);

// 取 .Voice 段各「行」（以 $(...) 换行标记分行），每行数其小节数（| 分隔符个数）。
function voiceLineMeasures(text) {
  const lines = text.split(/\r?\n/); let inV = false; const raw = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (t.startsWith(".")) { inV = /^\.voice/i.test(t); continue; }
    if (inV && t) raw.push(t);
  }
  // 每个源码行以 $(..) 结尾即一「排版行」。数每行的小节线（|、||、|]、:| 等，含 [|]）
  return raw.map((ln) => {
    const body = ln.replace(/\$\([^)]*\)\s*$/, "");
    const bars = (body.match(/\[\|\]|\|[\]:]?|:\|/g) || []).length;
    return bars;
  });
}

async function findSongs() {
  const out = [];
  for (const name of await readdir(TESTDATA)) {
    if (filters.length && !filters.some((f) => name.includes(f))) continue;
    let dir; try { dir = await readdir(join(TESTDATA, name)); } catch { continue; }
    const img = dir.find((f) => IMG_EXT.has(extname(f).toLowerCase()));
    const gt = dir.find((f) => /\.jpwabc$/i.test(f));
    if (img && gt) out.push({ name, img: join(TESTDATA, name, img), gt: join(TESTDATA, name, gt) });
  }
  return out;
}

const { port, close: closeServer } = await serveDist();
const { browser, page } = await launchPage({ viewport: { width: 1280, height: 900 } });
await loadApp(page, port);

const songs = await findSongs();
for (const song of songs) {
  const mime = mimeOf(song.img);
  const b64 = Buffer.from(await readFile(song.img)).toString("base64");
  let rec;
  try {
    rec = await page.evaluate(async ({ b64, mime }) => {
      const omr = await window.__omr;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bin = await omr.decodeToBinary(bytes, mime);
      const score = await omr.recognizeJianpu(bin, omr.paddleOcrBackend());
      window.__app.importBytes(new TextEncoder().encode(omr.toMusicXml(score)), "omr.musicxml");
      const orig = window.__app.getText();
      window.__app.setPhraseLayout(true);
      const phrase = window.__app.getText();
      window.__app.setPhraseLayout(false);
      return { jpw: orig, phrase, rows: score.rows.length };
    }, { b64, mime });
  } catch (e) { console.log(`✗ ${song.name}: ${String(e).slice(0, 100)}`); continue; }
  const gt = decodeJpwabc(await readFile(song.gt));
  const gLines = voiceLineMeasures(gt), rLines = voiceLineMeasures(rec.jpw);
  const gTotal = gLines.reduce((a, b) => a + b, 0), rTotal = rLines.reduce((a, b) => a + b, 0);
  const match = gLines.length === rLines.length && gLines.every((v, i) => v === rLines[i]);
  console.log(`\n【${song.name}】 图行=${rec.rows}  ${match ? "✅ 分行一致" : "⚠ 分行不同"}`);
  console.log(`  GT   ${gLines.length}行 每行小节=[${gLines.join(",")}] 共${gTotal}节`);
  console.log(`  原始 ${rLines.length}行 每行小节=[${rLines.join(",")}] 共${rTotal}节`);
  const pLines = voiceLineMeasures(rec.phrase);
  console.log(`  乐句 ${pLines.length}行 每行小节=[${pLines.join(",")}] 共${pLines.reduce((a, b) => a + b, 0)}节`);
}

await browser.close();
closeServer();
