// 和弦文本行：文法判定、切词、归一，以及按源图 x 落到谱行音符上。
//
// 吉他和弦（C / G/B / Am / Gsus4）印在**谱行音符的上方**，与段落方框（Intro/Verse/Chorus）
// 同处「上一谱行下缘 → 本谱行上缘」这条带里。识别侧先按整行文本形态把和弦行与歌词行分开
// （isAnnotationLine），再由 splitChordTokens 切出逐个记号、placeChords 落位。
//
// 判据一律**不依赖 OCR 大小写正确**（PP-OCR 常把 C 读成 c），也不依赖记号之间有空格
// （整行和弦常被连写成 "C#mF#mBmBm7E"）。
import type { JpNum, Rect, StaffRow, TextRegion } from "./types";

/** 一个待落位的和弦记号：归一后的文本 + 源图起始 x + 源图框。 */
export type ChordCand = { tok: string; x: number; bbox: Rect };

// 段落方框词。注记行判定用（比 lyrics.ts 的 SECTION_MARK_RE 多收 fine 等，这类行同样不是歌词、
// 要从歌词带里剔掉）。
const SECTION_RE = /(intro|verse|chorus|pre-?chorus|bridge|coda|outro|ending|interlude|solo|fine|tag|refrain)\d*/gi;
// 编者注/段落标记的方括号（`[下面一行也可用]`、`【Chorus】`）。
const BRACKET_RE = /[[【][^\]】]*[\]】]/g;
/** 把段落方框词与方括号注抹成**等长**空格：和弦切词要保住字符下标（换算源图 x 用），
 *  不能像 isAnnotationLine 那样变长替换。不抹的话 `Verse` 里的 e、`Coda` 里的 C/d/a
 *  都是合法根音，会被贪心吃成 E、C、D、A 四个凭空的和弦（「主祢真伟大」的 Verse/Coda 行）。 */
const blankNonChord = (s: string): string =>
  s.replace(BRACKET_RE, (m) => " ".repeat(m.length))
    .replace(SECTION_RE, (m) => " ".repeat(m.length))
    .replace(JUMP_RE, (m) => " ".repeat(m.length))
    .replace(KEY_METER_RE, (m) => " ".repeat(m.length));
// 中文谱常把备选和弦写成 `F或C`，升降根音也可能写成 `升F` / `降B`。这些少量汉字属于
// 和弦语法而非歌词；先折成分隔符再做根音形态判断。除此以外只要含汉字，仍按真歌词处理。
const CHORD_HANZI_RE = /[或升降]/g;
// 单个和弦记号：根音 **大写** [A-G] + 可选升降号 + 可选性质符 + 可选数字 + 可选 sus/add 扩展
// + 可选转位低音（`/D#`，低音同样大写）。交替里长后缀在前——JS 取**首个**成功的分支而非最长，
// `maj7` 若先命中 `m` 就会剩下 "aj7" 变成未覆盖。
// **根音必须大写**：印刷体和弦的根音从来是大写，而小写字母遍地都是——`Coda` 的 d/a、`Verse` 的 e
// 一旦算根音，就凭空长出 D、A、E 三个和弦。宁可漏掉 OCR 把 C 读成 c 的那几个，也不放小写进来。
const CHORD_TOKEN_RE = /^[A-G][#♯b♭]?(?:maj|min|dim|aug|sus|add|m|M)?\d*(?:sus\d*|add\d*)?(?:\/[A-G][#♯b♭]?)?/;
// 记号之间的分隔/标点：不计入覆盖率分母，也不产生 token。句点在其列——和弦之间的点多半是
// OCR 把字距读成的噪声（`Em F C/E G` 读成 `EmF.C/EG`），一律当未覆盖会把整条和弦行判没。
// 真含点的 `D.C.`/`D.S.` 另由 JUMP_RE 在切词前整段抹掉，不靠点这一条挡。
const CHORD_SEP_RE = /[\s()\-–—_,.·、|]/;
// 跳转记号：`D.C.` / `D.S.`（含 `al Fine`/`al Coda` 后缀）/ `Fine` / `To Coda`。它们的字母恰好
// 都是合法根音，不先抹掉就会被贪心吃成 D、C 两个凭空的和弦（「沧海一声笑」的 D.C. 曾这么变出两个）。
const JUMP_RE = /D\s*[.,·]\s*[CS]\s*[.,·]?(?:\s*al\s*[.,·]?\s*(?:Fine|Coda))?|\bFine\b|\bTo\s*Coda\b/gi;
// 调号 `1=C` / `1=bE`（等号可能被 OCR 读成冒号）与拍号 `4/4`。调名本身就是合法根音，
// 不先抹掉就会被贪心吃成凭空的和弦（「为基督赢得城市」首谱行上方带里的 `1=C 4/4`
// 跟行首和弦同处一块，OCR 把 `C` 与拍号首位连成 `C4`，于是多出一个 C4）。
// 旧版靠 scanChords 里「前面紧跟等号」的 keyed 判据，升降号一插就失效（`1=bE` 仍切出 E）。
// 等号只收 `=＝:：`：短横不能算，否则 `Am7-D` 这类写法会被当成调号抹掉真和弦。
// 拍号只认「数字/数字」：转位低音（`C/E`）斜杠两边都是字母，碰不到。
// 拍号**左邻的裸根音**一并抹掉：`1=` 被 OCR 吞掉时块里只剩 `C 4/4`，那个 C 是调名不是和弦。
// 真和弦行从不含拍号，故这一步不会误伤（`Am 4/4` 里 A 后有 m，接不上，只抹拍号）。
const KEY_METER_RE = /\d\s*[=＝:：]\s*[#♯b♭]?[A-G]|(?:[#♯b♭]?[A-G]\s*)?\d+\s*\/\s*\d+/g;

/** 从左到右贪心扫和弦记号。OCR 常把整行和弦连写成一串（"C#mF#mBmBm7E"），故不按空白切 token，
 *  而是逐个吃和弦、吃不动就跳一个字符记为未覆盖。覆盖率与切词共用这一趟扫描，免得两处文法漂移。 */
function scanChords(s0: string): { toks: { tok: string; index: number }[]; hit: number; total: number } {
  const s = s0.replace(JUMP_RE, (m) => " ".repeat(m.length))    // 等长抹除，保住字符下标
    .replace(KEY_METER_RE, (m) => " ".repeat(m.length));
  const toks: { tok: string; index: number }[] = [];
  let hit = 0, total = 0;
  for (let i = 0; i < s.length;) {
    if (CHORD_SEP_RE.test(s[i])) { i++; continue; }   // 分隔/标点不计入分母
    const m = CHORD_TOKEN_RE.exec(s.slice(i));
    if (m && m[0].length) {
      toks.push({ tok: m[0], index: i }); hit += m[0].length; total += m[0].length; i += m[0].length;
    } else { total++; i++; }
  }
  return { toks, hit, total };
}

/** 一行文本被和弦记号覆盖的字符比例 + 记号个数。 */
export function chordCoverage(s: string): { cov: number; count: number } {
  const { toks, hit, total } = scanChords(s);
  return { cov: total ? hit / total : 0, count: toks.length };
}

/** 贪心切出一行里的和弦记号，带每个记号在**原串**里的字符下标（供换算源图 x）。 */
export function splitChordTokens(s: string): { tok: string; index: number }[] {
  return scanChords(s).toks;
}

/** OCR 形态归一：根音大写、性质符大小写规整、全角升降号折成 ASCII、去空白。
 *  归一后的形式要同时被 layout/harmony.ts 的 chordTextSegs 与 score/harmonyxml.ts 的
 *  harmonyXml 接受——两者都认 `#`/`b`，故统一吐 ASCII 最稳。 */
export function normalizeChord(tok: string): string {
  let s = tok.replace(/\s/g, "").replace(/♯/g, "#").replace(/♭/g, "b");
  // 性质符：`M`（大写）在和弦里表示大三/大七，但 OCR 更常把小写 m 读成大写；简谱上大写 M
  // 几乎不用，故一律折成小写 m（`maj` 另有写法、不受影响）。
  s = s.replace(/^([A-G][#b]?)M(?!aj)/, (_, r: string) => `${r}m`);
  // 扩展词统一小写：`SUS4` → `sus4`、`Dim` → `dim`。
  s = s.replace(/(maj|min|sus|add|dim|aug)/gi, (m) => m.toLowerCase());
  return s;
}

/** 整行 rec 原文是否为和弦/段落标记行（而非歌词）。
 *  ① 无歌词汉字（只允许和弦语法里的「或/升/降」）；② 整行几乎能被一串**和弦记号**贪心覆盖
 *  （见 chordCoverage）。旧判据按 `[A-Za-z]+` 切字母簇、要求每簇首字母是 A-G 根音，但升降号与
 *  数字会把簇切断——`C#mF#mBm7E` 切出 `mF`/`mBmBm`、`E7sus4` 切出 `sus`，首字母都不是根音，
 *  于是整行和弦被当成歌词（「再次将我更新」的 W2/W3 就是这么来的）。改看覆盖率后二者都能吃完。
 *  不依赖大小写正确（OCR 常把 C 读成 c）；英文歌词的音节吃不动（"still"/"azing" 起头即失败），
 *  覆盖率立刻塌下去，故不会误伤。 */
export function isAnnotationLine(text0: string): boolean {
  // 方括号里的是编者注/段落标记（「立定心志」和弦行末的 `[下面一行也可用]`、`【Chorus】`），
  // 从来不是唱词。不先剥掉，一句中文编者注就会让整行和弦行被当成真歌词（该曲的 W2 = 和弦）。
  const text = text0.replace(/[[【][^\]】]*[\]】]/g, " ");
  const hanzi = text.match(/[一-鿿]/g) ?? [];
  if (hanzi.some((ch) => !/[或升降]/.test(ch))) return false;  // 除和弦连接/升降记号外有汉字 → 真歌词行
  const rest = text.replace(SECTION_RE, " ").replace(CHORD_HANZI_RE, " ");
  if (!rest.trim()) return text0.trim().length > 0;             // 纯段落标记（Intro/Chorus…）或纯方括号注
  if (!/[A-Za-z]/.test(rest)) return false;                      // 无字母 → 交给下游伪 verse 过滤
  const { cov, count } = chordCoverage(rest);
  // 两个以上和弦时容一点残渣（OCR 掉字/多字）；只有一个记号的短行要求完全吃净，免得把
  // 单个英文词（"Be"、"Ah"）当成和弦行整条丢掉。
  return count >= 2 ? cov >= 0.85 : count === 1 && cov === 1;
}

/** 从一行和弦文本里切出记号并换算源图坐标。
 *  `srcX(charIndex)` 把原串字符下标映到源图 x（下标可越界，返回该行右缘）；
 *  `mkBbox(x0,x1)` 由记号首尾 x 造源图框（供识别模式叠加）。
 *  对齐点取记号**起始 x**，与歌词单元同一基准。 */
export function chordCandidates(
  rawText: string, srcX: (charIndex: number) => number, mkBbox: (x0: number, x1: number) => Rect,
): ChordCand[] {
  return splitChordTokens(blankNonChord(rawText))
    .map(({ tok, index }) => {
      const x0 = srcX(index), x1 = srcX(index + tok.length);
      return { tok: normalizeChord(tok), x: x0, bbox: mkBbox(x0, Math.max(x1, x0 + 1)) };
    })
    // 归一后仍须是合法根音开头（`chordTextSegs`/`harmonyXml` 的最低要求），否则下游只能整段原样排字。
    .filter((c) => /^[A-G]/.test(c.tok));
}

/** 把一批带源图 x 的和弦落到某谱行的音符上（含拍内偏移）。
 *
 *  与 sectionMark 的落位**刻意不同**：段落总从整小节起、要回退到本小节首音；和弦不回退——
 *  它可落在小节内任意一拍。和弦也**不一定对着音符**：印在两音符之间时按 x 线性插值出
 *  `chordOffset`（本音符时值内的比例，0..1），由 MusicXML 那路折成 `<harmony><offset>`。 */
export function placeChords(
  row: StaffRow, cands: ChordCand[], regions: TextRegion[],
): void {
  const nums = row.nums;
  if (!nums.length) return;
  // 比较基准取**左缘**而非中心：和弦记号的左缘习惯对齐所辖音符的左缘，用中心比会给行首和弦
  // 凭空算出 0.35~0.40 的假偏移（音符半宽在密排行里就占相邻间距的近四成）。
  const lefts = nums.map((n) => n.bbox.x);
  const extraY = new Map<JpNum, number[]>();   // 每个 extraChords 项的来源 y（并行编配撞车时取低的那排）
  for (const c of [...cands].sort((a, b) => a.x - b.x)) {
    const x = c.x;
    let i = 0;
    while (i + 1 < lefts.length && lefts[i + 1] <= x) i++;
    let frac = 0;
    if (i + 1 < lefts.length && x > lefts[i]) {
      const gap = lefts[i + 1] - lefts[i];
      if (gap > 1) {
        const t = (x - lefts[i]) / gap;
        if (t >= 0.65) { i += 1; }        // 明显更贴右邻 → 归右邻、正对音符
        else if (t >= 0.35) frac = t;     // 夹在两音符之间 → 挂左音符 + 拍内偏移
      }
    }
    // 同一音符已有和弦：顺延到右邻空位（限一格）。两个和弦挤在同一音符上多半是印刷字距紧，
    // 直接丢掉会静默少一个记号。但**同名**的不顺延——同一拍点不会连着奏两个相同和弦，那只是
    // OCR 把一个记号读了两遍（跨 rec 块边界时常见），顺延会在谱上凭空多一个 G。
    if (nums[i].chord === c.tok) continue;
    // 已有和弦、而本记号又**明明落在本音符时值之内**（frac>0，多半印在增时线上方）：
    // 那是长音里换和弦（「世上所有的民族」第二行 `1 - - 0` 的第三拍上另有一个 C/G），
    // 不是字距挤在一起。顺延给右邻会把它挪后一整拍，故改挂 extraChords + 拍位。
    if (frac > 0 && nums[i].chord !== undefined) {
      const extra = nums[i].extraChords ??= [];
      const ys = extraY.get(nums[i]) ?? [];
      extraY.set(nums[i], ys);
      // 同一拍位上撞车 = 谱面印了**两套并行编配**（「爱是不保留」上排括号里是另一套配法）。
      // 两个都留的话，文本谱那边一条增时线只挂得住一个，还会静默丢掉后来的那个；只留贴着
      // 谱行的下排（bbox 更低的那个）——那才是主编配，上排是备选。
      const clash = extra.findIndex((e) => Math.abs(e.offset - frac) < 0.1);
      if (clash >= 0) {
        if (c.bbox.y > ys[clash]) {
          extra[clash] = { tok: c.tok, offset: frac };
          ys[clash] = c.bbox.y;
          regions.push({ text: c.tok, bbox: c.bbox });
        }
      } else if (!extra.some((e) => e.tok === c.tok)) {
        extra.push({ tok: c.tok, offset: frac });
        ys.push(c.bbox.y);
        regions.push({ text: c.tok, bbox: c.bbox });
      }
      continue;
    }
    if (nums[i].chord !== undefined && i + 1 < nums.length && nums[i + 1].chord === undefined) { i += 1; frac = 0; }
    if (nums[i].chord !== undefined) continue;
    nums[i].chord = c.tok;
    if (frac > 0) nums[i].chordOffset = frac;
    regions.push({ text: c.tok, bbox: c.bbox });
  }
}

