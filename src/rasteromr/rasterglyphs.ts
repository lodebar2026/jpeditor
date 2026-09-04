// 位图符号的形状字典：连通块 → 32×32 签名 → 形状类 → SMuFL 语义名。
//
// 与矢量路的 `staffglyphs.ts` 同一个套路，但**键不一样**：那边有字形轮廓，
// 可以拿 `shapeKey`（轮廓归一后哈希）当精确键；位图没有轮廓，
// 同一个符号每次栅格化出来的像素都略有出入，精确键必然全落空。
// 所以这边**只有一层**：按签名的汉明距离聚类，尺寸当粗筛。
//
// 尺寸一律归一到**线距**（与几何判据同口径）。不归一不行：同一本书里
// 正谱与小谱的谱表差一倍（实测主治万方一页上 18.5 与 15.6 两种线距同时出现）。
import { SIG_N, decodeSig, encodeSig, sigDistance } from "../omr/glyphdict";
import type { SmuflName } from "../staffomr/glyphs";

/** 一个形状类。 */
export interface RasterGlyphClass {
  id: number;
  /** 定案的 SMuFL 名；未定为 null。 */
  smufl: SmuflName | null;
  /** 定案来源，可信度依次递增：
   *  `template` = 拿矢量路 `glyphmap.json` 的已定案形状类比签名；
   *  `position` = 按位置自举（谱行开头的次序）；`manual` = 人工表定的。 */
  source: "template" | "position" | "manual" | null;
  /** 实例数。 */
  count: number;
  /** 宽高的中位数，**归一到线距**。 */
  w: number;
  h: number;
  /** 32×32 签名（base64）。 */
  sig: string;
  /** 头几次见到它的页，排查用。 */
  pages: number[];
}

export interface RasterGlyphDict {
  classes: RasterGlyphClass[];
}

/** 聚类的签名距离门槛（1024 格里差几格）。 */
export const CLUSTER_DIST = 60;
/** 聚类的尺寸门槛（线距的几分之几）。 */
export const CLUSTER_SIZE = 0.18;
/** 尺寸分桶的粒度。 */
const BUCKET = 0.1;

/** 累积器：脚本逐页喂块，最后 `finish()` 出字典。 */
export class RasterGlyphBuilder {
  private cls: (RasterGlyphClass & { sigBits: Uint8Array; ws: number[]; hs: number[] })[] = [];
  /** 按尺寸分的桶：`round(w/BUCKET),round(h/BUCKET)` → 类下标。
   *  不分桶的话每喂一个块都要扫全部类（两万个块 × 上千个类 × 1024 格），跑不完。 */
  private buckets = new Map<string, number[]>();

  private bucketKey(w: number, h: number): string {
    return `${Math.round(w / BUCKET)},${Math.round(h / BUCKET)}`;
  }

  /** 尺寸容差跨得过一个桶，所以要扫**九宫格**。 */
  private near(w: number, h: number): number[] {
    const bw = Math.round(w / BUCKET);
    const bh = Math.round(h / BUCKET);
    const r = Math.ceil(CLUSTER_SIZE / BUCKET);
    const out: number[] = [];
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++) {
        const a = this.buckets.get(`${bw + i},${bh + j}`);
        if (a) out.push(...a);
      }
    return out;
  }

  /** 喂一个块。`w`/`h` 已归一到线距。 */
  add(sig: Uint8Array, w: number, h: number, page: number): number {
    let best = -1;
    let bestD = CLUSTER_DIST + 1;
    for (const i of this.near(w, h)) {
      const c = this.cls[i];
      if (Math.abs(c.w - w) > CLUSTER_SIZE || Math.abs(c.h - h) > CLUSTER_SIZE) continue;
      const d = sigDistance(c.sigBits, sig);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) {
      this.cls.push({
        id: this.cls.length,
        smufl: null,
        source: null,
        count: 1,
        w,
        h,
        sig: encodeSig(sig),
        sigBits: sig,
        pages: [page],
        ws: [w],
        hs: [h],
      });
      const k = this.bucketKey(w, h);
      const a = this.buckets.get(k) ?? [];
      a.push(this.cls.length - 1);
      this.buckets.set(k, a);
      return this.cls.length - 1;
    }
    const c = this.cls[best];
    c.count++;
    c.ws.push(w);
    c.hs.push(h);
    if (c.pages.length < 5 && !c.pages.includes(page)) c.pages.push(page);
    // 中位数随实例更新——类的代表尺寸要跟着实例走，不能定死在第一个实例上
    const mid = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
    c.w = mid(c.ws);
    c.h = mid(c.hs);
    return best;
  }

  /**
   * 出字典。类按实例数降序**重新编号**——建库脚本要按这个序出人工确认表。
   *
   * `origin[新 id]` = 这个类在建库过程里的下标（`add` 的返回值）。
   * 脚本按 `add` 的返回值存代表实例，重编号之后要靠它把两边对回去
   * ——不给这张映射的话接触表画的是**另一个类**的样子，定名全标错。
   */
  finish(): RasterGlyphDict & { origin: number[] } {
    const order = this.cls.map((c, i) => ({ c, i })).sort((a, b) => b.c.count - a.c.count);
    const classes = order.map(({ c }, i) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { sigBits, ws, hs, ...rest } = c;
      return { ...rest, id: i };
    });
    return { classes, origin: order.map((o) => o.i) };
  }
}

/** 识别时用的查表器：块的签名 → SMuFL 名。 */
export class RasterGlyphLookup {
  private cls: { sig: Uint8Array; w: number; h: number; smufl: SmuflName }[] = [];
  /** 模板表（`outlineTemplates` 的结果）。给 `bootstrapClefs` 再验一道用；没有就为 null。 */
  templates: OutlineTemplate[] | null = null;
  /** 查不到的块：按最近的类记一笔，跑完就知道还差哪些形状。 */
  readonly misses: { sig: string; w: number; h: number; n: number }[] = [];

  constructor(dict: RasterGlyphDict) {
    for (const c of dict.classes) {
      if (!c.smufl) continue;
      this.cls.push({ sig: decodeSig(c.sig), w: c.w, h: c.h, smufl: c.smufl });
    }
  }

  lookup(sig: Uint8Array, w: number, h: number): SmuflName | null {
    let best: SmuflName | null = null;
    let bestD = CLUSTER_DIST + 1;
    for (const c of this.cls) {
      if (Math.abs(c.w - w) > CLUSTER_SIZE || Math.abs(c.h - h) > CLUSTER_SIZE) continue;
      const d = sigDistance(c.sig, sig);
      if (d < bestD) {
        bestD = d;
        best = c.smufl;
      }
    }
    if (!best) {
      const e = this.misses.find((m) => Math.abs(m.w - w) < 0.05 && Math.abs(m.h - h) < 0.05);
      if (e) e.n++;
      else this.misses.push({ sig: encodeSig(sig), w, h, n: 1 });
    }
    return best;
  }
}

/** 签名 → SVG 的 `d`（32×32 的方格拼起来）。人工确认表画它。 */
export function sigToPath(sig: Uint8Array): string {
  const out: string[] = [];
  for (let y = 0; y < SIG_N; y++) {
    let x = 0;
    while (x < SIG_N) {
      if (!sig[y * SIG_N + x]) {
        x++;
        continue;
      }
      let x2 = x;
      while (x2 + 1 < SIG_N && sig[y * SIG_N + x2 + 1]) x2++;
      out.push(`M${x} ${y}h${x2 - x + 1}v1h${-(x2 - x + 1)}z`);
      x = x2 + 1;
    }
  }
  return out.join("");
}

// ── 位置自举 ────────────────────────────────────────────────────────────────
//
// 与矢量路 `staffglyphs.ts::bootstrapByTable` 同一个用意（先拿一条独立的线索
// 给形状类打初标，再人工压尾），但线索不一样：那边有字体码位表可查，
// 位图这边没有，改用**位置**——谱号、调号、拍号在谱行开头的次序是刻谱的铁律。

/** 一行谱的几何（自举要用）。 */
export interface BootStaff {
  left: number;
  right: number;
  /** 五条线的 y，从上到下。 */
  lineYs: number[];
}

/** 自举出来的一条线索：某个块是什么。 */
export interface BootHint {
  /** 块在调用方数组里的下标（谱号是**种子块**的下标，真正的范围看 `box`）。 */
  index: number;
  code: SmuflName;
  /** 合并碎块之后的盒（谱号专用；调号那一路就是块本身的盒）。 */
  box?: { x: number; y: number; w: number; h: number };
}

/**
 * 谱行开头的**谱号**。
 *
 * ## 先把碎块并回一个盒，再判
 *
 * 谱号常被自己的笔画切开——中央那道竖笔横向游程短，孤立性判据拦不住时就被
 * 当成竖笔画抽走（实测宁静 p7 的高音谱号断成上下两截：1.43×2.59 与 2.76×2.65）。
 * 按连通块判必然错：剩下的上半截高度不到 3.8 格，整批误判成低音谱号，
 * 而 2.76×2.65 与 Maestro 的 fClef 模板（2.84×3.34）尺寸还挺像，字典也跟着认错。
 *
 * 所以先**把 x 上重叠的块并回一个盒**：谱号的碎块彼此在 x 上重叠，
 * 而后面的调号升降号在 x 上是分开的，并不进来。
 *
 * ## 判据（都按线距写）
 *
 *   - 横向落在谱行左端起**四个线距**以内——谱号总是紧贴谱行开头；
 *   - 纵向与谱表相交；
 *   - 并完之后高度至少 1.8 个线距、宽至少 0.8 个。宽度那一条不能省：
 *     系统线与花括号又高又窄，每次都比谱号高（实测取到 0.26×5.74 那种）。
 *
 * 高音谱号 vs 低音谱号：**先按模板签名比**（`tpl` 给了就比），比不出来再按高度分
 * ——高音谱号从谱表下方一路探到上方，实测 4.7~7.5 个线距；低音谱号只占上面两格半。
 */
export function bootstrapClefs(
  blobs: { x: number; y: number; w: number; h: number }[],
  staves: BootStaff[],
  space: number,
  /** 可选：拿签名再验一道。`sigOf` 按合并后的盒取签名（调用方从位图上算）。 */
  verify?: { tpl: OutlineTemplate[]; sigOf: (box: { x: number; y: number; w: number; h: number }) => Uint8Array },
): BootHint[] {
  const out: BootHint[] = [];
  for (const st of staves) {
    const top = st.lineYs[0];
    const bottom = st.lineYs[st.lineYs.length - 1];
    // 候选：落在谱行开头、与谱表相交的块
    const cand: number[] = [];
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      if (b.x < st.left - space || b.x > st.left + space * 4) continue;
      if (b.y > bottom || b.y + b.h < top) continue;
      cand.push(i);
    }
    if (!cand.length) continue;
    // 取最高的那个当种子，再把 x 上与它重叠的并进来
    let seed = cand[0];
    for (const i of cand) if (blobs[i].h > blobs[seed].h) seed = i;
    let box = { ...blobs[seed] };
    const used = [seed];
    for (let again = true; again; ) {
      again = false;
      for (const i of cand) {
        if (used.includes(i)) continue;
        const b = blobs[i];
        if (b.x > box.x + box.w || b.x + b.w < box.x) continue; // x 不重叠：那是调号，不是谱号的碎块
        const x0 = Math.min(box.x, b.x);
        const y0 = Math.min(box.y, b.y);
        box = { x: x0, y: y0, w: Math.max(box.x + box.w, b.x + b.w) - x0, h: Math.max(box.y + box.h, b.y + b.h) - y0 };
        used.push(i);
        again = true;
      }
    }
    if (box.h < space * 1.8 || box.w < space * 0.8) continue;
    let code: SmuflName | null = null;
    if (verify) {
      const hit = matchTemplate(verify.sigOf(box), box.w / space, box.h / space, verify.tpl.filter((t) => t.smufl === "gClef" || t.smufl === "fClef"));
      if (hit) code = hit.smufl;
    }
    out.push({ index: seed, box, code: code ?? (box.h >= space * 3.8 ? "gClef" : "fClef") });
  }
  return out;
}

/**
 * 谱号后面的**调号升降号**：紧跟谱号、又高又窄、纵向压在谱表上的那一串。
 *
 * 判据：
 *   - 横向落在谱号右缘起**六个线距**以内（调号最多七个记号，但一个记号约 0.8 格宽，
 *     六格足够罩住常见的四五个；再往右就是拍号了）；
 *   - 高度 1.8~3.6 个线距（升号约 2.7、降号约 2.3、还原号约 2.6）；
 *   - 宽度不到 1.5 个线距（谱号比这宽）。
 *
 * 升与降靠**墨迹重心的高度**分：降号是上面一根细竖、下面一个胖肚子，重心明显偏下
 * （实测中位数 0.594）；升号上下对称，重心居中（0.490）。两者隔得很开，门槛取 **0.57**。
 *
 * **不自举还原号**：它与升号都重心居中，只剩宽高比可分（实测升号 0.36、
 * 疑似还原号 0.276），那是一条连续谱、分不干净；而调号里本来就几乎不出现还原号
 * （只在转调时用来取消，本语料一处都没有）。自举只该断言它分得清的事——
 * 真有还原号会以「未定类」露出来，人工表补一条即可。
 */
export function bootstrapKeyAccidentals(
  blobs: { x: number; y: number; w: number; h: number; cy: number }[],
  staves: BootStaff[],
  clefRight: number[],
  space: number,
): BootHint[] {
  const out: BootHint[] = [];
  staves.forEach((st, k) => {
    const from = clefRight[k];
    if (!(from > 0)) return;
    const top = st.lineYs[0];
    const bottom = st.lineYs[st.lineYs.length - 1];
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      if (b.x < from || b.x > from + space * 6) continue;
      if (b.y > bottom || b.y + b.h < top) continue;
      if (b.h < space * 1.8 || b.h > space * 3.6) continue;
      if (b.w > space * 1.5) continue;
      const lowness = (b.cy - b.y) / b.h;
      const code: SmuflName = lowness > 0.57 ? "accidentalFlat" : "accidentalSharp";
      out.push({ index: i, code });
    }
  });
  return out;
}

// ── 拿矢量路的字形字典当模板 ────────────────────────────────────────────────

/** 一条模板：来自 `src/staffomr/glyphmap.json` 的一个已定案形状类。 */
export interface OutlineTemplate {
  smufl: SmuflName;
  /** 宽高，**归一到线距**（`glyphmap.json` 存的是 em 的倍数，而 em = 谱表高度 = 四个线距）。 */
  w: number;
  h: number;
  sig: Uint8Array;
}

/**
 * `glyphmap.json` → 模板表。
 *
 * 为什么能这么用：合唱谱这批底本与赞美之泉那本是**同一系的乐谱字体**（Maestro 一族），
 * 而那本的 176 个形状类**全部定案、未定 0**，并且存着 32×32 签名与 em 归一的宽高。
 * 于是位图这边不必另起炉灶——把那份现成的定案当模板比一比就行。
 * 实测尺寸逐项吻合：gClef 模板 2.75×7.45 格、位图实测 2.74×7.51。
 *
 * **签名要上下翻**：`shapeSig` 吃的是字形轮廓，那套坐标 **y 向上**，
 * 归一时字形的底边落到签名的第 0 行；位图签名是 y 向下的。不翻的话
 * gClef 的距离是 102（认成 `csymParensLeftTall`），翻过来是 **30**；
 * 升号 80 → 46、降号 127 → 52。这一条不是可选项。
 */
export function outlineTemplates(
  glyphmap: { classes: { smufl: string | null; family: string; w: number; h: number; sig: string }[] },
  /** 只取 Maestro 一家。**试过放开到 Opus、Anastasia，更差**
   *  （音符 57.88% → 56.76% / 56.81%）：那两家的同名字形形状差着一截，
   *  放进来只是给最近邻搜索添了一批更像噪声的候选。 */
  families = ["Maestro"],
): OutlineTemplate[] {
  const out: OutlineTemplate[] = [];
  for (const c of glyphmap.classes) {
    if (!c.smufl || !families.includes(c.family)) continue;
    const src = decodeSig(c.sig);
    const sig = new Uint8Array(SIG_N * SIG_N);
    for (let y = 0; y < SIG_N; y++) for (let x = 0; x < SIG_N; x++) sig[(SIG_N - 1 - y) * SIG_N + x] = src[y * SIG_N + x];
    out.push({ smufl: c.smufl as SmuflName, w: c.w * 4, h: c.h * 4, sig });
  }
  return out;
}

/** 模板匹配的签名距离上限（1024 格里差几格）。 */
export const TEMPLATE_DIST = 90;

/**
 * 拿模板给一个形状类定名。尺寸先粗筛、再比签名，取最近的那个。
 *
 * 尺寸容差按**尺寸本身**放大（`0.2 + 0.12 × 长边`）：谱号那种七格高的，
 * 位图上下多一两个像素就是 0.1 格；符点那种半格的，同样的绝对误差就是一倍。
 * 一刀切的绝对容差两头都不合适。
 */
export function matchTemplate(sig: Uint8Array, w: number, h: number, tpl: OutlineTemplate[]): { smufl: SmuflName; dist: number } | null {
  let best: { smufl: SmuflName; dist: number } | null = null;
  for (const t of tpl) {
    const tol = 0.2 + 0.12 * Math.max(t.w, t.h);
    if (Math.abs(t.w - w) > tol || Math.abs(t.h - h) > tol) continue;
    const d = sigDistance(t.sig, sig);
    if (d > TEMPLATE_DIST) continue;
    if (!best || d < best.dist) best = { smufl: t.smufl, dist: d };
  }
  return best;
}
