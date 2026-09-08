// 倚音的几何：小号数字 + 八度点 + 减时线 + 连接钩。
//
// **两条简谱路共用这一份**（文本谱 `src/pu/painter.ts::paintGrace`、成书/编辑器
// `src/layout/layout.ts::addGraceNotes`）。两边的绘图原语不一样（一边是 pu 自己的
// text/dot/rect/stroke，一边是页面树的 TextFrame/GraphicPath），所以这里只算**坐标**，
// 落笔各自去做。
//
// 所有比例都是照原版矢量量的，单位 = **主音数字的墨迹高**（`ink`）：
// 倚音墨迹高 0.50、中心在主音墨迹中心上方 0.94、离主音中心 0.665；
// 减时线长 0.388、线宽 0.055、落在倚音中心下方 0.42（原版是 0.36，见 `GRACE_BEAM_DROP`）；
// 连接钩从减时线中点垂下再朝主音弯（水平 0.249、垂直 0.304）。

/** 主音那一侧的度量。各路把自己的常量折算成这几个数。 */
export interface GraceMetrics {
  /** 主音数字的**墨迹高**——所有比例的基准。 */
  ink: number;
  /** 倚音字号 ÷ 主音字号。 */
  scale: number;
  /** 高音点的 y（相对主音基线，向上为负）与低音点的 y。
   *  **倚音不用这两个**（倚音的八度点按自己的墨迹边缘排，见 `graceGeometry`）——
   *  它们是各路画**主音**八度点用的，留在这里是因为两条路共用同一个度量对象。 */
  octaveUpY: number;
  octaveDownY: number;
  /** 多个八度点之间的间距、点半径。 */
  octaveDotGap: number;
  octaveDotRadius: number;
  /** 减时线之间的层距。 */
  underlineGap: number;
}

/** 一颗倚音占多宽（单位 = 主音墨迹高 `ink`）。 */
const GRACE_STEP = 0.45;
/** 带升降号的那一颗要额外多占这么一截，数字在格子里跟着右移同样多——
 *  不让位的话升降号会骑到左边那颗倚音上。 */
const GRACE_ACC_INSET = 0.32;

/** 竖向的三处间距（单位 = 主音墨迹高 `ink`）。原版矢量量出来的那套（0.36 / 0.8 / 0.055）
 *  在成书字号下挤成一团——倚音本来只有半个字高，几件东西贴在一起就糊成一坨，所以整体
 *  放宽：数字墨迹中心 → 第一条减时线顶 `GRACE_BEAM_DROP`（数字墨迹底在 0.25，净距因此
 *  是 0.17）、减时线的层距 `GRACE_BEAM_LAYER × m.underlineGap`、八度点与相邻墨迹之间
 *  以及点与点之间的净距 `GRACE_DOT_GAP`。三处一起调，只放宽一处会显得比例不对。 */
const GRACE_BEAM_DROP = 0.42;
const GRACE_BEAM_LAYER = 1.0;
const GRACE_DOT_GAP = 0.1;
/** 减时线线宽（也是钩子的线宽）——这是**墨迹**不是间距，放宽间距时不要跟着动。 */
const GRACE_BEAM_H = 0.055;

/** 倚音的临时升降号。两条路的原始口径不一样（简谱是 `jpAlter` 的 `#/b/n`、
 *  文本谱是 `NoteElement.accidental`），在这里统一成这一套名字。 */
export type GraceAlter = "sharp" | "flat" | "natural" | "double-sharp" | "double-flat";

/** 一颗倚音：数字、八度（正=高音点、负=低音点）、时值（4 = 四分，8 = 八分…）。 */
export interface GraceNote {
  digit: string;
  octave: number;
  /** MusicXML 的 duration 口径：pu 那边是 `gn.duration`，4 = 四分。默认 8（八分）。 */
  duration?: number;
  /** 临时升降号。带号的那一颗要多占 `GRACE_ACC_INSET` 一截（见 `graceAdvance`）。 */
  alter?: GraceAlter;
}

export interface GraceGeom {
  /** 数字：按**墨迹中心**定位（调用方按自己的字体度量把中心换算成基线）。 */
  digits: { text: string; cx: number; cy: number; size: number }[];
  dots: { cx: number; cy: number; r: number }[];
  /** 升降号：**按墨迹定位**——两条路各自量自己的 SMuFL 字形，把墨迹右缘贴到 `inkRight`、
   *  墨迹竖向中心对齐 `inkCy`、字号取到墨迹高等于 `inkHeight`。
   *  给的不是字号是因为两边字体度量不同，靠固定偏移放会随字体漂（与 pu 主音那套同理）。 */
  accidentals: { alter: GraceAlter; inkRight: number; inkCy: number; inkHeight: number }[];
  /** 减时线（矩形）。**同一层里相邻的倚音连成一条通杠**，不是一颗一小段。 */
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
  const out: GraceGeom = { digits: [], dots: [], accidentals: [], beams: [], hook: null };
  if (!notes.length) return out;
  const ink = m.ink;
  const size = fontSize * m.scale;
  const nearest = x + dir * ink * 0.665; // 最靠近主音的那个
  const gy = centerY !== undefined ? centerY : baseline - ink * 0.94;
  const halfBeam = ink * 0.194;
  // 横向：每颗占**自己那一格**（带升降号的宽一截），格子里数字居中偏右、升降号占前面
  // 那一截。没有升降号时逐格宽度都是 `GRACE_STEP`，中心距回到从前那个常数 0.45 ink。
  const centers: number[] = [];
  let cursor = 0;
  for (const gn of notes) {
    const inset = gn.alter ? ink * GRACE_ACC_INSET : 0;
    centers.push(cursor + inset + ink * (GRACE_STEP / 2));
    cursor += inset + ink * GRACE_STEP;
  }
  // 贴着主音的那一颗定锚：前倚音是最后一颗，后倚音是第一颗（两种方向都保持读序）
  const anchor = dir < 0 ? notes.length - 1 : 0;
  const shift = nearest - centers[anchor]!;
  const gxs = centers.map((c) => c + shift);
  // 倚音默认八分：一条减时线；时值再短就多一层。比主音的细得多。
  const lvCounts = notes.map((gn) => Math.max(1, Math.ceil(Math.log2((gn.duration ?? 8) / 4))));
  const beamY = (lv: number): number =>
    gy + ink * GRACE_BEAM_DROP + lv * m.underlineGap * GRACE_BEAM_LAYER;
  // **同一层里相邻的倚音连成一条通杠**（`3_2_` 这种要画一条横线贯到底，不是两小段）。
  // 层数不齐时按「这一层还有份的连续段」分别连，与主音符的符杠同一个道理。
  const maxLv = Math.max(...lvCounts);
  for (let lv = 0; lv < maxLv; lv++) {
    let runStart = -1;
    for (let i = 0; i <= notes.length; i++) {
      const on = i < notes.length && lvCounts[i]! > lv;
      if (on && runStart < 0) runStart = i;
      if (!on && runStart >= 0) {
        const x1 = gxs[runStart]! - halfBeam;
        const x2 = gxs[i - 1]! + halfBeam;
        out.beams.push({ x: x1, y: beamY(lv), w: x2 - x1, h: ink * GRACE_BEAM_H });
        runStart = -1;
      }
    }
  }
  let hookAt: { mid: number; y: number; low: boolean } | null = null;
  notes.forEach((gn, i) => {
    const gx = gxs[i]!;
    out.digits.push({ text: gn.digit, cx: gx, cy: gy, size });
    // 升降号贴在这一颗数字墨迹的左缘。竖向照 pu 主音那一套（墨迹中心在墨迹底上方
    // 0.34 个字高、降号再低 0.08），只是所有量都按倚音的墨迹高——也就是主音的一半。
    if (gn.alter) {
      const gInk = ink * 0.5; // 倚音墨迹高（这份文件里通篇的口径）
      out.accidentals.push({
        alter: gn.alter,
        inkRight: gx - halfBeam - gInk * 0.1,
        inkCy: gy + gInk * 0.5 - gInk * 0.34 + (gn.alter.includes("flat") ? gInk * 0.08 : 0),
        inkHeight: gInk * 0.78,
      });
    }
    const lastY = beamY(lvCounts[i]! - 1);
    // 八度点**按倚音自己的墨迹边缘排**（上边缘往上、减时线下边缘往下），净距取
    // `ink * 0.11`——就是减时线离墨迹底那一截，与这一份里其它比例同一个口径。
    //
    // 从前用的是 `m.octaveUpY` / `m.octaveDownY`：那两个数是**相对主音基线**量的
    //（`bnd.top − jpStackGap` 与 `jpDotRung`），却加在倚音的**墨迹中心** `gy` 上，
    // 两个原点对不上——低音点因此落进数字里（`jpDotRung × scale ≈ 4pt` 还不到
    // 倚音墨迹的半高 6pt，用户口径：「倚音的低音点和倚音数字重叠了」），
    // 高音点则被推到墨迹顶上方一个半字高。
    // **点半径照主音整体缩小**：倚音的墨迹高是主音的一半（这份文件里 0.50 × ink），
    // 点也该是一半。原先给 0.75，点比该有的胖出一半，整摞跟着往外顶
    //（用户口径：「倚音的低音点离音符太远，参考正常音符整体缩小」）。
    const rr = m.octaveDotRadius * 0.5;
    // 墨迹到第一个点的净距（见 `GRACE_DOT_GAP`）。
    const inkGap = ink * GRACE_DOT_GAP;
    const dotStep = rr * 2 + inkGap;
    for (let k = 0; k < gn.octave; k++)
      out.dots.push({ cx: gx, cy: gy - ink * 0.25 - inkGap - rr - k * dotStep, r: rr });
    for (let k = 0; k < -gn.octave; k++)
      out.dots.push({ cx: gx, cy: lastY + ink * GRACE_BEAM_H + inkGap + rr + k * dotStep, r: rr });
    if (i === anchor) {
      // 有低音点时钩子从**最低那个点的下缘**再让开一格起笔（见下面 hook 那一段）。
      const dotsBottom =
        gn.octave < 0
          ? lastY + ink * GRACE_BEAM_H + inkGap + rr * 2 + (-gn.octave - 1) * dotStep + inkGap
          : lastY;
      hookAt = { mid: gx, y: dotsBottom, low: gn.octave < 0 };
    }
  });
  if (hookAt === null) return out;
  const { mid, y: uy, low } = hookAt as { mid: number; y: number; low: boolean };
  const toward = -dir; // 前倚音（画在左）朝右弯，后倚音朝左弯
  const drop = ink * 0.304;
  const reach = ink * 0.249 * toward;
  const width = ink * GRACE_BEAM_H;
  // **有低音点时钩子接在低音点下方**：低音点排在数字正下方（cx = gx），钩子也从那儿
  // 垂下来，两者本来会叠在一起。做法不是把起脚横着挪开（那样钩子跟数字对不上竖轴），
  // 而是让**起点顺着同一条竖轴下移到最低那个点的下缘之外**，中间留一格空隙
  //（`GRACE_DOT_GAP`，与八度点之间的净距同一个口径，已经算进上面的 `hookAt.y`）。
  const startY = low ? uy : uy + ink * 0.033;
  out.hook = {
    m: [mid, startY],
    c: [mid, startY + drop * 0.6, mid - reach * 0.15, startY + drop * 0.87, mid + reach, startY + drop],
    width,
  };
  return out;
}

/**
 * 一组倚音的**墨迹底缘**（相对传给 `graceGeometry` 的那个 `centerY`）。
 *
 * 最低的那一笔不一定是数字：减时线在数字之下、连接钩还要再往下垂一截，有低音点时
 * 低音点更低。「倚音底缘贴着主音墨迹顶」这条落位规则要用它——按 `centerY = 0` 排一遍
 * 量出底缘，再回填真正的 `centerY`（见 `layout.ts::addGraceNotes`）。
 */
export function graceBottom(g: GraceGeom, m: GraceMetrics): number {
  let low = m.ink * 0.25; // 数字自己的墨迹底
  for (const b of g.beams) low = Math.max(low, b.y + b.h);
  for (const d of g.dots) low = Math.max(low, d.cy + d.r);
  if (g.hook) low = Math.max(low, g.hook.c[5] + g.hook.width / 2);
  return low;
}

/** 一组倚音占多宽（主音之外的那一截）——排版要按它给音符前面留位。
 *  带升降号的那几颗宽一截，所以按逐颗累加，不是「颗数 × 常数」。 */
export function graceAdvance(notes: readonly GraceNote[], m: GraceMetrics): number {
  let w = 0;
  for (const gn of notes) w += m.ink * (GRACE_STEP + (gn.alter ? GRACE_ACC_INSET : 0));
  return w;
}
