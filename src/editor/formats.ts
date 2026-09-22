// 源格式适配器注册表。**每加一种可编辑的源格式，只该动这张表**。
//
// 以前每种格式的差异是 `app.ts` 里散在约二十处的 `docFormat === "pu"` 三目式：
// 高亮、存盘编码、默认扩展名、标题取法、档位旋钮、格式标签、能不能简繁转换……
// 加第三、第四种格式时那二十处每处都要再分一次叉，漏一处就是一个只在某格式下复现的 bug。
//
// 这里只收**真正成表的那些**：数据与纯函数。真正因格式而异的算法
// （文本谱的 `reloadPu` / 乐句重排 / 播放高亮走 AST 索引）仍留在 `app.ts`，
// 适配器只负责把它们分派出去——照 `OmrHost` / `PlaybackHost` 的既有做法，
// 用一个**列全了的**宿主接口向 App 要能力，而不是把 App 的状态搬进来。

import type { Extension } from "@codemirror/state";
import { jpwHighlighter } from "./highlight";
import { puHighlighter } from "../pu/highlight";
import { j123Highlighter } from "../j123/highlight";
import { decodeJpwabc, encodeJpwabc } from "./fileio";
import { parsePu } from "../pu";
import { relayoutPuText } from "../pu/relayout";
import type { FitMeasure } from "../pu/phrase";
import { parse123, parseAbc } from "../j123/parse";
import { emit123 } from "../j123/emit";
import { emitAbc } from "../abcfamily/emitabc.entry";
import type { ScoreDoc } from "../model/doc";
import { loadScoreDoc } from "../model/fromxml";
import { fillDegreesFromPitch } from "../model/jianpu";
import { relayoutDocBreaks, relayoutJpwabcText, spliceComments } from "../model/relayout";
import { jpwToScoreDoc } from "../model/fromjpw";
import { JpwFile } from "../jpword/jpwfile";
import type { EditDialect } from "./visual/dialect";
import { DIALECT_123 } from "./visual/dialects/j123";
import { DIALECT_ABC } from "./visual/dialects/abc";
import { DIALECT_JPW } from "./visual/dialects/jpw";
import { DIALECT_PU } from "./visual/dialects/pu";

/** 可打开的源格式。`musicxml` 没有代码区（`caps.textEditor === false`），只看谱面、转成文本格式再编辑。 */
export type DocFormatId = "jpwabc" | "pu" | "123" | "abc" | "musicxml";

/** 适配器向 App 要的那些能力（**列全**，加一条就想想是不是该留在 App 里）。 */
export interface FormatHost {
  getText(): string;
  /** 文本谱已解析出的方言，用于代码区标签（解析前为 null）。 */
  readonly puDialectName: string | null;
  /** 当前谱面排版器认得的标题（`.jpwabc` 那路由引擎输入给）。 */
  readonly painterTitle: string;
  /** 文本谱重排/重渲染。 */
  reloadPu(text: string): boolean;
  /** `.jpwabc` 重排/重渲染。 */
  reloadJpwabc(text: string): boolean;
  /** `.123` 重排/重渲染。 */
  reload123(text: string): boolean;
  /** `.abc` 重排/重渲染。 */
  reloadAbc(text: string): boolean;
  /** `.musicxml` 重排/重渲染。 */
  reloadMusicXml(text: string): boolean;
}

export interface FormatCaps {
  /** 有没有代码区。`.musicxml` 没有：打开只进谱面视图（五线谱编辑那一路），要编辑先转成文本格式（新文档）。 */
  textEditor: boolean;
  /** 整篇简繁转换（`convertJpwabc` 认的是 `.Title`/`.Words` 段结构）。 */
  hanConvert: boolean;
  /** 谱面走哪套排版：`scoredoc` = 解析成 `ScoreDoc` 后原样档走 `PuPainter`、展开档经 `jianpuInputOfDoc`
   *  （文本谱、123、ABC）；`jpwabc` = `.jpwabc` 经 `jianpuInputOfJpw` 走简谱引擎（两档）。 */
  layout: "scoredoc" | "jpwabc";
  /** `scoredoc` 这一路**原样档**用哪个排版器：`jianpu` = 投影成简谱引擎输入、与 `.jpwabc` 原样档同一个
   *  `ScorePainter`（123、ABC；多声部的曲子仍回落 `PuPainter`，引擎只排一条旋律）；
   *  `pu` = `PuPainter`（文本谱的印刷原版观感、MusicXML）。`jpwabc` 本来就走引擎。 */
  originalEngine: "jianpu" | "pu";
  /** 有没有「按乐句重排」（要有 `FormatAdapter.relayoutText`）。`.musicxml` 没有代码区，不给。 */
  phraseRelayout: boolean;
}

export interface FormatAdapter {
  id: DocFormatId;
  /** 另存为时的默认扩展名（含点）。扩展名白名单本身只在 `common/filetypes.ts` 写一次。 */
  defaultExt: string;
  /** 代码区的 CodeMirror 高亮扩展。 */
  highlighter: Extension;
  /** 读盘解码。`.jpwabc` 是 JP-Word 的 UTF-16LE+BOM，其余是 UTF-8。 */
  decode(bytes: Uint8Array): string;
  /** 存盘编码，与 `decode` 对称。 */
  encode(text: string): Uint8Array;
  /** 代码区右上角的格式标签。 */
  label(host: FormatHost): string;
  /** 文档标题（另存为的默认文件名）。 */
  title(host: FormatHost): string;
  /** 用哪个档位旋钮记「展开/原样」：`jp` = `jpProfile`(normal/pptx)、`pu` = `puProfile`(print/slide)。
   *  两种格式各记各的档，换格式可能就换了档。 */
  profileKnob: "jp" | "pu";
  caps: FormatCaps;
  /** 解析 → 排版 → 渲染。失败返回 false（文本保留不动）。 */
  reload(host: FormatHost, text: string): boolean;
  /** 这种格式怎么得到一份 `ScoreDoc`（`caps.layout === "scoredoc"` 时必须给）。 */
  toScoreDoc?(text: string): ScoreDoc;
  /**
   * 「按乐句重排」怎么写回原文（`caps.phraseRelayout` 时必须给）。断句本身与格式无关
   * （`score/phrase.ts`），各格式的差别只在写回那一步：文本谱只搬原文片段（`pu/relayout.ts`），
   * 123/ABC 把断点写进模型再整份重出，`.jpwabc` 只挪 `.Voice` 里的 `$`（见 `model/relayout.ts`）。
   *
   * @param measure 行长尺子（展开档才有；没有就按出厂的小节数目标断，也就是一句一行）
   * @returns 新原文；没有可重排的曲行时原样返回 `text`
   */
  relayoutText?(text: string, measure: FitMeasure | null): string;
  /** 可视化编辑怎么改这种格式的原文（`editor/visual/dialect.ts`）。**给了就能在谱面上改谱**；
   *  不给的格式在谱面上只能选中、移动，不能改。 */
  editDialect?: EditDialect;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 123 读取时忽略 BOM（规范 §1）。 */
const stripBom = (bytes: Uint8Array): Uint8Array =>
  bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;

/** 123/ABC 的重排：断点写进模型（`$` 只落在小节之后，故小节中间的断点挪到下一根小节线），整份重出。
 *  重出会丢注释（注释不进模型），所以再把原文的注释按「跟着哪个和弦」缝回去（`spliceComments`）。 */
function emitFrom(
  text: string, measure: FitMeasure | null,
  parse: (text: string) => ScoreDoc, emit: (doc: ScoreDoc) => string,
): string {
  const doc = parse(text);
  if (!relayoutDocBreaks(doc, { measure, midBreaks: "snap" })) return text;
  const out = emit(doc);
  return spliceComments(text, doc, out, parse(out));
}

const JPWABC: FormatAdapter = {
  id: "jpwabc",
  defaultExt: ".jpwabc",
  highlighter: jpwHighlighter,
  decode: decodeJpwabc,
  encode: encodeJpwabc,
  label: () => "JPWABC",
  title: (host) => host.painterTitle.split("\n")[0] ?? "",
  profileKnob: "jp",
  caps: { hanConvert: true, textEditor: true, layout: "jpwabc", phraseRelayout: true, originalEngine: "jianpu" },
  reload: (host, text) => host.reloadJpwabc(text),
  // `.jpwabc` 是分节文件：只重切 `.Voice` 的行，别的节（样式、歌词、分页描述）一个字不动。
  // 尺子不用：这一路的展开档走的是另一套引擎输入，拿 `jianpuInputOfDoc` 那把尺子量不对。
  relayoutText: (text) => {
    const f = JpwFile.fromString(text);
    if (!f) return text;
    return relayoutJpwabcText(text, jpwToScoreDoc(f));
  },
  editDialect: DIALECT_JPW,
};

const PU: FormatAdapter = {
  id: "pu",
  defaultExt: ".pu",
  highlighter: puHighlighter,
  // 文本谱是纯文本源格式：UTF-8 原文进、UTF-8 原文出。
  decode: (bytes) =>
    new TextDecoder(bytes[0] === 0xff || bytes[0] === 0xfe ? "utf-16" : "utf-8").decode(bytes),
  encode: utf8,
  label: (host) => (host.puDialectName === null ? "文本谱" : `文本谱·${host.puDialectName}`),
  // 头部第一条 T:/B:
  title: (host) => {
    const first = host
      .getText()
      .split(/\r?\n/)
      .map((l) => /^\s*[TB]\s*[:：](.*)$/.exec(l))
      .find((m) => m !== null);
    return first ? first[1]!.trim() : "";
  },
  profileKnob: "pu",
  caps: { hanConvert: false, textEditor: true, layout: "scoredoc", phraseRelayout: true, originalEngine: "pu" },
  reload: (host, text) => host.reloadPu(text),
  toScoreDoc: (text) => parsePu(text),
  relayoutText: (text, measure) => relayoutPuText(text, parsePu(text), { measure }),
  editDialect: DIALECT_PU,
};

/** 123 —— 简谱主格式。原生解析直出 `ScoreDoc`；排版直接吃 `ScoreDoc`。
 *  档位旋钮跟文本谱同一个（`puProfile`）：两者都走 `PuPainter`（原样）/`ScorePainter`（展开）这一对。 */
const J123: FormatAdapter = {
  id: "123",
  defaultExt: ".123",
  highlighter: j123Highlighter,
  decode: (bytes) => new TextDecoder("utf-8").decode(stripBom(bytes)),
  encode: utf8,
  label: () => "123",
  // `T:` 的第一条是标题（其后为副标题）；中文别名 `标题：` 等价
  title: (host) => {
    const first = host
      .getText()
      .split(/\r?\n/)
      .map((l) => /^\s*(?:T|标题)\s*[:：](.*)$/.exec(l))
      .find((m) => m !== null);
    return first ? first[1]!.trim() : "";
  },
  profileKnob: "pu",
  caps: { hanConvert: false, textEditor: true, layout: "scoredoc", phraseRelayout: true, originalEngine: "jianpu" },
  reload: (host, text) => host.reload123(text),
  toScoreDoc: parse123,
  relayoutText: (text, measure) => emitFrom(text, measure, parse123, emit123),
  editDialect: DIALECT_123,
};

/** ABC —— 与 123 同源的那一支（123 是 ABC 方言）。**原生解析直出 `ScoreDoc`**，
 *  不经 `abc2xml → MusicXML` 转一手——那条路把源字符偏移丢光了，双向定位最多到小节级。
 *  `abc/abc2xml.ts` 留作对照基准与 fallback，见 `docs/模块/源格式-abc家族.md`。 */
const ABC: FormatAdapter = {
  id: "abc",
  defaultExt: ".abc",
  // 高亮暂借 123 那一份：两者的字段头、小节线、歌词行完全同形，音乐体的音符会被当成
  // 「认不出」而不上色——比不上色好，等 ABC 专用的那份写出来再换。
  highlighter: j123Highlighter,
  decode: (bytes) => new TextDecoder("utf-8").decode(stripBom(bytes)),
  encode: utf8,
  label: () => "ABC",
  title: (host) => {
    const first = host
      .getText()
      .split(/\r?\n/)
      .map((l) => /^\s*T\s*:(.*)$/.exec(l))
      .find((m) => m !== null);
    return first ? first[1]!.trim() : "";
  },
  profileKnob: "pu",
  caps: { hanConvert: false, textEditor: true, layout: "scoredoc", phraseRelayout: true, originalEngine: "jianpu" },
  reload: (host, text) => host.reloadAbc(text),
  toScoreDoc: parseAbc,
  relayoutText: (text, measure) => emitFrom(text, measure, parseAbc, emitAbc),
  editDialect: DIALECT_ABC,
};

/** MusicXML —— 五线谱主格式。**没有代码区**：编辑器文档里存的就是 XML 原文（不显示），
 *  谱面由 `ScoreDoc` 出（`fromxml.ts` 读全、读不懂的原样挂 `raw`）。存回原文件：没改过就是原文，
 *  经 `App.editScoreDoc` 改过的已经整份重写成 `toxml.ts` 的产物。 */
const MUSICXML: FormatAdapter = {
  id: "musicxml",
  defaultExt: ".musicxml",
  highlighter: [],
  decode: (bytes) =>
    new TextDecoder(bytes[0] === 0xff || bytes[0] === 0xfe ? "utf-16" : "utf-8").decode(stripBom(bytes)),
  encode: utf8,
  label: () => "MusicXML",
  title: (host) => {
    const m = /<(?:work-title|movement-title)>([^<]*)</.exec(host.getText());
    return m ? m[1]!.trim() : "";
  },
  profileKnob: "pu",
  caps: { textEditor: false, layout: "scoredoc", phraseRelayout: false, hanConvert: false, originalEngine: "pu" },
  reload: (host, text) => host.reloadMusicXml(text),
  // MusicXML 只给绝对音高，简谱排版要度数
  toScoreDoc: (text) => {
    const doc = loadScoreDoc(text);
    for (const song of doc.songs) fillDegreesFromPitch(song);
    return doc;
  },
};

export const FORMATS: Record<DocFormatId, FormatAdapter> = {
  jpwabc: JPWABC,
  pu: PU,
  "123": J123,
  abc: ABC,
  musicxml: MUSICXML,
};

export const formatOf = (id: DocFormatId): FormatAdapter => FORMATS[id];
