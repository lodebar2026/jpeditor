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
import { parse123, parseAbc } from "../j123/parse";
import { scoreDocToPu } from "../pu/slots";
import type { PuDoc } from "../pu";

/** 可编辑的源格式。阶段 4 加 `"musicxml"`。 */
export type DocFormatId = "jpwabc" | "pu" | "123" | "abc";

/** 适配器向 App 要的那些能力（**列全**，加一条就想想是不是该留在 App 里）。 */
export interface FormatHost {
  getText(): string;
  /** 文本谱已解析出的方言，用于代码区标签（解析前为 null）。 */
  readonly puDialectName: string | null;
  /** 当前谱面排版器认得的标题（`.jpwabc` 那路由 Score 给）。 */
  readonly painterTitle: string;
  /** 文本谱重排/重渲染。 */
  reloadPu(text: string): boolean;
  /** `.jpwabc` 重排/重渲染。 */
  reloadJpwabc(text: string): boolean;
  /** `.123` 重排/重渲染。 */
  reload123(text: string): boolean;
  /** `.abc` 重排/重渲染。 */
  reloadAbc(text: string): boolean;
}

export interface FormatCaps {
  /** 有没有五线谱/混排这一路（混排是简谱那侧的上下文工具，文本谱与 123 不适用）。 */
  mixed: boolean;
  /** 整篇简繁转换（`convertJpwabc` 认的是 `.Title`/`.Words` 段结构）。 */
  hanConvert: boolean;
  /** 谱面经 `PuDoc` 那条路渲染（原样档走 `PuPainter`、展开档先转 `Score`）。
   *  **过渡期的桥**：123 借它取排版，阶段 5 直通做完后这一位跟着 `topu.ts` 一起消失。 */
  viaPuDoc: boolean;
  /** 乐句重排（`pu/relayout.ts` 重排的是文本谱原文，认的是文本谱语法）。 */
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
  /** 过渡期：这种格式怎么得到一份 `PuDoc`（`caps.viaPuDoc` 为真时必须给）。 */
  toPuDoc?(text: string): PuDoc;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 123 读取时忽略 BOM（规范 §1）。 */
const stripBom = (bytes: Uint8Array): Uint8Array =>
  bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;

const JPWABC: FormatAdapter = {
  id: "jpwabc",
  defaultExt: ".jpwabc",
  highlighter: jpwHighlighter,
  decode: decodeJpwabc,
  encode: encodeJpwabc,
  label: () => "JPWABC",
  title: (host) => host.painterTitle.split("\n")[0] ?? "",
  profileKnob: "jp",
  caps: { mixed: true, hanConvert: true, viaPuDoc: false, phraseRelayout: false },
  reload: (host, text) => host.reloadJpwabc(text),
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
  caps: { mixed: false, hanConvert: false, viaPuDoc: true, phraseRelayout: true },
  reload: (host, text) => host.reloadPu(text),
  toPuDoc: parsePu,
};

/** 123 —— 简谱主格式。原生解析直出 `ScoreDoc`；排版在阶段 5 直通做完前借 `PuDoc` 那条路。
 *  档位旋钮跟文本谱同一个（`puProfile`）：两者都走 `PuPainter`/`ExpandedPainter` 这一对。 */
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
  caps: { mixed: false, hanConvert: false, viaPuDoc: true, phraseRelayout: false },
  reload: (host, text) => host.reload123(text),
  toPuDoc: (text) => scoreDocToPu(parse123(text)),
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
  caps: { mixed: false, hanConvert: false, viaPuDoc: true, phraseRelayout: false },
  reload: (host, text) => host.reloadAbc(text),
  toPuDoc: (text) => scoreDocToPu(parseAbc(text)),
};

export const FORMATS: Record<DocFormatId, FormatAdapter> = {
  jpwabc: JPWABC,
  pu: PU,
  "123": J123,
  abc: ABC,
};

export const formatOf = (id: DocFormatId): FormatAdapter => FORMATS[id];
