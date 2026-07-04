// 帮助对话框：双标签页（功能帮助 + 记谱法）。只读，自建 overlay（参照 export.ts 的
// showExportDialog），复用 .modal-overlay/.modal-box 样式 + 本文件专属的 .help-* 样式。
// 功能帮助 = 可展开主题列表（<details>）；记谱法 = 分节说明 + 实时渲染的 SVG 示例。
import type { App } from "./app";

// ---- 小工具 ----------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** 内联富文本：把 `**粗**`、`` `代码` `` 转成 span，避免手搓一堆 createElement。 */
function rich(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1] != null) frag.append(el("strong", undefined, m[1]));
    else if (m[2] != null) frag.append(el("code", "help-code", m[2]));
    last = re.lastIndex;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function para(text: string, cls = "help-p"): HTMLParagraphElement {
  const p = el("p", cls);
  p.append(rich(text));
  return p;
}

// ---- 功能帮助 --------------------------------------------------------------

type Badge = "desktop" | "browser" | "mac";
const BADGE_TEXT: Record<Badge, string> = {
  desktop: "🖥 仅桌面版",
  browser: "🌐 仅浏览器",
  mac: "🍎 仅 macOS 桌面",
};

interface Topic {
  title: string;
  badges?: Badge[];
  /** 段落文本（支持 **粗** 与 `代码`）。 */
  body: string[];
  /** 可选：额外自定义节点（如快捷键表）。 */
  extra?: () => HTMLElement;
}

const FEATURE_TOPICS: Topic[] = [
  {
    title: "打开与保存文件",
    body: [
      "工具栏 **打开** 支持 `.jpwabc`（本项目原生简谱格式）、`.xml` / `.musicxml`、`.abc`；也可把这些文件**直接拖进**右侧谱面区。",
      "**保存** / **另存为** 把当前简谱存成 `.jpwabc`（UTF-16LE 编码，与 JP-Word 兼容）。",
      "**桌面版**：打开/保存用系统原生对话框，可直接写回磁盘；下次启动会自动恢复上次打开的文件。**浏览器版**：用网页文件选择器打开，保存则以下载方式导出。",
    ],
  },
  {
    title: "编辑与实时排版",
    body: [
      "左侧是 `.jpwabc` 代码编辑区，**边打字边重排**——停顿约 0.2 秒后右侧谱面自动更新。",
      "**点选**：在谱面上点音符/小节，会高亮并在底部状态栏显示信息。",
      "混排、识别模式下代码区只读或隐藏（详见对应主题）。",
    ],
  },
  {
    title: "翻页与缩放",
    body: [
      "**翻页**：工具栏 上一页 / 下一页，或键盘 `PageUp` / `PageDown`；`Ctrl/⌘+Home` 跳首页、`Ctrl/⌘+End` 跳末页。",
      "**缩放**：工具栏 `−` / `100%` / `＋`，或 `Ctrl/⌘ +` / `-` / `0`，或按住 `Ctrl/⌘` 滚滚轮。",
      "**macOS 桌面版**还支持触控板双指捏合缩放。",
    ],
  },
  {
    title: "识图（图片转简谱）",
    body: [
      "把简谱**图片**（PNG/JPG 等）拖进谱面区，会自动识别成简谱并载入编辑。识别在**本地离线**完成，浏览器版和桌面版都能用。",
      "识别完成后，工具栏 **识别** 按钮可切换到「二值图 + 半透明识别结果叠加」的核对视图，配合右侧下拉选择 附近浮窗 / 原位叠加 / 仅原图 三种视图，点识别对象可定位到对应代码。",
      "识别结果建议再人工校对——尤其是歌词和复杂节奏。",
    ],
  },
  {
    title: "导入 ABC / MusicXML",
    body: [
      "**ABC 记谱**（`.abc`）：拖入或打开后自动转成简谱排版，支持多声部、反复、一二房、和弦、装饰音、歌词等。",
      "**MusicXML**（`.xml` / `.musicxml`）：导入后若是多声部（如四部合唱）会自动进入**混排**模式（五线谱 + 简谱）。",
    ],
  },
  {
    title: "混排与乐句排版",
    body: [
      "**混排**：导入 MusicXML/ABC 后可用，切换 五线谱+简谱 对照排版；混排下代码区只读。",
      "**乐句排版**：按乐句自动断行，可随时切回原始排版。",
      "两者都只在导入乐谱后才可用（按钮平时禁用）。",
    ],
  },
  {
    title: "播放",
    body: [
      "工具栏 **播放** / **停止**，简谱模式下可试听；播放时当前发声的音符会高亮。若先点选了某个音符，则从该处开始播放。",
      "多声部时可在 **选项** 里调各声部音量。",
      "**macOS 桌面版**可使用系统原生音色，音质更好。",
    ],
  },
  {
    title: "导出",
    body: [
      "工具栏 **导出**。简谱模式可导出 **PNG**（当前页）、**PPTX**（矢量，逐页成幻灯片）、**MIDI**（含反复/力度/声部音量）。",
      "混排模式可导出 **PDF**：**桌面版**直接存盘，**浏览器版**走浏览器打印对话框（打印成 PDF）。",
    ],
  },
  {
    title: "选项",
    body: [
      "工具栏 **选项** 可设置：谱面比例（16:9 / 4:3 / A4）、每页行数、字号（基础 / 标题 / 词曲信息）、颜色。",
      "多声部简谱还有各声部音量；混排模式下可勾选「隐藏小节号」。",
    ],
  },
  {
    title: "键盘快捷键",
    body: [],
    extra: shortcutTable,
  },
];

function shortcutTable(): HTMLElement {
  const rows: [string, string][] = [
    ["放大 / 缩小", "Ctrl/⌘ +  ·  Ctrl/⌘ -"],
    ["复位缩放 100%", "Ctrl/⌘ 0"],
    ["上一页 / 下一页", "PageUp  ·  PageDown"],
    ["首页 / 末页", "Ctrl/⌘ Home  ·  Ctrl/⌘ End"],
    ["按 Ctrl/⌘ 滚轮", "以指针为中心缩放"],
  ];
  const table = el("table", "help-shortcuts");
  for (const [act, key] of rows) {
    const tr = el("tr");
    tr.append(el("td", undefined, act), el("td", undefined, key));
    table.append(tr);
  }
  return table;
}

function buildFeatureHelp(): HTMLElement {
  const pane = el("div", "help-pane");
  pane.append(para("下面列出编辑器已有的功能，点标题展开查看详情。带徽标的功能在桌面版与浏览器版行为不同。", "help-intro"));
  for (const t of FEATURE_TOPICS) {
    const det = el("details", "help-topic");
    const sum = el("summary");
    sum.append(el("span", "help-topic-title", t.title));
    for (const b of t.badges ?? []) sum.append(el("span", "help-badge", BADGE_TEXT[b]));
    det.append(sum);
    for (const line of t.body) det.append(para(line));
    if (t.extra) det.append(t.extra());
    pane.append(det);
  }
  return pane;
}

// ---- 记谱法 ----------------------------------------------------------------

interface NoteEx {
  /** 小节标题。 */
  title: string;
  /** 「常用」或「进阶」定位标签。 */
  level: "常用" | "进阶";
  /** 说明段落（支持 **粗** 与 `代码`）。 */
  body: string[];
  /** 展示给用户看的源码（通常是 .Voice 里的一行）。 */
  code: string;
  /** 实际用于渲染的完整 jpwabc；缺省时用默认包裹 code。若 code 以 `.` 开头（含段头）则直接整体渲染。 */
  render?: string;
  /** 渲染独立的标题页（展示 Title/SubTitle/词曲 版式）而非乐谱内容页。 */
  titlePage?: boolean;
}

/** 把一段 .Voice 内容包成可渲染的最小完整 jpwabc（空标题，只设调号/拍号，避免抬头干扰）。 */
function wrapVoice(voice: string, key = "1=C", meter = "4/4"): string {
  return `.Title\nKeyAndMeters = {${key},${meter}}\n.Voice\n${voice}\n`;
}

const GLOSSARY: [string, string][] = [
  ["唱名 1–7", "简谱用数字 1234567 表示 do re mi fa so la si 七个音，`0` 是休止（不出声）。"],
  ["八度点", "音符上方或下方的小圆点，往上一个点高八度、往下一个点低八度。"],
  ["减时线", "写在音符**下方**的短横线，一条把时值减半（八分音符），两条再减半（十六分）。"],
  ["增时线", "音符**右侧**的横线 `-`，每条把时值延长一拍。"],
  ["附点", "音符右侧的小圆点 `.`，把时值延长一半（如四分附点 = 四分 + 八分）。"],
  ["小节线 / 拍号", "`|` 分隔小节；`拍号` 如 `4/4` 表示每小节四拍、以四分音符为一拍。"],
  ["调号", "如 `1=C` 表示 do 唱作 C，决定整首曲子的音高基准。"],
  ["连音线 / 延音线", "音符间的弧线：跨不同音高叫圆滑线（连奏），跨相同音高叫延音线（把两音连成一个长音）。"],
];

const NOTATION: NoteEx[] = [
  {
    title: "音符与休止",
    level: "常用",
    body: [
      "简谱用数字 **1–7** 表示七个唱名（do re mi fa so la si），**0** 表示**休止符**（该拍不发声）。",
      "音符之间可以留空格，也可以不留。",
    ],
    code: "1 2 3 4 5 6 7 0",
  },
  {
    title: "高低八度（八度点）",
    level: "常用",
    body: [
      "**八度点**：音符**上方**加一个 `'`（撇号）升高一个八度，**下方**加一个 `,`（逗号）降低一个八度；加两个点就是两个八度。",
      "在源码里写在数字**后面**：`1'` 是高音 do，`1,` 是低音 do。",
    ],
    code: "1, 1 1' 5, 5 5'",
  },
  {
    title: "升号与降号",
    level: "常用",
    body: [
      "在数字**前**加 `#` 升半音、加 `b` 降半音。",
      "例如 `#4` 是升 fa、`b7` 是降 si。",
    ],
    code: "1 #1 2 #2 3 4 #4 5",
  },
  {
    title: "时值：减时线与十六分",
    level: "常用",
    body: [
      "**减时线**（音符下方的下划线 `_`）把时值减半：一条 `_` 是八分音符，两条 `__` 是十六分音符。",
      "相邻的短音符会自动用横梁连起来。",
    ],
    code: "1 2 3_ 3_ 4 5__ 5__ 5__ 5__",
  },
  {
    title: "时值：附点与增时线",
    level: "常用",
    body: [
      "**附点** `.`（音符右侧小圆点）把时值延长一半：`5.` 是附点四分音符。常与减时线搭配成 `5. 5_`（附点节奏）。",
      "**增时线** `-`（音符右侧横线）每条延长一拍：`5-` 是二分音符、`5---` 是全音符。",
    ],
    code: "5. 5_ 5 5 |1- 1 |1--- |",
  },
  {
    title: "小节线、拍号与调号",
    level: "常用",
    body: [
      "`|` 是**小节线**，分隔小节。曲子的**拍号**和**调号**写在 `.Title` 段的 `KeyAndMeters` 里，格式 `{声部号=调,拍号}`，如 `{1=G,3/4}`。",
      "拍号也可以在 `.Voice` 中途改变，直接写 `3/4` 这样的记号即可。",
    ],
    code: ".Title\nKeyAndMeters = {1=G,3/4}\n.Voice\n5 1' 1' |6 1' 1' |5 4 3 |2- 0 |",
  },
  {
    title: "反复记号",
    level: "常用",
    body: [
      "反复记号让一段乐句重复演奏：`|:` 是反复开始、`:|` 是反复结束，中间的小节要唱两遍。",
      "`||` 是双小节线（分句），`|]` 是终止线（曲终）。",
    ],
    code: "1 2 3 4 |: 5 6 7 1' :| 1--- |]",
  },
  {
    title: "连音线与延音线",
    level: "进阶",
    body: [
      "音符之间的弧线：跨**不同**音高是**圆滑线**（连奏、一弓/一口气唱），跨**相同**音高是**延音线**（把两个音连成一个更长的音）。",
      "在源码里用圆括号 `( ... )` 括住要连起来的音符。",
    ],
    code: "(5 6) (1' 1') 3 2 |1--- |",
  },
  {
    title: "延音记号（fermata）",
    level: "进阶",
    body: [
      "在音符**前面**写 `{YanYin}` 加**延音记号**（fermata，音符上方的「◠」），表示这个音可以自由延长。",
    ],
    code: "5 5 5 5 |{YanYin}1 - - - |]",
  },
  {
    title: "歌词",
    level: "常用",
    body: [
      "歌词写在 `.Words` 段。前缀 `W1@1,1:` 表示第 1 段歌词、从第 1 小节第 1 个音符开始对齐。",
      "每个字**默认对一个音符**；用 `/` 表示这个音符**不换字**（一字多音的拖腔）。多段歌词用 `W1` `W2` 分别写。",
    ],
    code: ".Title\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 |5- 5- |\n.Words\nW1@1,1:\n我 们 歌 唱 主/爱/",
    render:
      ".Title\nTitle = {示例}\nKeyAndMeters = {1=C,4/4}\n.Voice\n1 2 3 4 |5- 5- |\n.Words\nW1@1,1:\n我 们 歌 唱 主/爱/\n",
  },
  {
    title: "标题信息",
    level: "常用",
    body: [
      "`.Title` 段放曲子的抬头信息：`Title` 是标题（居中显示在最上方）、`WordsByAndMusicBy` 是词曲作者（格式 `{词作者,曲作者}`）；`KeyAndMeters` 设置调号与拍号。",
      "下面这段会渲染出标题页的抬头版式。",
    ],
    code: ".Title\nTitle = {奇异恩典}\nKeyAndMeters = {1=G,3/4}\nWordsByAndMusicBy = {John Newton,美国民谣}\n.Voice\n5 1'. 1'_ 3' |2'- 1'- |",
    titlePage: true,
  },
];

function buildNotationHelp(app: App): HTMLElement {
  const pane = el("div", "help-pane");
  pane.append(
    para(
      "`.jpwabc` 是本项目使用的**纯文本简谱格式**，用普通文本分段描述乐谱：`.Title`（抬头）、`.Voice`（旋律，必需）、`.Words`（歌词）等，段头独占一行、以 `.` 开头。下面按**常用在前**的顺序介绍常见记号，每条都附实时渲染的效果。",
      "help-intro",
    ),
  );

  // 术语速查
  const gloss = el("details", "help-glossary");
  gloss.append(el("summary", undefined, "术语速查（点开）"));
  const dl = el("dl", "help-gloss-list");
  for (const [term, desc] of GLOSSARY) {
    dl.append(el("dt", undefined, term));
    const dd = el("dd");
    dd.append(rich(desc));
    dl.append(dd);
  }
  gloss.append(dl);
  pane.append(gloss);

  for (const ex of NOTATION) {
    const sec = el("div", "help-section");
    const head = el("div", "help-sec-head");
    head.append(el("span", "help-sec-title", ex.title));
    head.append(el("span", `help-level help-level-${ex.level === "常用" ? "common" : "adv"}`, ex.level));
    sec.append(head);
    for (const line of ex.body) sec.append(para(line));

    const card = el("div", "help-example");
    const pre = el("pre", "help-source");
    pre.textContent = ex.code;
    card.append(pre);

    const renderText = ex.render ?? (ex.code.trimStart().startsWith(".") ? ex.code : wrapVoice(ex.code));
    const svg = app.renderExampleSvg(renderText, { titlePage: ex.titlePage });
    if (svg) {
      const box = el("div", "help-render");
      svg.classList.add("help-svg");
      box.append(svg);
      card.append(box);
    }
    sec.append(card);
    pane.append(sec);
  }
  return pane;
}

/** 渲染出的示例 svg 默认是整页 viewBox；attach 到 DOM 后裁剪到内容紧包围盒。 */
function cropExamples(root: HTMLElement): void {
  for (const svg of Array.from(root.querySelectorAll<SVGSVGElement>("svg.help-svg"))) {
    let bb: DOMRect;
    try {
      // svg.getBBox() gives the union bbox of all descendants in viewBox space,
      // accounting for their transforms (unlike a child <g>.getBBox()).
      bb = svg.getBBox();
    } catch {
      continue;
    }
    if (bb.width <= 0 || bb.height <= 0) continue;
    const pad = 6;
    const vw = bb.width + pad * 2;
    const vh = bb.height + pad * 2;
    svg.setAttribute("viewBox", `${bb.x - pad} ${bb.y - pad} ${vw} ${vh}`);
    const dispH = Math.min(96, Math.max(36, vh));
    svg.style.height = `${dispH}px`;
    svg.style.width = `${(vw / vh) * dispH}px`;
  }
}

// ---- 对话框 ----------------------------------------------------------------

export function showHelpDialog(app: App): void {
  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal-box help-box");

  const title = el("div", "modal-title", "帮助");

  // 标签页头
  const tabs = el("div", "help-tabs");
  const tabFeature = el("button", "help-tab active", "功能帮助");
  const tabNotation = el("button", "help-tab", "记谱法");
  tabs.append(tabFeature, tabNotation);

  // 内容区
  const content = el("div", "help-content");
  const featurePane = buildFeatureHelp();
  const notationPane = buildNotationHelp(app);
  notationPane.style.display = "none";
  content.append(featurePane, notationPane);

  let cropped = false;
  const activate = (feature: boolean) => {
    tabFeature.classList.toggle("active", feature);
    tabNotation.classList.toggle("active", !feature);
    featurePane.style.display = feature ? "" : "none";
    notationPane.style.display = feature ? "none" : "";
    // getBBox only works once the pane is visible; crop on first reveal.
    if (!feature && !cropped) {
      cropExamples(notationPane);
      cropped = true;
    }
    content.scrollTop = 0;
  };
  tabFeature.onclick = () => activate(true);
  tabNotation.onclick = () => activate(false);

  const footer = el("div", "modal-footer");
  const closeBtn = el("button", undefined, "关闭");
  footer.append(closeBtn);

  box.append(title, tabs, content, footer);
  overlay.append(box);
  document.body.append(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  closeBtn.onclick = close;
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  document.addEventListener("keydown", onKey);
}
