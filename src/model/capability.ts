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
// | `docs/待办.md` §2.2「无法表达」的 全语料实测 | 文字行 `W:` / 圆滑线 / 多段歌词 / 印刷段号 / 多声部 / 分曲 / 倚音 / 房号 |
// | `docs/架构.md` §6.1 的模型主线 | `Score` 装不下力度、渐强渐弱、多声部并排；`scoreToJpwabc` 丢和弦与 slur |
// | `docs/模块/模型-scoredoc.md` | `playOrder` 与 `style` 是 **MusicXML 装不下的两样**（`<ending>` 只能整小节） |
// | `docs/模块/源格式-abc家族.md` | ABC 那一档的 clef/修饰、`Q:` 参照音符长度 |
//
// **改这张表之前先去改那几处的实测**——这里只是它们的汇总。

import type { ScoreDoc } from "./doc";
import { eachChord, verseCount } from "./helpers";

/** 一项「文档里可能用到、格式可能装不下」的特性。 */
export type Feature =
  | "harmony"        // 和弦符号
  | "multiVoice"     // 多声部
  | "dynamics"       // 力度与渐强渐弱
  | "playOrder"      // 演唱顺序（含 skip/limit）
  | "style"          // 样式表引用
  | "multiVerse"     // 多段歌词
  | "volta"          // 房号
  | "grace"          // 倚音
  | "slur"           // 圆滑线
  | "textLine"       // 文字行（段落词、注记）
  | "multiSong"      // 一个文件多首
  | "pageText"       // 页眉页脚
  | "verseLabel"     // 印刷段号 `<1.>`
  | "rhythmNote"     // 节奏音符（有声无音高）
  | "invisibleRest"; // 不可见休止

/** 人看的名字，直接进丢失清单。 */
export const FEATURE_NAMES: Readonly<Record<Feature, string>> = {
  harmony: "和弦符号",
  multiVoice: "多声部",
  dynamics: "力度与渐强渐弱",
  playOrder: "演唱顺序（房号跳转、第几遍配第几段词）",
  style: "样式表引用",
  multiVerse: "多段歌词",
  volta: "房号",
  grace: "倚音",
  slur: "圆滑线",
  textLine: "段落词与注记",
  multiSong: "一个文件里的多首曲子",
  pageText: "页眉页脚",
  verseLabel: "印刷段号",
  rhythmNote: "节奏音符（有声无音高）",
  invisibleRest: "不可见休止",
};

/** 目标格式。比 `DocFormatId` 多一个 `musicxml`，少一个「不能另存为」的都没有。 */
export type TargetFormat = "123" | "abc" | "jpwabc" | "pu" | "musicxml";

const ALL: Feature[] = Object.keys(FEATURE_NAMES) as Feature[];
/** 「除了这几样，其余都装得下」。 */
const allBut = (...gone: Feature[]): Set<Feature> => new Set(ALL.filter((f) => !gone.includes(f)));

/** 每种格式装得下哪些。**装不下的写在 `allBut(...)` 里，并在注释里写清依据。** */
export const FORMAT_CAPS: Readonly<Record<TargetFormat, ReadonlySet<Feature>>> = {
  // 123 是按「装得下全部」设计的（`docs/格式/123格式.md`），实测 全语料只有 0.17% 表达不了，
  // 那些是转换层的账不是格式的账。
  "123": allBut(),
  // 标准 ABC：样式被规范标为 VOLATILE（§11，「not standardised」），所以 123 才把样式
  // 另走样式表；`I:playorder` 是 123 的扩展，标准 ABC 读不懂（虽然会忽略，等于丢）。
  abc: allBut("style", "playOrder", "rhythmNote", "verseLabel"),
  // `.jpwabc` 的语法**刻意不扩**（`docs/架构.md` A5 那条）：和弦与 slur 在
  // `scoreToJpwabc` 就丢了，成书对比里那条基准路因此被停用。
  jpwabc: allBut("harmony", "slur", "dynamics", "multiVoice", "style", "multiSong", "grace"),
  // 文本谱：`scoreDocToScore` 丢和弦/力度/多声部（`docs/架构.md` §6.1 的表），
  // 但文本谱**原文**装得下和弦——这里算的是「另存为之后还在不在」，所以按解析器的能力写。
  pu: allBut("style", "playOrder", "dynamics"),
  // MusicXML 装不下的两样：`playOrder` 的 skip/limit（`<ending>` 只能整小节）与样式引用。
  // 见 `docs/模块/模型-scoredoc.md` 的关键判据。
  musicxml: allBut("playOrder", "style"),
};

/** 这份文档实际用到了哪些特性。 */
export function featuresUsed(doc: ScoreDoc): Set<Feature> {
  const used = new Set<Feature>();
  if (doc.songs.length > 1) used.add("multiSong");
  for (const song of doc.songs) {
    if (song.parts.length > 1) used.add("multiVoice");
    if (song.playOrder?.length) used.add("playOrder");
    if (song.style?.sheetRef || song.style?.raw?.length) used.add("style");
    if (song.pageText) used.add("pageText");
    if (song.remarks?.length) used.add("textLine");
    if (verseCount(song) > 1) used.add("multiVerse");
    for (const m of song.marks ?? []) {
      if (m.type === "slur") used.add("slur");
      if (m.type === "wedge") used.add("dynamics"); // 渐强渐弱
    }
    for (const part of song.parts) {
      for (const mea of part.measures) {
        for (const b of mea.barlines ?? []) if (b.ending) used.add("volta");
        // 力度与渐强渐弱走 `<direction>`
        for (const d of mea.directions ?? []) {
          if (d.type === "dynamics" || d.type === "wedge") used.add("dynamics");
        }
        for (const el of mea.elements) {
          if (el.kind === "space" && el.spacer === "x") used.add("invisibleRest");
          if (el.harmony?.text) used.add("harmony");
          if (el.kind === "chord") {
            if (el.grace) used.add("grace");
            if (el.rhythm) used.add("rhythmNote");
            if (el.sectionWord) used.add("textLine");
            if (el.printObject === false && el.rest) used.add("invisibleRest");
            for (const l of el.lyrics ?? []) if (l.verseLabel !== undefined) used.add("verseLabel");
          }
        }
      }
    }
    for (const { chord } of eachChord(song)) {
      for (const su of chord.sustains ?? []) if (su.harmony?.text) used.add("harmony");
    }
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
    `这份谱里有 ${losses.length} 样东西，存成 ${target} 之后会丢：\n\n` +
    losses.map((l) => `　· ${l.name}`).join("\n") +
    "\n\n要继续吗？"
  );
}
