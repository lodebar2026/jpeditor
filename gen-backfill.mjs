// 补字表：把重排时**读不出的字形**按 GT 对齐补上，产出 testdata/500/backfill.json。
//
// 与 gen-glyphdict 的分工（两者共用 collectSongItems 与 alignSeq，判据同源）：
//   gen-glyphdict  为**识别基线**定字，闸严（3 分 + 70%），宁缺毋滥；
//                  它从种子表起步自举，不认 OCR 标注。
//   gen-backfill   为**重排**补字，读的是建完库的正式字典（含 OCR 标注）当已知，
//                  闸放宽（2 分 + 60%）把长尾捞一遍。补的字只进重排的 PDF，
//                  不回灌字典、不影响 pdf-diff 的识别基线。
//
// 另出 suspect：字典已经定了字、但 GT 长期指向另一个字的形状——那是当初标错了，
// 交人工复核（校对.db）。
//
//   npm run build:cli && node gen-backfill.mjs
import { readFile, writeFile } from "node:fs/promises";
import { loadCli, openPdf, loadCorpus, mergePagemapEntries, collectSongItems } from "./scripts/node-harness.mjs";

const PAGEMAP = "testdata/500/pagemap.json";
const DICT = "testdata/500/glyphdict.json";
const OUT = "testdata/500/backfill.json";

const cli = await loadCli();
const { doc, OPS } = await openPdf();
const { songs } = await loadCorpus();
const pm = JSON.parse(await readFile(PAGEMAP, "utf8"));
const dict = JSON.parse(await readFile(DICT, "utf8"));

// 代表键：同一字形的分身都指向它（gen-glyphmerge 写的 `g`）
const R = (k) => dict.classes[k]?.g ?? k;
const known = new Map();
const sizeOf = new Map();
const countOf = new Map();
for (const c of Object.values(dict.classes)) {
  const r = R(c.key);
  if (c.char) known.set(r, c.char);
  if (!sizeOf.has(r) && c.h > 0) sizeOf.set(r, { h: c.h, w: c.w });
  countOf.set(r, (countOf.get(r) ?? 0) + (c.count ?? 0));
}

const sample = [];
for (let p = 40; p <= 200; p += 4) {
  const g = await doc.getPage(p);
  sample.push(await cli.extractVectorPage(g, OPS));
  g.cleanup();
}
const profile = cli.detectProfile(sample, "hymn500");

const byId = new Map();
for (const e of mergePagemapEntries(pm.map)) {
  const a = byId.get(e.id) ?? [];
  a.push(e);
  byId.set(e.id, a);
}

console.log("抽取页面字形序列…");
const items = await collectSongItems({ cli, doc, OPS, profile, byId, songs, keyOf: (o) => R(cli.shapeKey(o.obj.data)) });
console.log(`  ${items.length} 首`);

const votes = new Map(); // 未定形状 → 字符票
const conflict = new Map(); // 已定形状 → GT 指向的字符票
const decode = (keys) => keys.map((k) => known.get(k) ?? null);

function alignVote(gtStr, keys) {
  const r = cli.alignSeq(gtStr, decode(keys));
  if (!r) return;
  const w = r.direct ? 3 : 1; // 直配无歧义，一次抵三次 DP
  for (const { i, j } of r.pairs) {
    const k = keys[j];
    const ch = gtStr[i];
    const box = known.has(k) ? conflict : votes;
    const v = box.get(k) ?? new Map();
    v.set(ch, (v.get(ch) ?? 0) + w);
    box.set(k, v);
  }
}

for (const it of items) {
  alignVote(it.gtNotes, it.notes);
  alignVote(it.gtTitle, it.title);
  alignVote(it.gtChords, it.chords);
  alignVote(it.gtCategory, it.category);
  alignVote(it.gtCredit, it.credits);
  for (const f of it.footers) alignVote(f.text, f.keys);
  for (let v = 0; v < Math.min(it.gtVerses.length, it.verses.length); v++) alignVote(it.gtVerses[v], it.verses[v]);
}

const top = (v) => {
  let best = null;
  let bestN = 0;
  let total = 0;
  for (const [ch, n] of v) {
    total += n;
    if (n > bestN) {
      bestN = n;
      best = ch;
    }
  }
  return { best, bestN, total };
};

const byKey = {};
let instances = 0;
for (const [k, v] of votes) {
  const { best, bestN, total } = top(v);
  // 宽扁的形状不收单字：一个字再扁也扁不到宽是高的两倍半（「一」另有专门判据）。
  // 那些是短圆滑线、减时线之类，投票时被挤到某个字上，补进去就成了凭空多出的字。
  const s = sizeOf.get(k);
  const flat = s && s.h > 0 && s.w >= s.h * 2.5 && best !== "一";
  if (best !== null && !flat && bestN >= 2 && bestN / total >= 0.6) {
    byKey[k] = best;
    instances += countOf.get(k) ?? 0;
  }
}

const suspect = [];
for (const [k, v] of conflict) {
  const { best, bestN, total } = top(v);
  const cur = known.get(k);
  if (best !== null && best !== cur && bestN >= 5 && bestN / total >= 0.8)
    suspect.push({ key: k, dict: cur ?? null, gt: best, votes: bestN, ratio: Number((bestN / total).toFixed(2)), count: countOf.get(k) ?? 0 });
}
suspect.sort((a, b) => b.count - a.count);

await writeFile(OUT, JSON.stringify({ byKey, suspect }, null, 1));
console.log(`→ ${OUT}：补字 ${Object.keys(byKey).length} 类 / ${instances} 个字，可疑标注 ${suspect.length} 类`);
if (suspect.length) console.log("  可疑前几条:", suspect.slice(0, 8).map((s) => `${s.dict}→${s.gt}(${s.count})`).join(" "));
