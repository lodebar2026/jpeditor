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
  let hookAt: { mid: number; y: number; low: boolean } | null = null;
  notes.forEach((gn, i) => {
    // 前倚音：最后一个贴着主音，往左依次排开；后倚音镜像
    const order = dir < 0 ? notes.length - 1 - i : i;
    const gx = nearest + dir * order * step;
    out.digits.push({ text: gn.digit, cx: gx, cy: gy, size });
    // 倚音默认八分：一条减时线；时值再短就多一层。比主音的细得多。
    const levels = Math.max(1, Math.log2((gn.duration ?? 8) / 4));
    let lastY = gy + ink * 0.36;
    for (let lv = 0; lv < levels; lv++) {
      lastY = gy + ink * 0.36 + lv * m.underlineGap * 0.8;
      out.beams.push({ x: gx - halfBeam, y: lastY, w: halfBeam * 2, h: ink * 0.055 });
    }
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
    // 墨迹到第一个点的净距，同样是**主音那一格缩一半**：PPT 档 28pt 上主音的
    // 「减时线下缘 → 低音点墨迹顶」是 2.09pt，减半 1.04pt，`ink * 0.055` 折出来 1.10pt。
    const inkGap = ink * 0.055;
    const dotStep = rr * 2 + inkGap;
    for (let k = 0; k < gn.octave; k++)
      out.dots.push({ cx: gx, cy: gy - ink * 0.25 - inkGap - rr - k * dotStep, r: rr });
    for (let k = 0; k < -gn.octave; k++)
      out.dots.push({ cx: gx, cy: lastY + ink * 0.055 + inkGap + rr + k * dotStep, r: rr });
    if (order === 0) hookAt = { mid: gx, y: lastY, low: gn.octave < 0 };
  });
  if (hookAt === null) return out;
  const { mid, y: uy, low } = hookAt as { mid: number; y: number; low: boolean };
  const toward = -dir; // 前倚音（画在左）朝右弯，后倚音朝左弯
  const drop = ink * 0.304;
  const reach = ink * 0.249 * toward;
  const width = ink * 0.055;
  // **有低音点时钩子要错开**：低音点排在数字正下方（cx = gx），钩子本来也从那儿垂下来，
  // 两者正好叠在一起（用户口径：「有低音点时需要把倚音的小弧线左移错开」）。两件事一起做：
  //   1. 起脚往**反着弯的方向**挪一个「点半径 + 半个线宽 + 一格」——仍落在减时线上
  //      （减时线半长 0.194 ink，让的量只有它的六成）；
  //   2. 控制点改成**先垂直落到底、再横着甩过去**，这样扫到低音点那一段 x 时曲线已经
  //      在点的下缘之外。只挪起脚不够：默认那套控制点是斜着扫的，半路正好从点上穿过。
  const hx = low ? mid - toward * (m.octaveDotRadius * 0.5 + width / 2 + ink * 0.055) : mid;
  const dy = low ? drop * 1.1 : drop; // 有低音点时再垂深一成，横甩那一段稳稳走在点的下面
  out.hook = {
    m: [hx, uy + ink * 0.033],
    c: low
      ? [hx, uy + dy, hx, uy + dy, mid + reach, uy + dy] // 直角圆转：先落到底再横甩
      : [hx, uy + drop * 0.6, hx - reach * 0.15, uy + drop * 0.87, mid + reach, uy + drop],
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

/** 一组倚音占多宽（主音之外的那一截）——排版要按它给音符前面留位。 */
export function graceAdvance(count: number, m: GraceMetrics): number {
  return count > 0 ? m.ink * 0.45 * count : 0;
}
