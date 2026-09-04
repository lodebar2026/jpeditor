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
  /** 定案来源：`bravura` = 拿 Bravura 渲染的模板初标；`manual` = 人工表定的。
   *  初标只当线索——底本是 Maestro 一系，与 Bravura 不同源，**不能当判据**。 */
  source: "bravura" | "manual" | null;
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
