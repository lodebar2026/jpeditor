// 混排渲染的落笔小工具（线、SMuFL 字形、平移组）。五线谱层（`render.ts`）与简谱叠层（`jianpuoverlay.ts`）共用。

import { Matrix33, Point } from "../common/geom";
import { GraphicLine, Group, TextFrame } from "../layout/pageitem";
import { Font } from "../layout/font";

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
