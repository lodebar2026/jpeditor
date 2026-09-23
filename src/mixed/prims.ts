// 混排渲染的落笔小工具（线、SMuFL 字形、平移组）。五线谱层（`render.ts`）与简谱叠层（`jianpuoverlay.ts`）共用。

import { Matrix33, Point } from "../common/geom";
import { GraphicLine, Group, TextFrame } from "../layout/pageitem";
import { Font } from "../layout/font";
import type { ElementId } from "../model/doc";

/** 一个和弦画出来的那一组（五线谱层的符头、符干、符尾；简谱叠层的那一柱）的类名。
 *  `data` 是 `StaffChordData`：编辑器按元素 id 找到它，放播放线、认点选。 */
export const STAFF_CHORD = "staff-chord";
export interface StaffChordData {
  readonly chordId: ElementId;
}
/** 一行系统的组的类名。`data` 是 `StaffSystemData`：谱表带（混排连同简谱层）的上下沿，系统坐标（tenths）。 */
export const STAFF_SYSTEM = "staff-system";
export interface StaffSystemData {
  readonly top: number;
  readonly bottom: number;
}

/** 和弦 `id` 的组（见 `STAFF_CHORD`）。 */
export function chordGroup(id: ElementId): Group {
  const g = new Group();
  g.classes.add(STAFF_CHORD);
  g.data = { chordId: id } satisfies StaffChordData;
  return g;
}

export function addLine(g: Group, x1: number, y1: number, x2: number, y2: number, lw: number): void {
  const l = new GraphicLine();
  l.p0 = new Point(x1, y1);
  l.p1 = new Point(x2, y2);
  l.strokeColor = 0xff000000;
  l.strokeWidth = lw;
  g.add(l);
}

/** SMuFL glyph via TextFrame with Bravura family. */
export function addSmufl(g: Group, glyph: string, x: number, y: number, size: number): void {
  const t = new TextFrame();
  t.text = glyph;
  t.font = new Font("Bravura", size);
  t.color = 0xff000000;
  t.x = x;
  t.y = y;
  g.add(t);
}

/** SMuFL glyph with scale transform. */
export function addSmuflScaled(
  g: Group,
  glyph: string,
  x: number,
  y: number,
  size: number,
  scx: number,
  scy: number,
): void {
  const grp = new Group();
  const m = new Matrix33();
  m.setAffine([scx, 0, 0, scy, x, y]);
  grp.matrix = m;
  addSmufl(grp, glyph, 0, 0, size);
  g.add(grp);
}

export function translated(x: number, y: number): Group {
  const g = new Group();
  const m = new Matrix33();
  m.setAffine([1, 0, 0, 1, x, y]);
  g.matrix = m;
  return g;
}
