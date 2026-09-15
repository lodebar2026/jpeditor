# `.jpcss` 歌本样式表

> 一本歌本一份 `.jpcss`：**样式**（角色的字体/字号/对齐）+ **模板**（哪个字段排进哪个槽位、按什么格式印）
> + **装页**（新页/接排/半页起排、目录）。机制与级联见 [../样式机制.md](../样式机制.md)；
> 数据项（`SongMeta`）见 [../模块/模型-scoredoc.md](../模块/模型-scoredoc.md)。
>
> 状态：解析/写出（`src/style/jpcss.ts`）、模板排版（`src/style/template.ts`）、`hymn500` 与 `kl2020` 两份歌本已落地；
> `pu-original`、编辑器接入待做，见 [../待办.md](../待办.md) §2.3。

## 0. 为什么模板和样式放一个文件

- 同一套**级联**：内置主题 → 歌本 `.jpcss` → 曲内覆盖 → 用户层（[../样式机制.md](../样式机制.md) §3）。
- 同一套**上下文限定**：`@media (page: odd)`、`@song "…"` 对角色样式和模板一样有效。
- 同一套**单位**（pt / em / sp / tenths）与**实测值引用**（`ref()` / `metric()`）。

曲目清单（有哪些歌、顺序、逐曲 meta 覆盖）是**数据**，不进 `.jpcss`，放书清单 `book.json`（§8），清单用 `style:` 引用 `.jpcss`。

内置三份：

| 文件 | 歌本 | 基准 |
|---|---|---|
| `src/style/books/hymn500.jpcss` | 诗歌 500 首成书（`engine: book`） | 现有 `rebuild.mjs` 输出逐字节不变 |
| `src/style/books/kl2020.jpcss` | 声合为一 KL2020（`engine: mixed`） | 单曲版 PDF；接排版对照 1219 版 |
| `src/style/books/pu-original.jpcss` | 文本谱原样档（`engine: pu`）：目前只有页脚区域，页头仍是 `paintHeader` | 展开档指纹与 page-check 不变 |

## 1. 词法

- 编码 UTF-8；注释 `/* … */`。
- 标识符：字母、数字、`-`、`_`、`.`（字段路径）；中文可以出现在字符串里，也可以出现在 `@song` 的名字里。
- 字符串：`"…"` 或 `'…'`，`\"` 转义。字符串里的 `{…}` 是插值（§5），字面量花括号写成 `{{` `}}`。
- 长度：`12pt` `0.8em` `2sp` `75tenths` 或裸数字（按 `@book { unit }`，缺省 pt）。`+2pt` 表示相对继承值加减。
- 语句以 `;` 结尾，块用 `{ }`。解析错误报 `行:列`。

## 2. 顶层语句

| 语句 | 作用 | 落到 |
|---|---|---|
| `@book { engine: jianpu\|book\|mixed\|pu; unit: pt\|tenths; }` | 谱面走哪个排版器；本文件裸数字的单位 | 清单/脚本选择引擎 |
| `@import "x.jpcss";` | 就地展开公共片段 | — |
| `@page { size: A4 \| w h; margin: t [r b l]; mirror: true; }` | 纸与版心 | `StyleSheet.page` |
| `@page :odd \| :even \| :first { … }` | 按页位覆盖 | `when: { page }` |
| `@font-face 名 { family; file; face; mode: font\|path; bold; }` | 具名字体 | `FontRef` |
| `角色[限定]…, 角色… { 声明 }` | 角色样式 | `StyleSheet.roles` / scoped 规则 |
| `@template 区域 { … }` | 模板区域（§4） | `StyleSheet.template` |
| `@flow { … }` | 装页（§6） | `StyleSheet.template.flow` |
| `@media (维度: 值) and (…) { … }` | 按 mode / engine / page 限定 | `StyleRule.when` |
| `@song "标题" \| #曲号 { … }` | 逐曲：角色样式、模板覆盖、`@flow` 都可写 | `when: { song }` |
| `@jianpu` `@pu` `@staff { 键: 值; }` | 各尺子的 `overrides` | `StyleSheet.jianpu/pu/staff` |
| `@book-metrics { 路径: 值; }` | `BookStyle` 深块的少量覆盖 | `StyleSheet.book` |

**级联没有 CSS 的特异性**：层序优先，同层按出现顺序，后写的覆盖先写的——与 `computeStyle` 一致。

## 3. 角色样式

```css
title        { font: hei; size: 22pt; color: #000; }
lyric[part="P2"] { size: 0.8em; }
credit, rights { font: hei-light; size: 8pt; features: hwid; line-height: 1.45; }
```

声明（`RoleDecl`）：`font`（@font-face 名）、`family`（直接给字体族）、`size`、`weight`、`italic`、`color`、
`align: left|center|right|inner|outer`、`line-height`、`dx`、`dy`、`features`（OpenType 特性，如 `hwid`）、`visible`。

角色表见 `src/style/sheet.ts::StyleRole`；在原有 20 个之外，新增 `titleAlt` `epigraph` `epigraphRef` `rights`
`scriptureRefs` `tags` `note`（页脚注释）。

### 3.1 限定（选择器）

`角色[维度 op 值]`，`op` ∈ `= != > >= < <= *=`（`*=` 表示包含子串）。维度：

| 维度 | 含义 | 维度 | 含义 |
|---|---|---|---|
| `mode` | 档位 expanded/original/staff/mixed | `verse` | 第几段歌词（元素级） |
| `engine` | jianpu/pu/book/staff | `measure` | 小节号（1 基） |
| `page` | left/right/first | `beat` | 拍位（小节内，四分音符为 1） |
| `song` | 曲名或 `#曲号`（`@song`） | `text` | 元素原文 |
| `part` | 声部 id（P1…） | `glyph` | SMuFL 码位 |
| `voice` | 声部内的 voice | `name` | 歌词行原名（MusicXML `<lyric number>`，如 `part1verse5`） |

**伪角色 `score`**：整曲开关，例如 `score { chinese-hyphen: true; melody-only: true; hide-bar-number: true; }`；
`cue[measure>=22][measure<=23][beat>=1.5] { cue: true; }` 表示这一段画成小音符。

上下文维度只有 `mode` / `engine` / `page`（落到 `StyleRule.when`）；其余都是**元素级**，落成 scoped 规则。

**元素级属性**（scoped 规则专用，混排已接，见 `src/mixed/scoped.ts`）：

| 角色 | 限定 | 属性 |
|---|---|---|
| `lyric` | verse measure part name | `family` `size`（`+2pt` 相对） `dy` |
| `verseNum` | verse measure text | `text`（改写段号原文，`1.` → `1-3.`） |
| `chord` | measure beat text（`*=add9`） | `dx` `dy` |
| `direction` | measure text glyph（`U+E047`） | `dx` `dy` `text-split: each` `blank-after: 1 3`（第几项之后空一行，0 基） |
| `note` | measure beat voice part | `cue: true|false` `stem: up|down` |
| `score` | — | `chinese-hyphen: true` |

`+2pt` 这种带正号的值是相对继承值，写出成 `inherit + 2pt`。

## 4. 模板区域

区域名是固定的一组，由排版器在固定时机调用：

| 区域 | 何时 | 500 首 | KL2020 | 文本谱 |
|---|---|---|---|---|
| `song-head` | 本曲首帧之前 | fixed：曲号/标题/调号/署名 | block：标题/英文/经文 | 标题、Z、TL/TR、XL/XR、调号、J 文字 |
| `song-foot` | 本曲末帧之后 | — | block：词曲版权/经文标签 | block：BL/BC/BR |
| `page-header` | 每页 | 分类名放装订侧 | — | — |
| `page-footer` | 每页 | `·{n}·` | 不印 | — |
| `toc` / `index` | 前置页/附录 | 目录、两份索引 | 诗歌目录 | — |
| `front` | 扉页/前言 | ✓ | — | — |

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
| `display` | `none` \| 表达式 | 关闭整个区域 |
| `skip` | `blank` `song-first-page` | 在这些页上不排 |

### 4.2 行与格

```css
row(baseline: ref(book.titleBlock.titleBaseline)) { center: "{work.title}" as title; }
row { left: "{creators.lyricist}", "{creators.composer}" as credit; right: "…" as tags; }
```

- `row(baseline: 长度表达式)`：fixed 区域里是页内绝对基线（加区域 `dy`），block 区域里是相对区域顶的基线（首行不加 ascent）。
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
| `key` `time` `tempos.words` | 调号、拍号、速度文字 |
| `pageText.indexLeft` … `pageText.bottomRight` | 文本谱七项 |
| `meta.<键>` | `Song.meta`，注册键或未知键都可以 |
| `page.no` `page.label` | 当前页（物理页码 / 印刷页码标签） |
| `song.seq` | 本曲在书中的序号 |
| `toc.seq` `toc.page` `toc.pad` `toc.category` | 目录条目上下文 |

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
| `pu-key-meter()` | 文本谱「1=♭E」+ 分数拍号 |
| `leader(dots)` | 点线引导 |
| `ornament-frame()` | 注解花边框 |

## 6. 装页 `@flow`

| 属性 | 值 | 说明 |
|---|---|---|
| `song-start` | `new-page` \| `continue` \| `half-page` | 每首另起一页 / 接在上一首下面，放不下才换页 / 成书半页起排 |
| `frame-gap` | 长度 | 帧间距取 max(上一帧的下间距, 本帧的上间距) |
| `mid-start-gap` | 长度 | 半页起排时，上一首墨迹底到本首曲号基线的距离 |
| `music-top` / `cont-music-top` | 长度 | 首页 / 续页首条谱行的顶 |
| `no-split-sheet` | bool | 一首歌不跨同一张纸的正反面 |
| `mirror` | bool | 偶数页镜像 |
| `page-numbers` | bool | 是否印页码（有 `page-footer` 时由它决定位置） |

逐曲覆盖：清单里的 `meta["layout.new-page"]`，或者 `@song "…" { @flow { song-start: new-page; } }`。

## 7. 长度表达式

- 可以做四则运算，`calc()` 可省。
- 引用：
  - `ref(book.<路径>)`：`BookStyle`（bookstyle.json）的实测值。
  - `metric(<键>)`：`PuMetrics` 的实测值。
  - `page-bottom` `page-width` `content-left` `content-right`：纸边与版心边。
- **实测常量不抄进 `.jpcss`**，一律用 `ref()`/`metric()` 引用：一是保证浮点逐位一致，二是重跑统计脚本后能自动跟随。

## 8. 书清单 `book.json`

```json
{
  "id": "kl2020",
  "title": "声合为一",
  "style": "kl2020.jpcss",
  "songs": [
    { "file": "拥戴我主为君/拥戴我主为君.xml",
      "meta": { "title-alt": ["Crown Him with Many Crowns"], "layout.new-page": ["true"] },
      "style": "lyric[verse=\"5\"] { family: \"楷体-简\"; }" }
  ]
}
```

- `title` / `number` / `creators` / `rights` 覆盖谱文件里的对应字段（`creators` 整组替换）；`root` 是谱文件与字体文件的根目录。
- `meta` 按键**浅覆盖**谱文件自带的 `Song.meta`，以清单为准。
- `style` 是本曲的 jpcss 片段，作为曲内覆盖层。
- 清单由导入脚本从现有数据库生成（`gen-manifest-kl2020.mjs`、`gen-manifest-500.mjs`），数据库路径由参数或环境变量给。

## 9. 示例

### 9.1 KL2020（数值取自原排版程序）

```css
@book { engine: mixed; unit: tenths; }
@page { size: 1322 1870; margin: 75; }

@font-face hei       { family: "Source Han Sans SC"; }
@font-face hei-light { family: "SourceHanSansSC-Light"; }
@font-face georgia   { family: "Georgia"; }

title    { font: hei; size: 22pt; }
titleAlt { font: georgia; size: 12pt; weight: bold; }
epigraph { font: hei-light; size: 10pt; }
credit, rights, scriptureRefs, tags { font: hei-light; size: 8pt; features: hwid; }
lyric    { features: hwid; }
lyric[part="P2"] { size: 0.8em; }

@template song-head {
  flow: block; align-x: page; extent: content + 100; gap-after: 20;
  row { center: "{work.title}" as title; }
  row { center: "{meta.title-alt}" as titleAlt; }
  row { center: "{meta.epigraph}" as epigraph; }
}
@template song-foot {
  flow: block; align-x: page; inset: 94; extent: content * 1.5 + 40; line-height: 1.45;
  row {
    left:  "{creators.lyricist}", "{creators.composer}", "{identification.rights}", "{meta.rights-extra}" as credit;
    right: "经文参考：{meta.scripture-refs}" as scriptureRefs,
           "标签：{meta.tags | strip-parens | join('；')}" as tags;
  }
}
@template page-footer { display: none; }
@template toc {
  unit: pt;
  title: "诗歌目录" as frontTitle; title-baseline: 60;
  entry { left: "{toc.seq}. {toc.pad}{work.title}" at 100; right: "{toc.page}" at 505;
          leader: dots to 500; line-height: 1.5; first-baseline: 100; link: page; outline: true; }
}
@flow { song-start: new-page; frame-gap: 20; }

@song "十架大能" {
  verseNum[measure>=17][text="1."] { text: "1-3."; }
  chord[text*="add9"] { dx: 20; }
  score { chinese-hyphen: true; }
}
```

### 9.2 500 首（fixed 区域 + ref）

```css
@book { engine: book; unit: pt; }
@template song-head {
  flow: fixed; align-x: content;
  row(baseline: ref(book.titleBlock.numberBaseline)) { outer: "{work.number | strip-zero}" as songNumber; }
  row(baseline: ref(book.titleBlock.titleBaseline))  { center: "{work.title}" as title; }
  row(baseline: ref(book.titleBlock.keyMeterBaseline)) {
    left { content: key-meter(); role: keyMeter; dx: 2.3; dy: -5; avoid: chord note gap 1.5 scan 60; }
  }
  row(baseline: ref(book.titleBlock.creditFirstBaseline)) {
    right { content: "{creators.* | lines | label-by-type}"; role: credit; dx: -8.7; line-gap: ref(book.titleBlock.creditLineGap); }
  }
}
@template page-header {
  display: ref(book.header.enable);
  row(baseline: ref(book.titleBlock.headerBaseline)) {
    inner { content: "{meta.category | split-paren}"; role: header; line-gap: 1.56em; }
  }
}
@template page-footer {
  skip: blank;
  row(baseline: ref(book.titleBlock.footerBaseline)) { center: "·{page.label}·" as footer; }
}
@flow { song-start: half-page; mid-start-gap: ref(book.titleBlock.midStartGap);
        music-top: ref(book.titleBlock.firstSystemTop); cont-music-top: ref(book.titleBlock.contSystemTop);
        no-split-sheet: true; mirror: true; }
```

半页起排的装箱仍由 `rebuild.mjs` 的 `packMid`/`packAlone` 实现（line-check 有判据把关），模板只提供标题块高度。

### 9.3 文本谱原样档（节选）

```css
@book { engine: pu; }
@template song-head {
  flow: fixed; align-x: page;
  row(baseline: metric(titleY)) { left: "{pageText.indexLeft}" as songNumber; center: "{work.title}" as title; right: "{pageText.indexRight}" as songNumber; }
  row(baseline: metric(authorY)) { left: "{pageText.topLeft}" as header; right: "{creators.* | lines}", "{pageText.topRight}" as credit; }
}
@template song-foot {
  flow: block; align-x: content;
  row { left: "{pageText.bottomLeft | dash-empty}" as note; center: "{pageText.bottomCenter | dash-empty}" as note; right: "{pageText.bottomRight}" as note; }
}
```
