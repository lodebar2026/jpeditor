# `.ss` 歌本样式表

> 一本歌本一份 `.ss`：**样式**（角色的字体/字号/对齐）+ **模板**（哪个字段排进哪个槽位、按什么格式印）
> + **装页**（新页/接排/半页起排、目录）。机制与级联见 [../样式机制.md](../样式机制.md)；
> 数据项（`SongMeta`）见 [../模块/模型-scoredoc.md](../模块/模型-scoredoc.md)。
>
> 状态：解析/写出（`src/style/ss.ts`）、模板排版（`src/style/template.ts`）、`hymn500` 与 `kl2020` 两份歌本已落地；
> 原样文档布局的内置表 `original` / `original-shige` 已落地，编辑器接入待做，见 [../待办.md](../待办.md) §2.3；语法本身的收敛（认不出的名字要报错等）记在 `docs/ss-收敛待办.md`（本地，不入库）。

## 0. 为什么模板和样式放一个文件

- 同一套**级联**：内置主题 → 歌本 `.ss` → 曲内覆盖 → 用户层（[../样式机制.md](../样式机制.md) §3）。
- 同一套**上下文限定**：`@media (engine: …)`、`@media (paged: …)` 对角色样式和模板一样有效。
- 同一套**单位**（pt / em / sp）。

曲目清单（有哪些歌、顺序、逐曲 meta 覆盖）是**数据**，不进 `.ss`，放书清单 `book.json`（§8），清单用 `style:` 引用 `.ss`。

**样式表不改谱面内容，也不做逐曲规则**：小音符、段号改写、符干、文字换行、逐曲的和弦/文字位置微调、某段歌词换字体，
都先用脚本改好 MusicXML（KL2020 见 `scripts/kl2020-prep.mjs`，写 `<cue/>`、`<stem>`、`relative-x/relative-y`、
`<text font-family>` 等标准写法），`.ss` 只管全书统一的版式。写了 `@song` 或 `角色[…]` 的样式表解析时直接报错。

内置一份 + 歌本样例三份（歌本样式照特定印刷本逐点量出，**不在本仓库**，本地私有仓库里留着）：

| 文件 | 歌本 | 基准 |
|---|---|---|
| `hymn500-measured.ss` + `hymn500.ss`（不在本仓库） | 诗歌 500 首成书（`engine: book`）：前者是统计生成的实测部分（§10），后者是模板与手调常量，按序叠 | 现有 `rebuild.mjs` 输出逐字节不变 |
| `kl2020.ss`（不在本仓库） | 声合为一 KL2020（`engine: mixed`） | 单曲版 PDF |
| `kl2020-flow.ss`（不在本仓库） | 同上的**接排版叠加表**（只含与单曲版的差异，清单 `styleByFlow.continue` 指过来） | 1219 接排版 PDF |
| `src/style/books/original.ss` + `original-shige.ss` | 原样文档布局（`engine: pu`；文本谱、MusicXML、多声部 123/ABC 的原样档）：前者是公共底表（页脚区域，页头仍是 `paintHeader`），后者叠诗歌本方言与出厂（番茄）的差异 | 原样档指纹与 page-check 不变 |

## 1. 词法

- 编码 UTF-8；注释 `/* … */`。
- 标识符：字母、数字、`-`、`_`、`.`（字段路径）；中文写在字符串里。
- 字符串：`"…"` 或 `'…'`，`\"` 转义。字符串里的 `{…}` 是插值（§5），字面量花括号写成 `{{` `}}`。
- 长度：`12pt` `0.8em` `2sp` 或裸数字（缺省 pt——混排那本书的裸数字就是 tenths，由 `@page` 的尺寸定口径）。颜色 `#rrggbb` / `#aarrggbb`。
- 语句以 `;` 结尾，块用 `{ }`。解析错误报 `行:列`。

## 2. 顶层语句

| 语句 | 作用 | 落到 |
|---|---|---|
| `@page { size: 宽 高; margin: 上 外 下 内 \| 一个数; mirror: true; }` | 纸与版心（成书的四边距配 `mirror` 按页奇偶换边） | `StyleSheet.page` |
| `@font-face 名 { family; file; face; mode: font\|path; bold; }` | 具名字体 | `FontRef` |
| `角色, 角色… { 声明 }` | 角色样式 | `StyleSheet.roles` |
| `@template 区域 { … }` | 模板区域（§4） | `StyleSheet.template` |
| `@flow { … }` | 装页（§6） | `StyleSheet.template.flow` |
| `@media (维度: 值) and (…) { … }` | 按 mode / engine / paged / page / verse 限定（§2.2） | `StyleRule.when` |
| `@jianpu` `@staff { 键: 值; }` | 简谱 / 五线谱内容的几何与开关（§2.1） | `StyleSheet.jianpu/staff` |
| `@break { 键: 值; }` | 断句（§2.3），与谱式无关 | `StyleSheet.break` |

**级联没有 CSS 的特异性**：层序优先，同层按出现顺序，后写的覆盖先写的——与 `computeStyle` 一致。

### 2.1 `@jianpu` / `@staff`：按谱面内容分，不按排版器分

| 块 | 管什么 | 各模式落到 |
|---|---|---|
| `@jianpu` | **简谱内容**：减时线、八度点、附点、简谱调号拍号、歌词开关 | 展开 / 原样 / 成书 → `LayoutOptions`；混排 → `MixedOptions` 的简谱层；原样文档布局 → `JianpuMetrics` |
| `@staff` | **五线谱内容**：谱表、符干符杠、小节线、和弦、SMuFL 记号 | 五线谱 / 混排 → `MixedOptions` |

混排里的那层简谱也归 `@jianpu`——写样式表不必知道内部是哪个排版器在跑。模式差异用 `@media (mode: …)` 限定。

```css
@jianpu { beam-width: 1.5; octave-dot-dist: 0.6sp; }
@staff  { staff-height: 30; stem: 1; beam: 5; barline: 1.5; }
@media (mode: mixed) { @jianpu { legacy-time-sig: true; show-key-change: false; } }
```

- 键名是 **kebab-case 逻辑键**，全表（以及各键在两个排版器上落到哪个字段）见 `src/style/keys.ts`。
  线宽是一级键（`stem` `beam` `leger` `barline` `final-barline` `staff-line`），只给宽度，颜色随 `@page { ink }`。
- **块里没有字体**：字体写在角色上（§3）。
- 认不出的键解析期报 `行:列`；某个模式不支持的键（如纯简谱下的 `beam-top-y`，那几处笔位由排版器自算）排版时告警忽略。
- 长度：`@staff` 与混排下的 `@jianpu` 裸数字是 tenths，带单位只收 `em`（= `smufl` 字号，出厂 40 tenths）/ `sp`（= 10 tenths）；
  纯简谱下 `em` = 音符字号，`sp` = 名义谱高 / 4。
- 块上还可写 `preset`（`@jianpu { preset: pptx }`、`@staff { preset: musicpp }`）。
- **成书**也读 `@jianpu`（`keys.ts` 的 `book` 一列，落到 `BookStyle.metrics` / `layout`）：间距类写 `em`
  （基准是音符字号；`lyric-gap` `slur-thickness` `barline` `final-barline` 按歌词字号），线宽类（`bracket-width`、
  `repeat-dot-diameter`）写裸数 pt。例：`@jianpu { system-gap: 0.8575em; beam-top: 0.1393em; verse-numbers: auto; }`。
  数值原样存进字段、不在读样式表时乘字号，所以重排结果逐位不变。
- **原样文档布局**（文本谱、MusicXML、多声部 123/ABC 的原样档）也读 `@jianpu`：`keys.ts` 的 `original` 一列，只给内置方言表用到的键配了
  （`beam-width` `lyric-gap` `lyric-stack` `system-gap`，及只有这一路有的 `voice-gap` `barline-height` `double-barline-gap` `dash-width` `dash-half-length`）。
  裸数 pt，`em` = 音符字号。字号字体照常写在角色上（`note { size; family }`、`lyric` `verseNum` `chord { size }`…）。以前的 `@pu` 块已删。

### 2.2 `@media` 维度

| 维度 | 取值 | 说明 |
|---|---|---|
| `mode` | `expanded` `original` `staff` `mixed` | 排版档位 |
| `engine` | `jianpu` `pu` `book` `staff` | 哪个排版器在吃样式 |
| `paged` | `true` `false` | 分页（有实际纸张）还是长图。由算出来的 `@page` 纸反推（级联两趟，见 `themes.ts::computeStyleForPaper`） |
| `page` / `verse` | `left` `right` `first` / 段号 | 只实现了匹配，还没有消费者 |

认不出的维度、`paged` 写了 `true`/`false` 以外的值，都报 `行:列`。

### 2.3 `@break`：断句

行怎么断**与谱式无关**，所以单独一块，不放 `@jianpu`（五线谱以后也用）。现在只有成书（`rebuild.mjs`）读：

```css
@break { enable: true; target-measures: 0; length-weight: 0.25; break-weight: 3; mid-break: true; parallel-weight: 6; }
```

键：`enable` `lines-per-page` `target-measures` `length-weight` `break-weight` `mid-break` `merge-short` `even-weight`
`tail-weight` `content-only` `parallel-weight` `tail-long-weight` `more-rows-slack` `fit-slack`，
各自的含义见 `pdflayout/bookstyle.ts::BookLayoutOpts`。

## 3. 角色样式

```css
title        { font: hei; size: 22pt; color: #ff000000; }
credit, rights { font: hei-light; size: 8pt; features: hwid; }
```

声明（`RoleDecl`）：`font`（@font-face 名）、`family`（直接给字体族）、`size`、`weight`、`color`、
`features`（OpenType 特性，如 `hwid`）。认不出的属性报错。**对齐由槽位决定**（`left`/`center`/`inner`…），不写在角色上。

成书另有两项：`align-mode`（逐字定位的口径：`pen` `ink-center` `left` `center` `right` `outer`，见 `sheet.ts::AlignMode`）
与 `baseline-adjust`（基线修正，× 字号）。成书的角色 `size` 也是**字号**（裸数 pt）；原书量到的墨迹高由生成脚本按样本字的墨迹占比换算后才写进来，样式值里不出现墨迹高。

角色表见 `src/style/sheet.ts::STYLE_ROLES`（20 个）与 `TEMPLATE_ROLES`（模板专用：`titleAlt` `scripture` `scriptureRef`
`rights` `relatedScriptures` `tags`）；认不出的角色名报 `行:列`。

**排版器自带的那几支字也由角色换**（对照表 `src/style/keys.ts::ROLE_FONTS`）。`font` / `family` / `weight` 在各模式都生效；
字号在纯简谱下仍走 `note { size }` 那一路（由它派生间距），混排里 `note { size }` 改简谱层字号、谱表上缩小的那支随谱高派生：

| 角色 | 纯简谱（展开 / 原样） | 五线谱 / 混排 |
|---|---|---|
| `note` | 音符数字 | 简谱层数字（谱表上那层按 `staff-height / 40` 缩小，自动跟随） |
| `lyric` | 歌词 | —（混排歌词字体由 MusicXML `<defaults>` 给） |
| `smufl` | 记号 | 五线谱字体（其字号是 `@staff` 里 `em` 的基准） |
| `chord` | — | 和弦与文字记号（只取族名） |

```css
@font-face hei { family: "Source Han Sans SC"; bold: true; }
note  { font: hei; }
chord { font: hei; }
```

`@font-face` 解析期就归一化成 `FontRef`，只认 `family`（必填）`file` `face` `mode` `bold`，认不出的属性报错。

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
| `line-height` | 长度 | 格内换行的行距，**fixed / block 同一个词**；可写在格上（格上的优先）。`1.444em` = 1.444 个字号（原排版程序那套），`12pt` 或裸数是绝对值。缺省 `1.2em`。block 的块高与它无关，按逐行字高相加 |
| `display` | `false` \| 表达式 | 关闭整个区域 |

### 4.2 行与格

```css
row(baseline: 78.63) { center: "{work.title}" as title; }
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
right { content: "{creators.* | lines | label-by-type}"; role: credit; dx: -8.7; line-height: 13.1; }
```

格属性：`content`、`role`、`at`（绝对 x）、`dx`、`dy`、`line-height`、`avoid`（避让：往上抬，直到让开指定角色的墨迹）。

**行距只有 `line-height` 这一个词**：值是长度，倍数写成 `em`（= 该行角色的字号）。原先 fixed 用 `line-gap`（绝对长度）、
block 用 `line-height`（倍数）那两套已经合并——同一件事分两个词，写在哪一档要先想一下，得不偿失。

## 5. 内容表达式

### 5.1 插值与空值折叠

`"前缀{字段路径 | 过滤器 | …}后缀"`。

**空值折叠**：一行里所有插值字段都为空时，整行（连同前后缀文字）不输出；一个 row 所有槽位都空时，这个 row 不占高。
（musicpp 的「非空才加一行」和 rebuild `put()` 的 `if (!text) return` 是同一个意思。）

多值字段（`string[]`）默认每项一行。过滤器**不带参数**。

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
| `lines` | 每项按换行拆成多行，去空白行 |
| `lines-indent` | 同 `lines`，但保留显式行首缩进（只去行尾空白与空行） |

### 5.4 组件

非纯文字、会产出多个图元的内容，由 TS 实现：

| 组件 | 产出 |
|---|---|
| `key-meter()` | 成书调号 + 叠排拍号（`bookparts.ts::keyMeterItems`） |

## 6. 装页 `@flow`

| 属性 | 值 | 谁读 |
|---|---|---|
| `song-start` | `new-page` \| `continue` | 混排歌本（`pdflayout/songbook.ts`）：每首另起一页 / 接排，放不下才换页；接排时逐曲按清单 `meta["layout.new-page"]` |
| `number-baseline` | 数（pt） | 成书：曲号基线，半页起排时标题块整体下移的参照 |
| `first-system-top` / `cont-system-top` | 数（pt） | 成书：首页 / 续页第一条谱行的音符墨迹上缘 |
| `mid-start-gap` | 数（pt） | 成书：半页起排时上一首墨迹底到本首曲号基线的净距 |
| `footer-baseline` | 数（pt） | 成书：页码基线，谱面下界按它算 |

500 首的半页起排与正反面装箱本身在 `rebuild.mjs`（`packMid` / `packAlone`），line-check 把关，样式表里只给上面这几个位置；
帧间距在 `songbook.ts::FRAME_MARGIN`。**不在样式表里留没人读的键**——写了看着像生效，其实不是。

## 7. 长度表达式

- 四则运算直接写（`8.92 * 1.56`、`content * 1.5 + 40`），**没有 `calc()`，也没有 `ref()`**：写了会报「认不出函数」。
- 实测值直接写数：文本 ↔ double 按最短往返（`String(number)` / `Number(raw)`），逐位不丢精度。
  模板里用到的实测基线在统计报告里给出（`bookstyle-report.md` 的「模板基线实测」），重跑统计后要手动核对。
- `extent` 里可用 `content`（区域内容高）。

## 8. 书清单 `book.json`

```json
{
  "id": "kl2020",
  "title": "声合为一",
  "style": "kl2020.ss",
  "songs": [
    { "file": "十架大能/十架大能（最终）.fixed.xml",
      "meta": { "title-alt": ["The Power of the Cross"], "layout.new-page": ["true"], "layout.chinese-hyphen": ["true"] } }
  ]
}
```

- `title` / `number` / `creators` / `rights` 覆盖谱文件里的对应字段（`creators` 整组替换）；`root` 是谱文件与字体文件的根目录。
- `meta` 按键**浅覆盖**谱文件自带的 `Song.meta`，以清单为准。
- `file` 指向改谱脚本另存的 `.fixed.xml`（没有改谱的曲目指原文件）。XML 表达不了的排版开关（`layout.chinese-hyphen`、`layout.melody-only`、`layout.new-page`）写在 `meta`。
- `styleByFlow: { "new-page": "…", "continue": "…" }`：**按装页口径叠加**的样式表，解析后接在 `style` 之后
  （后者覆盖前者）。同一本书两种口径只差几项时写这个，不要复制整份样式表——KL2020 接排版（对照 1219 版）
  印简谱调号「1=X」、单曲版不印，差异就这一条，落在 `src/style/books/kl2020-flow.ss`。
- 清单由导入脚本从曲目库生成（`gen-manifest-kl2020.mjs`），再由 `kl2020-prep.mjs` 改谱并回写 `file` 与开关；库路径由参数或环境变量给。

## 9. 示例

直接看三份内置歌本（都能被 `scripts/ss-roundtrip.mjs` 解析、写出、再解析）：

- `hymn500-measured.ss`：统计生成的实测部分（纸、字体、角色、`@jianpu` / `@break` / `@flow`、目录几何）。
- `hymn500.ss`：fixed 区域（基线写实测数）+ `key-meter()` 组件（避让首行和弦）。
- `src/style/books/kl2020.ss`：block 区域（标题块、页脚块按原排版程序与成品实测）、`@font-face` 字体文件、目录区域。
- `src/style/books/original.ss`：原样文档布局的页脚（BL/BC/BR，`dash-empty` 去 `-` 占位）；`original-shige.ss`：诗歌本方言的度量差异。

## 10. 成书：样式表就是全部，没有 json

成书的 `BookStyle` 只是内存里的中间对象，由样式表算出（`src/style/bookss.ts::bookStyleOf`）；
反方向 `printBookSs` 给统计脚本用。两个方向读同一张对照表，逐字段往返：

| `BookStyle` | 写在 |
|---|---|
| `page` | `@page { size; margin: 上 外 下 内; mirror }` |
| `fonts` | `@font-face` |
| `roles` | 角色声明（`font` `size` `align-mode` `baseline-adjust` `color`） |
| `metrics`、`layout.verseNumbers` / `maxHorizontalScale` | `@jianpu`（§2.1） |
| `layout` 的断句参数 | `@break`（§2.3） |
| `titleBlock` | `@flow`（§6） |
| `toc` | `@template toc { title-baseline; heading-gap-above; heading-gap-below; entry { leader; line-height; first-baseline; left-edge; right-edge } index { columns; line-height; first-baseline } }` |

- **一本书两份样式表**：`<id>-measured.ss` 由 `gen-bookstyle.mjs` 从原书统计生成（不要手改，重跑覆盖；
  断句等调好的开关的默认值在 `bookstyle.ts::defaultBookStyle`，生成时带进去），`<id>.ss` 写模板与手调常量。
  脚本按这个顺序叠（`node-harness.mjs::loadBookStyle`，`--style=a.ss,b.ss` 可换），书的 id 取后一份的文件名。
- **不补默认值**：样式表没写的字段在 `BookStyle` 里就不出现，由消费端原来的 `??` 兜底。
- 原书量到但排版不读的量（描边宽、到谱行的各段距离…）只进统计报告作比对，不进样式表。

