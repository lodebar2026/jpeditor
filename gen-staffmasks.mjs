// 五线谱：**贴图字**建库。
//
//   npm run build:cli && node gen-staffmasks.mjs [--dry] [--v]
//
// 赞美之泉那本把造字区的汉字（禰 一类）当 **JBIG2 位图**贴进内容流，不走文字层
// （见 docs/实现/五线谱识别.md 的「贴图字」）。它们没有轮廓也没有码位，
// 只能按**位图指纹**建表。定案办法与正文字形字典同一套：拿 GT 的歌词投票。
//
// 做法：把未定的贴图字读成一个**占位汉字**，让它在歌词行里占住位子，
// 逐首与 GT 的歌词对齐，占位处 GT 是哪个字就投哪个字。
// 结果写进 `src/staffomr/lyricglyphs.json` 的 `masks`（指纹 → 字）。
import { readFile, writeFile } from "node:fs/promises";
import { alignSongs, loadS2T, lev } from "./scripts/staff-align.mjs";
import { loadCli } from "./scripts/node-harness.mjs";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const verbose = args.includes("--v");

const DICT = "src/staffomr/lyricglyphs.json";
const dict = JSON.parse(await readFile(DICT, "utf8"));
const cli = await loadCli();
// 占位汉字：随便一个**歌词里不会出现**的字，且落在 CJK 区（否则 splitSyllables 不当它是汉字）
const PH = "〇"; // 〇
const lookup = new cli.TextGlyphLookup({ ...dict, masks: {} }, PH);

// 全书的贴图字类（GT 只教得到出现在已配对曲子里的那几类，其余靠形近补）
const allSigs = new Map(); // 指纹 → 出现次数
const { results } = await alignSongs({
  quiet: true,
  textLookup: lookup,
  onPage(r) {
    for (const o of r.page.objs) {
      if (!o.run) continue;
      for (const g of o.run.glyphs) if (g.maskSig) allSigs.set(g.maskSig, (allSigs.get(g.maskSig) ?? 0) + 1);
    }
  },
});
const s2t = await loadS2T();

/** 归一：只留汉字（GT 是简体、书上是繁体，先简→繁再比）。 */
const zh = (t) => s2t(t).replace(/[^㐀-䶿一-鿿豈-﫿〇]/g, "");

/** 编辑距离回溯，返回 a 的每个位置对上了 b 的哪个字符（对不上为 null）。 */
function alignChars(a, b) {
  const n = a.length, m = b.length;
  const d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  const out = new Array(n).fill(null);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) { out[i - 1] = b[j - 1]; i--; j--; }
    else if (d[i][j] === d[i - 1][j] + 1) i--;
    else j--;
  }
  return out;
}

// 逐首投票
const votes = new Map(); // 指纹 → Map(字 → 票数)
let songsUsed = 0, placed = 0;
for (const r of results) {
  if (r.cjkRatio < 0.3) continue;
  const gt = zh(r.song.verses?.find((v) => v.verse === 1)?.chars ?? "");
  if (gt.length < 10) continue;
  // 谱面这一侧：取与 GT 最像的那一段
  let best = null, bs = -1;
  for (const [v, arr] of Object.entries(r.lyricGlyphs ?? {})) {
    const text = zh((r.verses[v] ?? ""));
    if (text.length < 10) continue;
    const sim = 1 - lev([...text], [...gt]) / gt.length;
    if (sim > bs) { bs = sim; best = { v, arr, text }; }
  }
  if (!best || bs < 0.6) continue; // 配对或识别太差，别拿来投票
  songsUsed++;
  // 音节序列 → 只留汉字的字符序列，同时记住每个字符出自哪个音节
  const chars = [], from = [];
  for (const syl of best.arr) {
    for (const ch of s2t(syl.text)) {
      if (!/[㐀-䶿一-鿿豈-﫿〇]/.test(ch)) continue;
      chars.push(ch); from.push(syl);
    }
  }
  const paired = alignChars(chars, gt);
  for (let k = 0; k < chars.length; k++) {
    if (chars[k] !== PH) continue;
    const sig = from[k]?.maskSig;
    const got = paired[k];
    if (!sig || !got || got === PH) continue;
    placed++;
    const m = votes.get(sig) ?? new Map();
    m.set(got, (m.get(got) ?? 0) + 1);
    votes.set(sig, m);
  }
}

const masks = { ...(dict.masks ?? {}) };
const rows = [];
for (const [sig, m] of votes) {
  const arr = [...m].sort((a, b) => b[1] - a[1]);
  const [char, n] = arr[0];
  const total = arr.reduce((a, x) => a + x[1], 0);
  // 至少两票、且得票过半才算定案——一票的多半是对齐时蹭上的
  if (n >= 2 && n / total > 0.5) masks[sig] = char;
  rows.push({ sig, char, n, total, arr });
}
rows.sort((a, b) => b.total - a.total);
const votedCount = Object.keys(masks).length;

/**
 * **形近补**：GT 只教得到出现在已配对曲子里的那几类，全书还有别的（标题里的、
 * 没配上 GT 的曲子里的）。指纹是同尺寸的 0/1 串，直接数汉明距离；
 * 门槛取 12%——同一个字不同字号重采样后差个百分之几，不同的字差得远。
 */
const ham = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
};
let fuzzy = 0;
const FUZZ = 0.12;
for (const [sig, n] of [...allSigs].sort((a, b) => b[1] - a[1])) {
  if (masks[sig]) continue;
  let best = null, bd = Infinity;
  for (const k of Object.keys(masks)) {
    if (k.length !== sig.length) continue;
    const d = ham(k, sig);
    if (d < bd) { bd = d; best = masks[k]; }
  }
  if (best && bd <= sig.length * FUZZ) { masks[sig] = best; fuzzy++; if (verbose) console.log(`  形近补 ${best} ← 距离 ${bd}/${sig.length} ×${n}`); }
  else if (verbose) console.log(`  未定 ×${n} 最近距离 ${bd}/${sig.length}`);
}

/**
 * **人工确认表压在最后**（`src/staffomr/maskmanual.json`，与 `glyphmanual.json` 同一个路数）。
 * GT 只教得到出现在已配对曲子里的那几类；标题里的、没配上 GT 的曲子里的，
 * 只能裁图看原件定案（`node staff-crop.mjs <页> <x0,y0,x1,y1> out.png`）。
 * 值为空串表示「一个字被切成上下两张图，这是下半片」——**不另算一个字**。
 */
let manual = 0;
try {
  const mm = JSON.parse(await readFile("src/staffomr/maskmanual.json", "utf8"));
  for (const [sig, v] of Object.entries(mm)) {
    masks[sig] = typeof v === "string" ? v : v.char;
    manual++;
  }
} catch { /* 没有就算了 */ }

console.log(`人工确认表 ${manual} 条`);
console.log(`用了 ${songsUsed} 首中文歌词曲子投票，占位处对上 ${placed} 次；` +
  `投出 ${rows.length} 类、定案 ${votedCount} 类，形近再补 ${fuzzy} 类；` +
  `全书贴图字 ${[...allSigs.values()].reduce((a, b) => a + b, 0)} 个 / ${allSigs.size} 类，` +
  `未定 ${[...allSigs.keys()].filter((k) => !masks[k]).length} 类`);
for (const r of rows) console.log(`  ${r.char} ← ${r.n}/${r.total} 票  ${verbose ? r.arr.map(([c, n]) => c + ":" + n).join(" ") : ""}  ${r.sig.slice(0, 24)}…`);

if (!dry) {
  dict.masks = masks;
  await writeFile(DICT, JSON.stringify(dict, null, 1));
  console.log(`→ ${DICT}（masks ${Object.keys(masks).length} 条）`);
}
