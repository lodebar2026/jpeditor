// 批量实测 musicpp 本地 OMR 准确率：遍历 testdata/ 下每个歌谱文件夹（各含一张图片 + 一份 .jpwabc GT），
// 用 Edge 跑真实 src/omr 管线（recognizeJianpu → toMusicXml → 编辑器导入 → getText），
// 与 GT 同一 tokenizer 出 token，算 Levenshtein 准确率。用法：
//   node measure-all.mjs              # 全部歌谱
//   node measure-all.mjs 世上 日光    # 仅文件夹名含这些子串的
// 需先 npm run build 出 dist + 本地 Edge。
import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, basename } from "node:path";
import { serveDist, launchPage, loadApp, decodeJpwabc, mimeOf } from "./harness.mjs";

const TESTDATA = join(process.cwd(), "testdata");
const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp"]);
const filters = process.argv.slice(2);

// 逐音符粘性 token。jpwabc 音符间可无空格；下划线(_)与附点(.)顺序不固定(GT 自身混用 6,_./2._)，
// 故用 [_.]* 一并吞、各自计数。一个音 → N<digit>o<octave>u<下划线数>(+附点)，增时线 '-' 单列、小节线 '|'。
function voiceTokens(text) {
  const lines = text.split(/\r?\n/); let inV = false; const toks = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (t.startsWith(".")) { inV = /^\.voice/i.test(t); continue; }
    if (!inV || !t) continue;
    const s = ln.replace(/\$\([^)]*\)/g, " ");
    const re = /([0-7])([',]*)([_.]*)(-*)|(\|)|(-)/g;
    let m;
    while ((m = re.exec(s))) {
      if (m[5]) { toks.push("|"); continue; }
      if (m[6]) { toks.push("-"); continue; }
      const oct = m[2].split("").reduce((a, c) => a + (c === "'" ? 1 : -1), 0);
      const u = (m[3].match(/_/g) || []).length;
      const dot = (m[3].match(/\./g) || []).length ? "." : "";
      toks.push(`N${m[1]}o${oct}u${u}${dot}`);
      for (let i = 0; i < m[4].length; i++) toks.push("-");
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
const acc = (g, r) => 1 - lev(g, r) / Math.max(g.length, r.length, 1);
// 去掉八度/下划线/附点 → 仅"数字+小节线+增时线"
const dOnly = (t) => t.map((x) => (x === "|" || x === "-" ? x : x.replace(/o.*$/, "")));
// 去掉下划线/附点(留八度) → "数字+八度+小节线"
const dOct = (t) => t.map((x) => (x === "|" || x === "-" ? x : x.replace(/u\d+\.?$/, "")));
// 仅附点：每音符化简为有无附点(N./N)，留小节线/增时线作对齐锚 → 量附点识别准确率
const dotFlag = (t) => t.map((x) => (x === "|" || x === "-" ? x : (/\.$/.test(x) ? "N." : "N")));
const dotCount = (t) => t.filter((x) => /^N.*\.$/.test(x)).length;
// 字符级准确率（去空白后逐字 Levenshtein）；两边都空 → 1，仅一边空 → 0
const charAcc = (g, r) => {
  const ga = [...g.replace(/\s/g, "")], ra = [...r.replace(/\s/g, "")];
  if (!ga.length && !ra.length) return 1;
  return 1 - lev(ga, ra) / Math.max(ga.length, ra.length, 1);
};

// ---- 圆滑线/连音线：.Voice 里 slur 与 tie 都渲染成 ( )。抽出有序括号序列(剔除 $(..)换行标记与
// {..}三连音/记号)，按序列 Levenshtein 比，并报组数(左括号数)。 ----
function brackets(text) {
  const seq = []; let inV = false;
  for (const ln of text.split(/\r?\n/)) {
    const t = ln.trim();
    if (t.startsWith(".")) { inV = /^\.voice/i.test(t); continue; }
    if (!inV || !t) continue;
    const s = ln.replace(/\$\([^)]*\)/g, "").replace(/\{[^}]*\}/g, "");
    for (const ch of s) if (ch === "(" || ch === ")") seq.push(ch);
  }
  return seq;
}
const slurGroups = (seq) => seq.filter((c) => c === "(").length;

// ---- 标题：.Title 段 `Title = {…}` 或 `Title = …`（识别端无花括号），取值去花括号 ----
function titleOf(text) {
  // 注意：`=` 后只吃同行空白([ \t]*)，不能用 \s*（会跨行吞掉下一行内容）
  const m = text.match(/^[ \t]*Title[ \t]*=[ \t]*(.*)$/m);
  return m ? m[1].trim().replace(/^\{|\}$/g, "").trim() : "";
}
// ---- 词曲：`WordsByAndMusicBy = …`，多作者用字面 \n 连接，归一成字符串比 ----
function creditsOf(text) {
  const m = text.match(/WordsByAndMusicBy[ \t]*=[ \t]*(.*)/);
  return m ? m[1].trim().replace(/\\n/g, " ") : "";
}
// ---- 歌词：.Words 段按 W<verse> 头分组，收正文(剔 / 分隔)，逐 verse 比，按 GT 字数加权平均 ----
function lyricsOf(text) {
  const verses = new Map(); let inW = false, cur = null;
  for (const ln of text.split(/\r?\n/)) {
    const t = ln.trim();
    if (t.startsWith(".")) { inW = /^\.words/i.test(t); continue; }
    if (!inW) continue;
    const h = t.match(/^W(\d+)/);
    if (h) { cur = h[1]; if (!verses.has(cur)) verses.set(cur, ""); continue; }
    if (cur == null) continue;
    verses.set(cur, verses.get(cur) + t.replace(/\//g, ""));
  }
  return verses;
}
// 中文/英文标点 + jpwabc 记号花括号；忽略标点比对时剔除
const stripPunct = (s) => s.replace(/[，。；：？！、,.;:?!{}]/g, "");
// ---- 反复(D.S. al Fine / 段落反复)写全的歌词：GT 把反复段照唱词抄了一遍，但图上只印一次，
// OMR 只读印刷一遍 → 不公平。规则：剔掉「整段又在前文连续出现过」的最长后缀(=照抄的反复段)，
// 循环直到稳定。对 GT/识别两侧对称施加(识别侧通常无反复后缀→空操作)；要求后缀够长(≥minLen)以免
// 误剔结尾正巧与前文重复的单个短句。三连「好像水充满洋海一般」是连印实唱、两侧都有→对称不受影响。----
function trimRepeatedSuffix(s, minLen = 8) {
  let cur = s;
  for (;;) {
    const n = cur.length; let cut = 0;
    for (let L = Math.floor(n / 2); L >= minLen; L--) {
      if (cur.slice(0, n - L).includes(cur.slice(n - L))) { cut = L; break; } // 最长(高→低先命中)
    }
    if (!cut) return cur;
    cur = cur.slice(0, n - cut);
  }
}
function lyricsAcc(gt, rec, ignorePunct = false) {
  const g = lyricsOf(gt), r = lyricsOf(rec);
  if (!g.size && !r.size) return { acc: 1, detail: "无" };
  let totW = 0, sum = 0; const parts = [];
  for (const [v, gtxt00] of g) {
    const gtxt0 = trimRepeatedSuffix(gtxt00), rtxt0 = trimRepeatedSuffix(r.get(v) ?? "");
    const gtxt = ignorePunct ? stripPunct(gtxt0) : gtxt0;
    const rtxt = ignorePunct ? stripPunct(rtxt0) : rtxt0;
    const a = charAcc(gtxt, rtxt);
    const w = [...gtxt.replace(/\s/g, "")].length || 1;
    totW += w; sum += a * w;
    parts.push(`W${v} ${(a * 100).toFixed(0)}%`);
  }
  return { acc: totW ? sum / totW : (r.size ? 0 : 1), detail: parts.join("/") || "无" };
}

// ---- 歌词↔音符「对位」：.Words 里每汉字占一个音符、`/` 占一格(melisma 续前字/空音符)、
// 标点贴前字不占音符。把每 verse 展开成逐音符 token 序列(汉字→该字; / →· 续记号)，与 GT 逐音符
// 序列做 Levenshtein——一处 / 错位会令其后整体偏移，故比 flat CER 更能反映对位。反复段同 lyricsAcc
// 对称剔除(trimSeqRepeat 复用 trimRepeatedSuffix)。按 GT 音格数加权平均。 ----
const isHan = (c) => /[一-鿿]/.test(c);
const NOTE_PUNCT = "，。、；：？！,.;:?!（）()《》「」“”‘’—…·　 \t";
function verseNoteSeq(text) {
  const verses = new Map(); let inW = false, cur = null;
  for (const ln of text.split(/\r?\n/)) {
    const t = ln.trim();
    if (t.startsWith(".")) { inW = /^\.words/i.test(t); continue; }
    if (!inW) continue;
    const h = t.match(/^W(\d+)/);
    if (h) { cur = h[1]; if (!verses.has(cur)) verses.set(cur, []); continue; }
    if (cur == null) continue;
    for (const c of ln) {
      if (c === "/") verses.get(cur).push("·");
      else if (isHan(c)) verses.get(cur).push(c);
      // 标点/空白/其它: 贴前字不占音符 → 跳过
    }
  }
  return verses;
}
// 反复段在 GT 里无 / 标记(纯汉字)，用汉字投影定位裁剪量，再从尾按汉字计数删对应音格(顺带删夹带的 ·)
function trimSeqRepeat(seq) {
  const han = seq.filter((t) => t !== "·").join("");
  let rm = han.length - trimRepeatedSuffix(han).length;
  if (rm <= 0) return seq;
  let i = seq.length;
  while (i > 0 && rm > 0) { i--; if (seq[i] !== "·") rm--; }
  return seq.slice(0, i);
}
// 对位只看「有字/续记号」结构：汉字→字、·→·。识别错字(字 vs 另一字)前后不错位 → 视为对位正确；
// 只有续记号错位(字↔·)或增删移位才算对位错。末尾漏识(最后一个续记号之后的字增删)不算错位——其后无
// 续记号→不可能错位，纯识别漏/多字 → 剔掉尾部裸字再比。
const trimTailSeq = (seq) => { let e = seq.length; while (e > 0 && seq[e - 1] !== "·") e--; return seq.slice(0, e); };
const normSeq = (seq) => trimTailSeq(seq.map((t) => (t === "·" ? "·" : "字")));
function alignAcc(gt, rec) {
  const g = verseNoteSeq(gt), r = verseNoteSeq(rec);
  if (!g.size && !r.size) return { acc: 1, detail: "无" };
  let totW = 0, sum = 0; const parts = [];
  for (const [v, gseq0] of g) {
    const gseq = trimSeqRepeat(gseq0), rseq = trimSeqRepeat(r.get(v) ?? []);
    const a = acc(normSeq(gseq), normSeq(rseq));
    const w = gseq.length || 1;
    totW += w; sum += a * w;
    parts.push(`W${v} ${(a * 100).toFixed(0)}%`);
  }
  return { acc: totW ? sum / totW : (r.size ? 0 : 1), detail: parts.join("/") || "无" };
}

// 和弦档的排除名单：这两首谱面印了**两套并行编配**（括号里另一套，「立定心志」页眉写明
// 「括号里和弦是灵栖清泉编配」），同一个音符要挂两个和弦——番茄文本谱这个 GT 载体（以及
// MusicXML 那路的 JpNum.chord）根本表达不了真值，拿它算准确率没有意义，故不计分。
// 它们的 gt.tomato.pu 仍然生成，只是和弦那一档留空。
const CHORD_GT_SKIP = new Set(["立定心志", "爱是不保留"]);

// 和弦：按出现顺序取 `"hx:X"` 序列（番茄文本谱原文里和弦就写成音符后的这条注释）。
// 位置正确性由序列顺序隐含保证——和弦挂错音符会让它与相邻记号换位、Levenshtein 立刻算进去。
function chordSeq(puText) {
  return [...puText.matchAll(/"hx:([^"]*)"/g)].map((m) => m[1]);
}

async function findSongs() {
  const out = [];
  for (const name of (await readdir(TESTDATA, { withFileTypes: true })).filter((d) => d.isDirectory())) {
    if (name.name === "pu") continue;   // 文本谱渲染夹具，不是识别用的歌谱
    const dir = join(TESTDATA, name.name);
    const files = await readdir(dir);
    // 优先图片；无图片的歌谱（如 PDF-only 的「耶稣普治」）取 .pdf，走同一 decodeToBinary(pdf) 管线。
    const img = files.find((f) => IMG_EXT.has(extname(f).toLowerCase())) ?? files.find((f) => extname(f).toLowerCase() === ".pdf");
    const gt = files.find((f) => extname(f).toLowerCase() === ".jpwabc");
    if (!img || !gt) continue;
    if (filters.length && !filters.some((f) => name.name.includes(f))) continue;
    // 和弦 GT（可选）：一份人工核对过的番茄文本谱原文。.jpwabc 装不下和弦，只能另置载体。
    const puGt = files.includes("gt.tomato.pu") && !CHORD_GT_SKIP.has(name.name) ? join(dir, "gt.tomato.pu") : null;
    out.push({ name: name.name, img: join(dir, img), gt: join(dir, gt), puGt });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

const { port, close: closeServer } = await serveDist();
const { browser, page, errors } = await launchPage({ viewport: { width: 1280, height: 900 }, quiet: true });
await loadApp(page, port);

const songs = await findSongs();
if (!songs.length) { console.log("testdata/ 下没找到 图片+jpwabc 的歌谱文件夹"); await browser.close(); closeServer(); process.exit(0); }

const rows = [];
const sum = { a: 0, o: 0, d: 0, dc: 0, s: 0, ly: 0, lyNp: 0, al: 0, ti: 0, cr: 0, ch: 0, chN: 0 };
for (const song of songs) {
  // 每首重载页面：App/Score 在同一 page 里复用会串味——实测「爱是不保留」（带 |: :| 反复+两段词）
  // 单跑 slur/歌词 100%，跟在别的歌谱后面跑就掉到 60%/42%。重载几秒的代价换基线可复现。
  await loadApp(page, port);
  errors.length = 0;
  const mime = mimeOf(song.img);
  const b64 = Buffer.from(await readFile(song.img)).toString("base64");
  let rec;
  try {
    rec = await page.evaluate(async ({ b64, mime }) => {
      const omr = await window.__omr;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bin = await omr.decodeToBinary(bytes, mime);
      const score = await omr.recognizeJianpu(bin, omr.paddleOcrBackend());
      const stats = { rows: score.rows.length, notes: score.rows.reduce((a, r) => a + r.nums.length, 0), bars: score.rows.reduce((a, r) => a + r.barlineXs.length, 0) };
      const pu = omr.toPuText(score, "tomato").text;
      window.__app.importBytes(new TextEncoder().encode(omr.toMusicXml(score)), "omr.musicxml");
      return { jpw: window.__app.getText(), stats, pu };
    }, { b64, mime });
  } catch (e) {
    console.log(`✗ ${song.name}: 识别异常 ${String(e).slice(0, 120)}`);
    rows.push({ name: song.name, fail: true });
    continue;
  }
  const gt = decodeJpwabc(await readFile(song.gt)), rj = rec.jpw;
  const g = voiceTokens(gt), r = voiceTokens(rj);
  const a = acc(g, r), d = acc(dOnly(g), dOnly(r)), o = acc(dOct(g), dOct(r));
  const dc = acc(dotFlag(g), dotFlag(r));
  const gB = brackets(gt), rB = brackets(rj);
  const s = acc(gB, rB);
  const ly = lyricsAcc(gt, rj);
  const lyNp = lyricsAcc(gt, rj, true);
  const al = alignAcc(gt, rj);
  // 标题比对忽略开头的诗歌序号（如 "127哦…" / "557.…"）——识别读出编号是对的，不该扣分
  const stripNum = (s) => s.replace(/^\s*\d+[.．、,，\s]*/, "");
  const ti = charAcc(stripNum(titleOf(gt)), stripNum(titleOf(rj)));
  const cr = charAcc(creditsOf(gt), creditsOf(rj));
  sum.a += a; sum.o += o; sum.d += d; sum.dc += dc; sum.s += s; sum.ly += ly.acc; sum.lyNp += lyNp.acc; sum.al += al.acc; sum.ti += ti; sum.cr += cr;
  // 和弦：仅对备了 gt.tomato.pu 的歌谱计分（其余留空，不拉平均）。
  let ch = null, chG = 0, chR = 0;
  if (song.puGt) {
    const gc = chordSeq(await readFile(song.puGt, "utf8")), rc = chordSeq(rec.pu);
    chG = gc.length; chR = rc.length; ch = acc(gc, rc);
    sum.ch += ch; sum.chN += 1;
  }
  rows.push({ name: song.name, a, o, d, dc, gdot: dotCount(g), rdot: dotCount(r), s, sg: slurGroups(gB), sr: slurGroups(rB), ch, chG, chR,
    ly: ly.acc, lyNp: lyNp.acc, lyD: ly.detail, al: al.acc, alD: al.detail, ti, cr, g: g.length, r: r.length, stats: rec.stats,
    err: errors.filter((e) => !/favicon|space too large/.test(e)).slice(0, 2) });
}

// CSV 输出：百分比保留 1 位小数（不带 % 号），字段含逗号则加引号
const p1 = (x) => (x * 100).toFixed(1);
const csv = (v) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const cols = ["歌谱", "音符", "八度", "附点", "附GT", "附识", "小节", "slur/tie", "slur组GT", "slur组识", "歌词", "歌词*", "对位", "和弦", "和弦GT", "和弦识", "标题", "词曲", "GT_token", "识_token", "行", "音", "线"];
const lines = [cols.join(",")];
for (const x of rows) {
  if (x.fail) { lines.push([csv(x.name), "识别异常"].join(",")); continue; }
  lines.push([
    csv(x.name), p1(x.a), p1(x.o), p1(x.dc), x.gdot, x.rdot, p1(x.d), p1(x.s), x.sg, x.sr,
    p1(x.ly), p1(x.lyNp), p1(x.al), x.ch === null ? "" : p1(x.ch), x.chG || "", x.chR || "", p1(x.ti), p1(x.cr), x.g, x.r,
    x.stats.rows, x.stats.notes, x.stats.bars,
  ].join(","));
}
const n = rows.filter((x) => !x.fail).length || 1;
lines.push([
  "平均", p1(sum.a / n), p1(sum.o / n), p1(sum.dc / n), "", "", p1(sum.d / n), p1(sum.s / n), "", "",
  p1(sum.ly / n), p1(sum.lyNp / n), p1(sum.al / n),
  sum.chN ? p1(sum.ch / sum.chN) : "", "", "", p1(sum.ti / n), p1(sum.cr / n), "", "", "", "", "",
].join(","));

const outPath = join(process.cwd(), "measure-all.csv");
const out = lines.join("\n") + "\n";
await writeFile(outPath, "﻿" + out, "utf8"); // BOM 便于 Excel 识别 UTF-8 中文
console.log(out);
console.log(`已写入 ${outPath}`);

await browser.close();
closeServer();
