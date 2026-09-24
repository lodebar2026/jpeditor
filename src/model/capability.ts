// **格式能力表**：每种源格式装得下什么。
//
// 用途只有一个：另存为别的格式之前，算出「这份文档里用到、但目标格式装不下」的东西，
// 列给用户，确认后再写（`editor/dialogs.ts::showConfirmDialog`）。
//
// ## 表里的内容不是凭空写的
//
// 每一条都来自既有的实测与各模块文档的「已知限制」：
//
// | 来源 | 得到的条目 |
// |---|---|
// | `docs/待办.md` §2.2「无法表达」的全语料实测 | 文字行 `W:` / 圆滑线 / 多段歌词 / 印刷段号 / 多声部 / 分曲 / 倚音 / 房号 |
// | `docs/模块/模型-scoredoc.md` | `playOrder` 与 `style` 是 **MusicXML 装不下的两样**（`<ending>` 只能整小节） |
// | `docs/模块/源格式-abc家族.md` | ABC 那一档的 clef/修饰、`Q:` 参照音符长度 |
// | `break-roundtrip-check`（断点写回 → 各写出端 → 读回） | 换页（ABC 装不下）；换行含小节中间的，六种都装得下，不列 |
//
// **改这张表之前先去改那几处的实测**——这里只是它们的汇总。

import type { Mark, ScoreDoc, Song } from "./doc";
import { inlineBreakOf, nestArcsInTuplets } from "./emitutil";
import { eachChord, verseCount } from "./helpers";
import { projectForJianpu } from "./jianpuproject";
import { melodyLane } from "./jianpu";
import { puArcLosses } from "./topu";
import { songHeaderFonts, songLyricSize, songPage, songStaffSize } from "./pagemeta";

/** 一项「文档里可能用到、格式可能装不下」的特性。 */
export type Feature =
  | "harmony"        // 和弦符号
  | "harmonyOffset"  // 落在长音中间、又不在整拍上的和弦（简谱挂不到增时线上）
  | "multiVoice"     // 多声部（多个 part）
  | "noteStack"      // 同一声部里同时发声的几个音（五线谱的和弦内音、声部内第二 voice）
  | "dynamics"       // 力度与渐强渐弱
  | "playOrder"      // 演唱顺序（含 skip/limit）
  | "style"          // 样式表引用
  | "layoutDirectives" // 文档内的版面指令（文本谱的 `FontSize:` / `Margin:` / `Space:` / `Off:`）
  | "keyChange"      // 曲中转调
  | "multiVerse"     // 多段歌词
  | "volta"          // 房号
  | "grace"          // 倚音
  | "slur"           // 圆滑线
  | "textLine"       // 文字行（段落词、注记）
  | "multiSong"      // 一个文件多首
  | "pageText"       // 页眉页脚
  | "meta"           // 扩展 meta（英文标题、经文、标签…，`Song.meta`）
  | "paper"          // 谱里自带的纸（MusicXML `<page-layout>`、123/ABC `I:meta page`）
  | "verseLabel"     // 印刷段号 `<1.>`
  | "rhythmNote"     // 节奏音符（有声无音高）
  | "invisibleRest"  // 不可见休止
  | "nestedArc"      // 一条弧线完全包住另一条（文本谱的括号先开先闭，写不出）
  | "oddTuplet"      // 比例不是 n:n−1 的多连音（文本谱里 n 个音一律占 n−1 个基本时值）
  | "slurCrossTuplet" // 跨出多连音组的弧（123 的弧与多连音共用括号、只许嵌套）
  | "lyricOnRest"    // 挂在可见休止上的词（123、ABC 的休止不占对位格）
  | "pageBreak";     // 谱里写的换页（小节级或小节中间的）

/** 人看的名字，直接进丢失清单。 */
export const FEATURE_NAMES: Readonly<Record<Feature, string>> = {
  harmony: "和弦符号",
  harmonyOffset: "长音中间不在整拍上的和弦（会提前到音符上）",
  multiVoice: "多声部",
  noteStack: "同一声部里同时发声的音（和弦内音、声部内第二声部，只留简谱印的旋律）",
  dynamics: "力度与渐强渐弱",
  playOrder: "演唱顺序（房号跳转、第几遍配第几段词）",
  style: "样式表引用",
  layoutDirectives: "版面指令（字号、页边距等）",
  keyChange: "曲中转调",
  multiVerse: "多段歌词",
  volta: "房号",
  grace: "倚音",
  slur: "圆滑线",
  textLine: "段落词与注记",
  multiSong: "一个文件里的多首曲子",
  pageText: "页眉页脚",
  meta: "扩展曲目信息（英文标题、经文、标签等）",
  paper: "谱里写的纸张、页边距、五线谱谱表大小与歌词字号、页眉字体（改记进设置）",
  verseLabel: "印刷段号",
  rhythmNote: "节奏音符（有声无音高）",
  invisibleRest: "不可见休止",
  nestedArc: "套在另一条弧线里的弧线（外面那条或里面那条会丢一条）",
  oddTuplet: "比例特殊的多连音（按 n 个音占 n−1 拍写不出来）",
  slurCrossTuplet: "跨出多连音组的弧线（会截到组的边界）",
  lyricOnRest: "挂在休止符上的歌词",
  pageBreak: "换页（会改成换行）",
};

/** 目标格式。文本谱两种方言各算一种（装得下的不一样：番茄没有页眉页脚与版面指令字段）。 */
export type TargetFormat = "123" | "abc" | "jpwabc" | "tomato" | "shige" | "musicxml";

/** 丢失清单里给人看的格式名。 */
export const TARGET_LABEL: Readonly<Record<TargetFormat, string>> = {
  "123": "123",
  abc: "ABC",
  jpwabc: "JPWABC",
  tomato: "番茄简谱",
  shige: "诗歌本文本谱",
  musicxml: "MusicXML",
};

/** 文本谱两种方言都装不下的。依据见 `model/topu.ts` 开头与 `docs/模块/源格式-文本谱.md` 的已知限制：
 *  样式表引用、演唱顺序、扩展 meta 没有字段可落（文本谱只有按位置的 XL/XR/TL/TR/BL/BC/BR，不往里猜）；
 *  没有曲中转调的写法；音符堆只写简谱印的那个音；弧线与多连音共用一个先开先闭的括号队列。 */
const PU_GONE: Feature[] = [
  "style", "playOrder", "harmonyOffset", "meta", "paper", "keyChange", "noteStack", "nestedArc", "oddTuplet",
];

const ALL: Feature[] = Object.keys(FEATURE_NAMES) as Feature[];
/** 「除了这几样，其余都装得下」。 */
const allBut = (...gone: Feature[]): Set<Feature> => new Set(ALL.filter((f) => !gone.includes(f)));

/** 每种格式装得下哪些。**装不下的写在 `allBut(...)` 里，并在注释里写清依据。** */
export const FORMAT_CAPS: Readonly<Record<TargetFormat, ReadonlySet<Feature>>> = {
  // 123 是按「装得下全部」设计的（`docs/格式/123格式.md`），实测全语料只有 0.17% 表达不了，
  // 那些是转换层的账不是格式的账。
  // 音符堆 123 刻意不做（规范：和弦走符号，`.jpwabc` 的 `[1 3 5]` 语料 0 例）。
  // 嵌套弧与任意比例的多连音（`(5:4:`）都写得出；弧与多连音只许嵌套、可见休止不跟词（规范 §4、§5.1）
  "123": allBut("harmonyOffset", "noteStack", "slurCrossTuplet", "lyricOnRest"),
  // 标准 ABC：样式被规范标为 VOLATILE（§11，「not standardised」），所以 123 才把样式
  // 另走样式表；`I:playorder` 是 123 的扩展，标准 ABC 读不懂（虽然会忽略，等于丢）。
  // 休止不跟词（ABC §5.1「syllables are not aligned on … rests」）；
  // 换页没有记号，写出端退化成换行（`emitabc.ts::breakText`；换行本身含小节中间的都装得下，`break-roundtrip-check` 实测）
  abc: allBut("style", "playOrder", "rhythmNote", "verseLabel", "harmonyOffset", "lyricOnRest", "pageBreak"),
  // `.jpwabc` 的语法**刻意不扩**：和弦、力度、多声部都写不进去。
  // 音符堆：写出端只留最高音、删 voice > 1
  jpwabc: allBut("harmony", "harmonyOffset", "slur", "dynamics", "multiVoice", "noteStack", "style", "layoutDirectives", "multiSong", "grace", "meta", "paper", "nestedArc", "oddTuplet"),
  // 文本谱：展开档谱面不画和弦/力度/多声部，但文本谱**原文**装得下和弦、力度（`&f`、`<`…`!`）——
  // 这里算的是「另存为之后还在不在」，所以按解析器的能力写。
  // 番茄另外没有页眉页脚与版面指令字段（写了会被嗅探成诗歌本，见 `pu/dialect.ts::EmitStyle.pageFields`）
  tomato: allBut(...PU_GONE, "pageText", "layoutDirectives"),
  shige: allBut(...PU_GONE),
  // MusicXML 装不下的两样：`playOrder` 的 skip/limit（`<ending>` 只能整小节）与样式引用。
  // 见 `docs/模块/模型-scoredoc.md` 的关键判据。
  musicxml: allBut("playOrder", "style", "layoutDirectives", "nestedArc", "oddTuplet"),
};

/** 文本谱认的版面指令（`pu/parse.ts` 的头部字段）。123/ABC 读进来是小写（`I:fontsize`）。 */
const LAYOUT_DIRECTIVE = /^(fontsize|margin|space|off)$/i;

function keyDiffers(a: NonNullable<Song["key"]>, b: NonNullable<Song["key"]>): boolean {
  return a.fifths !== b.fifths || (a.spelling ?? "") !== (b.spelling ?? "") || (a.tonicDegree ?? "1") !== (b.tonicDegree ?? "1");
}

/** 这份文档实际用到了哪些特性。 */
export function featuresUsed(doc: ScoreDoc): Set<Feature> {
  const used = new Set<Feature>();
  if (doc.songs.length > 1) used.add("multiSong");
  for (const song of doc.songs) {
    if (song.parts.length > 1) used.add("multiVoice");
    if (song.playOrder?.length) used.add("playOrder");
    if (song.style?.sheetRef || song.style?.inline?.length) used.add("style");
    for (const r of song.style?.raw ?? []) used.add(LAYOUT_DIRECTIVE.test(r.key) ? "layoutDirectives" : "style");
    if (song.pageText) used.add("pageText");
    if (song.meta && Object.keys(song.meta).length) used.add("meta");
    if (songPage(song) || songStaffSize(song) || songLyricSize(song) || Object.keys(songHeaderFonts(song)).length) used.add("paper");
    if (song.remarks?.length) used.add("textLine");
    if (verseCount(song) > 1) used.add("multiVerse");
    for (const m of song.marks ?? []) {
      if (m.type === "slur") used.add("slur");
      if (m.type === "wedge") used.add("dynamics"); // 渐强渐弱
    }
    for (const part of song.parts) {
      part.measures.forEach((mea, mi) => {
        if (mi > 0 && mea.attrs?.key && song.key && keyDiffers(mea.attrs.key, song.key)) used.add("keyChange");
        if (mi > 0 && mea.print?.newPage) used.add("pageBreak");
        if (mea.elements.some((el) => inlineBreakOf(el) === "page")) used.add("pageBreak");
      });
      for (const mea of part.measures) {
        const lane = melodyLane(mea);
        for (const b of mea.barlines ?? []) if (b.ending) used.add("volta");
        // 力度与渐强渐弱走 `<direction>`
        for (const d of mea.directions ?? []) {
          if (d.type === "dynamics" || d.type === "wedge") used.add("dynamics");
        }
        for (const el of mea.elements) {
          if (el.kind === "space" && el.spacer === "x") used.add("invisibleRest");
          // MusicXML 读进来的和弦是结构化的、没有 text，所以按有无判
          if (el.harmony) used.add("harmony");
          if (el.kind === "chord") {
            if (el.notes.length > 1 || (lane && (el.staff !== lane.staff || el.voice !== lane.voice))) used.add("noteStack");
            if (el.grace) used.add("grace");
            if (el.rhythm) used.add("rhythmNote");
            if (el.sectionWord) used.add("textLine");
            if (el.printObject === false && el.rest) used.add("invisibleRest");
            if (el.rest && el.printObject !== false && el.lyrics?.some((l) => l.text !== "")) used.add("lyricOnRest");
            for (const l of el.lyrics ?? []) if (l.verseLabel !== undefined) used.add("verseLabel");
          }
        }
      }
    }
    for (const { chord } of eachChord(song)) {
      for (const su of chord.sustains ?? []) if (su.harmony) used.add("harmony");
    }
    // 长音中途换和弦：进简谱形状后还挂不到增时线上的才算（`jianpuproject.ts`）
    if ([...eachChord(song)].some(({ chord }) => chord.laterHarmonies?.length)) {
      if ([...eachChord(projectForJianpu(song))].some(({ chord }) => chord.laterHarmonies?.length)) used.add("harmonyOffset");
    }
    // 弧线与多连音能不能写成文本谱的括号：判据与写出端同一份（`topu.ts::planArcs`）
    for (const part of song.parts) {
      const isArc = (m: Mark): boolean => m.type === "slur" || m.type === "tied";
      if (nestArcsInTuplets(part, song.marks ?? [], isArc).crossed) used.add("slurCrossTuplet");
    }
    const arcs = puArcLosses(song);
    if (arcs.nested) used.add("nestedArc");
    if (arcs.oddTuplet) used.add("oddTuplet");
  }
  return used;
}

export interface Loss {
  feature: Feature;
  name: string;
}

/** 存成 `target` 会丢掉什么 = 用到的 ∖ 目标装得下的。空数组 = 无损。 */
export function planSave(doc: ScoreDoc, target: TargetFormat): Loss[] {
  const caps = FORMAT_CAPS[target];
  return [...featuresUsed(doc)]
    .filter((f) => !caps.has(f))
    .map((f) => ({ feature: f, name: FEATURE_NAMES[f] }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

/** 丢失清单 → 给人看的一段话。 */
export function describeLosses(target: TargetFormat, losses: readonly Loss[]): string {
  if (losses.length === 0) return "";
  return (
    `这份谱里有 ${losses.length} 样东西，存成 ${TARGET_LABEL[target]} 之后会丢：\n\n` +
    losses.map((l) => `　· ${l.name}`).join("\n") +
    "\n\n要继续吗？"
  );
}
