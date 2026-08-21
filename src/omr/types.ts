// 简谱 OMR（移植自 ~/proj/musicpp/omr/jianpu.cpp 的 recognition_jp 管线）。
// 不依赖 OpenCV/Tesseract 原生库：像素运算用纯 TS，OCR 子模块可插拔（tesseract.js / Gemini）。

/** 二值图：1=前景(黑/有墨)，0=背景。row-major，w*h。 */
export interface Binary {
  w: number;
  h: number;
  data: Uint8Array; // 长度 w*h，值 0/1
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const rright = (r: Rect) => r.x + r.w;
export const rbottom = (r: Rect) => r.y + r.h;
export const rcx = (r: Rect) => r.x + r.w / 2;
export const rcy = (r: Rect) => r.y + r.h / 2;

/** 连通域：包围盒 + 像素数 + 质心。 */
export interface Component {
  id: number;
  bbox: Rect;
  area: number; // 前景像素数
  cx: number;
  cy: number;
}

/** jianpu.cpp: struct jpnum —— 一个简谱音符（数字 + 修饰）。 */
export interface JpNum {
  digit: number; // 0-7（0=休止）
  bbox: Rect;
  dot: number; // 附点数（右侧点）
  octave: number; // 八度偏移（上点+，下点-）
  div: number; // 下划线条数（每条时值减半）
  augment: number; // 增时线 '-' 数（延长拍）
  augmentRects?: Rect[]; // 增时线各横块源图 bbox（仅识别模式叠加按原位绘制用，不参与导出）
  lyrics?: string[]; // 歌词：按声部(verse)索引，lyrics[0]=第一段(W1)、lyrics[1]=第二段……
  // 段落标记（Intro/Verse/Chorus/Coda…，谱面上多印成方框）：标在该段起始音符上。
  // → MusicXML `<direction><words>`，下游供乐句排版按段落硬换行（见 score/phrase.ts）。
  sectionMark?: string;
  // 和弦符号（归一后的原文，如 "Am" / "G/B" / "Gsus4"）。印在本谱行音符**上方**，识别见 chordline.ts。
  // → MusicXML `<harmony>` 与文本谱 `"hx:…"`；.jpwabc / Score 模型装不下和弦，那一路会丢（同力度、渐强渐弱）。
  chord?: string;
  // 和弦在本音符时值内的拍位偏移，取 0..1 的比例（缺省=正对音符本身）。简谱上和弦常印在
  // 两音符之间的拍点上，故不能只表达「挂在某音符」。MusicXML 那路折成 <harmony><offset>（乘本音符
  // divisions）；文本谱 `"hx:"` 挂不住偏移，只能就近挂到本音符（有损）。
  chordOffset?: number;
  // 同一音符时值内的**后续**和弦（长音上第二、第三拍各换一个和弦时用），offset 同上为 0..1 比例。
  // 谱面上它们印在增时线上方，模型里没有独立元素可挂，只能连同 offset 挂回起头的那个音符。
  // → MusicXML 各出一个带 <offset> 的 <harmony>；文本谱挂到对应的那条增时线上（`- "hx:…"`）。
  extraChords?: { tok: string; offset: number }[];
  // 圆滑线/连音线（音符上方弧形 ⌒）。一个音符可同时是上一条的结束与下一条的开始，故各用布尔。
  slurStart?: boolean; // 圆滑线起点 → MusicXML <slur type="start">
  slurStop?: boolean;  // 圆滑线终点 → <slur type="stop">
  tieStart?: boolean;  // 连音线起点（弧下同音高）→ <tied type="start">
  tieStop?: boolean;   // 连音线终点 → <tied type="stop">
  // 反复与一/二房结构锚定到边界相邻音符，MusicXML 输出时再提升为小节左右 barline。
  repeatForward?: boolean;  // 本音符所在小节左边界为 ||:
  repeatBackward?: boolean; // 本音符所在小节右边界为 :||
  // 房号是 MusicXML `<ending number>` 的原文：一个房括号可辖多遍，写作 "1,2,3,5"。
  endingStart?: string;     // 本音符所在小节开始该房
  endingStop?: string;      // 本音符所在小节结束该房
  // 跳转记号（D.C./D.S./Fine/To Coda…），印在本谱行音符附近 → MusicXML <direction>+<sound>。
  jumpMark?: string;
}

/** 一行（一个 staff 行）识别出的内容。 */
export interface StaffRow {
  topY: number;
  bottomY: number;
  nums: JpNum[]; // 按 x 排序
  barlineXs: number[]; // 小节线 x 位置
}

/** 一处带源图坐标的识别文本（页眉/歌词），供识别模式按原位、原字号叠加。 */
export interface TextRegion {
  text: string; // 识别出的展示文本（如 "日光之上"、"作词：叶薇心"、"1=♭B"、歌词单字）
  bbox: Rect; // 源图像素坐标
  // 可选：逐字源图位置（页眉行用 OCR 返回的字位）。识别模式据此把每个字落回源图 x，
  // 使展开排布的标题/著作者行逐字对位，而非整行左对齐挤在一头。
  chars?: { text: string; cx: number }[];
}

export interface RecognizedScore {
  key: string; // 如 "C"
  fifths: number;
  beats: number;
  beatType: number;
  rows: StaffRow[];
  title?: string;
  credits?: string[]; // 著作者整行文本（作词/作曲…），→ MusicXML <credit>
  tempo?: number; // 速度 ♩=NN（仅进 MusicXML；当前下游导入器不读 tempo）
  headerRegions?: TextRegion[]; // 页眉文本的源图定位（识别模式按原位叠加）
  lyricRegions?: TextRegion[]; // 歌词单字的源图定位+字号（识别模式按原图位置/大小叠加）
  chordRegions?: TextRegion[]; // 和弦记号的源图定位（识别模式按原位叠加）
  dotDiam?: number; // 八度点/附点在源图的统计直径（识别模式按原图大小画点，非按字号推算）
}
