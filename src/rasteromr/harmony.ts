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
    const y0 = Math.max(0, Math.round(jp ? st.ceiling! - sp * JP_BAND : st.box.top - sp * BAND_TOP));
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
    if (y1 - y0 < 4 || x1 - x0 < 8) continue;
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
      }
      const box = { x: x0 + a, y: ya, w: b - a + 1, h: yb - ya + 1 };
      const data = new Uint8Array(box.w * box.h);
      for (let y = 0; y < box.h; y++)
        for (let x = 0; x < box.w; x++) {
          const py = box.y + y;
          data[y * box.w + x] = py >= y0 ? at(box.x + x, py) : bin.data[py * bin.w + box.x + x];
        }
      out.push({ w: box.w, h: box.h, data, box, staff: st.index });
    }
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
 * 一条的 OCR 字符序列 → 一个个和弦记号。
 *
 * **靠文法切**：`CHORD_TOKEN_RE` 要求根音是大写 A–G，从左往右贪心地咬，咬不动就跳一个字符。
 * 每个记号的 x 由它头尾两个字符的 `xFrac` 定；字数对不上（归一化删过字）就整条当一个记号的盒。
 */
export function harmonyTokens(strip: HarmonyStrip, chars: OcrChar[]): HarmonyToken[] {
  const kept: { ch: string; xFrac: number }[] = [];
  for (const c of chars) {
    const t = normalizeChordText(c.ch);
    for (const ch of t) kept.push({ ch, xFrac: c.xFrac });
  }
  const raw = fixTail(kept.map((c) => c.ch).join(""));
  const out: HarmonyToken[] = [];
  const px = (frac: number) => strip.box.x + frac * strip.box.w;
  let i = 0;
  while (i < raw.length) {
    const m = CHORD_TOKEN_RE.exec(raw.slice(i));
    if (!m || !m[0]) {
      i++;
      continue;
    }
    const a = i;
    const b = i + m[0].length - 1;
    i += m[0].length;
    const x0 = px(kept[a].xFrac);
    const x1 = px(kept[b].xFrac);
    out.push({
      text: m[0],
      box: { x: Math.min(x0, x1), y: strip.box.y, w: Math.max(1, Math.abs(x1 - x0)), h: strip.box.h },
      staff: strip.staff,
    });
  }
  return out;
}
