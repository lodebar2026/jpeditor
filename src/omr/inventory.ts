// 页面对象归类：把一页的每个矢量对象归到一个语义类，并**列出归不掉的**。
//
// 这是「尽量识别 PDF 中所有内容，不支持的也要列出来」那条要求的落点：
// 硬指标是 `unclassified` 收敛到 0——归不掉的对象要么是我们还没认识的版面元素，
// 要么是判据有洞，两种都必须暴露出来，不能默默丢掉。
//
// 归类只用几何 + profile 字号，**不需要认字**（认字是 glyphdict 的事）。
// 无 DOM 依赖（Node CLI 要用）。
//
// 几条拿具体页换来的判据，改之前先看这里的注释：
//  - **不是每个字都是一个 path**。歌词/音符是逐字一对象，但**花边框里的小字注解整行合成
//    一个 path**（p42 底部那段圣诗故事：一行 = curves 548 的单个对象）。故先按 segs 把
//    「整行文字」摘出来，否则它会被宽扁判据误当成圆滑线。
//  - **花边不是虚线**。p42 的花边框是同一个装饰纹样（5.0×10.8, curves=36）沿矩形四边
//    重复平铺出来的，页面上一个 setDash 都没有。故按「同形状对象沿周边重复」检测。
//  - **花边检测必须排在结构线之前**。点线花边的每一个点都是细高小块，会被小节线判据收走
//    （实测 p605 收了 60 条假小节线 → 造出 21 个假谱行 → 框内那段圣诗故事被当成音符和歌词）。
//    识别出框以后，框内的对象一律归 storyText 并跳过后续判据——框里是注解正文，不是乐谱。
//  - 谱行的基线要用**带内音符**统计，不能用小节线底——小节线比数字高，上下都超出，
//    拿它当基线会把增时线和减时线判反。
//  - **不能用「有没有曲线」判断是不是字**。这本书数字字体里的 1/4/7 等是纯折线（curves=0），
//    拿 curves>=1 当门槛会把整行音符漏成未归类。改按**宽高比**认结构线，其余按字号认字。
//  - **同一个字画了两遍**：一个 fill 一个 stroke（描边加粗），bbox 差约一个线宽。
//    两个都要归类（否则重排核对会报 unplaced），但逻辑上是一个字——用 `dup` 标出描边那份，
//    下游数音符/取文本时只认非 dup 的。
import type { Rect } from "./types";
import type { BookProfile } from "./bookprofile";
import type { VecObj, VecPage } from "./vector";
import { concatObjects, intersectRect } from "./vector";

export type ObjClass =
  // 乐谱本体
  | "note" // 音符数字
  | "octaveDot" // 八度点（音符上/下方的圆点）
  | "augmentDot" // 附点（音符右侧的圆点）
  | "divLine" // 减时线（音符下方短横）
  | "augmentLine" // 增时线（与音符同基线的长横 "-"）
  | "barline" // 小节线（细高竖线，含复纵线/终止线）
  | "repeatDot" // 反复记号的冒号点
  | "slur" // 圆滑线 / 连音线（宽扁弧）
  | "tupletNum" // 三连音数字与其括线
  | "keyMeter" // 调号拍号「1=F 4/4」
  // 文字
  | "title"
  | "songNumber"
  | "category" // 页眉分类词
  | "credit" // 词曲署名
  | "lyric" // 歌词
  | "lyricYi" // 歌词里的「一」：扁横条，与短圆滑线同形，只能按「与歌词共基线」认，且不进字典
  // 注：歌词里的「一」在矢量层就是一条扁横线，**与跨一个音符的短圆滑线尺寸完全一样**
  //（10.4×1.0）。早年按「宽度 ≈ 一个字宽」捞过两回（走字典、直接定案），
  // 两种都让准确率不升反降（86.9% → 72.7% / 85.9%）——那时的判据只看自己，
  // 捞回来的多半是圆滑线。现在改**看同行的上下文**：与同行满格汉字共**字格中心**
  //（不是共基线——「一」悬在字格中部，下缘比汉字高四五个点）、且相邻不超过 3.5 个字宽。
  // 真圆滑线就是靠这一条挡住的，捞回来之后完全一致 441 → 451 首。判据见下面 `lyricYi` 那一段。
  | "verseNum" // 段号 1. 2. 3.
  | "chord" // 和弦符号
  | "sectionWord" // 段落词（副歌/间奏…）
  | "textLine" // 整行合成一个 path 的文字，需再拆字
  | "storyText" // 花边框内的注解正文（圣诗故事/经文/注记）
  | "tocEntry" // 目录 / 首句索引页的条目文字（无谱行的纯文字页）
  | "leader" // 目录里的引导点线 ……
  | "footer" // 页码
  // 版面
  | "rule" // 通栏分隔线
  | "frame" // 边框
  | "ornament" // 花边装饰纹样
  | "bracket" // 反复房号括线、三连音括线
  | "unclassified";

export interface ClassifiedObj {
  obj: VecObj;
  cls: ObjClass;
  /** 归属的谱行下标（-1 = 不属于任何谱行）。 */
  row: number;
  /** 判据说明，便于回查为什么这么归。 */
  why: string;
  /** 同一字形的重复描边份（fill + stroke 画两遍中的后一份）。下游计数/取文本时应跳过。 */
  dup?: boolean;
  /** 归行用的基线。只有 `lyricYi` 会给：「一」只有一横、悬在字格中部，
   *  它自己的下缘比同行汉字高四五个点，按下缘聚行会被分到别的行去。
   *  这里存的是**参照汉字的下缘**，聚行时优先用它。 */
  baseline?: number;
}

export interface StaffBand {
  index: number;
  /** 小节线覆盖的 y 区间。 */
  top: number;
  bottom: number;
  /** 带内音符的顶/底/基线（音符 bbox 统计，非小节线）。 */
  noteTop: number;
  noteBottom: number;
  x0: number;
  x1: number;
  barlineXs: number[];
  noteCount: number;
}

/** 花边框：一圈重复纹样围出的矩形。 */
export interface OrnamentFrame {
  box: Rect;
  /** 纹样实例数。 */
  tiles: number;
  tileW: number;
  tileH: number;
}

export interface PageInventory {
  page: number;
  width: number;
  height: number;
  objs: ClassifiedObj[];
  bands: StaffBand[];
  frames: Rect[];
  ornaments: OrnamentFrame[];
  counts: Record<string, number>;
  unclassified: ClassifiedObj[];
}

const cx = (r: Rect) => r.x + r.w / 2;
const cy = (r: Rect) => r.y + r.h / 2;
const bottom = (r: Rect) => r.y + r.h;
const right = (r: Rect) => r.x + r.w;

function overlap1d(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** 四分之三分位。量「这一行是多大的字」要用它而不是中位数：
 *  行里夹着标点、上标数字（才 2.9 高），中位数会被它们拽下去，
 *  一行歌词那号字的经文（10.6）中位能掉到 9.6，字号闸就形同虚设。 */
function q75(v: number[]): number {
  if (!v.length) return 0;
  const a = [...v].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * 0.75))];
}

/** 粗形状指纹：同一个装饰纹样在页面上重复出现时，这四项完全一致。
 *  （精确到字符的形状键是 glyphdict 的事，这里只要能认出「同一个图形」。） */
/** 有效宽/高：零宽的竖线（PDF 里靠 lineWidth 呈现）按线宽算，否则宽高比会算成无穷。 */
const effW = (o: VecObj) => Math.max(o.bbox.w, o.lineWidth, 0.1);
const effH = (o: VecObj) => Math.max(o.bbox.h, o.lineWidth, 0.1);

function coarseKey(o: VecObj): string {
  return `${o.curves}/${o.segs}/${o.bbox.w.toFixed(1)}/${o.bbox.h.toFixed(1)}`;
}

export interface ClassifyOptions {
  /** 音符数字的高度；不给则从 profile 推。 */
  noteH?: number;
}

/** 从 profile 推音符字号族（窄字、实例最多）。 */
export function noteHeightOf(profile: BookProfile): number {
  const f = profile.families
    .filter((f) => f.count > 100 && f.w / f.h < 0.75 && f.h > 4)
    .sort((a, b) => b.count - a.count)[0];
  return f?.h ?? 8.3;
}

/** 从 profile 推主歌词字号族（近方汉字、比音符大、实例最多）。 */
export function lyricHeightOf(profile: BookProfile, noteH: number): number {
  const f = profile.families
    .filter((f) => f.count > 100 && f.w / f.h > 0.85 && f.h > noteH)
    .sort((a, b) => b.count - a.count)[0];
  return f?.h ?? noteH * 1.25;
}

/**
 * 归类一页。
 *
 * 顺序有讲究：结构线 → 谱行带 → 音符 → 圆点/横线（依赖音符位置）→ 弧线 →
 * 花边与框 → 版面带 → 剩余文字按相对谱行的位置分。
 */
export function classifyPage(page: VecPage, profile: BookProfile, opts: ClassifyOptions = {}): PageInventory {
  const objs = page.objs;
  const out: ClassifiedObj[] = objs.map((o) => ({ obj: o, cls: "unclassified" as ObjClass, row: -1, why: "" }));
  const set = (i: number, cls: ObjClass, why: string) => {
    // **花边框里的东西一律只当注解正文**：框内印的是圣诗故事/经文/注记，与乐谱无关。
    // 0a 一进来就把框内定成 storyText，这里守住不许后面的判据再改判——
    // 「整行合成 path」那一步原先不看已有归类，把框里 2662 行正文全改判成了 textLine，
    // 它们于是又流回谱行的判据里去（当署名、当歌词）。
    if (out[i].cls === "storyText" && cls !== "storyText") return;
    // 框的一圈纹样同样是 0a 定的案，同样不许后面改判。整条边合成一个 path 的那种花边边
    // （`collectSolidEdges`）又宽又扁又多段，紧接着的「步骤 0：整行合成的文字对象」正好
    // 把它当成一行字收走——于是那条边又落回框内，以正文首行的身份印出来（p92/p591/p633…）。
    if (out[i].cls === "ornament" && cls !== "ornament") return;
    out[i].cls = cls;
    out[i].why = why;
  };

  const noteH = opts.noteH ?? noteHeightOf(profile);
  const lyricH = lyricHeightOf(profile, noteH);

  // ── 0a. 花边框：同一批小纹样沿矩形四边重复平铺。**必须在结构线之前**，
  //      否则点线花边的每个点都会被小节线判据收走。
  const ornaments = detectOrnamentFrames(objs, noteH, profile.contentBox.w);
  for (const orn of ornaments) {
    for (const i of orn.idx) set(i, "ornament", `重复纹样 ×${orn.idx.length}，围成 ${orn.box.w.toFixed(0)}×${orn.box.h.toFixed(0)} 的框`);
  }
  // 框内的一切都是注解正文，不是乐谱——直接定案，跳过后续所有判据（`set` 里有一道锁）。
  // 范围取**整个框**而不是 inner：inner 往里缩了一圈边宽，压在那一圈上的文字收不到，
  // 全书还剩 566 行正文流回谱面判据里去。框的一圈纹样自己早已定成 ornament，不受影响。
  for (const orn of ornaments) {
    for (let i = 0; i < objs.length; i++) {
      if (out[i].cls !== "unclassified") continue;
      if (intersectRect(objs[i].bbox, orn.box)) set(i, "storyText", "花边框内的注解正文");
    }
  }

  // ── 0. 整行合成的文字对象：段数远超单字，且宽扁。
  //     必须最先摘出来，否则下面的宽扁判据会把它当成圆滑线。
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    if (o.curves >= 40 && o.bbox.w > o.bbox.h * 3) set(i, "textLine", `整行合成 path（curves=${o.curves}）`);
  }

  // ── 1. 结构线：按**宽高比**认，不看有没有曲线（数字 1/4/7 也是纯折线）。
  const barlineIdx: number[] = [];
  const shortBarIdx: number[] = [];
  const hLineIdx: number[] = [];
  const frames: Rect[] = [];
  for (let i = 0; i < objs.length; i++) {
    if (out[i].cls !== "unclassified") continue;
    const o = objs[i];
    if (o.curves > 2) continue; // 带多段曲线的是字，不是线
    const { w, h } = o.bbox;
    const ew = effW(o);
    const eh = effH(o);
    // 竖线必须**一条曲线都没有**（是个矩形）：全书 2676 条小节线无一例外 curves=0，
    // 而拉丁小写 `l` 是 2.4×7.3 的细竖笔、带一点衬线弧（curves=1），
    // 不卡这一条它就被当成短竖线收走了——词曲署名里 `Walter` 读成 `Water`、
    // `Gluck` 读成 `Guck`，全书少了 78 个 `l`。
    if (o.curves === 0 && eh / ew >= 2.5 && ew <= noteH * 0.35) {
      // **小节线明显比字高**（实测 13.8 vs 字高 8.3，比值 1.66）。门槛设在 1.15 字高，
      // 正好把拉丁人名里的竖笔（D/l/d，与字等高）挡在外面——那是词曲署名行被误判成
      // 谱行的根因（p300 曾因此多出两个假谱行、40 个假音符）。
      if (h > noteH * 2.5) {
        // **太高的不是小节线，是框的竖边**：这本书的小节线一律 13.8 高（1.66 个字号），
        // 而曲末注解框的竖边有 45 高。不挡住的话，一个框的两条竖边跨度够大，
        // 会被第 2 步凑成一个假谱行——框里那句经文的「106」于是成了音符
        //（004 首因此多出四个音符）。
        set(i, "rule", `竖线太高（${h.toFixed(1)}），是框的竖边`);
      } else if (h >= noteH * 1.15) {
        barlineIdx.push(i);
        set(i, "barline", `细高竖线 ${w.toFixed(1)}×${h.toFixed(1)}`);
      } else {
        shortBarIdx.push(i); // 短竖线：房号括线脚/三连音括线脚，等谱行定了再判
      }
    } else if (ew / eh >= 2.5 && eh <= Math.max(2.5, noteH * 0.3)) {
      hLineIdx.push(i); // 减时线/增时线/通栏线，等谱行定了再分
    } else if (w > noteH * 3 && h > noteH * 1.5) {
      frames.push(o.bbox);
      set(i, "frame", `矩形框 ${w.toFixed(0)}×${h.toFixed(0)}${o.dash ? "（虚线）" : ""}`);
    }
  }

  // ── 2. 谱行带：小节线的 y 区间聚类
  const bands: StaffBand[] = [];
  {
    const bars = barlineIdx.map((i) => objs[i].bbox).sort((a, b) => cy(a) - cy(b));
    for (const b of bars) {
      const last = bands[bands.length - 1];
      if (last && overlap1d(last.top, last.bottom, b.y, bottom(b)) > Math.min(last.bottom - last.top, b.h) * 0.4) {
        last.top = Math.min(last.top, b.y);
        last.bottom = Math.max(last.bottom, bottom(b));
        last.x0 = Math.min(last.x0, b.x);
        last.x1 = Math.max(last.x1, right(b));
        last.barlineXs.push(cx(b));
      } else {
        bands.push({
          index: bands.length,
          top: b.y,
          bottom: bottom(b),
          noteTop: b.y,
          noteBottom: bottom(b),
          x0: b.x,
          x1: right(b),
          barlineXs: [cx(b)],
          noteCount: 0,
        });
      }
    }
    // **谱行的小节线要成规模**：至少两条、且横向跨度可观，或者干脆四条以上。
    // 不加这条会把词曲署名行判成谱行——拉丁人名里的竖笔（D/l/d）像小节线，
    // 生卒年份（1851-1920）像音符（实测 p300 因此多出两个假谱行、40 个假音符）。
    const minSpan = profile.contentBox.w * 0.12;
    // 音符大小的字形：末行那种「只有一小节」的谱行靠它救回来（判据同第 3 步）
    const noteSized = (b: Rect) => b.h >= noteH * 0.75 && b.h <= noteH * 1.3 && b.w <= noteH * 1.1;
    const keep = bands.filter((b) => {
      if (b.barlineXs.length >= 3) return true;
      const span = Math.max(...b.barlineXs) - Math.min(...b.barlineXs);
      if (span >= minSpan) return true;
      // **末行常常只有一小节**：一个音符 + 一条终止线（001 首末行就是 `1 - - -‖`），
      // 整带只有紧挨的两条复纵线，跨度到不了门槛。但它**带着音符**，署名行没有——
      // 署名里的竖笔够不上 1.15 字高，第 1 步就挡掉了，压根进不了这里。
      // 不救的话，那一行的音符与和弦会被当成歌词，报成「GT 有 PDF 无」。
      return objs.some((o, i) => {
        if (out[i].cls !== "unclassified" || !noteSized(o.bbox)) return false;
        const c = cy(o.bbox);
        return c >= b.top && c <= b.bottom;
      });
    });
    if (keep.length !== bands.length) {
      // 被淘汰的带里那些「小节线」退回待定，交给后面的文字判据
      const kept = new Set(keep);
      for (const i of barlineIdx) {
        const b = objs[i].bbox;
        if (!keep.some((k) => overlap1d(k.top, k.bottom, b.y, bottom(b)) > 0)) {
          out[i].cls = "unclassified";
          out[i].why = "";
        }
      }
      bands.length = 0;
      for (const b of keep) if (kept.has(b)) bands.push(b);
    }
    bands.forEach((b, i) => {
      b.index = i;
      b.barlineXs.sort((a, c) => a - c);
    });
  }

  const bandOf = (r: Rect, slackAbove: number, slackBelow: number): number => {
    for (const b of bands) if (bottom(r) >= b.top - slackAbove && r.y <= b.bottom + slackBelow) return b.index;
    return -1;
  };

  // ── 2b. **通栏双线框**：曲末的经文/注记有时不用花边围，而是上下各画一道通栏横线
  //       （实测 p36 是 y475/478 与 y520/522 两对，中间夹着「神的慈爱永远长存 诗(106:1)」）。
  //       框里的东西一律只当注解正文，跟花边框一个待遇——不然那句经文里的「106」
  //       会被当成音符混进音符序列（004 首因此多出四个音符）。
  //       判据：两条通栏横线之间**不夹谱行**、间距不超过八个字高。
  {
    // 同一种纹样密排成的**上下两条边**也算框（p479 的注解框只有上下两边、纹样是「十」字，
    // 没有竖边，`detectOrnamentFrames` 那套「要一横一竖」认不出来）。
    // **只在这里标 storyText，不注册成花边框**：注册进去的话，版面规格会为它多出一个
    // 框对象与一套「框内文字」，重排时和正文那条路径重复画（实测目录页多出几百个对象）。
    // **只在乐谱页上认**：目录/索引页整页都是同形状的引导点行，两两一配就能圈住半页条目
    // （实测那样会把七千个对象误收成注解正文）。乐谱页有谱行，目录页没有。
    // 框内的东西**不止「未定类的带曲线单字」**：
    //  - 整行合成一个 path 的（第 0 步已定成 textLine）也是框里的正文（408 首那句
    //    「《快乐日》…的曲调是林伯特…」，`快乐日` 三个字就是一个合成对象）；
    //  - `《`『」』这类全直笔的标点 curves=0，照 curves 卡会漏掉。
    // 结构线（减时线/增时线/通栏线，这会儿还没定案）仍要放过——它们又扁又平，按高度挡。
    const inBoxText = (i: number) =>
      (out[i].cls === "unclassified" || out[i].cls === "textLine") && (objs[i].curves >= 1 || objs[i].bbox.h > noteH * 0.3);
    const tileRows = new Map<string, { key: string; y: number; x0: number; x1: number; idx: number[] }[]>();
    for (let i = 0; bands.length && i < objs.length; i++) {
      if (out[i].cls !== "unclassified") continue;
      const b = objs[i].bbox;
      if (b.w > noteH * 1.6 || b.h > noteH * 1.6) continue;
      const k = coarseKey(objs[i]);
      const rows = tileRows.get(k) ?? [];
      const row = rows.find((r) => Math.abs(r.y - cy(b)) <= noteH * 0.4);
      if (row) {
        row.x0 = Math.min(row.x0, b.x);
        row.x1 = Math.max(row.x1, right(b));
        row.idx.push(i);
      } else rows.push({ key: k, y: cy(b), x0: b.x, x1: right(b), idx: [i] });
      tileRows.set(k, rows);
    }
    for (const rows of tileRows.values()) {
      const edges = rows.filter((r) => r.idx.length >= 8 && r.x1 - r.x0 > profile.contentBox.w * 0.3).sort((a, b) => a.y - b.y);
      for (let a = 0; a + 1 < edges.length; a++) {
        const t = edges[a];
        const b2 = edges[a + 1];
        if (b2.y - t.y < lyricH * 2.5 || b2.y - t.y > lyricH * 30) continue;
        if (bands.some((bd) => bd.top < b2.y && bd.bottom > t.y)) continue;
        // **边本身也要定案**：不定案的话，那一排纹样后面会被当成一整行歌词
        //（408 首因此多出一段 28 个「十」的「歌词」）。
        for (const i of [...t.idx, ...b2.idx]) set(i, "ornament", "注解框的纹样边");
        for (let i = 0; i < objs.length; i++) {
          if (!inBoxText(i)) continue;
          const bb = objs[i].bbox;
          if (cy(bb) > t.y && cy(bb) < b2.y && right(bb) > t.x0 - lyricH && bb.x < t.x1 + lyricH) set(i, "storyText", "上下两条纹样边之间的注解正文");
        }
      }
    }

    const wide = hLineIdx
      .filter((i) => objs[i].bbox.w > page.width * 0.5)
      .sort((a, b) => cy(objs[a].bbox) - cy(objs[b].bbox));
    for (let a = 0; a < wide.length; a++) {
      for (let b = a + 1; b < wide.length; b++) {
        const y0 = bottom(objs[wide[a]].bbox);
        const y1 = objs[wide[b]].bbox.y;
        const gap = y1 - y0;
        if (gap <= lyricH * 0.5) continue; // 紧挨着的两条是同一道双线
        // 两头各有一条把上下两道通栏线连起来的竖边 = 这是个实打实的矩形框，
        // 框里不可能有谱行。**框里的经文会让第 2 步凑出假谱行**（368 首那个框里
        // 凑出了一个只有 1 个音符的「谱行」），不认框就永远被这道判据挡在外面。
        const hx0 = Math.min(objs[wide[a]].bbox.x, objs[wide[b]].bbox.x);
        const hx1 = Math.max(right(objs[wide[a]].bbox), right(objs[wide[b]].bbox));
        const vAt = (nearX: number) =>
          objs.some((o2, j) => {
            const q = o2.bbox;
            return out[j].cls === "rule" && q.w <= 2 && q.y <= y0 + 2 && bottom(q) >= y1 - 2 && Math.abs(cx(q) - nearX) <= lyricH;
          });
        const boxed = vAt(hx0) && vAt(hx1);
        // 太远、又没有竖边把两条横线连起来，那中间就不是一个框。
        // **有竖边就不卡这个上限**：078 那个框有 7 行经文、100pt 高，
        // 按 8 个歌词行的老上限正好卡在外面，整框的字于是全被当成歌词读了。
        if (!boxed && gap > lyricH * 8) break;
        if (!boxed && bands.some((bd) => bd.top < y1 && bd.bottom > y0)) break; // 中间夹着谱行，那不是框
        for (let i = 0; i < objs.length; i++) {
          if (!inBoxText(i)) continue;
          const bb = objs[i].bbox;
          if (bb.y >= y0 && bottom(bb) <= y1) set(i, "storyText", "通栏双线框内的注解正文");
        }
        break;
      }
    }
  }

  // ── 3. 音符数字
  const noteBoxes: { i: number; box: Rect; row: number }[] = [];
  for (let i = 0; i < objs.length; i++) {
    if (out[i].cls !== "unclassified") continue;
    const o = objs[i];
    const { w, h } = o.bbox;
    if (h < noteH * 0.75 || h > noteH * 1.3 || w > noteH * 1.1) continue;
    const row = bandOf(o.bbox, noteH * 0.35, noteH * 0.35);
    if (row < 0) continue;
    set(i, "note", `谱行 ${row} 内、高 ${h.toFixed(1)}≈字号`);
    out[i].row = row;
    noteBoxes.push({ i, box: o.bbox, row });
    bands[row].noteCount++;
  }
  // 用带内音符统计出真正的基线（小节线比数字高，不能拿它当基线）
  for (const b of bands) {
    const mine = noteBoxes.filter((n) => n.row === b.index);
    if (mine.length) {
      b.noteTop = median(mine.map((n) => n.box.y));
      b.noteBottom = median(mine.map((n) => bottom(n.box)));
    }
  }
  // **同一谱行的音符共一条基线**。小节线（实测 h≈13.8）比数字（8.3）高出一大截，
  // 带内一收就把上方的和弦字母（h≈7.0，正好落在音符的高度区间里）也收成了音符——
  // 实测全书页面音符数中位数比 GT 多 20 个，就是这么来的。
  // 故按带内音符 cy 的中位数二次筛，偏离超过 0.45 字高的退回待定，交给后面的和弦/歌词判据。
  for (const b of bands) {
    const mine = noteBoxes.filter((n) => n.row === b.index);
    if (mine.length < 3) continue;
    const mid = median(mine.map((n) => cy(n.box)));
    for (const n of mine) {
      if (Math.abs(cy(n.box) - mid) > noteH * 0.45) {
        out[n.i].cls = "unclassified";
        out[n.i].row = -1;
        out[n.i].why = "";
        b.noteCount--;
      }
    }
  }
  for (let k = noteBoxes.length - 1; k >= 0; k--) if (out[noteBoxes[k].i].cls !== "note") noteBoxes.splice(k, 1);
  for (const b of bands) {
    const mine = noteBoxes.filter((n) => n.row === b.index);
    if (mine.length) {
      b.noteTop = median(mine.map((n) => n.box.y));
      b.noteBottom = median(mine.map((n) => bottom(n.box)));
    }
  }
  noteBoxes.sort((a, b) => a.box.x - b.box.x);

  // ── 4. 圆点：八度点 / 附点 / 反复点
  const dotMax = Math.max(profile.dotDiam * 1.8, noteH * 0.35);
  // **下限**：印刷的圆点直径极其集中——全书 8810 个八度点里 p5~p95 全是 1.89~1.90
  //（正是 `dotDiam`）。原先只卡上限，于是一批 **0.4×0.4** 的碎点也当成了八度点：
  // 它们成对出现在音符上方 6.5~8 pt 处（真点只贴 0.7~2.6），全书 175 个，
  // 169/429/028 那几首的「GT 无点 / PDF 高音点」几乎全是它们。
  // 定在半个 dotDiam：真点 1.89 稳过，碎点 0.4 挡住（`augmentDot` 8060 个里只有 1 个 < 1.0）。
  const dotMin = profile.dotDiam * 0.5;
  for (let i = 0; i < objs.length; i++) {
    if (out[i].cls !== "unclassified") continue;
    const o = objs[i];
    const { w, h } = o.bbox;
    if (w > dotMax || h > dotMax) continue;
    if (Math.abs(w - h) / Math.max(w, h) > 0.45) continue;
    // 太小的**当场定成版面记号**，不能只是 `continue`：放着不管它们会落进后面的
    // 和弦带判据，被当成和弦符号的一部分（p503 一页就有 17 个跑进 `chord`，
    // 全书和弦内容差异因此多出 10 项）。它们是 `segs=5 / curves=0` 的退化短线段，
    // 成对出现在音符上方 6.5~8pt 处，既不是八度点也不是任何内容。
    if (w < dotMin && h < dotMin) {
      set(i, "rule", `碎点 ${w.toFixed(2)}×${h.toFixed(2)}，不足半个 dotDiam`);
      continue;
    }
    let best = -1;
    let bestD = Infinity;
    for (const n of noteBoxes) {
      const d = Math.hypot(cx(o.bbox) - cx(n.box), cy(o.bbox) - cy(n.box));
      if (d < bestD) {
        bestD = d;
        best = n.i;
      }
    }
    if (best < 0 || bestD > noteH * 2.2) continue; // 留给后面的版面带判据
    const nb = objs[best].bbox;
    const dx = cx(o.bbox) - cx(nb);
    const dyTop = nb.y - bottom(o.bbox);
    out[i].row = out[best].row;
    if (Math.abs(dx) <= nb.w * 0.6) set(i, "octaveDot", `与音符同 x（Δx=${dx.toFixed(1)}），在其${dyTop > 0 ? "上" : "下"}方`);
    else if (dx > nb.w * 0.3 && Math.abs(cy(o.bbox) - cy(nb)) < nb.h * 0.6) set(i, "augmentDot", `音符右侧同高`);
    else set(i, "repeatDot", `近音符但既不同 x 也不在右侧`);
  }

  // ── 4b. 短竖线：谱行内的是房号/三连音括线的脚，谱行外的当装饰线
  for (const i of shortBarIdx) {
    if (out[i].cls !== "unclassified") continue;
    const row = bandOf(objs[i].bbox, noteH * 1.8, noteH * 0.4);
    out[i].row = row;
    set(i, row >= 0 ? "bracket" : "rule", `短竖线 h=${objs[i].bbox.h.toFixed(1)}${row >= 0 ? `，谱行 ${row} 附近` : ""}`);
  }

  // ── 5. 横线：减时线 / 增时线 / 通栏分隔线
  for (const i of hLineIdx) {
    if (out[i].cls !== "unclassified") continue;
    const o = objs[i];
    const { w, h } = o.bbox;
    if (w > page.width * 0.5) {
      set(i, "rule", `通栏横线 宽 ${w.toFixed(0)}`);
      continue;
    }
    const row = bandOf(o.bbox, noteH * 0.4, noteH * 1.2);
    if (row < 0) {
      // 找不到所属谱行的横线：只有**宽度恰好一个字宽**的那种才可能是歌词里的「一」，
      // 退回去交给文字判据；其余一律当装饰线定案。
      // 不加这道闸的话，各种短横线退回后会被第 10 步当成歌词字收进去，
      // 把歌词准确率从 89.6% 打到 74.2%。
      set(i, "rule", `谱行外横线 ${w.toFixed(1)}×${h.toFixed(1)}`);
      continue;
    }
    const b = bands[row];
    // 减时线紧贴音符底线下方（一到两层），增时线穿过音符纵向中部。
    // **下界必须卡死**：歌词里的「一」字也是一条扁横线（宽 ≈ 歌词字宽），
    // 落在谱行下方一个字高开外，不卡下界就会被吞成减时线（实测全书漏掉 519 个「一」）。
    if (o.bbox.y >= b.noteBottom - noteH * 0.1 && o.bbox.y <= b.noteBottom + noteH * 0.9) {
      out[i].row = row;
      set(i, "divLine", `音符底线下方 ${(o.bbox.y - b.noteBottom).toFixed(1)}，减时线`);
    } else if (o.bbox.y < b.noteBottom - noteH * 0.1 && bottom(o.bbox) > b.noteTop) {
      out[i].row = row;
      set(i, "augmentLine", `与音符同高，增时线`);
    }
    // 其余退回待定：多半是歌词里的「一」，交给后面的文字判据
  }

  // ── 6. 弧线：宽扁、且**段数少**（整行文字已在第 0 步摘走，这里再加一道 segs 上限兜底）
  const pendingYi: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    if (out[i].cls !== "unclassified") continue;
    const o = objs[i];
    const { w, h } = o.bbox;
    if (o.curves < 1 || o.segs > 12) continue;
    if (w >= noteH * 0.8 && w / Math.max(h, 0.01) >= 2.2 && h <= noteH * 1.1) {
      // 歌词里的「一」字也是宽扁带曲线的东西（宋体起笔顿角），会被吞成圆滑线。
      // 拿 GT 的上下文回查过：它的字形恒定是 10.4×1.0（curves=4, fill），
      // **和跨一个音符的短圆滑线尺寸完全一样**——只按尺寸放行会把真圆滑线一起放走，
      // 那一版把歌词准确率从 86.9% 打到 72.7%。
      // 真正分得开的是**位置**：圆滑线画在音符**上方**，歌词「一」在音符**下方**的歌词带里。
      if (h <= 2.6 && w >= lyricH * 0.7 && w <= lyricH * 1.35) {
        pendingYi.push(i); // 缓一步：等歌词都归好类，看它有没有同基线的邻居再定
        continue;
      }
      out[i].row = bandOf(o.bbox, noteH * 1.6, noteH * 0.4);
      set(i, "slur", `宽扁弧 ${w.toFixed(0)}×${h.toFixed(1)}，段数 ${o.segs}`);
    }
  }

  // ── 8. 版面带：页脚 / 标题 / 曲号 / 页眉分类
  //     页脚按**本页**最底部那一小撮判（全局带位在内容多的页会误伤末行歌词）
  const pageFooterY = (() => {
    // 页脚（页码）**按最底下那一撮的样子认**，不按「本页最底部的空隙」，也不拿全书版心下沿当兜底：
    //  - 只找空隙会翻车：前言/目录页行距大，最靠下的那个大空隙可能出现在版心中部，
    //    整块正文会被判成页脚（实测 p30 曾误收 581 个对象）。
    //  - 拿版心下沿（全书 98% 分位）兜底也会翻车：排得满的页，最后一两行歌词本就压在
    //    那条线以下，于是整行被当成页脚（279 首末页因此少了两段各 14 字的歌词）。
    // 页码自己的样子很好认：**孤零零一小撮、字比歌词小、与上一行隔着一行以上**。
    const lines: { cy: number; h: number[] }[] = [];
    for (const o of [...objs].sort((a, b) => cy(a.bbox) - cy(b.bbox))) {
      const last = lines[lines.length - 1];
      if (last && cy(o.bbox) - last.cy <= lyricH * 0.6) last.h.push(o.bbox.h);
      else lines.push({ cy: cy(o.bbox), h: [o.bbox.h] });
    }
    const bottom2 = lines[lines.length - 1];
    const above = lines[lines.length - 2];
    if (!bottom2 || !above) return Infinity;
    if (bottom2.h.length > 12) return Infinity; // 一大片，那是正文不是页码
    if (bottom2.cy - above.cy <= lyricH * 1.2) return Infinity; // 贴着正文，不是单起一带
    if (median(bottom2.h) > noteH * 1.05) return Infinity; // 页码用小字号，歌词字比它大一截
    return bottom2.cy - lyricH * 0.5;
  })();
  // 页码还有一条**按样子认**的路，与上面那条「按空隙认」并行（哪条认出来都算）：
  // 全书的页码一律是**两个小圆点夹着两三个数字**（`·259·`），孤零零印在版心最底下，
  // 跨度只有二十来点。空隙那条判据挡不住末行歌词的标点掉到页码那一带——一掉下来，
  // 「与上一行隔着一行以上」就不成立，整个页码跟着漏进歌词（215 首的页码因此成了
  // 歌词里的一处「未识别」）。点是版式的一部分，跟着数字走，比空隙可靠。
  const footerIdx = new Set<number>();
  {
    const order = objs.map((_, i) => i).sort((a, b) => cy(objs[a].bbox) - cy(objs[b].bbox));
    const lines: number[][] = [];
    for (const i of order) {
      const last = lines[lines.length - 1];
      if (last && cy(objs[i].bbox) - cy(objs[last[0]].bbox) <= lyricH * 0.6) last.push(i);
      else lines.push([i]);
    }
    const ln = lines[lines.length - 1];
    if (ln && ln.length >= 3 && ln.length <= 10) {
      const bs = ln.map((i) => objs[i].bbox).sort((a, b) => a.x - b.x);
      const tiny = (q: Rect) => q.w <= profile.dotDiam * 1.6 && q.h <= profile.dotDiam * 1.6;
      const span = right(bs[bs.length - 1]) - bs[0].x;
      if (span <= lyricH * 4 && tiny(bs[0]) && tiny(bs[bs.length - 1]) && median(bs.map((q) => q.h)) <= noteH * 1.05)
        for (const i of ln) footerIdx.add(i);
    }
  }
  const titleH = lyricH * 1.25;
  const headerPending: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    // 标题与曲号也可能整行合成一个 path（第 0 步会先把它们记成 textLine），
    // 所以这一步允许改判 textLine——实测 p474 的标题、p383 的三位曲号都是合成的。
    if (out[i].cls !== "unclassified" && !(out[i].cls === "textLine" && objs[i].bbox.h >= titleH)) continue;
    const o = objs[i];
    const b = o.bbox;
    if (cy(b) >= pageFooterY || footerIdx.has(i)) {
      set(i, "footer", footerIdx.has(i) ? "版心最底下、两个小点夹着数字，是页码" : "本页最底部、与正文有明显空隙");
      continue;
    }
    // 细长条（宽只有高的十分之一）不是字，是装饰线——标题带里混着它们，
    // 会被当成标题的一部分（实测 33 首的识别标题以它们开头）。
    if (b.h >= titleH && b.w / Math.max(b.h, 0.1) < 0.12) {
      set(i, "rule", `标题带里的细长条 ${b.w.toFixed(1)}×${b.h.toFixed(1)}`);
      continue;
    }
    if (b.h >= titleH) {
      set(i, "title", `大字号 h=${b.h.toFixed(1)}`);
      continue;
    }
    if (profile.headerBand && cy(b) <= profile.headerBand[1]) {
      // **续页第一谱行的和弦带就落在页眉带里**：接排的曲子这一页没有标题，头一行谱
      // 顶到 y≈97，它上方那排和弦（y≈86~91）正好压在全书统计出的页眉带下沿上。
      // 定成 category 之后第 10 步再也够不着，那一整行和弦就全没了
      //（054 首页 87 少 5 个、136 首页 177 少 5 个；136 那行更刁——大写字母的中心
      //  卡在带内、小写 `m` 的中心卡在带外，同一个和弦被劈成两半）。
      // 页眉分类词离头一行谱远得很（054 页 87 / 136 页 177 / 169 页 211 都是 33~38 点，
      // 合四个多字高），和弦只隔一个字高；房号括线顶着的那排和弦也不过 14 点（1.8 字高），
      // 所以门槛取 3.2 个字高，两者分得开。
      if (!bands.some((bd) => bd.noteTop >= bottom(b) && bd.noteTop - bottom(b) < noteH * 3.2)) {
        // **先记下、别定案**：标题里的扁字（「心」「一」「么」）够不着大字号门槛，
        // 却与页眉分类词同在这一带，直接定成 category 就永远回不到标题里去
        //（「耶和华的心」少了「心」，全书这样的缺字上百处）。等 8b 认完标题行再说。
        headerPending.push(i);
        continue;
      }
    }
  }

  // ── 8b. 标题里的标点。「，」「！」只占字格的一小块，够不着大字号门槛，
  //       但它们在谱面上就是标题的一部分，漏了标题就永远对不齐 GT。
  //       判据：与已认出的标题字同一行、且横向落在标题的范围内。
  {
    // **必须按标题行分组来收**，不能拿整页标题的 y 包络当带位：一页上常印着两首歌
    // （下半页起新曲），两个标题一上一下，包络一取就是整页——中间的歌词、音符会被
    // 整片收成「标题里的标点」（实测 p606 的 75 个标题对象里 69 个是这么来的，
    // J/D 那十首附录曲的标题因此全成了满页乱码，歌词也跟着少一片）。
    const titles = out.filter((c) => c.cls === "title" && !c.dup).map((c) => c.obj.bbox);
    const lines: Rect[][] = [];
    for (const b of [...titles].sort((a, b) => a.y - b.y)) {
      const last = lines[lines.length - 1];
      // 同一行：与已归入这行的字在纵向上有重叠（标题字大小不一，按中心距会分不开）
      if (last && b.y < Math.max(...last.map(bottom))) last.push(b);
      else lines.push([b]);
    }
    for (const ln of lines) {
      // **收一轮不够，要收到收不动为止**：标题的横向范围是拿「已认出的标题字」算的，
      // 而末尾连着两个够不着大字号门槛的字时（「必有一日」的 `一` 和 `日`），
      // 第一轮只够得着 `一`，`日` 在一轮制下永远收不进来。
      // 空当也要按**标题字号**量，不能按歌词字号：`日` 的墨迹只有 9.5 宽（同行的
      // `必` 有 17.1），字窄墨迹就离得远，`一` 与 `日` 的墨迹间距 10.9——按歌词
      // 字号那 10.4 差半点就够不着；只有两个字的标题字距还拉得开（233 首「主日」
      // 两字的墨迹间距 20.8），所以量到 1.8 个标题字号。放宽不怕误收页眉分类词——
      // 真正把它们挡住的是下面那道「外侧紧不紧跟着同伙」。
      // 233/247/449 三首的标题都是这么少了个「日」。
      const mem = [...ln];
      for (let pass = 0; pass < 8; pass++) {
        const ty0 = Math.min(...mem.map((b) => b.y));
        const ty1 = Math.max(...mem.map(bottom));
        const tx0 = Math.min(...mem.map((b) => b.x));
        const tx1 = Math.max(...mem.map(right));
        let added = false;
        for (let i = 0; i < objs.length; i++) {
          if (out[i].cls !== "unclassified") continue;
          const b = objs[i].bbox;
          if (b.y < ty0 - 2 || bottom(b) > ty1 + 2) continue;
          if (right(b) < tx0 - titleH * 1.8 || b.x > tx1 + titleH * 1.8) continue;
        // **标题外侧的字要看它是不是页眉分类词**：分类词（「敬拜 赞美」）紧挨在标题右边，
        // 离标题末字只差七八个点，与标题末尾那些够不着大字号门槛的扁字（「心」「一」）
        // 一样近——按距离、按字号都分不开（试过按字号切：标题 99.2% → 98.0%）。
        // 分得开的是**它右边还有没有同伙**：分类词是一小串小字，一路排到版心右边缘；
        // 标题的末字右边什么都没有（曲号是大字，不算同伙）。
          if (b.x > tx1 || right(b) < tx0) {
            // 分得开的是**它外侧紧不紧跟着同伙**：分类词是一小串小字挨着排（间距一两个点），
            // 标题末尾那个扁字外侧要么什么都没有，要么隔着老远才是分类词（058 首隔了 71 点）。
            // **两侧都要查**：分类词也印在标题左边（J08 首的「短歌 / 歌文」），
            // 只查右侧的话，收到收不动为止那一轮会顺着它们一个个往左啃过去。
            const outward = b.x > tx1 ? 1 : -1;
            const tight = objs.some((o2, j) => {
              if (j === i || out[j].dup) return false;
              const q = o2.bbox;
              if (q.h >= titleH) return false; // 大字（曲号）不算同伙
              if (q.y < ty0 - 2 || bottom(q) > ty1 + 2) return false;
              // 门槛量到一个字宽：页眉分类词「基督」两字的墨迹间距 8.5，卡在 0.8 个
              // 字高（8.3）上差一点点，于是整个词又被当成标题收了进去（079/165 首）。
              // 放宽不怕误收标题末字：真分类词离标题远着呢（058 首隔了 71 点）。
              const gap = outward > 0 ? q.x - right(b) : b.x - right(q);
              return gap >= -1 && gap <= lyricH;
            });
            if (tight) continue;
          }
          set(i, "title", `标题行内的标点 ${b.w.toFixed(1)}×${b.h.toFixed(1)}`);
          mem.push(b);
          added = true;
        }
        if (!added) break;
      }
    }
  }

  // ── 8c. 页眉分类词。两条来源，缺一不可：
  //       - 全书统计出的页眉带里、没被标题收走的（原有判据）；
  //       - **y 方向与大标题有重叠的小字**：分类词就印在标题两侧、与标题同高
  //         （「基督」「信徒生活／事奉献身」）。这一条不依赖全书带位，
  //         半页起的曲子、带位不准的页也管用。标题自己的标点已在 8b 收走，
  //         那些落在标题的 x 范围内，不会被这一条误收。
  for (const i of headerPending) if (out[i].cls === "unclassified") set(i, "category", "页眉带");
  {
    const tRows = out
      .filter((c) => c.cls === "title" && !c.dup)
      .map((c) => c.obj.bbox)
      .filter((b) => b.h >= titleH);
    for (let i = 0; i < objs.length; i++) {
      if (out[i].cls !== "unclassified") continue;
      const b = objs[i].bbox;
      if (b.h >= titleH) continue;
      if (!tRows.some((t) => b.y < bottom(t) && bottom(b) > t.y)) continue;
      set(i, "category", "与大标题同高的小字，是页眉分类词");
    }
  }

  // ── 8d. 大字号里再把**曲号**摘出来。曲号与标题同在标题带、同属大字号，
  //       曲号贴版心左右边缘（对开页左右交替），标题居中。
  //       但不能**逐字**按「贴不贴边」判：长标题的头尾两个字本来就压到了 15%/85% 的边上，
  //       于是「万福源头」少了「万」、「耶和华的心」少了「心」（全书 172 项标题缺字里
  //       这是最大的一撮）。曲号真正的特征是**孤零零一撮**——与标题之间隔着一大段空白。
  //       所以先按 x 串成撮，只有「贴边 + 不是最长的那撮 + 撮里不超过四个字」才是曲号。
  //       **要排在 8b 之后**：标题里的扁字（「心」）是 8b 才认出来的，
  //       少了它标题就断成两撮，反而是三位曲号成了「最长的一撮」（p386 的 330）。
  {
    const lines: number[][] = [];
    const titleIdx: number[] = [];
    for (let i = 0; i < objs.length; i++) if (out[i].cls === "title" && !out[i].dup) titleIdx.push(i);
    for (const i of titleIdx.sort((a, b) => objs[a].bbox.y - objs[b].bbox.y)) {
      const last = lines[lines.length - 1];
      if (last && objs[i].bbox.y < Math.max(...last.map((j) => bottom(objs[j].bbox)))) last.push(i);
      else lines.push([i]);
    }
    for (const ln of lines) {
      const runs: number[][] = [];
      for (const i of ln.slice().sort((a, b) => objs[a].bbox.x - objs[b].bbox.x)) {
        const last = runs[runs.length - 1];
        const prev = last ? objs[last[last.length - 1]].bbox : null;
        if (prev && objs[i].bbox.x - right(prev) <= titleH * 1.2) last.push(i);
        else runs.push([i]);
      }
      if (runs.length < 2) continue; // 只有一撮：整行都是标题
      // 曲号最多四个字形（`J07`、`082A`），标题一撮至少五个——只摘短的那撮。
      const longest = runs.reduce((a, b) => (b.length > a.length ? b : a), runs[0]);
      for (const run of runs) {
        if (run === longest || run.length > 4) continue;
        const x0 = Math.min(...run.map((i) => objs[i].bbox.x));
        const x1 = Math.max(...run.map((i) => right(objs[i].bbox)));
        const nearLeft = x0 < profile.contentBox.x + profile.contentBox.w * 0.15;
        const nearRight = x1 > profile.contentBox.x + profile.contentBox.w * 0.85;
        if (nearLeft || nearRight) for (const i of run) set(i, "songNumber", `大字号、孤立成撮、${nearLeft ? "贴左" : "贴右"}`);
      }
    }
  }


  // ── 9. 框内正文
  const boxes = [...frames, ...ornaments.map((o) => o.box)];
  for (let i = 0; i < objs.length; i++) {
    if (out[i].cls !== "unclassified") continue;
    for (const f of boxes) {
      if (intersectRect(objs[i].bbox, f)) {
        set(i, "textLine", "落在框内");
        break;
      }
    }
  }

  // ── 10. 剩余的字：看它离**上方谱行的底**近还是离**下方谱行的顶**近。
  //        「一」候选要跳过——它们在 10c 单独裁定，混进这里会连同真圆滑线一起变成歌词。
  const pendingSet = new Set(pendingYi);
  //      和弦印在谱行正上方（一个字高以内）；歌词在谱行下方 1~3 字高。
  //
  //      **大字标题把两首歌隔开**：半页起的曲子，它的调号、词曲署名夹在上一首的末行谱
  //      与本首第一谱行之间，离上一行谱更近，于是被判成上一首的歌词
  //      （102 首的署名一个字都读不出；调号拍号当年也栽在这儿，10e/10f 里另有兜底）。
  //      隔着一条标题就不可能是上一首的东西——把「上方那一行谱」这个选项直接掐掉。
  const titleBoxes = out.filter((c) => c.cls === "title" && !c.dup).map((c) => c.obj.bbox);
  for (let i = 0; i < objs.length; i++) {
    // `textLine`（一整行文字合成一个 path）也要在这里分：它就是一行字，
    // 只是没拆成单字。**OCR 兜底把整行的文本补进字典之后**，它能像别的字一样参与比对
    // （016 首的词曲署名就是这么一个对象，不放进来就永远读不出）。
    if ((out[i].cls !== "unclassified" && out[i].cls !== "textLine") || pendingSet.has(i)) continue;
    const o = objs[i];
    const b = o.bbox;
    let above = -1;
    let below = -1;
    let dAbove = Infinity;
    let dBelow = Infinity;
    for (const bd of bands) {
      if (bottom(b) <= bd.noteTop + noteH * 0.2) {
        const d = bd.noteTop - bottom(b);
        if (d < dBelow) {
          dBelow = d;
          below = bd.index;
        }
      }
      if (b.y >= bd.noteBottom - noteH * 0.2) {
        const d = b.y - bd.noteBottom;
        // 两者之间夹着标题 = 这一行谱是上一首的，不能算
        if (titleBoxes.some((t) => t.y >= bd.noteBottom && bottom(t) <= b.y)) continue;
        if (d < dAbove) {
          dAbove = d;
          above = bd.index;
        }
      }
    }
    // 谱行之间的那一带既可能是上一行的歌词，也可能是下一行的和弦。
    // 除了比上下距离，还要看**形状**：和弦是拉丁窄字（宽高比明显小于 1），
    // 歌词是近方的汉字。只比距离时，行距紧的页面会把和弦判进上一行的歌词。
    const narrow = b.w / Math.max(b.h, 0.1) < 0.82;
    // **和弦是音符那号字，歌词字比它大一截**：`A`（6.4×7.1）不窄，却明明白白是和弦。
    // 谱行之间夹着 `rit.` 之类的表情记号时，那几个和弦被整个顶上去（321 首顶到 15.8，
    // 常规只有 7~8），按 1.6 个字高卡就够不着，`Am` 于是掉成了上一行的歌词。
    // 门槛照**音符字号**划，不照歌词字号：和弦字母高 6.2~8.7，汉字再窄也有 9 往上
    //（`日` 7.1×9.2、`白` 8.7×10.8、`五` 9.4），按歌词字号的 0.85 划会把它们一并吸走
    //（353 首的歌词少了个「五」）。
    const small = b.h <= noteH * 1.05;
    // **和弦带里宽扁带曲线的东西是短圆滑线，不是和弦**：和弦的字形没有比自己高还宽的
    //（字母 6×7、`♭` 2.6×4.2、`/` 3×7.3），短弧却是 7.3×3.4。它卡在第 6 步弧线判据的
    // 宽高比门槛（2.2）外面一点点，落到这里就成了假和弦（379 首多出三个 `D`）。
    if (o.curves >= 1 && b.w >= noteH * 0.8 && b.w / Math.max(b.h, 0.1) >= 1.6 && b.h <= noteH * 0.5) {
      out[i].row = bandOf(b, noteH * 1.6, noteH * 0.4);
      set(i, "slur", `和弦带里的宽扁弧 ${b.w.toFixed(1)}×${b.h.toFixed(1)}`);
      continue;
    }
    // **倚音**：小号数字，**底下紧跟着一两条与它同宽的短横**（减时线）。
    // 它是实打实的音符，GT 的 musicxml 记作 `<grace>`，漏掉音符序列就少一个
    //（260 首少 5 个、264 首少 2 个）。光按尺寸认不行——三连音的 `3`、变拍号的数字
    // 与倚音的字号完全重叠（都是 4.8~5.5 高），试过只按尺寸收，音符 27→70 项差异。
    // 那条短横才是分得开的地方：
    //  - 变拍号的分数线比数字宽一大截（9.1 对 3.7），按「与数字同宽」挡掉；
    //  - 三连音的 `3` 与房号数字底下没有这样一条横。
    if (below >= 0 && dBelow < noteH * 1.6 && b.h >= noteH * 0.5 && b.h <= noteH * 0.75 && b.w <= noteH * 0.6) {
      const beamed = objs.some((o2, j) => {
        if (j === i) return false;
        const q = o2.bbox;
        if (q.h > 1 || q.w > b.w * 1.8 || q.w < b.w * 0.6) return false;
        if (Math.abs(cx(q) - cx(b)) > noteH * 0.3) return false;
        return q.y >= bottom(b) - 1 && q.y <= bottom(b) + noteH * 0.9;
      });
      if (beamed) {
        out[i].row = below;
        set(i, "note", `谱行 ${below} 上方 ${dBelow.toFixed(1)} 的小号数字带减时线，倚音`);
        continue;
      }
    }
    // **和弦不会是满格汉字**：和弦是拉丁窄字，字高只有音符那号（7 上下）。
    // 一行歌词那号字的方块字落在两谱行之间时，按距离会判给下面那行的和弦带——
    // 022 首的第 2 段就整段印在下一谱行上方，于是整段歌词没了。它属于**上面**那行谱。
    // 「歌词那号字」按**绝对尺寸**认，不按宽高比：`日`（7.1×9.2）、`白`（8.7×10.8）
    // 这些字本来就窄，按比例判会漏掉，它们于是掉进下一行的和弦带、歌词里少一个字。
    // 和弦字母只有 7 高上下，够不着这个门槛。
    if (above >= 0 && b.h >= lyricH * 0.85 && b.w >= lyricH * 0.6) {
      out[i].row = above;
      set(i, "lyric", `谱行 ${above} 下方 ${dAbove.toFixed(1)} 的满格汉字`);
      continue;
    }
    // 距离门槛按**字形像不像和弦**放宽：和弦字母就音符那么高（6.2~8.7）、不比自己宽。
    // 房号（一房二房）的括线会把那一行的和弦整排顶高一倍（164 首顶到 20 点，
    // 常规只有 7~8），按 1.6 个字高卡就够不着，那四个和弦全掉成了歌词。
    // 距离门槛只在**中间隔着房号括线**时放宽：一房二房的括线会把那一行的和弦整排顶高
    // 一倍（164 首顶到 20 点，常规只有 7~8），按 1.6 个字高卡就够不着，那四个和弦
    // 全掉成了歌词。不能无条件放宽——放宽到 3 个字高时，歌词行首的段号数字
    // （窄、又正好一个音符高）会被下一行的和弦带吸走，段号一丢整叠段序就乱（歌词 99.2%→97.8%）。
    const voltaBelow =
      below >= 0 &&
      out.some(
        (c, j) =>
          (c.cls === "bracket" || c.cls === "rule") &&
          !c.dup &&
          objs[j].bbox.y >= bottom(b) &&
          bottom(objs[j].bbox) <= bands[below].noteTop + noteH * 0.2 &&
          right(objs[j].bbox) > b.x - noteH &&
          objs[j].bbox.x < right(b) + noteH,
      );
    // 放宽还要再加一道：这一行上**没有汉字**才行。歌词行首的段号也是又窄又矮，
    // 它旁边紧跟着汉字，一看就知道那是歌词行不是和弦行。
    const hanOnLine =
      voltaBelow &&
      objs.some((o2, j) => {
        if (j === i || out[j].dup) return false;
        const q = o2.bbox;
        return q.h >= lyricH * 0.85 && q.w >= lyricH * 0.6 && Math.abs(bottom(q) - bottom(b)) <= 3 && Math.abs(cx(q) - cx(b)) <= lyricH * 8;
      });
    const chordish = below >= 0 && dBelow < noteH * (voltaBelow && !hanOnLine ? 3.0 : narrow || small ? 2.4 : 1.6);
    // 整行合成的 path 只在**谱行上方**这一侧参与（署名、经文都印在那儿）。
    // 让它也去当歌词行反而更糟：一整行歌词是一个对象，归段/折行那套按字数算的判据
    // 全失灵（实测歌词 98.29% → 98.17%，剔掉的非歌词对象从 1296 涨到 4031）。
    // 上方这一侧的门槛要放宽到几个字高——署名印在第一谱行上方三四个字高处，
    // 按和弦那 1.6 字高的门槛够不着。
    if (out[i].cls === "textLine") {
      if (below >= 0 && dBelow <= dAbove && dBelow < noteH * 5) {
        out[i].row = below;
        set(i, "chord", `谱行 ${below} 上方 ${dBelow.toFixed(1)} 的整行文字`);
      }
      continue;
    }
    // 「窄字优先判和弦」这条要有个度：`日` `白` `曲` 这些字本来就窄（7.1×9.2），
    // 离上一行谱明明近一半，却因为窄被判进下一行的和弦带，歌词里就少了那个字。
    if (chordish && (dBelow <= dAbove || ((narrow || small) && dBelow <= dAbove * 1.5))) {
      out[i].row = below;
      set(i, "chord", `谱行 ${below} 上方 ${dBelow.toFixed(1)}${narrow ? "，窄字" : small ? "，小字" : ""}`);
    } else if (above >= 0) {
      out[i].row = above;
      set(i, "lyric", `谱行 ${above} 下方 ${dAbove.toFixed(1)}`);
    } else if (below >= 0) {
      out[i].row = below;
      set(i, "chord", `谱行 ${below} 上方 ${dBelow.toFixed(1)}`);
    }
  }

  // ── 10a2. 和弦是**成排印的**，同一谱行上方的一排和弦共一条基线。
  //         第 10 步只按「离上下哪一行谱近」加一条「窄不窄」来判，谱行之间夹着东西
  //         （变拍号、三连音括线）把整排和弦顶高时，这一排里窄的（`C` 5.3×7.3）过了
  //         2.4 字高那道松门槛、不窄的（`A` 6.4×7.1、`m` 7.0×4.3）卡在 1.6 上，
  //         同一个 `Am` 就一半判和弦一半判歌词，最后整个和弦都没了（144 首的 `Am`）。
  //         已经认定的那排和弦本身就是最好的凭据：与它们共基线的，也是和弦。
  //         满格汉字除外——它是歌词，判据与第 10 步同一把尺子。
  for (const bd of bands) {
    const bots: number[] = [];
    for (let i = 0; i < objs.length; i++) if (out[i].cls === "chord" && !out[i].dup && out[i].row === bd.index) bots.push(bottom(objs[i].bbox));
    if (bots.length < 2) continue;
    for (let i = 0; i < objs.length; i++) {
      if (out[i].cls !== "lyric" || out[i].dup) continue;
      const b = objs[i].bbox;
      if (bottom(b) > bd.noteTop + noteH * 0.2) continue;
      if (b.h >= lyricH * 0.85 && b.w >= lyricH * 0.6) continue;
      if (bots.filter((y) => Math.abs(y - bottom(b)) <= noteH * 0.25).length < 2) continue;
      // **这一行上有汉字就别动它**：歌词行首的段号（`1.`）又窄又矮，与和弦一样够不着
      // 满格汉字的门槛，而它的基线常与下一行谱的和弦排对得上；把它收成和弦，
      // 归段的锚点就没了，整叠歌词跟着串位（实测 100/446/170 首各多出几十项假差异）。
      // 与第 10 步 `hanOnLine` 同一把尺子：同基线、左右八个字以内有满格汉字。
      if (
        objs.some((o2, j) => {
          if (j === i || out[j].dup) return false;
          const q = o2.bbox;
          return q.h >= lyricH * 0.85 && q.w >= lyricH * 0.6 && Math.abs(bottom(q) - bottom(b)) <= 3 && Math.abs(cx(q) - cx(b)) <= lyricH * 8;
        })
      )
        continue;
      out[i].row = bd.index;
      set(i, "chord", `与谱行 ${bd.index} 上方那排和弦共基线`);
    }
  }

  // ── 10b. 无谱行的纯文字页（目录 / 首句索引 / 前言）：没有谱行可依，按行聚类兜底。
  //        这些页占全书约 60 页，不兜底的话它们的对象会全数落进 unclassified。
  if (!bands.length) {
    for (let i = 0; i < objs.length; i++) {
      if (out[i].cls !== "unclassified") continue;
      const { w, h } = objs[i].bbox;
      // 引导点：目录里 "……" 的那一串小点
      if (w <= profile.dotDiam * 2 && h <= profile.dotDiam * 2) set(i, "leader", "目录引导点");
      else set(i, "tocEntry", "无谱行页的条目文字");
    }
  }

  // ── 10c. 裁定缓下来的「一」候选。
  //        歌词里的「一」在矢量层是 10.4×1.0 的扁横条，**与跨一个音符的短圆滑线尺寸完全一样**，
  //        只按尺寸分会把真圆滑线一起放走（歌词准确率 86.9% → 72.7%）；
  //        只按「在谱行下方多远」也不行，上一行的圆滑线正好落在那个区间里。
  //        真正分得开的是：**「一」嵌在歌词行里，与左右汉字共基线**，圆滑线不会。
  for (const i of pendingYi) {
    if (out[i].cls !== "unclassified") continue;
    const b = objs[i].bbox;
    // 比**字格中心**而不是基线：「一」只有一横、悬在字格中部（h≈1.0），
    // 同行汉字是满格（h≈10.5）贴着基线，两者的下缘差着四五个点，按基线比会全部落空。
    const mid = cy(b);
    let neighbor = 0;
    let neighborRow = -1;
    for (let j = 0; j < objs.length; j++) {
      if (out[j].cls !== "lyric" || out[j].dup) continue;
      const q = objs[j].bbox;
      if (q.h < lyricH * 0.7) continue; // 拿满格的汉字当参照，标点不算
      if (Math.abs(cy(q) - mid) > lyricH * 0.28) continue; // 不在同一行
      const gap = q.x > b.x ? q.x - right(b) : b.x - right(q);
      // 窗口放到 3.5 个字宽：行末那个「一」下面的音符常被拉得很开，与前一个汉字能隔到
      // 两三个字宽（034 首隔了 28 点）。放宽到 2.5/3.5/5/8 实测都一样——真圆滑线是靠
      // 「与汉字共基线」挡住的，不是靠这个窗口；完全一致 441→451 首。
      if (gap <= lyricH * 3.5) {
        neighbor = bottom(q); // 记下参照汉字的下缘，供聚行用
        neighborRow = out[j].row; // 归行也跟着它走（见下）
        break;
      }
    }
    if (neighbor) {
      // 单列一类而不是并进 lyric：它的轮廓（10.4×1.0）在字典里跟减时线等扁横条撞键，
      // 自举投票会被冲散（试过，全书只学出一个「一」，还是标题里的）。
      // 判据已经足够硬（共基线 + 相邻），直接按几何定案，取字时不查字典。
      out[i].cls = "lyricYi";
      out[i].baseline = neighbor;
      out[i].why = `与歌词同行的扁横条 ${b.w.toFixed(1)}×${b.h.toFixed(1)}，是「一」`;
      // **归行跟着参照汉字**，不能用 bandOf：第三、四段歌词离谱行底早超过 4 个字高，
      // bandOf 给不出谱行（-1）。而下游按 row 聚段时 -1 排在所有谱行之前，那个「一」
      // 就被塞进第 1 段的开头（实测全书三分之一的「一」如此，p46/47/48 的第 1 段
      // 都以一个凭空多出的「一」起头）。参照汉字与它同行同段，它的 row 才是对的。
      out[i].row = neighborRow >= 0 ? neighborRow : bandOf(b, noteH * 1.6, noteH * 4);
    } else {
      out[i].cls = "slur";
      out[i].why = `宽扁弧 ${b.w.toFixed(0)}×${b.h.toFixed(1)}（无同基线歌词邻居）`;
      out[i].row = bandOf(b, noteH * 1.6, noteH * 0.4);
    }
  }

  // ── 10e. 把调号拍号从和弦带里摘出来。
  //
  //   「1=F 4/4 (1=D)」跟和弦印在同一带里，里头的 F、D 会被当成和弦塞进序列开头，
  //   让整首的和弦比对从头错位。**别拿位置切**——第一谱行的头一个和弦本来就印在最左，
  //   试过按「右缘在版心左 22% 以内」切，和弦准确率从 80.8% 掉到 66.3%。
  //
  //   分得开的是这两点：**和弦一行有好几个，调号整页只有一处；而调号的音名左边紧挨着等号。**
  //   等号的几何很好认：两条平行横线，实测 5.8×3.3、curves=0——
  //   和弦带里其它没有曲线的字（A、4）高度都是 7~8，差得远。
  //
  //   **半页起的曲子**，调号印在上一首末行歌词与本首第一谱行之间，离上一行谱更近。
  //   这里曾为它开过一道「候选也收 lyric」的口子，后来第 10 步用**大字标题隔开两首**
  //   （标题以下不可能属于上一首）从根上解决了，那道口子就撤了——撤掉之后
  //   调号 97.0%→97.4%、拍号 99.1%→99.6%，可见它自己也在误伤。
  {
    // 等号的**左边必须紧挨着一个窄字**——调号永远写作「1=X」，那个 `1` 宽只有高的四成。
    // 少了这一条，词曲署名里的 `W`（6.2×4.3、curves=0，横平竖直没有一段曲线）会被当成等号，
    // 底下那个「一路往外长」的循环再把半行人名吞成调号（290 首的 `EHewitt(1851-` 整段）。
    const narrowLeftOf = (eb: Rect) =>
      objs.some((o, j) => {
        if (out[j].dup) return false;
        const b = o.bbox;
        if (Math.abs(cy(b) - cy(eb)) > noteH * 0.95) return false;
        const gap = eb.x - right(b);
        return gap >= -0.5 && gap <= noteH * 0.75 && b.w / Math.max(b.h, 0.1) < 0.6;
      });
    const eqs: number[] = [];
    for (let i = 0; i < objs.length; i++) {
      if (out[i].cls !== "chord" || out[i].dup) continue;
      const b = objs[i].bbox;
      const ratio = b.w / Math.max(b.h, 0.1);
      if (objs[i].curves !== 0 || b.h < noteH * 0.28 || b.h > noteH * 0.55 || ratio < 1.3 || ratio > 2.6) continue;
      if (!narrowLeftOf(b)) continue;
      eqs.push(i);
    }
    for (const e of eqs) {
      const eb = objs[e].bbox;
      set(e, "keyMeter", `等号 ${eb.w.toFixed(1)}×${eb.h.toFixed(1)}`);
      // 等号左右紧挨着的就是「1」和音名。**要一路往外长**，不能只看与等号的距离：
      // 替代调「(1=D)」的括号隔着「1」和音名，离等号一个多字距，收不到就留在和弦带里，
      // 还会被自举投成某个字母（实测那个 3.0×10.6 的括号被投成 `E`，
      // 全书和弦序列凭空多出上百个 E，和弦准确率掉 1.5 个点）。
      // 往外长也要有个边：调号拍号连括号一共不过五六个字宽，长过头就是长进署名里了
      const grp = [eb];
      const limit = noteH * 7;
      for (let pass = 0; pass < 4; pass++) {
        let grew = false;
        for (let i = 0; i < objs.length; i++) {
          if (out[i].cls !== "chord" || out[i].dup) continue;
          const b = objs[i].bbox;
          if (Math.abs(cy(b) - cy(eb)) > noteH * 0.95) continue;
          if (Math.abs(cx(b) - cx(eb)) > limit) continue;
          if (!grp.some((q) => Math.min(Math.abs(b.x - right(q)), Math.abs(q.x - right(b))) <= noteH * 0.75)) continue;
          set(i, "keyMeter", `紧挨调号，调号的一部分`);
          grp.push(b);
          grew = true;
        }
        if (!grew) break;
      }
    }
  }

  // ── 10f. 拍号「4/4」：一条短分数线，上下各一个数字。三者一并归 keyMeter。
  //        分数线常被前面的判据当成谱行外的装饰线（rule），所以这里连 rule 一起找。
  {
    for (let i = 0; i < objs.length; i++) {
      if (out[i].cls !== "rule" && out[i].cls !== "chord") continue;
      if (out[i].dup) continue;
      const b = objs[i].bbox;
      // 分数线：扁、短，宽度约一个到两个字宽
      if (b.h > noteH * 0.15 || b.w < noteH * 0.8 || b.w > noteH * 2.4) continue;
      const above: number[] = [];
      const below: number[] = [];
      for (let j = 0; j < objs.length; j++) {
        if (j === i || out[j].dup) continue;
        // 上下必须是和弦带里的字，**不能是音符**——增时线的宽度也落在分数线的区间里，
        // 允许音符的话，一条增时线加上下两个音符就被当成了拍号（实测 p60 误收 7 个对象）。
        if (out[j].cls !== "chord" && out[j].cls !== "keyMeter") continue;
        const q = objs[j].bbox;
        const qcx = q.x + q.w / 2;
        if (qcx < b.x - noteH * 0.3 || qcx > right(b) + noteH * 0.3) continue; // 不在分数线的横向范围内
        const dUp = b.y - bottom(q);
        const dDown = q.y - bottom(b);
        if (dUp >= -1 && dUp < noteH * 0.8) above.push(j);
        else if (dDown >= -1 && dDown < noteH * 0.8) below.push(j);
      }
      if (!above.length || !below.length) continue; // 上下都得有数字才算拍号
      set(i, "keyMeter", `拍号的分数线 ${b.w.toFixed(1)}×${b.h.toFixed(1)}`);
      for (const j of [...above, ...below]) set(j, "keyMeter", `拍号的数字`);
    }
  }

  // ── 10g. 谱行**当中**的转拍号：曲子中途改拍号时，「3/4」直接印在谱行里，
  //         两个数字都比音符小一号（实测 3.7×6.3 对音符的 5.4×8.1），中间一条短横。
  //         不把它摘出来，上面那个数字就当成了音符（403 首多出一个 3）、
  //         下面那个当成了歌词。10f 那条只认和弦带里的拍号，够不着谱行里的这一种：
  //         这里的短横已经被判成增时线、数字已经被判成音符，都不在 10f 的候选里。
  //         判据要紧：上下两个数字**都得比音符矮一截**，否则一条增时线加上下两个
  //         正常音符就成了拍号。
  {
    for (let i = 0; i < objs.length; i++) {
      const cls = out[i].cls;
      if (cls !== "rule" && cls !== "augmentLine" && cls !== "divLine") continue;
      const b = objs[i].bbox;
      if (b.h > noteH * 0.15 || b.w < noteH * 0.8 || b.w > noteH * 2.4) continue;
      const pick = (up: boolean) => {
        const r: number[] = [];
        for (let j = 0; j < objs.length; j++) {
          if (j === i) continue;
          // 和弦（连同它的上标 `m`/`7`）也够得着这个尺寸区间，别把它们收成拍号
          if (out[j].cls === "chord" || out[j].cls === "credit" || out[j].cls === "storyText" || out[j].cls === "title") continue;
          const q = objs[j].bbox;
          if (q.h > noteH * 0.85 || q.h < noteH * 0.5 || q.w > noteH * 0.9) continue; // 比音符矮一截的数字
          const qcx = cx(q);
          if (qcx < b.x - noteH * 0.3 || qcx > right(b) + noteH * 0.3) continue;
          const d = up ? b.y - bottom(q) : q.y - bottom(b);
          if (d >= -1 && d < noteH * 0.5) r.push(j);
        }
        return r;
      };
      const up = pick(true);
      const dn = pick(false);
      if (!up.length || !dn.length) continue;
      set(i, "keyMeter", `谱行内转拍号的分数线 ${b.w.toFixed(1)}×${b.h.toFixed(1)}`);
      for (const j of [...up, ...dn]) set(j, "keyMeter", "谱行内转拍号的数字");
    }
  }

  // ── 11. 标记重复描边：同一字形画了 fill 与 stroke 两遍，bbox 差约一个线宽。
  //        两份都保留（重排核对要逐对象配对），但把后一份标成 dup，下游计数只认非 dup。
  //        **必须查相邻网格**：只查自己那一格会漏掉骑在格边界上的一对
  //        （实测因此漏配了一批，识别出来的音符串里出现成对重复的数字）。
  {
    const CELL = 4;
    const byCell = new Map<string, number[]>();
    for (let i = 0; i < objs.length; i++) {
      const b = objs[i].bbox;
      const k = `${Math.floor(b.x / CELL)},${Math.floor(b.y / CELL)}`;
      const g = byCell.get(k);
      if (g) g.push(i);
      else byCell.set(k, [i]);
    }
    const paired = new Set<number>();
    for (let i = 0; i < objs.length; i++) {
      if (paired.has(i) || out[i].dup) continue;
      const A = objs[i];
      const gx = Math.floor(A.bbox.x / CELL);
      const gy = Math.floor(A.bbox.y / CELL);
      let mate = -1;
      for (let dx = -1; dx <= 1 && mate < 0; dx++) {
        for (let dy = -1; dy <= 1 && mate < 0; dy++) {
          for (const j of byCell.get(`${gx + dx},${gy + dy}`) ?? []) {
            if (j === i || paired.has(j) || out[j].dup) continue;
            const B = objs[j];
            if (out[i].cls !== out[j].cls) continue;
            // 一个 fill 一个 stroke 是常见的那种重复描边；**也有画两遍 fill 的**——
            // 那种两份一模一样（同 bbox、同段数），得按「严丝合缝地重合」认，
            // 不然 003 首那个 `♭B` 会读成 `♭B` + `B`，多出一个和弦。
            const samePaint = A.paint === B.paint;
            if (samePaint && (A.curves !== B.curves || A.segs !== B.segs)) continue;
            const tolp = samePaint ? 0.1 : Math.max(A.lineWidth, B.lineWidth, 0.3) * 2;
            if (
              Math.abs(A.bbox.x - B.bbox.x) <= tolp &&
              Math.abs(A.bbox.y - B.bbox.y) <= tolp &&
              Math.abs(A.bbox.w - B.bbox.w) <= tolp &&
              Math.abs(A.bbox.h - B.bbox.h) <= tolp
            ) {
              mate = j;
              break;
            }
          }
        }
      }
      if (mate < 0) continue;
      // 描边那份算重复（填充那份才是字形本体）
      const aStroke = A.paint.toLowerCase().includes("stroke") && !A.paint.toLowerCase().includes("fill");
      const dupI = aStroke ? i : mate;
      out[dupI].dup = true;
      paired.add(i);
      paired.add(mate);
    }
  }

  // ── 12. 把拆成偏旁的字合回一个字形。
  //        **必须排在「标记重复描边」之后**：那之前每个字都有 fill/stroke 两份几乎重合的对象，
  //        它们的横向间距是负的，会被当成偏旁并掉。
  //        转曲时左右结构的字有时会拆成两个 path（实测标题里的「祂」= 礻 + 也、
  //        歌词里的「像」= 亻 + 象）。拆着查字典只查得到右半边，于是「祂」读成「也」、
  //        「像」读成「象」——那些看着像「GT 与 PDF 用字不同」的差异，其实是这么来的。
  //        判据：同类、同一行（下缘接近）、横向几乎挨着，且**合并后的宽度仍在一个字格内**。
  for (const cls of ["lyric", "title", "tocEntry", "storyText", "category"] as ObjClass[]) {
    const idx = out
      .map((c, i) => ({ c, i }))
      .filter((x) => x.c.cls === cls && !x.c.dup)
      // **按 x 排序**。按下缘排会打乱 x 顺序（同一行里各字的下缘本就差着几个点），
      // 于是相邻两项在横向上可能是反的，gap 算出负值 → 误判成偏旁，一路把整行并成一个
      //（实测把「拥戴祂为王」并成了一个 102.9 宽的对象）。同行与否由下缘差单独判。
      .sort((a, b) => a.c.obj.bbox.x - b.c.obj.bbox.x)
      .map((x) => x.i);
    if (idx.length < 2) continue;
    // 一个字格有多宽：取本类里对象高度的中位数（汉字近方）
    const cell = median(idx.map((i) => objs[i].bbox.h));
    if (!cell) continue;
    let k = 0;
    while (k < idx.length - 1) {
      const a = idx[k];
      const group = [a];
      while (k + 1 < idx.length) {
        const b = idx[k + 1];
        const A = objs[group[group.length - 1]].bbox;
        const B = objs[b].bbox;
        if (Math.abs(bottom(A) - bottom(B)) > cell * 0.25) break; // 不同行
        const gap = B.x - (A.x + A.w);
        if (gap > cell * 0.08) break; // 离得开，是相邻的两个字
        const wide = B.x + B.w - objs[group[0]].bbox.x;
        // 上限 1.55 个字格。左右结构的字本就排得开——实测「祂」的 礻+也 合起来 1.47 个字格；
        // 而挨着的两个整字最少也要 1.74 个（还另有间距判据拦着），留得出余量。
        if (wide > cell * 1.55) break;
        // **必须有一个部件明显窄于字格**：偏旁才窄（「祂」的礻旁只有 0.4 个字宽），
        // 两个挨着的整字都是满格宽。少了这条判据，歌词里相邻的字会被成对并掉——
        // 形状类从 1.6 万炸到 5.1 万，自举只认得出 197 类。
        if (Math.min(A.w, B.w) > cell * 0.55) break;
        // **也必须两个部件都是满格高**：偏旁与它的主体一样高（「祂」的礻旁顶天立地），
        // 而尾随的标点只占字格下部（「，」3.1 高，字格 10.5）——它又窄又矮，
        // 上面那条「窄」的判据拦不住，于是被并进前一个字里，那个合起来的形状
        // 字典里没有，整个字读不出、连带标点也少一个（009 首的「赞，」）。
        if (Math.min(A.h, B.h) < cell * 0.55) break;
        group.push(b);
        k++;
      }
      if (group.length > 1) {
        const merged = concatObjects(group.map((i) => objs[i]));
        objs[group[0]] = merged;
        out[group[0]].obj = merged;
        out[group[0]].why += `（并入 ${group.length - 1} 个偏旁）`;
        for (const j of group.slice(1)) out[j].dup = true;
      }
      k++;
    }
  }


  // ── 13. 和弦带里的**词曲署名**。第一谱行上方那一块「作词 / 作曲 + 英文人名 + 年份」
  //        与和弦同带同高，会被整块读成一串假和弦（023 首因此在序列里多出 `B`、`F9`，
  //        全书 806 项「PDF 有 GT 无」的和弦里这是最大的一撮）。
  //        分得开的是**排布**：和弦是一个个孤立的短记号，彼此隔着大半个小节；
  //        署名是密排的一长串。按 x 把同一谱行的和弦对象串成连续段，段里超过 6 个字的
  //        就不是和弦（最长的和弦记号 `D/#Fm` 也只有 5 个字形）。门槛试过 5/6/8/9，7 最好。
  //        **必须排在最后**：排在调号拍号（10e/10f）之前会把「1=F 4/4」整块判成署名
  //        （调号 93.0% → 14.1%）；排在「标记重复描边」（11）之前则每个字都有 fill/stroke
  //        两份，串长直接翻倍，四个字的和弦也过了 7 的门槛（和弦 88.6% → 86.4%）。
  for (const bd of bands) {
    const idx: number[] = [];
    for (let i = 0; i < objs.length; i++) if (out[i].cls === "chord" && !out[i].dup && out[i].row === bd.index) idx.push(i);
    // **先按基线分行，再按 x 串**。署名是上下两行（作词 / 作曲）交错排的，
    // 按 x 一路扫下去，相邻两个对象常常分属不同的行，「同一条基线」的判定就把串切碎了，
    // 整块署名一个也摘不出来（p79 因此把署名里的 `O` 夹进了 `♭B`，读成 `B`）。
    const lines: number[][] = [];
    for (const i of idx.slice().sort((a, b) => bottom(objs[a].bbox) - bottom(objs[b].bbox))) {
      const last = lines[lines.length - 1];
      if (last && bottom(objs[i].bbox) - bottom(objs[last[last.length - 1]].bbox) <= noteH * 0.35) last.push(i);
      else lines.push([i]);
    }
    // 这一谱行的和弦基线（最靠下、≥3 个共线的那一撮），判据与 15 同一套。
    let chordBase = -Infinity;
    for (const i of idx) {
      const b = bottom(objs[i].bbox);
      const same = idx.filter((j) => Math.abs(bottom(objs[j].bbox) - b) <= noteH * 0.4);
      if (same.length < 3) continue;
      const span = Math.max(...same.map((j) => right(objs[j].bbox))) - Math.min(...same.map((j) => objs[j].bbox.x));
      if (span < noteH * 4) continue;
      if (b > chordBase) chordBase = b;
    }
    for (const ln of lines) {
      // 字号要按**整行**量，不能按 run 量：谱行上下印着的经文用歌词那号字（整行中位 10.0），
      // 但其中七八个字凑出来的一小段中位可能只有 9.5，卡不住（105 首曲末那句经文）。
      if (q75(ln.map((i) => objs[i].bbox.h)) > lyricH * 0.92) continue;
      ln.sort((a, b) => objs[a].bbox.x - objs[b].bbox.x);
      let run: number[] = [];
      const flush = () => {
        // 密排还不够，还得是**小字号**：谱行上下印着的经文/注记也是密排的一长串，
        // 但它用歌词那号字（一行中位 10.5），署名只有 6.5~8.1
        //（031 首曲末那句经文七个字，正好卡在密排门槛上被当成署名）。
        // **落在和弦基线上、而且这一行别处还有同基线的和弦，那就是和弦，再密也是**。
        // 段落词（`(副歌)` 连着两个括线）紧挨着真和弦印在一起，一串就凑够七个字，
        // 整块被判成署名——464 首页 543 的 `(副歌)#FmBm` 就是这么丢的两个和弦。
        // 署名的立足点是「印在和弦基线之上一整行」（见 15），所以判据要连高度一起看：
        // 只看「有没有同基线的伙伴」会误伤真署名——署名自己就是并排的一整行，
        // 谱行上方三十几点处，同一行里当然彼此同基线（305 首整条署名因此没了）。
        const runLo = run.length ? median(run.map((i) => bottom(objs[i].bbox))) : 0;
        const runX0 = run.length ? Math.min(...run.map((i) => objs[i].bbox.x)) : 0;
        const runX1 = run.length ? Math.max(...run.map((i) => right(objs[i].bbox))) : 0;
        const onChordLine =
          run.length > 0 &&
          chordBase - runLo <= noteH * 1.2 &&
          idx.filter((j) => {
            if (run.includes(j)) return false;
            const q = objs[j].bbox;
            // 紧挨着这一串的不算「别处」：署名里一个空档（生卒年前的破折号）就足以把它
            // 切成两串，两串当然彼此同基线，一比就把自己认成了和弦（305 首整条署名因此没了）。
            if (q.x - runX1 < noteH * 4 && runX0 - right(q) < noteH * 4) return false;
            return Math.abs(bottom(q) - runLo) <= noteH * 0.4;
          }).length >= 2;
        if (run.length >= 7 && !onChordLine && median(run.map((i) => objs[i].bbox.h)) <= lyricH * 0.92)
          for (const i of run) set(i, "credit", `和弦带里密排 ${run.length} 个小字，是词曲署名`);
        run = [];
      };
      for (const i of ln) {
        const prev = run.length ? objs[run[run.length - 1]].bbox : null;
        if (prev && objs[i].bbox.x - right(prev) > noteH * 0.8) flush();
        run.push(i);
      }
      flush();
    }
  }


  // ── 15. 署名的**短行**兜底。13 只认「密排 ≥7 个字」的一串，
  //       「词曲：唐崇明」这种六个字的短署名够不着门槛，会留在和弦里（002 首整条署名读不出）。
  //       署名与和弦的区别不在长短，在**高度**：署名印在和弦线上方一整行以上，
  //       而和弦（连同它的上标 `♭`、`m`、`7`）都贴着同一条基线。
  //       所以：先取每个谱行里和弦的基线（最靠下、≥3 个的那一撮），
  //       比它高出一个字高以上的整行，判为署名。
  for (const bd of bands) {
    const idx: number[] = [];
    for (let i = 0; i < objs.length; i++) if (out[i].cls === "chord" && !out[i].dup && out[i].row === bd.index) idx.push(i);
    if (idx.length < 3) continue;
    // 基线要**横着铺开一整行**才算数。`rit.` `Fine` 这类表情记号印得比和弦低半个字
    //（321 首的 `rit.` 低了 6.5 点），三个字母正好凑够「共线 ≥3 个」，按「最靠下」
    // 一取基线就成了它；整排真和弦跟着「高出基线一个字高」，被 `rit.` 顶上去的那个
    // `Am` 高出 10.6，直接接到署名尾巴上去了。和弦是隔着小节铺满整行的，
    // 表情记号只占一个词的宽度——按跨度一量就分开了。
    let base = -Infinity;
    for (const i of idx) {
      const b = bottom(objs[i].bbox);
      const same = idx.filter((j) => Math.abs(bottom(objs[j].bbox) - b) <= noteH * 0.4);
      if (same.length < 3) continue;
      const span = Math.max(...same.map((j) => right(objs[j].bbox))) - Math.min(...same.map((j) => objs[j].bbox.x));
      if (span < noteH * 4) continue;
      if (b > base) base = b;
    }
    if (base === -Infinity) continue;
    //       **位置判据试过，不如这条**：署名的版面位置很固定（标题之下、第一谱行之上、
  //       靠右半边，左半边是「1=F 4/4」），照这个框去收，署名反而从 87.3% 掉到 83.6%——
  //       同一带里还夹着页眉分类词、经文、副标题，而 13/15 看的是「与和弦基线的高差 +
  //       字号」，比位置准。位置只在一处非用不可：**大字标题隔开半页起的两首**（见第 10 步）。
  //       还要**小字号**：谱行上方有时印着整段经文（022 首「主命令众星宿…」），
    //       它也比和弦线高，但用的是歌词那号字（一行的中位高 10.3~11.1），署名只有 6.5~8.1。
    //       **字号要按行取中位**，不能逐字判：汉字的墨迹高度差得远（「上」才 7 高、
    //       「日」有 10），逐字判会从经文里挑出一半来当署名。
    // **先按基线把整个谱行的和弦分行，再挑「整行都比基线高」的那些行**。
    // 不能先按高度筛掉一半再分行：房号顶高的那一排和弦本就贴着 1.2 字高这条线，
    // 排里有一个碰巧高出半点（164 首的 `D7` 高 0.5 点），它就自己单独成一「行」——
    // 独字必然密排，下面那道密排判据形同虚设，于是那个 `D` 被接到署名尾巴上
    //（识别出的署名成了「作曲王丽玲D」），和弦里少一个 `D7`。整排一起量，跨度一拉开，
    // 密排判据立刻把它挡住。
    // 分行**按行首那个基线量，不接龙**：接龙会让署名行顺着 0.5 点一档的小台阶
    // 一路并到底下那排和弦上，整条署名跟着被否掉（064 首的「作曲 Adolphe…」）。
    const lines2: number[][] = [];
    for (const i of idx.slice().sort((a, b) => bottom(objs[a].bbox) - bottom(objs[b].bbox))) {
      const last = lines2[lines2.length - 1];
      if (last && bottom(objs[i].bbox) - bottom(objs[last[0]].bbox) <= noteH * 0.4) last.push(i);
      else lines2.push([i]);
    }
    for (const ln of lines2) {
      // 高度按**行的中位基线**量，不能逐字量：拉丁小写的降部（`p` `g` `y`）比同行低两点，
      // 逐字量时一个 `p` 就能把整条署名否掉（064 首的「作曲 Adolphe…」）。
      const lo = median(ln.map((i) => bottom(objs[i].bbox)));
      if (base - lo <= noteH * 1.2) continue;
      ln.sort((a, b) => objs[a].bbox.x - objs[b].bbox.x);
      // 段落词 `(副歌)` 也印在和弦线上方一整行处，收成署名就凭空接到人名后面。
      // 认它靠**两头那对括线**：又细又高（1.9×6.8，宽不到高的三成，高够着音符那号字），
      // 署名里最细的 `l` `i` 也有 2.3~2.4 宽、而且不会正好排在一行的头尾两端。
      const thinBar = (i: number) => {
        const q = objs[i].bbox;
        return q.w < q.h * 0.45 && q.h >= noteH * 0.7;
      };
      if (ln.length <= 4 && thinBar(ln[0]) && thinBar(ln[ln.length - 1])) continue;

      // **还得密排**：房号（一房二房）会把那一行的和弦整排抬高一个字，
      // 抬上去之后它们同样「比和弦基线高一个字高」，于是被当成署名接到人名后面
      //（037 首的署名尾巴上多出 `CFFCCF`）。署名是挤在一起的一串，
      //  和弦是隔着大半个小节的孤立记号——按「墨迹宽 / 跨度」一量就分开了（门槛试过 0.3/0.45/0.6，0.3 最好；
      //  另外试过再加「一行至少四个字」，短署名反被剔掉，署名 88.0→87.7）。
      const xs = ln.map((i) => objs[i].bbox);
      const span = Math.max(...xs.map(right)) - Math.min(...xs.map((b) => b.x));
      const ink = xs.reduce((a, b) => a + b.w, 0);
      if (span > 0 && ink / span < 0.3) continue;
      const h = q75(ln.map((i) => objs[i].bbox.h));
      if (h > lyricH * 0.92) continue; // 这一行是经文/正文，不是署名
      // **靠左/靠右分不开**：署名行的左缘中位虽在版心 57% 处，但长署名（外文人名 + 生卒年）
      // 从 15% 处就起排，而经文也顶到右边界。试过把左缘门槛设在 0.15/0.22/0.30，
      // 署名准确率分别掉到 81.5/80.5/80.5（不设是 82.8）——分得开的是字号，不是对齐。
      for (const i of ln) set(i, "credit", `比和弦基线高出 ${(base - bottom(objs[i].bbox)).toFixed(1)} 的小字行，是词曲署名`);
    }
  }


  const counts: Record<string, number> = {};
  for (const c of out) counts[c.cls] = (counts[c.cls] ?? 0) + 1;

  return {
    page: page.page,
    width: page.width,
    height: page.height,
    objs: out,
    bands,
    frames,
    ornaments: ornaments.map((o) => ({ box: o.box, tiles: o.idx.length, tileW: o.tileW, tileH: o.tileH })),
    counts,
    unclassified: out.filter((c) => c.cls === "unclassified"),
  };
}


/** 花边框检测的中间结果（带对象下标）。 */
interface OrnamentHit {
  idx: number[];
  box: Rect;
  /** 框内区域（去掉一圈纹样），框内正文落在这里。 */
  inner: Rect;
  tileW: number;
  tileH: number;
}

/** 一条「同形状密排线」：花边的一条边。 */
interface TileRun {
  idx: number[];
  horizontal: boolean;
  /** 整条边合成一个 path 的那种边（见 `collectSolidEdges`）。它自己不足以成框。 */
  solid?: boolean;
}

/**
 * 整条边合成一个 path 的花边边。
 *
 * 同一本书里，有的页花边的每一片是独立对象（走 `collectRuns`），有的页整条边被合并成了
 * **一个** path 对象——密排那套「≥7 片」的判据根本看不见它，于是那条边落在框外：
 * 框的包围盒只由剩下三条边定出来，顶边连同它压着的正文一起流回谱面判据里去。
 * 全书 13 页栽在这上面（92/286/287/351/355/379/451/463/591/614/618/633/635），
 * 而且清一色缺的是**顶**边。
 *
 * 判据只有三条，是拿全书扫描标定的（873 个「长宽比极端且够长」的对象里只命中这 13 个，零误报）：
 *   - **够长**：长边 ≥ 版心宽 0.85（实测这批边 287~294，版心 307.6）
 *   - **够扁**：短边 ≤ noteH*0.85（这批 2.8~6.6；注解正文整行合成的 path 高 7.8+，就此分开）
 *   - **段数够多**：`segs ≥ 60`（**这条是要害**）。普通结构线——通栏横线、双细线框的边——
 *     `segs` 恒等于 5，一条都混不进来。
 *
 * **不要改用 `curves`**：这批合并边的 curves 从 0（p351/p451）到 1372（p287）都有，
 * 拿它当判据会把一半漏掉。分开「花边合并边」与「结构线」的是段数，不是曲线数。
 */
function collectSolidEdges(objs: VecObj[], noteH: number, contentW: number): TileRun[] {
  const out: TileRun[] = [];
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    const long = Math.max(o.bbox.w, o.bbox.h);
    const short = Math.min(o.bbox.w, o.bbox.h);
    if (long < contentW * 0.85 || short > noteH * 0.85 || o.segs < 60) continue;
    out.push({ idx: [i], horizontal: o.bbox.w >= o.bbox.h, solid: true });
  }
  return out;
}

/**
 * 找出「同一批小纹样沿矩形四边重复平铺」围成的花边框。
 *
 * 判据是**同一形状连续密排成线**：花边的一条边就是同一个装饰字形挨着排十几二十个，
 * 相邻间距不超过自身宽度的两三倍。汉字不会同一个字连排十次，所以这条判据很干净。
 *
 * 先试过「同形状重复多次 + 包络中心为空」，在 p300 翻了车：框内的高频汉字（的、一…）
 * 也满足「重复多次 + 尺寸小」，把中心占满了，整框就被判掉。
 *
 * 为什么要把不同形状的线合起来：一圈花边常由几种纹样拼成（横边一种、竖边一种、角上一种）。
 */
function detectOrnamentFrames(objs: VecObj[], noteH: number, contentW: number): OrnamentHit[] {
  const groups = new Map<string, number[]>();
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    if (o.bbox.w > noteH * 1.6 || o.bbox.h > noteH * 1.6) continue;
    const k = coarseKey(o);
    const g = groups.get(k);
    if (g) g.push(i);
    else groups.set(k, [i]);
  }

  const runs: TileRun[] = [];
  for (const [, idx] of groups) {
    if (idx.length < 8) continue;
    const w = median(idx.map((i) => Math.max(objs[i].bbox.w, 0.3)));
    const h = median(idx.map((i) => Math.max(objs[i].bbox.h, 0.3)));
    // 横向密排：同一 y 上连续排开
    collectRuns(idx, objs, true, h * 0.6, w * 2.5, runs);
    // 纵向密排
    collectRuns(idx, objs, false, w * 0.6, h * 2.5, runs);
  }
  // 整条边合成一个 path 的那种边。放在密排线之后：它只补边，自己成不了框。
  const solids = collectSolidEdges(objs, noteH, contentW);
  runs.push(...solids);
  if (runs.length < 2) return [];

  // 把交叠/相邻的线并成一个框（一圈花边由几条线组成）
  const used = new Set<number>();
  const out: OrnamentHit[] = [];
  for (let a = 0; a < runs.length; a++) {
    if (used.has(a)) continue;
    const group = [a];
    used.add(a);
    let changed = true;
    while (changed) {
      changed = false;
      for (let b = 0; b < runs.length; b++) {
        if (used.has(b)) continue;
        if (group.some((g) => runsNear(runs[g], runs[b], objs, noteH))) {
          used.add(b);
          group.push(b);
          changed = true;
        }
      }
    }
    const idx = [...new Set(group.flatMap((g) => runs[g].idx))];
    const bs = idx.map((i) => objs[i].bbox);
    const x0 = Math.min(...bs.map((b) => b.x));
    const y0 = Math.min(...bs.map((b) => b.y));
    const x1 = Math.max(...bs.map(right));
    const y1 = Math.max(...bs.map(bottom));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < noteH * 4 || h < noteH * 3) continue;
    // 至少要有一横一竖两条边，否则可能只是一行重复符号
    const hasH = group.some((g) => runs[g].horizontal);
    const hasV = group.some((g) => !runs[g].horizontal);
    if (!hasH || !hasV) continue;
    // 合成边只补边，不立框：全靠它凑出来的「框」没有密排线背书，
    // 那是两条无关的宽扁 path 撞在一起，不是花边。
    if (group.every((g) => runs[g].solid)) continue;
    // **必须是「环」：中间三分之一区域基本没有本簇的纹样。**
    // 目录页的引导点线（……）也是同形状密排、也凑得出一横一竖，但它布满整页中心；
    // 少了这条约束，全书会误报 131 个花边框（真正带注解的框只有三十来个）。
    const mid = { x: x0 + w / 3, y: y0 + h / 3, w: w / 3, h: h / 3 };
    if (bs.filter((b) => intersectRect(b, mid)).length > idx.length * 0.03) continue;
    const box = { x: x0, y: y0, w, h };
    const corners = collectCornerTiles(objs, box, noteH, new Set(idx));
    const all = corners.length ? [...idx, ...corners] : idx;
    const abs = all.map((i) => objs[i].bbox);
    // 角片比边突出去一点，box 要按并集重算，否则压在角上的那一圈收不进来。
    const bx0 = Math.min(...abs.map((b) => b.x));
    const by0 = Math.min(...abs.map((b) => b.y));
    const bw = Math.max(...abs.map(right)) - bx0;
    const bh = Math.max(...abs.map(bottom)) - by0;
    const edge = Math.max(noteH * 0.8, Math.min(bw, bh) * 0.06);
    out.push({
      idx: all,
      box: { x: bx0, y: by0, w: bw, h: bh },
      inner: { x: bx0 + edge, y: by0 + edge, w: bw - edge * 2, h: bh - edge * 2 },
      tileW: median(bs.map((b) => b.w)),
      tileH: median(bs.map((b) => b.h)),
    });
  }

  return out;
}

/**
 * 花边框四角上那枚**独立的**纹样。
 *
 * 四角印的不是横竖两条边的母题，而是第三枚字形（实测尺寸也不同：p42 的角片 7.7×7.6，
 * 边片却是 10.8×5.0）。每框只有 4 个，永远够不着 `collectRuns` 那个「≥7 片」的门槛，
 * 于是全书 427 个角片一路落到框内正文里，被当成字读出来——**「X」44 个、「S」19 个、
 * 「米」18 个、「K」11 个……110 条注解里有 103 条正文混着这种垃圾字**。
 * （`bookmeta.ts` 那条「1~2 个拉丁字母独占一行就丢掉」的过滤只挡住了独占整行的那部分。）
 *
 * 判据是拿全书 110 个框实测标定的：
 *   - **贴角**：中心距框角 ≤ `noteH*1.2`（实测 3.1~9.6，中位 5.4，p90 只有 7）。
 *     这条才是主力：框内正文离角至少隔着一圈内边距，第一个字的中心距角 14 以上。
 *   - **够小**：bbox ≤ `noteH*1.35`（实测 4.8×4.8 ~ 10.6×10.5）。放到 1.35 是为了 p149/p555
 *     那两个框的角片（10.0×8.8 / 10.5×10.4），卡在 1.2 上它们会整框漏掉。
 *   - **四角同源**：四个角位上至少两个的 `curves/segs` 一致。角片是同一枚字形的四种旋转，
 *     旋转不改段数——实测每种 `curves/segs` 的计数都是 4 的整倍数。
 *     少了这条，尺寸上限放宽后框内贴着角的正文字就会被当成角片吞掉。
 *     **同源要按四个角位一起看，不能只看待补的那几个**：角片与边片同形状时（p633 的
 *     `12/29`），三个角早被 `collectRuns` 当边片收走了，只剩一个孤角——只数它自己永远凑不够两票。
 *
 * 全书 427 个角片，补完只剩 0 个流进正文。
 */
function collectCornerTiles(objs: VecObj[], box: Rect, noteH: number, taken: Set<number>): number[] {
  const near = noteH * 1.2;
  const size = noteH * 1.35;
  const pts: [number, number][] = [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x, box.y + box.h],
    [box.x + box.w, box.y + box.h],
  ];
  const found: { i: number; sig: string; taken: boolean }[] = [];
  for (const [px, py] of pts) {
    let best: { i: number; d: number } | null = null;
    for (let i = 0; i < objs.length; i++) {
      const b = objs[i].bbox;
      if (b.w > size || b.h > size) continue;
      const d = Math.hypot(b.x + b.w / 2 - px, b.y + b.h / 2 - py);
      if (d <= near && (!best || d < best.d)) best = { i, d };
    }
    if (best) found.push({ i: best.i, sig: `${objs[best.i].curves}/${objs[best.i].segs}`, taken: taken.has(best.i) });
  }
  // 同源统计连已收为边片的角位一起数，再只补没收的那几个。
  const tally = new Map<string, number>();
  for (const f of found) tally.set(f.sig, (tally.get(f.sig) ?? 0) + 1);
  const win = [...tally].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0];
  if (!win) return [];
  return found.filter((f) => f.sig === win[0] && !f.taken).map((f) => f.i);
}

/** 在同形状的一组对象里，找沿某方向密排 ≥8 个的连续段。 */
function collectRuns(idx: number[], objs: VecObj[], horizontal: boolean, lineTol: number, gapMax: number, out: TileRun[]): void {
  const key = (i: number) => (horizontal ? cy(objs[i].bbox) : cx(objs[i].bbox));
  const pos = (i: number) => (horizontal ? objs[i].bbox.x : objs[i].bbox.y);
  const end = (i: number) => (horizontal ? right(objs[i].bbox) : bottom(objs[i].bbox));
  const sorted = [...idx].sort((a, b) => key(a) - key(b));
  let line: number[] = [];
  const flush = () => {
    // 7 而不是 8：短框的一条竖边只有 7 片（p555 那个框左右各 7 片，卡在 8 上整框都没认出来，
    // 于是框里的注解正文全落进歌词带）。与下面 run 的门槛保持一致。
    if (line.length < 7) return;
    const seq = [...line].sort((a, b) => pos(a) - pos(b));
    let run: number[] = [seq[0]];
    for (let k = 1; k < seq.length; k++) {
      if (pos(seq[k]) - end(seq[k - 1]) <= gapMax) run.push(seq[k]);
      else {
        if (run.length >= 7) out.push({ idx: run, horizontal });
        run = [seq[k]];
      }
    }
    if (run.length >= 7) out.push({ idx: run, horizontal });
  };
  for (const i of sorted) {
    if (line.length && Math.abs(key(i) - key(line[line.length - 1])) > lineTol) {
      flush();
      line = [];
    }
    line.push(i);
  }
  flush();
}

/** 两条密排线是否属于同一个框（端点相近或共边）。 */
function runsNear(a: TileRun, b: TileRun, objs: VecObj[], noteH: number): boolean {
  const bbox = (r: TileRun) => {
    const bs = r.idx.map((i) => objs[i].bbox);
    return {
      x: Math.min(...bs.map((v) => v.x)),
      y: Math.min(...bs.map((v) => v.y)),
      w: Math.max(...bs.map(right)) - Math.min(...bs.map((v) => v.x)),
      h: Math.max(...bs.map(bottom)) - Math.min(...bs.map((v) => v.y)),
    };
  };
  const A = bbox(a);
  const B = bbox(b);
  const pad = noteH * 2;
  return !!intersectRect({ x: A.x - pad, y: A.y - pad, w: A.w + pad * 2, h: A.h + pad * 2 }, B);
}
