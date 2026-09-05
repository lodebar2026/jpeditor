// 认领账本：识别的每一步认走了哪些 contour，剩下的就是**无主的**。
//
// 这一份不参与识别，只记账。识别侧每造一个 `Sym`、每收一条段、每切一个歌词字格，
// 就按它的盒记一笔；一页跑完，没有任何一笔的 contour 就是「印在纸上而我们从没看见的」
// ——松叶、力度、表情文字、段落记号、页眉，全在里面。那张表是往后取舍的证据。
//
// **认领是按盒查标号图**（`ContourMap.labels`），不是按盒相交：盒相交会把
// 路过盒角的符干、隔壁符号一并算进来。
import type { Rect } from "../omr/types";
import type { Contour, ContourMap } from "./contour";

/** 认领人。字符串而不是枚举——`dict:<smufl>` 这种要带上认成了什么。 */
export type ClaimBy = string;

export interface Claim {
  by: ClaimBy;
  box: Rect;
}

/** 一团墨要被认领，至少得有这么多像素落在盒里（挡住路过盒角的那种）。 */
const MIN_PIX = 4;
/** 落进盒里的像素占**本团墨**或占**盒内全部墨**的比例，过一条就算认领。
 *  两条都要：符头的盒只盖住「符头+符干+符杠」那一大团的一小截（占团的比例低，
 *  但占盒内墨的比例高）；歌词字格反过来（盒里可能还压着别的偏旁）。 */
const MIN_SHARE = 0.2;

export class ContourLedger {
  private readonly map: ContourMap;
  private readonly book = new Map<number, Claim[]>();

  constructor(map: ContourMap) {
    this.map = map;
  }

  /** 记一笔：盒里的墨属于谁。返回被认领的 contour id。 */
  claim(box: Rect, by: ClaimBy): number[] {
    const { labels, w, h } = this.map;
    const x0 = Math.max(0, Math.floor(box.x));
    const y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(w - 1, Math.ceil(box.x + box.w));
    const y1 = Math.min(h - 1, Math.ceil(box.y + box.h));
    const hit = new Map<number, number>();
    let ink = 0;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const id = labels[y * w + x];
        if (!id) continue;
        ink++;
        hit.set(id, (hit.get(id) ?? 0) + 1);
      }
    const out: number[] = [];
    for (const [id, n] of hit) {
      const c = this.map.byId.get(id);
      if (!c || n < MIN_PIX) continue;
      if (n < ink * MIN_SHARE && n < c.area * MIN_SHARE) continue;
      const a = this.book.get(id) ?? [];
      a.push({ by, box });
      this.book.set(id, a);
      out.push(id);
    }
    return out;
  }

  /** 一条线段（横段/竖段/符杠）的认领：按它的包围盒记。 */
  claimSeg(s: { x0: number; y0: number; x1: number; y1: number; maxLw: number }, by: ClaimBy): void {
    const pad = s.maxLw / 2 + 1;
    const x = Math.min(s.x0, s.x1) - pad;
    const y = Math.min(s.y0, s.y1) - pad;
    this.claim({ x, y, w: Math.max(s.x0, s.x1) + pad - x, h: Math.max(s.y0, s.y1) + pad - y }, by);
  }

  /** 这团墨的认领记录。 */
  claimsOf(id: number): Claim[] {
    return this.book.get(id) ?? [];
  }

  /** 没有任何一笔的 contour。 */
  unclaimed(): Contour[] {
    return this.map.contours.filter((c) => !this.book.has(c.id));
  }

  /**
   * 墨覆盖率。
   *
   * **口径**：认领过的 contour 的**全部**像素都算「已解释」——符头的盒只盖住
   * 「符头+符干+符杠」那一团的一小截，但那一团确实是解释得了的东西。
   * 所以这个数偏乐观，它量的是「还剩多少团墨完全没人看过」，
   * 不是「像素级的解释率」。两个数一起看：`ratio` 与 `unclaimedCount`。
   */
  coverage(): { ink: number; claimed: number; ratio: number; total: number; unclaimedCount: number } {
    let claimed = 0;
    for (const c of this.map.contours) if (this.book.has(c.id)) claimed += c.area;
    return {
      ink: this.map.ink,
      claimed,
      ratio: this.map.ink ? claimed / this.map.ink : 0,
      total: this.map.contours.length,
      unclaimedCount: this.map.contours.length - this.book.size,
    };
  }
}
