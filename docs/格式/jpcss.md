# `.jpcss` 歌本样式表

> 一本歌本一份 `.jpcss`：**样式**（角色的字体/字号/对齐）+ **模板**（哪个字段排进哪个槽位、按什么格式印）
> + **装页**（新页/接排/半页起排、目录）。机制与级联见 [../样式机制.md](../样式机制.md)；
> 数据项（`SongMeta`）见 [../模块/模型-scoredoc.md](../模块/模型-scoredoc.md)。
>
> 状态：解析/写出（`src/style/jpcss.ts`）、模板排版（`src/style/template.ts`）、`hymn500` 与 `kl2020` 两份歌本已落地；
> `pu-original`、编辑器接入待做，见 [../待办.md](../待办.md) §2.3。

## 0. 为什么模板和样式放一个文件

- 同一套**级联**：内置主题 → 歌本 `.jpcss` → 曲内覆盖 → 用户层（[../样式机制.md](../样式机制.md) §3）。
- 同一套**上下文限定**：`@media (engine: …)` 对角色样式和模板一样有效。
- 同一套**单位**（pt / em / sp / tenths）与**实测值引用**（`ref()` / `metric()`）。

曲目清单（有哪些歌、顺序、逐曲 meta 覆盖）是**数据**，不进 `.jpcss`，放书清单 `book.json`（§8），清单用 `style:` 引用 `.jpcss`。

**样式表不改谱面内容，也不做逐曲规则**：小音符、段号改写、符干、文字换行、逐曲的和弦/文字位置微调、某段歌词换字体，
都先用脚本改好 MusicXML（KL2020 见 `scripts/kl2020-prep.mjs`，写 `<cue/>`、`<stem>`、`relative-x/relative-y`、
`<text font-family>` 等标准写法），`.jpcss` 只管全书统一的版式。写了 `@song` 或 `角色[…]` 的样式表解析时直接报错。

内置三份：

| 文件 | 歌本 | 基准 |
|---|---|---|
| `src/style/books/hymn500.jpcss` | 诗歌 500 首成书（`engine: book`） | 现有 `rebuild.mjs` 输出逐字节不变 |
| `src/style/books/kl2020.jpcss` | 声合为一 KL2020（`engine: mixed`） | 单曲版 PDF；接排版对照 1219 版 |
| `src/style/books/pu-original.jpcss` | 文本谱原样档（`engine: pu`）：目前只有页脚区域，页头仍是 `paintHeader` | 展开档指纹与 page-check 不变 |

## 1. 词法

- 编码 UTF-8；注释 `/* … */`。
- 标识符：字母、数字、`-`、`_`、`.`（字段路径）；中文写在字符串里。
- 字符串：`"…"` 或 `'…'`，`\"` 转义。字符串里的 `{…}` 是插值（§5），字面量花括号写成 `{{` `}}`。
- 长度：`12pt` `0.8em` `2sp` 或裸数字（缺省 pt）。颜色 `#rrggbb` / `#aarrggbb`。
- 语句以 `;` 结尾，块用 `{ }`。解析错误报 `行:列`。

## 2. 顶层语句

| 语句 | 作用 | 落到 |
|---|---|---|
| `@book { engine: jianpu\|book\|mixed\|pu; unit: pt\|tenths; }` | 谱面走哪个排版器；本文件裸数字的单位 | 清单/脚本选择引擎 |
| `@page { size: A4 \| w h; margin: t [r b l]; mirror: true; }` | 纸与版心 | `StyleSheet.page` |
| `@font-face 名 { family; file; face; mode: font\|path; bold; }` | 具名字体 | `FontRef` |
| `角色, 角色… { 声明 }` | 角色样式 | `StyleSheet.roles` |
| `@template 区域 { … }` | 模板区域（§4） | `StyleSheet.template` |
| `@flow { … }` | 装页（§6） | `StyleSheet.template.flow` |
| `@media (维度: 值) and (…) { … }` | 按 mode / engine 限定 | `StyleRule.when` |
| `@jianpu` `@pu` `@staff { 键: 值; }` | 各尺子的 `overrides`（`@staff` 另收 `MixedOptions` 的布尔开关，如 `showKeyChangeJp: false`） | `StyleSheet.jianpu/pu/staff` |

**级联没有 CSS 的特异性**：层序优先，同层按出现顺序，后写的覆盖先写的——与 `computeStyle` 一致。

## 3. 角色样式

```css
title        { font: hei; size: 22pt; color: #ff000000; }
credit, rights { font: hei-light; size: 8pt; features: hwid; }
```

声明（`RoleDecl`）：`font`（@font-face 名）、`family`（直接给字体族）、`size`、`weight`、`italic`、`color`、
`align: left|center|right|inner|outer`、`line-height`、`features`（OpenType 特性，如 `hwid`）、`visible`。认不出的属性报错。

角色表见 `src/style/sheet.ts::StyleRole`；在原有 20 个之外，新增 `titleAlt` `epigraph` `epigraphRef` `rights`
`scriptureRefs` `tags` `note`（页脚注释）。

## 4. 模板区域

区域名是固定的一组，由排版器在固定时机调用：

| 区域 | 何时 | 500 首 | KL2020 | 文本谱 |
|---|---|---|---|---|
| `song-head` | 本曲首帧之前 | fixed：曲号/标题/调号/署名 | block：标题/英文/经文 | 标题、Z、TL/TR、XL/XR、调号、J 文字 |
| `song-foot` | 本曲末帧之后 | — | block：词曲版权/经文标签 | block：BL/BC/BR |
| `page-header` | 每页 | 分类名放装订侧 | — | — |
| `page-footer` | 每页 | `·{n}·` | 不印 | — |
| `toc` | 目录页 | —（仍由 `bookparts.ts::tocPages` 排） | 诗歌目录 | — |

### 4.1 区域属性

| 属性 | 值 | 说明 |
|---|---|---|
| `flow` | `fixed` \| `block` | fixed：按页内绝对基线定位，不占谱面高度；block：占高度，把谱面往下推 |
| `align-x` | `page` \| `content` | 居中和左右对齐的参照：整页还是版心 |
| `inset` | 长度 | 左右各缩进 |
| `extent` | 长度表达式，可含 `content` | 区域高。`content + 100`、`content * 1.5 + 40` |
| `gap-before` / `gap-after` | 长度 | 与谱面的间距 |
| `line-height` | 倍数 | block：格内换行 = 该行字高 × 它（原排版程序 1.444） |
| `line-box` | 倍数 | block：每行计入块高的倍数（× 字高，缺省 1）；可写在格上 |
| `display` | `false` \| 表达式 | 关闭整个区域 |

### 4.2 行与格

```css
row(baseline: ref(book.titleBlock.titleBaseline)) { center: "{work.title}" as title; }
row { left: "{creators.lyricist}", "{creators.composer}" as credit; right: "…" as tags; }
```

- `row(baseline: 长度表达式)`：fixed 区域里是页内绝对基线（加区域 `dy`），block 区域里是相对区域顶的基线（首行不加 ascent）。
- `row(top: 长度表达式)`：仅 block 区域，行顶相对区域顶固定（首行基线 = 行顶 + ascent），不接上一行块底；块高照常计入。
- block 区域不写 baseline 的行接在上一行块底，`row(gap-before: 29)` 再空一段（不计入块高）；首行基线 = 行顶 + 字体 ascent。
- 格有五个槽位：`left | center | right | inner | outer`。`inner`/`outer` 按页码奇偶换边（装订侧/切口侧）。
- 槽位的值是逗号分隔的一串**行**，每行是一个内容表达式，可带 `as 角色`。不写 `as` 时继承本槽位最后一个 `as`，
  再没有就用 meta 注册表里该字段的默认角色。
- 简写：`center: "{work.title}" as title;` 块形式带几何：

```css
left { content: key-meter(); role: keyMeter; dx: 2.3; dy: -5; avoid: chord note gap 1.5 scan 60; }
right { content: "{creators.* | lines | label-by-type}"; role: credit; dx: -8.7; line-gap: ref(book.titleBlock.creditLineGap); }
```

格属性：`content`、`role`、`at`（绝对 x）、`dx`、`dy`、`line-gap`、`avoid`（避让：往上抬，直到让开指定角色的墨迹）。

## 5. 内容表达式

### 5.1 插值与空值折叠

`"前缀{字段路径 | 过滤器 | …}后缀"`。

**空值折叠**：一行里所有插值字段都为空时，整行（连同前后缀文字）不输出；一个 row 所有槽位都空时，这个 row 不占高。
（musicpp 的「非空才加一行」和 rebuild `put()` 的 `if (!text) return` 是同一个意思。）

多值字段（`string[]`）默认每项一行；要合成一行用 `| join('；')`。

### 5.2 字段路径

| 路径 | 取自 |
|---|---|
| `work.title` `work.number` `work.subtitles` | `Song.work` |
| `creators.lyricist` `creators.composer` `creators.arranger` `creators.translator` `creators.transcriber` `creators.*` | `identification.creators` 按类型 |
| `identification.rights` | 版权 |
| `pageText.indexLeft` … `pageText.bottomRight` | 文本谱七项 |
| `meta.<键>` | `Song.meta`，注册键或未知键都可以 |
| `page.no` `page.label` | 当前页（物理页码 / 印刷页码标签） |
| `toc.seq` `toc.page` `toc.pad` | 目录条目上下文 |

### 5.3 过滤器

| 过滤器 | 作用 |
|---|---|
| `strip-zero` | 曲号去前导 0 |
| `label-by-type` | 没带冒号标签的署名，按 creator 类型补「作词：」「作曲：」「编曲：」 |
| `strip-parens` | 去掉括号及括号里的内容（中英文括号都算） |
| `cn-semicolon` | `;` → `；` |
| `split-paren` | `甲（乙）` 拆成 `甲`、`乙` 两行 |
| `unescape-newline` | 字面 `\n` → 换行 |
| `dash-empty` | 值为 `-` 视为空 |
| `sharp-flat` | 调号里的 b/# → ♭/♯，并把升降号挪到字母前 |
| `trim` `upper` `first` `lines` `join(s)` | 通用 |

### 5.4 组件

非纯文字、会产出多个图元的内容，由 TS 实现：

| 组件 | 产出 |
|---|---|
| `key-meter()` | 成书调号 + 叠排拍号（`bookparts.ts::keyMeterItems`） |

## 6. 装页 `@flow`

| 属性 | 值 | 谁读 |
|---|---|---|
| `song-start` | `new-page` \| `continue` | 混排歌本（`pdflayout/songbook.ts`）：每首另起一页 / 接排，放不下才换页；接排时逐曲按清单 `meta["layout.new-page"]` |
| `song-start: half-page` 及 `mid-start-gap` `music-top` … | — | 500 首的半页起排与正反面装箱仍在 `rebuild.mjs`（line-check 把关），这几项只作记录 |

## 7. 长度表达式

- 可以做四则运算，`calc()` 可省。
- 引用：
  - `ref(book.<路径>)`：`BookStyle`（bookstyle.json）的实测值。
- **实测常量不抄进 `.jpcss`**，一律用 `ref()` 引用：一是保证浮点逐位一致，二是重跑统计脚本后能自动跟随。
- `extent` 里可用 `content`（区域内容高）。

## 8. 书清单 `book.json`

```json
{
  "id": "kl2020",
  "title": "声合为一",
  "style": "kl2020.jpcss",
  "songs": [
    { "file": "十架大能/十架大能（最终）.fixed.xml",
      "meta": { "title-alt": ["The Power of the Cross"], "layout.new-page": ["true"], "layout.chinese-hyphen": ["true"] } }
  ]
}
```

- `title` / `number` / `creators` / `rights` 覆盖谱文件里的对应字段（`creators` 整组替换）；`root` 是谱文件与字体文件的根目录。
- `meta` 按键**浅覆盖**谱文件自带的 `Song.meta`，以清单为准。
- `file` 指向改谱脚本另存的 `.fixed.xml`（没有改谱的曲目指原文件）。XML 表达不了的排版开关（`layout.chinese-hyphen`、`layout.melody-only`、`layout.new-page`）写在 `meta`。
- 清单由导入脚本从曲目库生成（`gen-manifest-kl2020.mjs`），再由 `kl2020-prep.mjs` 改谱并回写 `file` 与开关；库路径由参数或环境变量给。

## 9. 示例

直接看三份内置歌本（都能被 `scripts/jpcss-roundtrip.mjs` 解析、写出、再解析）：

- `src/style/books/hymn500.jpcss`：fixed 区域 + `ref(book.titleBlock.*)` 引用实测值 + `key-meter()` 组件（避让首行和弦）。
- `src/style/books/kl2020.jpcss`：block 区域（标题块、页脚块按原排版程序与成品实测）、`@font-face` 字体文件、目录区域。
- `src/style/books/pu-original.jpcss`：文本谱页脚（BL/BC/BR，`dash-empty` 去 `-` 占位）。
