// 正文字体的字形建库：拿 **GT 的歌词**给字形投票，修好那几档 ToUnicode 坏掉的 CJK 字体。
//
//   npm run build:cli && node gen-stafflyrics.mjs
//   node gen-stafflyrics.mjs --v      # 逐首打印对齐情况
//
// 为什么能这么干（详见 docs/实现/五线谱识别.md）：曲目已经按**音符序列**对上了 GT
// （不依赖任何字体），于是每首歌都有一份「谱面上这一串字形」与「GT 的这一串字」的对应，
// 逐字投票就能把字形的真身认出来。500 首那本没有这个便利，只能先跑 OCR。
//
// **要跑好几轮**：字典一补上，中文标题就读得出来了，于是更多曲子能按标题对上 GT，
// 于是又有更多歌词可投票。轮次之间只看「定案类数」还在不在涨。
import { readFile, writeFile } from "node:fs/promises";
import { alignSongs, lev, loadT2S, loadS2T } from "./scripts/staff-align.mjs";

const args = process.argv.slice(2);
const verbose = args.includes("--v");
const OUT = "src/staffomr/lyricglyphs.json";
const ROUNDS = Number(process.argv.find((a) => a.startsWith("--rounds="))?.slice(9) ?? 3);

const t2s = await loadT2S();
// **票要投成繁体**：书上印的是繁体，GT 是简体。投简体的话字典会把全书吐成简体，
// 那不是这本书的原文（对拍那一路自己会做繁简归一，不靠字典给简体）。
const s2t = await loadS2T();
/** 歌词归一：繁→简、去标点空白。GT 是简体，谱面是繁体。 */
/** 汉字（含扩展 A、兼容区）。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/**
 * 建库时的归一：繁→简、**去掉空白与标点**。
 *
 * 试过把标点也留下来一起投票（想把「，」「。」的字形也认出来），**实测更差**：
 * 定案类数 1250 → 990。GT 的 `<text>` 里标点未必与谱面一一对应
 * （有的版本不写、有的连在音节里），位置一错后面整段都跟着错。
 * 标点那一档改由「认不出来的小墨迹不输出」兜底，见 textanalyze.ts::splitSyllables。
 */
const norm = (s) => t2s(s).replace(/[\s　，。、；：！？“”‘’（）《》〈〉—…·.,;:!?"'()\-]/g, "");

const harness = await import("./scripts/node-harness.mjs");
const cli0 = await harness.loadCli();

// 从上一次的成果接着建（`--reset` 从头来）。每跑一次都能再涨一点：
// 字典好一分，中文标题就多认出几首，歌词也多对上几段，于是又能多投几票。
let dict = null;
if (!args.includes("--reset")) {
  try {
    dict = JSON.parse(await (await import("node:fs/promises")).readFile(OUT, "utf8"));
    console.log(`接着上次的字典建：已定案 ${dict.classes.filter((c) => c.char).length} 类`);
  } catch { /* 头一次跑，没有就没有 */ }
}
for (let round = 1; round <= ROUNDS; round++) {
  const builder = new cli0.TextGlyphBuilder();
  const textLookup = dict ? new cli0.TextGlyphLookup(dict) : null; // null = 明确不要字典
  const strictRound = round === 1 && !dict; // 没有字典可依时只收长度相等的段，理由见下
  const { results } = await alignSongs({ cli: cli0, textLookup, quiet: round > 1 });

  let voted = 0, used = 0, skipped = 0, titles = 0;
  for (const r of results) {
    // 先把这一首用到的字形都登记进累积器（没登记的类投不了票）
    // **逐字形**登记（`metas`）：一个音节里每个字形各带各的签名与墨迹尺寸，
    // 不能都记成首字形那一份（理由见 staff-align.mjs::versesGlyphs 的注释）。
    for (const arr of Object.values(r.lyricGlyphs ?? {}))
      for (const syl of arr)
        for (const m of syl.metas ?? []) builder.ensure(m.id, m);
    for (const v of r.song.verses) {
      const gt = [...s2t(norm(v.chars))];
      const seq = r.lyricGlyphs?.[v.verse] ?? [];
      if (!gt.length || !seq.length) continue;
      // 两边长度差太多就整段跳过——那是谱面与 GT 结构不同（反复记号／分页），对齐不可信
      // **第一轮只收长度完全相等的段**。
      // 乱码文本让 `alignPairs` 的相等判据永远不成立，DP 退化成「全是替换」的对角线：
      // 长度相等时那正好就是逐位对应（可信），长度不等时插入删除落在哪儿全凭运气，
      // 投出来的票会把常用字的类污染成一锅粥（实测「我:104 的:75 祢:69」同属一个字形类）。
      // 有了字典之后（第二轮起）文本能对上一部分，DP 才有锚点，才允许长度不等。
      // 长度门槛只在**没有字典可依**时才卡死（第一轮）。有字典之后，
      // 对齐里已经有一批「文本本来就对上」的锚点，编辑距离能扛住长度差
      // （谱面多一段引子、少印一段、分页断开都会让两边长度不同）。
      if (strictRound && gt.length !== seq.length) { skipped++; continue; }
      const pairs = alignPairs(seq, gt);
      if (pairs.length < Math.min(gt.length, seq.length) * 0.6) { skipped++; continue; }
      if (!strictRound) {
        // 锚点太少就不信这一段：字典已经认得的字里，至少要有三成落在对角线上。
        const known = pairs.filter(([i]) => CJK.test(seq[i].text)).length;
        const hit = pairs.filter(([i, j]) => seq[i].text === gt[j]).length;
        if (known >= 4 && hit < known * 0.3) { skipped++; continue; }
      }
      used++;
      for (const [i, j] of pairs) {
        // **一个音节一个字形**才投：汉字是一字一形，而拉丁词一个音节好几个字母，
        // 拿一个汉字去给四个字母各投一票，字母的类立刻被污染。
        if (seq[i].ids.length !== 1) continue;
        if (!CJK.test(gt[j])) continue; // GT 那一侧不是汉字也不投
        // 谱面那一侧也得像个汉字：ASCII 的一律不投（拉丁单字母音节 `I`/`a` 会被
        // 拿去给汉字投票，把字母的类污染成一锅粥）。
        if (/^[\x20-\x7e]$/.test(seq[i].text)) continue;
        // 墨迹太小的是标点（GT 那侧已经把标点抹掉了，位置对不上）
        if (seq[i].w < 0.5 || seq[i].h < 0.5) continue;
        builder.vote(seq[i].ids[0], gt[j]);
        voted++;
      }
      // 标题也投：标题字体与歌词字体不是同一套类
    {
      const gtT = [...s2t(norm(r.song.zh))];
      const seqT = (r.titleGlyphs ?? []).filter((x) => x.ids.length === 1 && !/^[\x20-\x7e]$/.test(x.text) && x.w >= 0.5 && x.h >= 0.5);
      if (gtT.length && gtT.length === seqT.length) {
        for (let k = 0; k < gtT.length; k++) {
          if (!CJK.test(gtT[k])) continue;
          builder.ensure(seqT[k].ids[0], { sig: seqT[k].sig, w: seqT[k].w, h: seqT[k].h, uni: seqT[k].uni });
          builder.vote(seqT[k].ids[0], gtT[k]);
          voted++;
        }
        titles++;
      }
    }
    if (verbose) console.log(`  ${r.song.id} ${r.song.zh} 第${v.verse}段 谱面${seq.length} GT${gt.length} 对上${pairs.length}`);
    }
  }
  // 定案的两档规则见 `TextGlyphBuilder.finish` 的注释。
  const next = builder.finish("赞美之泉");
  // 上一轮定过的案继承下来（这一轮没投到票的类不该被抹掉）
  if (dict) {
    const old = new Map(dict.classes.filter((c) => c.char).map((c) => [cli0.textClassId(c.font, c.key), c]));
    for (const c of next.classes) {
      if (c.char) continue;
      const o = old.get(cli0.textClassId(c.font, c.key));
      if (o) { c.char = o.char; c.source = o.source; }
    }
  }
  dict = next;
  const done = dict.classes.filter((c) => c.char);
  console.log(`第 ${round} 轮：对上 ${results.length} 首，${used} 段 + ${titles} 个标题投了 ${voted} 票（跳过 ${skipped} 段）；` +
    `字形类 ${dict.classes.length}，定案 ${done.length}（覆盖字形 ${done.reduce((a, c) => a + c.count, 0)}/${dict.classes.reduce((a, c) => a + c.count, 0)}）`);
}

// **形近补字放在最后一次**，不进轮内：补错的字会被下一轮当成锚点用，越滚越歪
// （实测轮内补的话歌词档从 77.8% 掉到 63.3%）。
const fuzzy = cli0.fuzzyFill(dict);
console.log(`形近补字 ${fuzzy} 类（末轮一次性），定案共 ${dict.classes.filter((c) => c.char).length} 类`);

// **贴图字表要原样带过去**（`masks`，见 gen-staffmasks.mjs）：那一档不是靠轮廓聚类的，
// 这里重建的是字形类，别把它冲掉。
try {
  const prev = JSON.parse(await readFile(OUT, "utf8"));
  if (prev.masks) dict.masks = prev.masks;
} catch { /* 头一回建库，没有旧的 */ }
await writeFile(OUT, JSON.stringify(dict, null, 1));
console.log("→", OUT);

/** 编辑距离回溯：返回「相同或替换」的位置对 `[i, j]`。 */
function alignPairs(a, b) {
  const n = a.length, m = b.length;
  const f = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i++) f[i][0] = i;
  for (let j = 0; j <= m; j++) f[0][j] = j;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      f[i][j] = Math.min(f[i - 1][j] + 1, f[i][j - 1] + 1, f[i - 1][j - 1] + (a[i - 1].text === b[j - 1] ? 0 : 1));
  const out = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const sub = f[i - 1][j - 1] + (a[i - 1].text === b[j - 1] ? 0 : 1);
    if (f[i][j] === sub) { out.push([i - 1, j - 1]); i--; j--; }
    else if (f[i][j] === f[i - 1][j] + 1) i--;
    else j--;
  }
  return out.reverse();
}
void lev;
