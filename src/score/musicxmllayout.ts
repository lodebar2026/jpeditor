// 给导出的 MusicXML 补版面信息：页面尺寸/边距、每行（system）的分行与间距、小节宽度、
// 音符与歌词的行内位置。目的是让 MuseScore/Finale 打开时「一行几个小节」与原图对得上。
//
// **不引用 JinpuPainter**：本应用屏幕上的简谱排版（可变纸张、乐句重排、翻页）不是给第三方看的
// 版面，硬塞过去只会显示得又挤又怪。这里只做两件事：
//  1) 分行——识别底本里现成的 <print new-system>（omr/musicxml.ts 按 RecognizedScore.rows
//     逐行写的，即原图的「一行几个小节」）原样沿用；没有的才按 measuresPerSystem 补。
//  2) 版面参数——一张写死的 A4 常量表，按每行实际小节数把行宽分掉。
//
// 底本自带 <defaults><scaling>（abc2xml 会输出）时整体跳过：作者已给的版面比我们合成的更贴切。
import { child, children, fragment, insertOrdered } from "./xmldom";

export interface LayoutOpts {
  /** 底本没有任何 <print> 分行凭据时，每行放几个小节。 */
  measuresPerSystem?: number;
}

// A4 @ scaling 7mm/40tenths（1 tenth = 1/40 staff 高），MusicXML 生态的惯用值。
const PAGE_W = 1233;
const PAGE_H = 1596;
const MARGIN = 70;
const TOP_SYSTEM_DISTANCE = 240; // 给页顶的标题与著作者行留出位置
const SYSTEM_DISTANCE = 110;
/** 首行要给 <attributes>（谱号/调号/拍号）留的宽度。 */
const FIRST_SYSTEM_INDENT = 80;
/** 小节两端的固定留白，避免只有一个音符的小节被压扁。 */
const MEASURE_PAD = 2;
const NOTE_LEFT = 12;

const frag = (doc: Document, xml: string): Element => fragment(doc, xml, "版面片段");
const round1 = (v: number) => String(Math.round(v * 10) / 10);

/** 标题基线（从页面**底边**往上量，见 layoutCredits 的说明）。 */
const TITLE_Y = PAGE_H - MARGIN - 30;
/** 第一行著作者的基线，之后每行下移一格。 */
const CREDIT_Y = PAGE_H - MARGIN - 110;
const CREDIT_LINE = 30;

/** 本小节参与横向分配的音符数（<chord/> 从属音与 grace 不占位）。 */
function noteCount(measureEl: Element): number {
  let n = 0;
  for (const el of children(measureEl, "note")) {
    if (child(el, "grace") || child(el, "chord")) continue;
    n++;
  }
  return n;
}

function defaultsXml(): string {
  return `<defaults><scaling><millimeters>7</millimeters><tenths>40</tenths></scaling>` +
    `<page-layout><page-height>${PAGE_H}</page-height><page-width>${PAGE_W}</page-width>` +
    `<page-margins type="both"><left-margin>${MARGIN}</left-margin>` +
    `<right-margin>${MARGIN}</right-margin><top-margin>${MARGIN}</top-margin>` +
    `<bottom-margin>${MARGIN}</bottom-margin></page-margins></page-layout>` +
    `<system-layout><system-margins><left-margin>0</left-margin><right-margin>0</right-margin>` +
    `</system-margins><system-distance>${SYSTEM_DISTANCE}</system-distance>` +
    `<top-system-distance>${TOP_SYSTEM_DISTANCE}</top-system-distance></system-layout></defaults>`;
}

/**
 * 给 `<credit-words>` 补页面坐标。
 *
 * **`<credit>` 的坐标原点在页面左下角、y 轴向上**，和小节里那些 `default-y`（相对五线谱顶线、
 * 向上为正）不是一个坐标系。不写坐标的话 MuseScore 会把词曲行丢到页面底部——因为它按
 * default-y 缺省 0 处理，那正是页面底边。
 *
 * 布局按谱面惯例：标题居中放页顶，著作者行右对齐排在标题下方。
 */
function layoutCredits(root: Element): void {
  const workTitle = child(child(root, "work") ?? root, "work-title")?.textContent?.trim() ?? "";
  // MuseScore 的规则：**只要文件里有任何 <credit>，就完全以 credit 为准**，不再拿 <work-title>
  // 生成标题框。我们的谱子只有词曲两条 credit，标题于是整个消失——所以缺 title credit 时补一条。
  const hasTitleCredit = children(root, "credit").some((cr) => {
    const t = child(cr, "credit-type")?.textContent?.trim();
    if (t === "title") return true;
    return workTitle.length > 0 &&
      children(cr, "credit-words").some((w) => (w.textContent ?? "").trim() === workTitle);
  });
  if (workTitle && !hasTitleCredit) {
    const node = root.ownerDocument.createElement("credit");
    node.setAttribute("page", "1");
    const ty = root.ownerDocument.createElement("credit-type");
    ty.textContent = "title";
    const w = root.ownerDocument.createElement("credit-words");
    w.textContent = workTitle;
    node.append(ty, w);
    insertOrdered(root, node, ["credit", "part-list", "part"]);
  }
  let line = 0;
  for (const cr of children(root, "credit")) {
    const type = child(cr, "credit-type")?.textContent?.trim();
    for (const w of children(cr, "credit-words")) {
      if (w.getAttribute("default-y") !== null) continue; // 底本已给坐标：不覆盖
      const text = (w.textContent ?? "").trim();
      const isTitle = type === "title" || (workTitle.length > 0 && text === workTitle);
      if (isTitle) {
        w.setAttribute("default-x", String(PAGE_W / 2));
        w.setAttribute("default-y", String(TITLE_Y));
        w.setAttribute("justify", "center");
        w.setAttribute("valign", "top");
        w.setAttribute("font-size", "24");
      } else {
        w.setAttribute("default-x", String(PAGE_W - MARGIN));
        w.setAttribute("default-y", String(CREDIT_Y - line * CREDIT_LINE));
        w.setAttribute("justify", "right");
        w.setAttribute("valign", "top");
        w.setAttribute("font-size", "12");
        line++;
      }
    }
  }
}

export function annotateLayout(doc: Document, opt: LayoutOpts = {}): void {
  const root = doc.documentElement;
  if (child(root, "defaults")) return; // 底本自带版面：尊重它，一个字不改
  const partEl = children(root, "part")[0];
  if (!partEl) return;
  const measureEls = children(partEl, "measure");
  if (!measureEls.length) return;

  // <defaults> 必须排在 <credit>/<part-list> 之前（MusicXML DTD 的元素顺序）。
  insertOrdered(root, frag(doc, defaultsXml()), ["credit", "part-list", "part"]);
  layoutCredits(root);

  // 分行：底本已有的 <print new-system|new-page> 优先，没有才按每行 N 小节补。
  const perSystem = Math.max(1, opt.measuresPerSystem ?? 4);
  const hasPrint = measureEls.some((m) => {
    const p = child(m, "print");
    return !!p && (p.getAttribute("new-system") === "yes" || p.getAttribute("new-page") === "yes");
  });
  const systemStart: boolean[] = measureEls.map((m, i) => {
    if (i === 0) return true;
    if (!hasPrint) return i % perSystem === 0;
    const p = child(m, "print");
    return !!p && (p.getAttribute("new-system") === "yes" || p.getAttribute("new-page") === "yes");
  });

  // 切成行
  const systems: number[][] = [];
  measureEls.forEach((_, i) => {
    if (systemStart[i]) systems.push([]);
    systems[systems.length - 1].push(i);
  });

  systems.forEach((sys, si) => {
    const avail = (si === 0 ? PAGE_W - 2 * MARGIN - FIRST_SYSTEM_INDENT : PAGE_W - 2 * MARGIN);
    const weights = sys.map((i) => noteCount(measureEls[i]) + MEASURE_PAD);
    const total = weights.reduce((a, b) => a + b, 0) || 1;

    sys.forEach((mi, k) => {
      const el = measureEls[mi];
      const width = avail * weights[k] / total;
      el.setAttribute("width", round1(width));

      if (k === 0 && si > 0) {
        // 行首小节：补 <print new-system> + 该行的纵向间距。
        let printEl = child(el, "print");
        if (!printEl) {
          printEl = doc.createElement("print");
          printEl.setAttribute("new-system", "yes");
          el.insertBefore(printEl, el.firstChild);
        }
        if (!child(printEl, "system-layout")) {
          printEl.append(frag(doc,
            `<system-layout><system-distance>${SYSTEM_DISTANCE}</system-distance></system-layout>`));
        }
      }

      // 行内位置：音符按小节宽均分，歌词按段次逐行下移。
      const notes = children(el, "note").filter((n) => !child(n, "grace") && !child(n, "chord"));
      const step = notes.length ? (width - 2 * NOTE_LEFT) / notes.length : 0;
      notes.forEach((n, j) => {
        n.setAttribute("default-x", round1(NOTE_LEFT + step * j));
        for (const l of children(n, "lyric")) {
          const num = l.getAttribute("number") ?? "1";
          const verse = num === "chorus" ? 1 : (parseInt(num, 10) || 1);
          l.setAttribute("default-y", String(-80 - 20 * (verse - 1)));
        }
      });
    });
  });
}
