// 谱行**上方的和弦字母**：切条、算指纹、把 OCR 回来的字串切成一个个和弦记号。
//
// 独唱谱（领唱谱、诗歌本式的五线谱）在谱表上方印和弦字母：`C`、`Am`、`G/B`、`D7`、`E/G♯`。
// 矢量路早就认（`staffomr/textanalyze.ts::attachHarmonies`，靠 PDF 的文本层），
// 位图路一处都没有——全仓从来没有一行给 `StaffNote.chord` 赋过值。
//
// **照歌词那条路走**（`lyric.ts` + `gen-rasterlyrics.mjs`），不是照标签那条：
// 切条 → 按**条的内容指纹**寻址的离线 OCR 缓存（`gen-rasterharmony.mjs` →
// `rasterharmony.json`）→ 识别时纯查表。连缓存的值类型都共用歌词那边的 `OcrChar`。
//
// **定位自己做，不请 DBNet**（标签那条是请的）。两者的差别在于带里有什么：
// 标签带里压着上一行谱的歌词与弧线，几何闸分不开；和弦带里只有一行和弦字母，
// 列投影一打就是干净的簇——实测《坚固保障》三条带，**簇内字距 ≤10px、簇间 ≥16px**
// （线距 15px），中间空得一干二净。而 DBNet 在这个尺度上反而框不全：
// 整页 42 个和弦只框出 30 个，`Dm`→`om`、`G C`→`C10`、`E/G♯ Am`→`E1`+`An`+`1`。
// 逐簇裁紧、各自送 rec，短拉丁串就认得准了。
//
// **切成记号靠和弦文法**，不靠簇的边界：簇偶尔会并掉两个挨得近的和弦
// （实测系统三末尾 `Dm G` 只隔 9px），`CHORD_TOKEN_RE` 要求根音是大写 A–G，
// 从左往右贪心地咬，`DmG` 自然断回 `Dm` + `G`。
import type { Binary, Rect } from "../omr/types";
import type { RasterUnit } from "./staffline";
import type { OcrChar } from "./lyric";
import { CHORD_TOKEN_RE } from "../staffomr/textanalyze";
import { blankNonChord } from "../omr/chordline";

/** 带的窗口（线距的倍数）：顶线上方这一段。
 *
 *  下界 1.0 格：贴着顶线的是**符头、加线、符杠的梢**，收进来会被当成和弦字母。
 *  上界 3.2 格：《坚固保障》的和弦字母印在顶线上方 1.6 格处、字高约一格。
 *  再往上是上一个系统的歌词。 */
const BAND_TOP = 3.2;
const BAND_BOTTOM = 1.0;
/** 混排谱：简谱行上沿往上这么多格（《是谁》和弦字母下沿离简谱带上沿 0.2 格、字高 1.3 格）。 */
const JP_BAND = 3.0;
/** 有简谱行时带底比简谱行上沿再往下放几格（见 `findHarmonyStrips`）。 */
const JP_BELOW = 0.6;

/** 簇间的空白：相邻两段墨拉开这么多个线距才算是两个和弦。
 *  实测三条带的间隙**两极分化**（簇内 ≤0.67 格、簇间 ≥1.07 格），0.75 格落在空当里。
 *  并掉的那一两对由和弦文法断回来，所以这道闸宁松不紧——切错了断不回去。 */
const CLUSTER_GAP = 0.75;

/** 一簇至少要有这么宽、这么多墨才算数（相对线距 / 相对簇的面积）。
 *  挡掉带里的孤立噪点与谱线的碎渣。 */
const MIN_W = 0.25;
const MIN_INK = 8;

/** 带底下探到顶线上方多少格（非简谱行的谱表）。见 `findHarmonyStrips`。 */
const LOW_CLEAR = 0.15;
/** 簇内上下两段隔开这么多格就只留上面那段。 */
const RUN_GAP = 0.15;
/** 碰到带顶的簇最多往上长几格。 */
const GROW_UP = 1.5;
/** 往上长出这么多格才算「字大半在带外」（见 `findHarmonyStrips` 的整行重切）。
 *  顶到带顶只长几个像素的很常见（坚固保障一行 11 条全顶到，只长 0.2 格），那不用重切。 */
const GROW_BIG = 1.0;

/** 整块落在 `yB` 行以下的连通块抹掉（八连通，就地改）。 */
function dropBelow(band: Uint8Array, W: number, H: number, yB: number): void {
  const seen = new Uint8Array(W * H);
  const comp: number[] = [];
  for (let i0 = 0; i0 < W * H; i0++) {
    if (!band[i0] || seen[i0]) continue;
    comp.length = 0;
    let minY = H;
    const stack = [i0];
    seen[i0] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const y = Math.floor(i / W);
      const x = i % W;
      if (y < minY) minY = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
          const j = ny * W + nx;
          if (!band[j] || seen[j]) continue;
          seen[j] = 1;
          stack.push(j);
        }
    }
    if (minY >= yB) for (const i of comp) band[i] = 0;
  }
}

/** 带底往下再看多深（线距的倍数），用来认「从下面伸上来的东西」。见 `withoutRisers`。 */
const RISER_DEPTH = 0.3;

/**
 * 带里的墨，**抹掉从带底穿出去的连通块**（`[y0,y1)` 行、`[x0,x1)` 列，逐像素 0/1）。
 *
 * 和弦字母是浮在带里的：《坚固保障》全部 42 个的下沿离顶线 1.73~1.93 格，没有一个碰到带底。
 * 碰到带底、而且在带底下面接着有墨的，是从谱表那边**伸上来**的东西——谱号的顶、
 * 往上的符干、加线上的全音符。它们一进带就成了一簇，OCR 读成 `A`/`D`：
 * 《善牧恩慈歌》（没有和弦的四部合唱谱）因此认出四个和弦，还顺手把调号升号认领走了。
 * 整簇丢不得——真和弦也会和伸上来的符干挤在一簇里（坚固保障 `E/G♯ Am` 那一条就是），
 * 所以按连通块抹：只抹伸上来的那一块，同簇的字母照留。没沾上的条内容一字不变，缓存照旧命中。
 */
function withoutRisers(bin: Binary, x0: number, x1: number, y0: number, y1: number, depth: number, seedFrom = -1): Uint8Array {
  const W = x1 - x0;
  const yEnd = Math.min(bin.h, y1 + depth);
  const H = yEnd - y0;
  const seen = new Uint8Array(W * H);
  const out = new Uint8Array(W * (y1 - y0));
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) out[(y - y0) * W + (x - x0)] = bin.data[y * bin.w + x];
  // 种子只取**带底往下 `depth` 深的那一行**，从那里八连通往上灌，灌到的都是「伸上来的」。
  // 不从带底紧下面取：真和弦的笔画也会探出带底一两个像素（坚固保障 `E/G♯` 的升号比字母低，
  // 下端正好越过带底 1px），那不算伸上来。
  const stack: number[] = [];
  for (let y = seedFrom >= 0 ? seedFrom : yEnd - 1; y < yEnd; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y - y0) * W + (x - x0);
      if (bin.data[y * bin.w + x] && !seen[i]) {
        seen[i] = 1;
        stack.push(i);
      }
    }
  while (stack.length) {
    const i = stack.pop()!;
    const yy = Math.floor(i / W);
    const xx = i % W;
    if (yy < y1 - y0) out[i] = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const ny = yy + dy;
        const nx = xx + dx;
        if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
        const j = ny * W + nx;
        if (seen[j] || !bin.data[(ny + y0) * bin.w + nx + x0]) continue;
        seen[j] = 1;
        stack.push(j);
      }
  }
  return out;
}

/** 一条和弦条：**一簇墨**的裸像素 + 它在页面上的盒。 */
export interface HarmonyStrip {
  w: number;
  h: number;
  /** 逐像素 0/1，长 `w*h`，1 = 墨。 */
  data: Uint8Array;
  box: Rect;
  /** 这条属于第几行谱（`SPage.staves` 的下标）。 */
  staff: number;
}

/**
 * 切出各谱行上方的和弦条（一簇一条）。`staves` 给每行谱的盒（页面坐标）。
 *
 * **几何是死的**——同一页跑几次裁出来的条一模一样，指纹才稳得住。
 * 认字是 OCR 缓存的事，切成记号是 `harmonyTokens` 的事。
 */
export function findHarmonyStrips(
  bin: Binary,
  /** `ceiling`：谱表上方另有一行东西（简谱行，见 `jianpuband.ts`）时它的上沿，
   *  和弦带就改贴在它上面 `JP_BAND` 格那一段。 */
  staves: { box: { left: number; right: number; top: number }; index: number; ceiling?: number }[],
  unit: RasterUnit,
): HarmonyStrip[] {
  const sp = unit.space;
  const out: HarmonyStrip[] = [];
  for (const st of staves) {
    const jp = st.ceiling != null;
    const yTop = Math.max(0, Math.round(jp ? st.ceiling! - sp * JP_BAND : st.box.top - sp * BAND_TOP));
    /** 原来的带底：簇要有墨落在它上面才算。 */
    const yB = Math.max(0, Math.round(jp ? st.ceiling! : st.box.top - sp * BAND_BOTTOM));
    // **带底下探到顶线上方**（`LOW_CLEAR`）：全音符小节上方的和弦字母印得低（《赞美一神》「阿们」
    // 两小节的 C、G 离顶线只有 0.25 格），穿过原带底，被「伸上来的东西」那一步整个抹掉。
    // 下探之后「伸上来」改成**连着谱表的**（从顶线那几行起灌），浮着的字母留下；
    // 整块都在原带底以下的（贴着谱表的符头、加线）另外丢掉。
    // 有简谱行时同样往下放一点（`JP_BELOW`）：简谱行的上沿按行里最高的墨定，和弦字母的下半截
    // 常压在它里面（颂赞与尊贵字母 215~245、简谱行上沿 239），截掉底的「F」「B♭」OCR 认不出
    const y1 = jp ? Math.min(bin.h, Math.round(yB + sp * JP_BELOW)) : Math.max(yB, Math.round(st.box.top - sp * LOW_CLEAR));
    const x0 = Math.max(0, Math.round(st.box.left));
    const x1 = Math.min(bin.w, Math.round(st.box.right));
    if (y1 - yTop < 4 || x1 - x0 < 8) continue;
    // 切一遍：带顶在 `y0`。回报有几条顶到带顶、往上长出一格以上（`GROW_BIG`），以及长到的最高处
    const cut = (y0: number) => {
      const strips: HarmonyStrip[] = [];
      let grown = 0;
      let top = y0;
      const band = withoutRisers(bin, x0, x1, y0, y1, Math.ceil(sp * RISER_DEPTH), jp ? -1 : y1);
      if (!jp) dropBelow(band, x1 - x0, y1 - y0, yB - y0);
      const at = (x: number, y: number) => band[(y - y0) * (x1 - x0) + (x - x0)];
      // 列投影 → 游程 → 按空白并成簇
      const col = new Int32Array(x1 - x0);
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) if (at(x, y)) col[x - x0]++;
      const gap = Math.max(2, Math.round(sp * CLUSTER_GAP));
      const runs: [number, number][] = [];
      let s = -1;
      for (let i = 0; i <= col.length; i++) {
        const ink = i < col.length && col[i] > 0;
        if (ink && s < 0) s = i;
        if (!ink && s >= 0) {
          const last = runs[runs.length - 1];
          if (last && s - last[1] - 1 < gap) last[1] = i - 1;
          else runs.push([s, i - 1]);
          s = -1;
        }
      }
      for (const [a, b] of runs) {
        if (b - a + 1 < sp * MIN_W) continue;
        // 纵向也裁紧：条越紧，rec 越准
        let ya = y1;
        let yb = y0;
        let ink = 0;
        for (let y = y0; y < y1; y++)
          for (let x = x0 + a; x <= x0 + b; x++)
            if (at(x, y)) {
              ink++;
              if (y < ya) ya = y;
              if (y > yb) yb = y;
            }
        if (ink < MIN_INK || yb < ya) continue;
        const rowInk = (y: number) => {
          for (let x = x0 + a; x <= x0 + b; x++) if (y >= y0 ? at(x, y) : bin.data[y * bin.w + x]) return true;
          return false;
        };
        {
          // **只留最上面一段**：和弦记号只有一行，同簇里下面隔开的是延长记号
          //（《赞美一神》延长记号上方的 G 与记号并成一条，OCR 读成「5」）
          const cut = Math.max(2, Math.round(sp * RUN_GAP));
          let blank = 0;
          for (let y = ya; y <= yb; y++) {
            if (rowInk(y)) blank = 0;
            else if (++blank >= cut) {
              yb = y - blank;
              break;
            }
          }
          while (yb > ya && !rowInk(yb)) yb--;
          // **碰到带顶的往上长**：延长记号上方的和弦字母印得高，顶上被带顶切掉
          if (!jp && ya === y0) while (ya > 0 && ya > y0 - sp * GROW_UP && rowInk(ya - 1)) ya--;
          if (y0 - ya >= sp * GROW_BIG) {
            grown++;
            top = Math.min(top, ya);
          }
        }
        const box = { x: x0 + a, y: ya, w: b - a + 1, h: yb - ya + 1 };
        const data = new Uint8Array(box.w * box.h);
        for (let y = 0; y < box.h; y++)
          for (let x = 0; x < box.w; x++) {
            const py = box.y + y;
            data[y * box.w + x] = py >= y0 ? at(box.x + x, py) : bin.data[py * bin.w + box.x + x];
          }
        strips.push({ w: box.w, h: box.h, data, box, staff: st.index });
      }
      return { strips, grown, top };
    };
    let r = cut(yTop);
    // **整行和弦字排得高**：多数条都顶到带顶、往上长过，就把带顶挪到它们长到的最高处再切一遍。
    // 列投影只看带里的墨，字露在带外的部分左右边界算不进来：《圣哉三一歌伴奏》和弦字在顶线上方
    // 2.7~4.7 格（音符高、和弦行跟着抬），带里只剩字脚，♭ 的肚子、「7」的上半、F 的横画都被切掉，
    // OCR 把 E♭ 读成「El」。只有**多数**条都顶到时才挪——偶尔一个印得高的字母（延长记号上方）
    // 照旧靠往上长解决，其余谱行的条一个像素不变（缓存指纹不动）。
    if (!jp && r.grown >= 2 && r.grown * 2 >= r.strips.length) r = cut(Math.max(0, r.top));
    out.push(...r.strips);
  }
  return out;
}

/** 条的**内容指纹**（与 `lyric.ts::stripKey` / `stafflabel.ts::labelKey` 同一套）。 */
export function harmonyKey(s: HarmonyStrip): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.data.length; i++) {
    h1 ^= s.data[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return `H${s.w}x${s.h}-${h1.toString(36)}`;
}

/** 切出来的一个和弦记号（页面坐标）。 */
export interface HarmonyToken {
  text: string;
  box: Rect;
  staff: number;
  /** 文本才有：`mark` = 记号词（Fine、D.C.、段落词，`blankNonChord` 认的），不算和弦行里的「杂文」；
   *  `word` = 其余单词与汉字串（署名、表情术语）。见 `harmonyLine`。 */
  kind?: "mark" | "word";
}

/**
 * OCR 读岔的归一。
 *
 * 前几条是**等价写法**（全角升降号、全角斜杠、夹进来的空白），没有判断。
 * 后两条是**形近纠正**，只敢在和弦这个小字表里做：
 *   - `卜`/`ト`/`下`/`尸` → `F`：底本线距才 15px，`F` 的横画糊成一团，
 *     中文 rec 最爱吐这几个字（实测《坚固保障》两个 `F` 都读成 `卜`）。
 *     这几个字在和弦记号里**根本不存在**，改它不会误伤真字。
 *   - **结尾**的 `i`/`í`/`j`/`l` → `7`：`E7` 读成 `Ei`。只改结尾，
 *     因为 `dim` / `min` 这些后缀里的 `i` 在词中间——那里一改就把后缀毁了。
 */
function normalizeChordText(s: string): string {
  return s
    .replace(/[\s·・,.]/g, "")
    .replace(/[♯＃]/g, "#")
    .replace(/[♭]/g, "b")
    .replace(/[／∕丨|]/g, "/")
    .replace(/[（）()]/g, "")
    .replace(/[卜ト下尸]/g, "F");
}

/** 整条拼完之后再做的**结尾**形近纠正（见 `normalizeChordText` 的第二条）。 */
const fixTail = (s: string): string => s.replace(/(?<=[A-G][#b]?)[iíjl]$/, "7");

/**
 * 一条的 OCR 字符序列 → 和弦记号 + 文本。
 *
 * 与简谱那一路（`omr/chordline.ts`）同一套文法与记号词表：
 *   1. **记号词先认成文本**：`blankNonChord` 抹掉的段落词、跳转记号（Fine、D.C.、D.S.、To Coda）、
 *      调号拍号、方括号注——它们的字母恰好都是合法根音，不先拿走就被贪心吃成和弦
 *     （《颂赞与尊贵》的「Fine」成了 F）。抹掉的每一段交出来当文本。
 *   2. **根音大写、从左往右贪心地咬**（`CHORD_TOKEN_RE`），咬不动的跳过：小节号、
 *      延长记号读成的 `S`（`DS`）这类杂字只是跳过，不交出去——和弦带里不会有单个的非根音大写字母。
 *   3. **和小写字母粘在一起的是单词，不是和弦**：和弦除了自己的后缀（m、maj、dim…，文法已咬进去）
 *      不与小写字母连写。咬出来的记号前面紧挨着小写字母（上一个记号的尾巴除外，`DmG` 要断回 `Dm`+`G`），
 *      或后面紧跟着咬不进去的小写字母，整串字母收成文本（带往上挪后收进来的署名「(John B. Dykes)」）。
 *
 * 每个记号 / 文本的 x 由它头尾两个字符的 `xFrac` 定；文本按 OCR 原字符交出（空格、标点照留）。
 */
const HAN = /\p{Script=Han}/u;

export function readHarmonyStrip(strip: HarmonyStrip, chars: OcrChar[]): { chords: HarmonyToken[]; texts: HarmonyToken[] } {
  const chords: HarmonyToken[] = [];
  const texts: HarmonyToken[] = [];
  const px = (frac: number) => strip.box.x + frac * strip.box.w;
  const boxOf = (f0: number, f1: number): Rect => {
    const x0 = px(f0);
    const x1 = px(f1);
    return { x: Math.min(x0, x1), y: strip.box.y, w: Math.max(1, Math.abs(x1 - x0)), h: strip.box.h };
  };
  const textOf = (a: number, b: number) => chars.slice(a, b + 1).map((c) => c.ch).join("").trim();
  // 1. 记号词：按字符等长抹（一个 OCR 字符一格，抹掉的格子就是记号词的字）
  const orig = chars.map((c) => (c.ch.length === 1 ? c.ch : c.ch[0] ?? " ")).join("");
  const blanked = blankNonChord(orig);
  const isWord = chars.map((c, k) => blanked[k] === " " && c.ch.trim() !== "");
  for (let k = 0; k < chars.length; ) {
    if (!isWord[k]) {
      k++;
      continue;
    }
    let e = k;
    while (e + 1 < chars.length && (isWord[e + 1] || (chars[e + 1].ch.trim() === "" && isWord[e + 2]))) e++;
    texts.push({ text: textOf(k, e), box: boxOf(chars[k].xFrac, chars[e].xFrac), staff: strip.staff, kind: "mark" });
    k = e + 1;
  }
  // 2、3. 其余的字归一后贪心咬；`src` 是归一前在 `chars` 里的下标
  const kept: { ch: string; xFrac: number; src: number }[] = [];
  chars.forEach((c, src) => {
    if (isWord[src]) {
      kept.push({ ch: " ", xFrac: c.xFrac, src }); // 占一格隔开，免得两边粘起来
      return;
    }
    for (const ch of normalizeChordText(c.ch)) kept.push({ ch, xFrac: c.xFrac, src });
  });
  const raw = fixTail(kept.map((c) => c.ch).join(""));
  const letter = (i: number) => i >= 0 && i < raw.length && /[A-Za-z]/.test(raw[i]);
  let chordEnd = -1; // 上一个和弦记号结束的位置（它后面紧跟的大写根音不算「粘着字母」）
  let i = 0;
  while (i < raw.length) {
    const m = CHORD_TOKEN_RE.exec(raw.slice(i));
    const len = m?.[0].length ?? 0;
    // 只看**小写**：前面的大写杂字（`SD` 里延长记号读成的 S）不算粘着
    const glued = /[a-z]/.test(raw[i - 1] ?? "") && chordEnd !== i;
    if (len && !glued && !/[a-z]/.test(raw[i + len] ?? "")) {
      chords.push({ text: m![0], box: boxOf(kept[i].xFrac, kept[i + len - 1].xFrac), staff: strip.staff });
      i += len;
      chordEnd = i;
      continue;
    }
    if (HAN.test(raw[i])) {
      // 汉字串（署名「刘廷芳译」、表情术语）：和弦里除了「或/升/降」不会有汉字，整串收成文本
      let b = i;
      while (b + 1 < raw.length && HAN.test(raw[b + 1])) b++;
      texts.push({ text: textOf(kept[i].src, kept[b].src), box: boxOf(kept[i].xFrac, kept[b].xFrac), staff: strip.staff, kind: "word" });
      i = b + 1;
      continue;
    }
    if (letter(i)) {
      // 一整串字母；紧挨在前面的和弦记号不退回（归一化删了空白，`Am Fine` 与 `AmFine` 分不开）
      let a = i;
      while (letter(a - 1) && a - 1 >= chordEnd) a--;
      let b = i;
      while (letter(b + 1)) b++;
      // 带小写的才是单词，整串收走；单个 / 全大写的非根音字母是杂字，只跳过这一个（`SD` 里还有 D）
      if (/[a-z]/.test(raw.slice(a, b + 1))) {
        texts.push({ text: textOf(kept[a].src, kept[b].src), box: boxOf(kept[a].xFrac, kept[b].xFrac), staff: strip.staff, kind: "word" });
        i = b + 1;
        continue;
      }
    }
    i++;
  }
  texts.sort((p, q) => p.box.x - q.box.x);
  return { chords, texts };
}

/**
 * **整行判**：一行谱上方和弦带里的条合起来，是和弦行还是文本行。
 *
 * 单条判不了：词曲署名「(John B. Dykes)」被列投影切成 `(John`、`B.`、`Dykes)` 三条，
 * 中间那条单看就是一个 B 和弦。与简谱那一路的 `isAnnotationLine` 同一口径——看和弦记号
 * 覆盖了多少字：两个以上和弦要占 85% 以上，只有一个和弦时不许有别的单词。
 * 记号词（`mark`：Fine、D.C.）与数字（小节号）不计——它们本来就与和弦同处一带。
 * 判成文本行的，行里咬出来的「和弦」一律改记文本（原样的记号文字）。
 */
export function harmonyLine(chords: HarmonyToken[], texts: HarmonyToken[]): { chords: HarmonyToken[]; texts: HarmonyToken[] } {
  const cc = chords.reduce((n, t) => n + t.text.length, 0);
  const wc = texts.filter((t) => t.kind === "word").reduce((n, t) => n + (t.text.match(/[A-Za-z]|\p{Script=Han}/gu)?.length ?? 0), 0);
  const isChordLine = chords.length >= 2 ? cc / (cc + wc) >= 0.85 : chords.length === 1 && wc === 0;
  if (isChordLine || !chords.length) return { chords, texts };
  const all = [...texts, ...chords.map((t): HarmonyToken => ({ ...t, kind: "word" }))].sort((p, q) => p.box.x - q.box.x);
  return { chords: [], texts: all };
}
