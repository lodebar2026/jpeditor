# jpeditor-web

简谱（JP-Word / `.jpwabc`）排版与编辑器。这是原 Kotlin/JVM + JavaFX + Skija 桌面应用
（仓库根 `../`）向 **Tauri 2 + TypeScript + SVG** 的迁移版。完整方案见
`~/.claude/plans/abundant-sniffing-dragon.md`。

## 架构决策（已定，勿轻易推翻）

- **渲染用 SVG**（不是 Canvas 2D / CanvasKit）。乐谱页面树（PageItem/Group/GraphicPath/
  GraphicLine/TextFrame）直接映射到 SVG DOM。
- **"在哪测量就在哪绘制"**：排版期的文本宽度/紧包围盒用浏览器的 `getBBox` /
  `getComputedTextLength`（见 `src/common/measure.ts`），与 SVG 渲染同一引擎，天然一致；
  **不需要原生字体测量**，不需要 CanvasKit，不需要 DPI 位图缩放。
  - `Path.computeTightBounds()` → `pathTightBounds(d)`（临时 `<path>`.getBBox）
  - `font.measureText()` → `measureGlyphText()`（`<text>`.getComputedTextLength）
- **MusicXML 已放弃 JAXB**，导入改为 Rust 后端解析 → 输出 `.jpwabc`（Phase 5，未做）。
  因此 `src/score/score.ts` 里 **故意省略** 所有 MusicXML 导入方法（Score.load /
  Part.load / Measure.load / Note.load / parse*）。**IDML 导出已彻底放弃。**
- **逻辑分层**：排版/渲染/模型/编辑全在前端 TS；Rust 只做文件 I/O、对话框，以及（计划中的）
  MusicXML 解析、PPTX/MIDI 打包导出。

## 命令

```bash
npm run dev            # Vite 开发服务器
npm run build          # tsc 严格检查 + vite 打包
npx tsc --noEmit       # 仅类型检查（CI 用）
npm run tauri dev      # 跑 Tauri 桌面应用（需 Rust）
cd src-tauri && cargo check   # 仅检查 Rust 侧

# 无头渲染/交互校验（用本地 Edge，免下载 chromium）：
npm run build && node shot.mjs /tmp/out.png            # 截 #score-pane + 诊断
npm run build && node abc-check.mjs                    # ABC→MusicXML 移植回归（见 docs/实现/ABC-导入.md）
npm run build && node xml-roundtrip.mjs                # MusicXML 导出回归（序列化往返 / 增量 patch / 版面）
npm run build && node omr-export-check.mjs             # 同上，但底本取自真跑一遍 OMR 的识别原文
npm run build && node abc-shot.mjs <abc> /tmp/abc.png  # 拖入 .abc 端到端渲染核对
npm run build && node omr-pu-check.mjs                 # 识别→文本谱原文→回解析 逐项对拍
npm run build:cli && node pdf-diff.mjs && node pdf-mark.mjs   # 矢量 PDF 识别 ↔ GT 对比 + 差异标记版 PDF
node rebuild.mjs [--one=020,373] && node line-check.mjs        # 成书重排 + 判据断言（断句 D1~D9 / 版面 V1~V9 + 全书基线）
node gen-storyocr.mjs && node gen-glyphsheet.mjs               # 整行 OCR 补字 + 人工确认表
node gen-bookmeta.mjs [--check]                                # 书级内容（调号拍号/目录/索引/注解…）入 校对.db
node gen-glyphmerge.mjs        # 字形建库第三步：同一字形的分身归并、标注取齐
npm run build && node gen-pu-gt.mjs                    # 生成和弦 GT 底稿（须人工核对后才算 GT）
```

`shot.mjs` 用 Playwright `channel: "msedge"` 驱动本地 Edge，serve `dist/`，加载后截图并
打印页数/着色 token 数/控制台错误。改了渲染相关代码后用它做回归。
所有 `.mjs` 的浏览器引导（MIME 表 / serve dist / 起 Edge / 遍历 testdata 夹具 / 读 GT）
共用 `scripts/harness.mjs`，**加新资源类型只改那里的 MIME 表**；脚本里只留断言逻辑。
`window.__app`（App 实例）在运行时暴露，便于脚本化测试（如 `__app.setText(...)`）。

## 目录与数据流

```
.jpwabc 文本
  → JpwFile.fromString          src/jpword/jpwfile.ts   分段(.Title/.Voice/.Words/...)
  → ANTLR 词法/语法              src/jpword/parse.ts     复用 Jpwabc.g4 生成的 TS 解析器
  → fromJpw → Score             src/score/jpwimport.ts  + src/score/score.ts (模型)
  → JinpuPainter.resize → 排版   src/layout/painter.ts   + src/layout/layout.ts (引擎)
  → SVG DOM                      painter.renderPage(i)
```

三个排版器（`JinpuPainter` / `PuPainter` / `MixedPainter`）实现同一个
`layout/pagepainter.ts::PagePainter`（`pageCount` / `pageSize` / `renderPage`），
编辑器的铺页逻辑（`App._renderPagesWith`）只依赖它。**高亮不在接口里**——三者语义不同。
`mixed/painter.ts` 的 `renderItem` 与 `layout/painter.ts` 的 `renderPageItem` 看着像但
**不要合并**（matrix 加在 `<g>` 还是叶子上、颜色取 item 还是写死 black），理由写在前者的注释里。

- `src/common/` — `fraction.ts`（含 `gcd`/`lcm`）、`geom.ts`（Point/Rect/Matrix33，含
  `toSvg()`）、`measure.ts`（SVG 测量基础设施，**核心**）、`filetypes.ts`（能打开哪些
  扩展名——**只在这里写一次**）。
- `src/smufl/smufl.ts` — Bravura 元数据加载（`public/redist/bravura_metadata.json`）+
  GlyphCodes。**PUA 码位用 `String.fromCharCode(0x...)`，切勿在源码里写字面 PUA 字符**
  （Write 工具会损坏这些字节）。
- **矢量 PDF 路**（**目前只有 CLI 脚本走这条路，编辑器尚未接**——`isVectorPdf` 已备好
  但还没有调用方；接进去时才是「为真走矢量、否则退回 `decode.ts`」）：
  `src/omr/vector.ts`（读 PDF 路径对象，**不得碰 canvas/document**——Node CLI 要 import 它）、
  `bookprofile.ts`（字号族/版心统计）、`inventory.ts`（对象归类，硬指标是未归类数）、
  `glyphdict.ts`（形状→字符字典）。引导在 `scripts/node-harness.mjs`（**不起浏览器**，
  与起 Edge 的 `harness.mjs` 分工）。详见 [矢量PDF识别](docs/实现/矢量PDF识别.md)。
- `src/jpword/tokens.ts` — `TokenData` 分词器，仅用于编辑器语法高亮（非语义解析）。
- `src/jpword/hanconv.ts` — 简繁转换（工具栏「简繁」）。词表用 opencc-js，按方向动态
  `import()`（`opencc-js/cn2t` / `opencc-js/t2cn`，各自独立 chunk，首屏不加载）。只转
  `.Title` 的字段值与 `.Words` 的歌词内容；歌词行先把非 ASCII 内容字符抽出拼成整串再送词表
  （跨过 `/`、`-`、`()` 等记号，否则 `日光/之下` 会被拆开导致词汇级转换失效），转换结果按原位
  逐字回填，长度对不上就退回逐字转换，绝不错位。
- `src/editor/` — `app.ts`（编辑器↔实时重排↔翻页↔文件 I/O 控制器）、`highlight.ts`
  （CodeMirror 装饰）、`fileio.ts`（UTF-16LE 编解码 + Tauri 运行时探测）、
  `settings.ts`（localStorage 持久化，只管存取不管应用）。
  两块从 `app.ts` 切出来的控制器，各自通过一个**列全了的**宿主接口向 App 要能力
  （那个接口就是「这摊事到底依赖编辑器多少东西」的清单，加东西前先想想）：
  `omrctl.ts::OmrController`（识别 → 出文本 → 叠加核对 → 点选定位，入口 `app.omr.*`）、
  `playback.ts::PlaybackController`（播放器/速度/音量，入口 `app.playback.*`；
  **谱面高亮不在里面**，那属于「谁在画谱面」，留在 App）。
- `src/jpword/parser/` — **ANTLR 生成代码，勿手改**，每个文件首行 `// @ts-nocheck`。

## 与原 Kotlin 的对应

按文件近乎逐行翻译。改行为前先看 `../src/main/kotlin/` 对应文件确认原意：
`layout.kt→layout/layout.ts`、`draw.kt→layout/painter.ts`、`score.kt→score/score.ts`、
`jpw.kt→score/jpwimport.ts`、`jpwfile.kt→jpword/jpwfile.ts`、`skia.kt→common/geom.ts`。
Skija 值类型不可变（offset/inset/union 返回新对象）——TS 端保持同样语义。

**已知的一处刻意背离**：`MusicCommon.jpToStep`（简谱数字 → 音名字母）不再照 Kotlin 按
`basePitch % 12` 查表，改按调号**拼写**（`fifths → keys[]` 取主音字母）。同音高的升/降两种
拼写字母不同（`#C` 的 `1` 是 C、`bD` 的 `1` 是 D），只看音高分不开，原表因此干脆缺 mod 1/6
两项直接 `throw`——`1=#C`/`1=bD`/`1=#F`/`1=bG` 四个调整首排不出来（代码区有文本、排版是空的，
因为 `setText` 成功而随后的 `reload()` 崩在这里）。

## 专题实现笔记（按需再读，别整篇加载）

下面每块只在**改到该模块**时才需要展开；`docs/实现/` 里是完整的原委与踩坑记录，
改行为前先读对应那篇，别照直觉改。

- **[矢量 PDF 识别](docs/实现/矢量PDF识别.md)**（`src/omr/vector.ts` / `bookprofile.ts` /
  `inventory.ts` / `glyphdict.ts`）——**文字转曲**的印刷歌本 PDF 直接读矢量对象，不栅格化、不跑 OCR。
  重叠对象在矢量层天然分离（`jianpu.ts` 那五处拆粘连启发式全都用不上），全书 666 页 6.5 秒。
  字形按轮廓聚类后用 GT 语料自举标注，剩下的每类送一次 OCR 兜底
  （**整行合成一个 path 的按整行送行识别**，收多字符结果）——字典覆盖 98.1%。
  568 首基线：音符 100.0%、歌词 99.3%、标题 99.7%、和弦 99.1%、圆滑线 97.0%、调号 97.5%、拍号 99.6%、词曲署名 97.1%
  （调号/拍号剩下的差异几乎全是 GT 按主音和弦订正过、与谱面不同调，真没读到的只剩拍号 1 首）
  （**基准一律是 musicxml**，`.jpwabc` 那一路已停用：它装不下和弦与 slur，共用副歌之类的写法还得另做口径对齐），
  全书未归类对象 0/365694，内容完全一致（音符+歌词+标题）468/568、再算上和弦 391/568。
  **建库三步走**：`gen-glyphdict`（GT 自举）→ `gen-glyphocr`（未定类送 OCR，唯一要起浏览器的一步）
  → `gen-glyphmerge`（按 32×32 签名把同一字形的分身归并、标注取齐；`shapeKey` 对亚像素抖动不稳，
  16180 个类其实只有 10269 个字形，分身各学各的字会打架；归并已挪到自举之前，
  `gen-glyphmerge` 只做收尾对齐）。**对比报告只出有事可说的那些**，全量跑会先清空 `pdf-diff/`。
  **花边框里的文字一律只当注解正文**（`inventory.ts` 的 `set` 里有一道锁），不进音符/歌词。
  **书级内容**（`bookmeta.ts` → 校对.db 八张表 → `bookparts.ts` 排回去）：调号拍号原文
  （拍号上下叠排）、段落词、花边框正文、目录、两份索引（尾数是**曲号**不是页码）、扉页前言；
  补字靠 `gen-storyocr.mjs`（**整行**送 OCR + 锚点分段，标点另按墨迹高判）与
  `gen-glyphsheet.mjs`（人工确认表）；空格没有字形对象，按**字距**还原（只对西文补）。
  注解框有花边纹样框与**双细线矩形框**两种（后者 53 条，`clusterRuleFrames` 认）。
  整本 655 页、注解 164/164 排入、缺字 0。
  **B 路 rebuild 的排版口径**（谱面全走排版引擎，整本那一层只管书级装饰）：容量、断句、
  反复记号与房号、调号升降号、段落词（「（副歌）」挂 `Chord.sectionWord`）、目录与页眉版面
  ——每条判据都记在 [矢量PDF识别](docs/实现/矢量PDF识别.md) 的「成书排版」几节里，**动之前必看**。
  「一行的头尾长什么样」那几条（行首不留半小节休止、弱起要齐、行首不挂上一句的长音收尾、
  末两行要均匀、段落词不出版心、歌词标点不相压）由 **`line-check.mjs`** 守着：
  `rebuild.mjs` 顺带写出逐行事实 `pdf-out/rebuild-lines.json`，脚本读它 + drawlist 判**两族**
  ——**D1~D9 断句**（行首 → 行末 → 行长 → 整首口径）与 **V1~V9 版面**（绘制与几何，断句改动
  不该动到它们）；全书基线在 `testdata/500/line-check-baseline.json`（任一档变差即失败），
  另有十几首定点断言。**「一行放不放得下」一律按真实坐标判**（`applybreaks.ts::FitMetric`
  ← `browser.ts::measureChordSpans` ← `layout.ts::Line.naturalSpans`），不按格数。
  **归类判据一改就要重跑 `gen-glyphdict.mjs`**（再把上一版的 OCR 标注并回未定类）——
  字形自举靠 GT 与页面序列对齐投票，归类错位时学到的字符也跟着错。
  对比报告把「内容差异 / 表述或结构不一致 / 未识别 / 版面」分四类记（**表述不一致要记账不要吞掉**：
  共用副歌、谱面段号印错、GT 按主音和弦订正过的调号…都归这一类），
  折行、标点位置、旋律重复这些排版事实单列，不混进「录错」。
  `pdf-mark.mjs` 出**差异标记版 PDF**（红 = 页面读错/多出、黄 = GT 有页面无、橙 = 字形未读出；
  标点不一致是蓝色，**默认不画**、`--punct` 才画——七百多处会把红标淹掉，
  盖在原件上，默认只出有标记的页）；位置由 pdf-diff 写的 `pdf-diff-marks.json` 提供。
  另有 page-report.mjs 出逐页排版信息（页型/曲目落位/页眉页脚/花边文字框/边框类型，未安置 0），
  relayout.mjs 从版面规格排回去：outline 模式做对象级核对（全书 spurious 0、unplaced 21/308044），
  text 模式用 pdf-lib 直出 666 页文字版 PDF（可选中可搜索，12.3MB，不经浏览器故字体只嵌一份）。
  篇中逐条记录了归类判据的判据与反例（重复描边的 3×3 邻域配对、小节线高度门槛、
  花边框的密排线判据、页顶续尾、段号重印…），**动那些阈值前必看**。
- **[OMR 简谱识别](docs/实现/OMR-简谱识别.md)**（`src/omr/`，最长的一篇）——图片/PDF → MusicXML。
  全本地一条路：连通域几何 + PaddleOCR PP-OCRv6_small，浏览器离线。14 首 GT 基线：音符/八度/附点/小节/对位/标题/词曲 100%，slur-tie 99.8%、歌词 99.5%。
  回归 `node measure-all.mjs`、`node bench-lyrics.mjs`、`node check-gt.mjs`。
  篇中逐条记录了几何启发式的判据与反例（八度点/附点/减时线/衬词行/歌词标点/反复房/页眉著作者…），
  **动那些阈值前必看**——每条都是拿具体曲子换来的。
  **和弦符号**（`src/omr/chordline.ts`）：印在谱行上方的 `Am`/`G/B`/`Gsus4` 也识别出来，
  挂 `JpNum.chord` → MusicXML `<harmony>` 与文本谱 `"hx:…"` 两路；**`.jpwabc`/Score 装不下和弦**，
  那一路会丢（有意为之，不扩 jpwabc 语法）。和弦与圆滑线同处一带、与段落方框共用文法判定；
  根音必须大写、跳转记号/段落词/调号拍号先抹掉、和弦数与小节数的比例兜底——每条都是拿具体曲子换来的，
  动前必看那篇的「和弦符号」一节。长音里逐拍换的和弦挂 `JpNum.extraChords`（带拍内偏移），
  文本谱那路落到对应的增时线上（`- "hx:…"`）。
  识别输出格式可选 `jpwabc`（默认）/ 番茄简谱 / 诗歌本文本谱（工具栏「核对」组下拉，持久化）：
  内存里留着格式无关的 `RecognizedScore`，**换格式只重走 emitter，绝不重跑识别**；
  格式清单是 `src/omr/emit.ts` 的注册表（加一种 = 补一项，文本谱那几种由 `DIALECTS` 派生），
  几何/统计小工具在 `src/omr/geom.ts`（`clusterByY` 的容差**一律由调用点传**，见那篇）；
  文本谱那路是 `src/omr/topu.ts` 直出原文（不过 Score），回归 `node omr-pu-check.mjs`。
- **[简谱纵向栅格](docs/实现/简谱纵向栅格.md)**（`src/layout/layout.ts`）——高音点/低音点、slur/tie、
  三连音、fermata、减时线、小节线高度共用的一把尺子（唯一常量 `jpStackGap`，墨迹到墨迹等距；
  musicpp 自己在这里并不等距），以及八度点按**墨迹**而非 advance 居中（`1` 在 PingFang 里偏 0.88px）。
  含跨小节 slur 的小节线避让，和两处刻意背离 musicpp 的地方。**动这些常量前必看。**
  弧高的**上下限**（按原书 1205 条实测定的）、超长跨度**改画扁平长连音线**（参 open-fanqie）、
  长弧底下**和弦与段落词整排让位**也在那篇里；三条简谱路（编辑器 / 成书重排 / 文本谱）
  共用 `SlurTieBase` 一套参数，`src/mixed/` 的副本不在此列。**改这几个常量会牵动全书断句**
  （弧高→行高→每页行数→重排），动完必跑 `rebuild.mjs && line-check.mjs`。
- **[歌词标点挤压](docs/实现/歌词标点挤压.md)**（`src/common/cjkpunct.ts` + `common/measure.ts` +
  `scripts/punctshape.mjs`）——标点挤压的**两派**都在这里，**全仓唯一一份规则**：
  **全书一律半身式**（开明式，点号占半个字身）——谱面歌词由 `LayoutOptions.punctCompress` 定、
  书级正文由 `punctshape.mjs::BOOK_MODE` 定；歌词逐字挂音符、标点不占音符格，原书就是半身，
  改走全身式会把全书从 673 撑到 695 页。另一派 `clreq`（全身式 + 上下文挤压，CLREQ 3.1.6：
  只在相邻标点与行首行末压掉多余的半格）也实现了，换档即可。OpenType 的 `chws`/`halt` **有就用**
  （本书那套方正字体一个都没有，实测后走等效实现）。挤压出**逐字笔位**（`TextFrame.charXs` →
  `<text>` 的 `x` 列表 → DrawList 的 `xs`），渲染端**绝不再叠 font-feature-settings**。
  压缩量一律受**实际留白**封顶（只压空白不压墨；表里也只收全角形——ASCII 的 `(` `)` 没有那半格）；
  半身**不是把 advance 砍一半就完了**——字形要在半角格里居中（否则 `（第一调）` 括号两侧各空 0.37em），
  相邻标点之间再收拢到 `PUNCT_PAIR_GAP`（否则 `：「`、`！」` 中间摞着两截边距）。
  跨音符的那一对标点（`召：` + `“将` 分属两个 `<text>`，特性管不到）由 `calcXPos` 补一道下限
  `hang ≤ lyricGap`；`line-check` 的 **V8**（谱面）与 **V9**（书级正文连排）守着。`halfWidthPunct` 那套**换字符**的老做法已退休。
- **[乐句排版](docs/实现/乐句排版.md)**（`src/score/phrase.ts`）——工具栏「按乐句重排」的 DP 与代价项
  （行长目标、整句独占一行、断点凭据、段落/副歌分页）。回归 `node phrase-lines.mjs [曲名子串]`。
- **[ABC 记谱导入](docs/实现/ABC-导入.md)**（`src/abc/`）——abc2xml.py 的全量忠实移植（含 pyparsing /
  etree shim）。改前先核对 python 原文，回归 `node abc-check.mjs`、`node abc-shot.mjs`。
- **[文本谱](docs/实现/文本谱.md)**（`src/pu/`）——番茄简谱 / 诗歌本两种**纯文本简谱**的
  原生支持：编辑器直接编原文、专用排版器（原版连续长图 + PPT 版面、四声部并排）、
  导出 MusicXML/`.jpwabc`/MIDI/PPTX、试听逐字高亮。两方言差异与排版判据都在那篇里，
  **动解析或排版常量前必看**。回归 `node pu-parse-check.mjs`、`node pu-export-check.mjs`、
  `node pu-shot.mjs`。
- **[混排](docs/实现/混排.md)**（`src/mixed/`）——移植自 C++ 工程 musicpp（`~/proj/musicpp`），
  含测试 musicxml 的位置。改混排行为前先核对 musicpp 原文。
- **[播放速度](docs/实现/播放速度.md)**（`score/timeline.ts`）——谱面 `♩=` × 用户倍率，
  以及它怎么经 `.Title` 的 `Expression` 字段往返 `.jpwabc`。
- **[MusicXML 导出](docs/实现/MusicXML-导出.md)**（`score/musicxmlout.ts`、`musicxmlpatch.ts`、
  `harmonyxml.ts`、`musicxmllayout.ts`；公共件 `xmlutil.ts` 管字符串拼装
  （escape/外壳/`<barline>` 子元素顺序/duration 取整）、`xmldom.ts` 管 DOM 后处理）——工具栏「导出 → MusicXML」。**有 MusicXML 底本（OMR/ABC/导入的 xml）
  就在底本上做增量 patch，绝不整体重生成**（.jpwabc 承载的信息更少，重生成 = 降采样）；
  patch 刻意不碰 barline/ending/repeat/direction/harmony 等 jpwabc 表达不了的结构
  （`harmonyxml.ts` 是和弦符号 → `<harmony>` 的公共实现，文本谱直出与简谱 OMR 共用）。全量序列化那条路
  有四个要害（divisions/音高拼写/调号推断/type-dot 互逆），改之前必看那篇。
  回归 `node xml-roundtrip.mjs`、`node omr-export-check.mjs`。

面向仓库读者（非本文件受众）的文档在 [docs/](docs/)：开发、技术栈、进度、macOS 打不开。

## 重新生成 ANTLR 解析器

改了 `src/jpword/Jpwabc.g4` 后（需 JDK，本机在 `/opt/homebrew/opt/openjdk/bin`）：

```bash
java -jar /tmp/antlr-4.13.2-complete.jar -Dlanguage=TypeScript -o /tmp/gen -visitor src/jpword/Jpwabc.g4
# 把生成的 *.ts 拷到 src/jpword/parser/，给每个文件首行加 `// @ts-nocheck`
```
运行时用 npm 的 `antlr4` 包（浏览器构建），导入写 `from "antlr4"`、生成文件用 `./X.js` 后缀
（bundler 解析到 `.ts`）。

## 约定

- 严格模式 TS，`noUnusedLocals/Parameters`。生成代码用 `// @ts-nocheck` 豁免。
- 文件编码：`.jpwabc` 读时 BOM 探测（回退 UTF-16LE/UTF-8），存时 UTF-16LE + BOM。
- Tauri 能力在 `src-tauri/capabilities/default.json`；新增插件要同时改 Cargo.toml、
  `src-tauri/src/lib.rs`、capabilities、`package.json`。
- 提交信息用简要中文，不要 `Co-Authored-By` 尾注。

## 进度

Phase 0~2（脚手架 / 解析→模型→导入→排版→SVG / 编辑器 + 实时重排 + 文件读写 + 翻页）已完成。
Phase 3（点选/选中高亮/对话框）、4（导出 MIDI/PNG/PPTX）、5（Rust MusicXML 导入）、
6（选项面板/打包）待做。此外已落地：简谱 OMR、ABC 导入、乐句排版、播放速度——各见上面的专题笔记。
（面向用户的进度清单在 [docs/进度.md](docs/进度.md)。）
