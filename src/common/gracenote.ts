// 倚音的几何：小号数字 + 八度点 + 减时线 + 连接钩。
//
// **两条简谱路共用这一份**（文本谱 `src/pu/painter.ts::paintGrace`、成书/编辑器
// `src/layout/layout.ts::addGraceNotes`）。两边的绘图原语不一样（一边是 pu 自己的
// text/dot/rect/stroke，一边是页面树的 TextFrame/GraphicPath），所以这里只算**坐标**，
// 落笔各自去做。
//
// 所有比例都是照原版矢量量的，单位 = **主音数字的墨迹高**（`ink`）：
// 倚音墨迹高 0.50、中心在主音墨迹中心上方 0.94、离主音中心 0.665；
// 减时线长 0.388、线宽 0.055、落在倚音中心下方 0.36；
// 连接钩从减时线中点垂下再朝主音弯（水平 0.249、垂直 0.304）。

/** 主音那一侧的度量。各路把自己的常量折算成这几个数。 */
export interface GraceMetrics {
  /** 主音数字的**墨迹高**——所有比例的基准。 */
  ink: number;
  /** 倚音字号 ÷ 主音字号。 */
  scale: number;
  /** 高音点的 y（相对主音基线，向上为负）与低音点的 y。 */
  octaveUpY: number;
  octaveDownY: number;
  /** 多个八度点之间的间距、点半径。 */
  octaveDotGap: number;
  octaveDotRadius: number;
  /** 减时线之间的层距。 */
  underlineGap: number;
}

/** 一颗倚音：数字、八度（正=高音点、负=低音点）、时值（4 = 四分，8 = 八分…）。 */
export interface GraceNote {
  digit: string;
  octave: number;
  /** MusicXML 的 duration 口径：pu 那边是 `gn.duration`，4 = 四分。默认 8（八分）。 */
  duration?: number;
}

export interface GraceGeom {
  /** 数字：按**墨迹中心**定位（调用方按自己的字体度量把中心换算成基线）。 */
  digits: { text: string; cx: number; cy: number; size: number }[];
  dots: { cx: number; cy: number; r: number }[];
  /** 减时线（矩形）。 */
  beams: { x: number; y: number; w: number; h: number }[];
  /** 连接钩：一段三次贝塞尔（`m` 起点，`c` 两个控制点 + 终点），`width` 是线宽。 */
  hook: { m: [number, number]; c: [number, number, number, number, number, number]; width: number } | null;
}

/**
 * 算出一组倚音该画在哪儿。
 *
 * @param x        主音数字的**墨迹中心** x
 * @param baseline 主音的基线 y
 * @param dir      -1 = 前倚音（画在左），1 = 后倚音（画在右）
 */
export function graceGeometry(
  notes: readonly GraceNote[],
  m: GraceMetrics,
  x: number,
  baseline: number,
  dir: -1 | 1,
  fontSize: number,
  /** 倚音数字**墨迹中心**的 y。省略 = 番茄原版那套（基线上方 0.94 个墨迹高）。
   *  简谱这一路要按音符的**墨迹栈顶**算：原书实测倚音中心在主音中心上方
   *  1.13~1.77 个音符高，差的那一截正是有没有高音点。 */
  centerY?: number,
): GraceGeom {
  const out: GraceGeom = { digits: [], dots: [], beams: [], hook: null };
  if (!notes.length) return out;
  const ink = m.ink;
  const size = fontSize * m.scale;
  const step = ink * 0.45; // 多个倚音之间的中心距
  const nearest = x + dir * ink * 0.665; // 最靠近主音的那个
  const gy = centerY !== undefined ? centerY : baseline - ink * 0.94;
  const halfBeam = ink * 0.194;
  let hookAt: { mid: number; y: number } | null = null;
  notes.forEach((gn, i) => {
    // 前倚音：最后一个贴着主音，往左依次排开；后倚音镜像
    const order = dir < 0 ? notes.length - 1 - i : i;
    const gx = nearest + dir * order * step;
    out.digits.push({ text: gn.digit, cx: gx, cy: gy, size });
    for (let k = 0; k < gn.octave; k++)
      out.dots.push({ cx: gx, cy: gy + m.octaveUpY * m.scale - k * m.octaveDotGap * 0.7, r: m.octaveDotRadius * 0.75 });
    for (let k = 0; k < -gn.octave; k++)
      out.dots.push({ cx: gx, cy: gy + m.octaveDownY * m.scale + k * m.octaveDotGap * 0.7, r: m.octaveDotRadius * 0.75 });
    // 倚音默认八分：一条减时线；时值再短就多一层。比主音的细得多。
    const levels = Math.max(1, Math.log2((gn.duration ?? 8) / 4));
    let lastY = gy + ink * 0.36;
    for (let lv = 0; lv < levels; lv++) {
      lastY = gy + ink * 0.36 + lv * m.underlineGap * 0.8;
      out.beams.push({ x: gx - halfBeam, y: lastY, w: halfBeam * 2, h: ink * 0.055 });
    }
    if (order === 0) hookAt = { mid: gx, y: lastY };
  });
  if (hookAt === null) return out;
  const { mid, y: uy } = hookAt as { mid: number; y: number };
  const toward = -dir; // 前倚音（画在左）朝右弯，后倚音朝左弯
  const drop = ink * 0.304;
  const reach = ink * 0.249 * toward;
  out.hook = {
    m: [mid, uy + ink * 0.033],
    c: [mid, uy + drop * 0.6, mid - reach * 0.15, uy + drop * 0.87, mid + reach, uy + drop],
    width: ink * 0.055,
  };
  return out;
}

/** 一组倚音占多宽（主音之外的那一截）——排版要按它给音符前面留位。 */
export function graceAdvance(count: number, m: GraceMetrics): number {
  return count > 0 ? m.ink * 0.45 * count : 0;
}
