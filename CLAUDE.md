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
npm run build && node abc-check.mjs                    # ABC→MusicXML 移植回归（见 ABC 节）
npm run build && node abc-shot.mjs <abc> /tmp/abc.png  # 拖入 .abc 端到端渲染核对
```

`shot.mjs` 用 Playwright `channel: "msedge"` 驱动本地 Edge，serve `dist/`，加载后截图并
打印页数/着色 token 数/控制台错误。改了渲染相关代码后用它做回归。
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

- `src/common/` — `fraction.ts`、`geom.ts`（Point/Rect/Matrix33，含 `toSvg()`）、
  `measure.ts`（SVG 测量基础设施，**核心**）。
- `src/smufl/smufl.ts` — Bravura 元数据加载（`public/redist/bravura_metadata.json`）+
  GlyphCodes。**PUA 码位用 `String.fromCharCode(0x...)`，切勿在源码里写字面 PUA 字符**
  （Write 工具会损坏这些字节）。
- `src/jpword/tokens.ts` — `TokenData` 分词器，仅用于编辑器语法高亮（非语义解析）。
- `src/editor/` — `app.ts`（编辑器↔实时重排↔翻页↔文件 I/O 控制器）、`highlight.ts`
  （CodeMirror 装饰）、`fileio.ts`（UTF-16LE 编解码 + Tauri 运行时探测）。
- `src/jpword/parser/` — **ANTLR 生成代码，勿手改**，每个文件首行 `// @ts-nocheck`。

## 与原 Kotlin 的对应

按文件近乎逐行翻译。改行为前先看 `../src/main/kotlin/` 对应文件确认原意：
`layout.kt→layout/layout.ts`、`draw.kt→layout/painter.ts`、`score.kt→score/score.ts`、
`jpw.kt→score/jpwimport.ts`、`jpwfile.kt→jpword/jpwfile.ts`、`skia.kt→common/geom.ts`。
Skija 值类型不可变（offset/inset/union 返回新对象）——TS 端保持同样语义。

## 混排（src/mixed/）的参考源与测试数据

- **`src/mixed/` 移植自 C++ 工程 musicpp，路径 `~/proj/musicpp`**。改混排
  行为前先核对 musicpp 原文（render.ts↔`model/render.cpp`、model.ts↔`model/model.cpp`、
  loader.ts↔`mxml/loader.cpp`、painter.ts↔`util/pao.cpp`）。代码里的 `render.cpp:行号` 注释
  即指该仓库。
- **测试 musicxml 在 `~/Documents/Praise as One/`**（只用其中的 `.musicxml/.xml`，
  忽略目录里其它文件）。部分子目录有同名 `*.pdf`（Sibelius 原始排版）可作 slur/tie/小节线
  对位的视觉基准。无头渲染混排：`node shot.mjs out.png --xml <path>`（`window.__mixedPainter`）。

## 简谱图像识别（OMR，`src/omr/`）

把简谱图片（PNG/JPG）识别成 MusicXML，再走编辑器现有 `importBytes`→`loadMusicXml` 导入排版。
工具栏「识图」按钮 → `showRecognizeDialog`（[src/editor/dialogs.ts](src/editor/dialogs.ts)）选方式 →
`App.recognizeFromImage`（[src/editor/app.ts](src/editor/app.ts)）。**两种方式**：

**PDF 输入**（拖入 `.pdf`，见 `main.ts` 的 `RECOG_EXT_RE`）经 `decode.ts` 的 `pdfToImageData` 转位图再走
同一 OMR 管线。用 **pdf.js（`pdfjs-dist`）**：worker 经 Vite `?url` 引入，位图解码器 wasm 目录（jbig2.wasm
兼管 **CCITTFax G4**、openjpeg 管 JPEG2000）在 `public/redist/pdfjs/`，**必须**用 `getDocument({wasmUrl})`
指明——否则内嵌位图（扫描版乐谱多是 1-bit `ImageMask`）会被 pdf.js 静默丢弃、页面只剩矢量文字。**优先直接抽取
内嵌位图**（`largestPageBitmap`：`getOperatorList` 找 `paintImage(Mask)XObject` → `objs.get(id)` 拿解码好的
`ImageBitmap`）而非整页渲染——源本就是二值扫描图，直接贴白底即可（顺带甩掉赞美诗页码/栏目标题等叠加矢量文字，
如「耶稣普治」PDF 顶部的 `055/圣子耶稣`）；纯矢量 PDF（无内嵌图）退回 `page.render` 整页光栅化。多页竖向拼接。

- **`gemini`**：整页交 Antigravity CLI `agy` 让 Gemini 直接转写（真实照片更准）。**仅桌面版**：
  `agy` 是命令行工具，经 Rust `omr_gemini_cmd`（[src-tauri/src/lib.rs](src-tauri/src/lib.rs)，
  `std::process::Command`，stdin 关掉防挂起）调用；浏览器内 `agyAvailable()` 为 false → 报"需桌面版"。
- **`musicpp`**：**完全本地**，浏览器/桌面均可、可离线。`decode.ts`(图→二值) → `jianpu.ts`
  (连通域/几何启发式：数字块拆分、下划线 div、八度点、增时线) → `musicxml.ts`(→partwise)；
  数字/歌词/页眉 OCR 走本地 **PaddleOCR PP-OCRv6_small**（`paddleocr.ts`，onnxruntime-web 浏览器离线推理，
  逐数字格 / 歌词条 rec→CTC），**不经 agy**——整页识别本就是 Gemini 方案在做的事。模型/字典在
  `public/redist/ocr/`（rec onnx `ch_PP-OCRv6_small_rec_infer.onnx` **~21MB** + `ppocrv6_dict.txt` **18708 字**
  + **det onnx ~4.7MB**（DBNet，仍 PP-OCRv4，页眉用；det 头与 rec 无关故可跨版混用）），wasm 运行时在
  `public/redist/ort/`（纯 wasm 单线程，免 COOP/COEP）；`onnxruntime-web/wasm` 子入口避开 26MB 的 jsep 构建。
  旧的 **tesseract.js** 后端（`localocr.ts` + `montage.ts`）保留为 fallback（`localOcrBackend()`）。
  - **rec 逐代换**（2026-07）：PP-OCRv4(6623字/无「祂」) → v5_mobile(18383字) → **v6_small(18708字)**。v4 无「祂」
    （赞美诗第三人称神）只能读成形近「他」；v5_mobile 字典含「祂」但**视觉仍偏向高频「他」**、48px 二值条上「祂」全读错；
    **v6_small 同一条子「祂」4/4 全对**（基督更美/耶稣普治），整体音符 100%、含标点歌词 ~93→**99.8%**、词曲 99→**100%**。
    前端 CTC 解码字典驱动（`_chars`=["", ...dict]）、数字类别索引 `chars.indexOf` 动态求、Rust argmax 读动态末轴，
    **换字典/模型无需改逻辑**，只换 `REC_URL`/`DICT_URL` + `tauri.conf.json` 打包映射（rec.onnx）。输入 shape
    仍 [3,48,320]、归一化不变。导出：`paddlepaddle 3.x`(macOS arm64 **必须 3.x**，2.6.2 CPU 构建卡死/段错误) +
    `paddleocr 3.7.0` → `paddle2onnx 2.1.0`（**注意** `paddlex --install paddle2onnx` 会降级到 2.0.2rc3 且报
    "Paddle2ONNX is not available"，须 `pip install paddle2onnx==2.1.0` 后直接 `paddle2onnx --model_dir …`）。
    变体实测：v6_tiny(4.4MB)「祂」读成「池」、**v6_small(21MB)「祂」4/4**、v6_medium(76MB)太大 → v6_small 最优。
  - **v6 换代的两处数字回退，用两条通用几何修复消掉**（均在 `jianpu.ts`，非针对样本打补丁）：① **矮块补高**
    （`recRects`）——连通域偶尔只截半个字（淡印断笔「1」竖笔断开、块高≈半字高 → 送 rec 成半字读作「4」），据本行
    数字带统计高度把 h<带高×0.7 的块纵向补到整字高（`cellOf` 按 rect 从二值图裁、会纳入带内断开的另一半；带
    `[topY,botY]` 由数字核算出不含下划线/八度点，补高安全）；② **空心环校验**（`midbandInk`）——简谱「0」是空心环、
    从不带斜线，糊死的「3」中间横笔连成穿心斜线被读成「内含斜线的 0」；测中央横带前景占比（真 0 各图 ≤0.47、糊 3
    恒 ≥0.7），>0.65 判"读成 0 却中带占满"= 实为糊 3，走既有 `rankDigits` 取首个非零复原。两修复后 6 曲音符 **100%**、
    slur/tie 不再受连带（0=休止会丢闭合圆滑线）影响。回归/分析：`node gen-song-analysis.mjs <歌谱名>`（单曲全流程
    HTML：原图/二值 → 逐格数字与 GT 自动对齐标红 → 歌词条含「祂/他」绿框）。

已修复初版几处 bug：连音(下划线相连)数字粘连不切分、增时线后 MusicXML `type/duration` 不一致、
montage 单行长条过大导致 OCR 超时（改网格）、**八度点过检**（约束 octave 点须水平居中且紧贴上/下方、
封顶 ±3）、**歌词行混入数字 OCR**（小节线须纵向贯穿本行才算乐谱行 → 歌词行得不到小节线，不送数字 OCR）、
**减时线(下划线 div)过检**（初版在数字块内找"底部宽行"，把 5/6/2/3 自身底横笔误判成下划线 → 几乎全变八分；
实际减时线是数字**正下方的独立 hline 连通块**，改到 `buildJpNums` 按"数字下方 hline"数 div，类比增时线用"右侧 hline"）。
**歌词识别**（`lyrics.ts`）：乐谱行下方"歌词带"取字号连通块 → 按 y 分 verse 行 → 按 x 邻近并字格 →
按宽度切块、每块裁**自然连续区域**(保留原始字间距，不重拼)整体 rec(`buildStrip`/`chunkCells`，宽≤320 免压扁) →
块内字按格序取 x → 按 x 单调最近对齐到音符（melisma 自然留空），写 `JpNum.lyrics[verse]`。
**标点**：单元=汉字+紧随尾随标点(全角 `，。、；！？` 等，向左贴前一字、不占音符)，并入该音节串不另立格——
保持"音节数==字格数"对齐前提；rec 在自然块上下文里读逗号也准(`LYRIC_PUNCT`)。带标点 歌词档 89.6→93.0%
(忽略标点 歌词* 仍 98.9%、对齐未破)；淡印逗号 rec 捕获不到的(如 我今来就你)仍漏，属图像层面限制。
**英文歌词**（如「主祢真伟大」的 `How-awe-some-you-are`）：单元不再限于汉字——拉丁串按**连字符**
(音节边界，`-` 随音节保留)与**词间空白**(rec 不吐空格 → 按源图字距 >0.5 字宽断)切成音节，每音节
占一个音符，与汉字单元同等对齐。**对齐点取音节起始 x**（与汉字用字位左缘同一基准），宽度取实际跨度
——不能拿 `charW` 兜底：英文行的字格是整串音节合成的一个大块，`charW` 就是那个块宽（两百多像素），
用它算出的中心会把音节整体右移一个多字位（实测 `How-` 落到 x233、该在 x170 的 `5` 音上）。配套两处：① 英文字号只有汉字一半，一串音节缩到 48px 高后宽近千，
故 `mergeSmallTextBlocks` 把相邻矮块(<0.8 charH)并回一块防音节被 `chunkCells` 从中间切断
（曾读出 `How-awe-s`/`ome-you-are`），`recognizeTexts(Pos)` 对切不开的超宽条按自身宽度放宽 rec 上限
（`"auto"`，≤2048；常规条仍 320 → 与旧行为逐位一致）。② **和弦/段落标记行**(`Am`/`G/B`/`Gsus4`/
`Chorus`，印在**下一谱行音符上方**、同落在歌词带内)放开拉丁字符后会变成伪 verse，故 `isAnnotationLine`
按形态剔除：无汉字 + 每个字母簇首字母是 A-G 根音 + 簇内最长连续小写段 ≤2（英文音节 awe/some/ther 更长），
**不依赖大小写正确**（OCR 常把 C 读成 c）；剔后该谱行剩余 verse 重新编号。
**八度点两处误判**（`jianpu.ts` `buildJpNums`，均由**歌词字的顶部笔画**引起——歌词带紧接在数字下方，
字顶的短竖/点正落在数字正下方、dx≈0，与「减时线下方的低音点」几乎同高）：
① **居中阈值 0.4→0.25**：真八度点是印在数字正上/正下方的圆点，实测 |dx| ≤0.07~0.14；偏在两字之间的
字顶笔画 |dx| 0.3~0.39，旧阈值放它进来 → 凭空多出低八度点，若该音本就有高八度点还会被一加一减抵消
（实测「主祢真伟大」Coda 的 `i`(为) 丢点、`7`(我) 平白多点）。
② **低八度点要求「其下方 0.3 字号内基本无墨」**（`inkBelow < 0.12`）：dx≈0 的字顶笔画（如「主」字
上方那一竖）靠位置分不开（间隙 14~15px vs 真点 3~13px）——但八度点是**孤立**的圆点、下方留白，
字顶笔画下方紧接着字的其余笔画。**先试过宽高比**（八度点 w/h≈1.0、字顶笔画 0.67~0.83），但小字号图上
真点只有 2×3 像素、比值不可靠，世上所有的民族的真低音点被误剔（音符 100→99.3）；窗口也不能大到
0.5 字号，否则大字号图会吃到下方歌词（基督更美 100→99.2）。

**反复记号**（`repeats.ts` 识别 + `score/score.ts::RepeatProcessor` 展开，issue #2）：以
《沧海一声笑》（`1.2.3.5.` / `4.`(带 D.C.) / `6.` 三房）为基准，识别与展开各修了几处：
- **房括线搜索窗放深到 3.4 字号**：括线到数字顶的距离随谱面松紧变化很大，行内有圆滑线时括线
  被顶到 ~2.8 字号高处，旧的 1.8 字号窗口整片漏掉三个房。放深的误检由新增的 `hasLeftHook`
  （括线左端必有下垂短竖，歌词/连音线等长横墨线没有）挡住。
- **一个房可辖多遍**：房号 `1. 2. 3. 5.` 是一串小连通块，改为从左端起收**连续同高**的块
  （按最高块 0.55 倍剔掉号后的小圆点、断在第一个 >1.2 字号的空档），逐块 OCR 后拼成
  `<ending number="1,2,3,5">`。`JpNum.endingStart/Stop` 因此从 `number` 改成 `string`。
- **D.C./D.S./Fine/To Coda**（`lyrics.ts` 的 `JUMP_MARK_RE`）：这类记号印在**本谱行**音符下方
  近旁（落进歌词带），与段落方框（归下一行）落位规则不同 → 归 x 处或其左侧最近的音符，
  出 `<direction>`+`<sound dacapo=…>`。只在无汉字的块里找，免得歌词里的 Do/Si 被误当记号。
- **三房以上的演唱顺序**（`RepeatProcessor`）：① 本遍不唱的房，其右边界的 `:||` 不该照跳
  （否则第 4 遍永远落不到「4.」房）；② 「最后一房」须按房号判（`max(endingNum) >= passCount`），
  中间的房右边界同样没有 backward，按「无 backward 即收组」会半途把 pass 归 1 并死循环；
  ③ **房内的 D.C.** 只是这一遍的回头记号（与 `:||` 等价），回到曲首后**后续反复照常生效**，
  故不进 `inJump` 抑制模式；房外的 D.C. 仍按老规矩。④ 谱面写明 2 号以上的房时**不再**跑
  `repeatByLyric()`——遍数已由房号显式给定，再按歌词段数整体乘一遍会把本曲乘成 6 倍。
- **多段词只印在主歌行**：伪 verse 过滤原先只看「有字谱行数 ≥ 主 verse 一半」，而 2..N 段词
  本就只印在主歌那几行（啦…/间奏行下方没有），本曲 A 段五行词被整片当伪 verse 删光、六个房
  全唱成第一段。加逃生口：**该行字数 ≥ 同行主 verse 的 0.6 倍**（= 完整一行）即保留；噪声伪行
  只有零星几字，仍被删。去留还改成按**视觉行序整体**决定而非逐谱行：一个行序只要在某一谱行上
  是完整一行词就算真 verse，它在别的谱行上的短行（房内只唱一小节的「几多娇？」）跟着保留。
- **行首段号 → 词段映射**（`lyrics.ts` 的 `parseVerseLabel`）：多段谱在歌词行首印段号，
  **视觉行序未必等于段号**——`3.5.` 表示第 3、5 段共用这一行词，号还可能跳（`6.`）。段号是
  非汉字、装配时本就被丢弃不占音符位，只需从 rec 原文行首取回来做重映射（`versesOf`，一行词
  可同时写进多个 `lyrics[]`）。段号小、点更小，OCR 常把点吞掉（实测 `1沧海…`/`35江山…`），
  故分隔符可选、连写数字**逐位**拆号。房括号上的号码（`1.2.3.5.`）也会落进歌词带被当一行，
  按「号后须跟 ≥2 个汉字」剔掉。整套映射还要过「首行标 1 + 号不重复 + 至少两行有标签」才生效，
  否则作废退回"行序即段号"。标签通常只印在第一谱行，后续谱行按同一视觉行序共用该映射。
- **房内的短歌词行**（`covOf`）：注记过滤按「行宽/整谱行宽」算 cov，房内只覆盖一小节的第 2、3 段
  词（「天知晓。」占 0.2）会被当注记丢掉、那几遍没词唱。改成 cov 取「对整行」与「对各房」的
  最大值——整条落在某房内且铺满该房的短行同样算真词。

**隐含 tie 补检**（`jianpu.ts`，在歌词识别之后）：**无歌词的音符若与前一个音同音高，就是延音**。
简谱里同音延续本该画连音线，但**跨谱行的弧原图上就没有**（画不出来），行内的淡弧也可能漏检。
有歌词的音是新音节、不算延音；纯器乐行（前奏/间奏，整行无词）缺"有无歌词"这条线索，跳过以免把
重复音连成一片。实测补上「主祢真伟大」副歌跨行的 `1'_|1'`（两次副歌的行结构因此完全对称）、
「从前所珍爱」漏检的一条 → slur/tie 档 80→100%，平均 97.1→**99.6%**。

**长弧**（`slur.ts`）：弧高上限 1.05 字号只够跨相邻两音；跨多音的长弧拱得更高（`5__|5---|5` 的 tie
实测 w205 h28、numH22）会被整条漏掉。故 w>3 字号时上限放到 1.6 字号，但**高过 1.05 字号的块另要求
w/h≥4**——弧越长越扁（7.3），段落方框（"Chorus" 带框 w98 h36）接近方正（2.7）被挡在外。

**段落标记**（Intro/Verse/Chorus/Coda 方框）：与和弦同处歌词带，被 cov 过滤当注记丢弃——但它标出了
段落起点，对乐句排版有用。故被丢弃的短行（≤5 格）也送 rec（`Chunk.mark`，只提词不参与歌词装配），
在任何块的 rec 原文里用 `SECTION_MARK_RE` 就地捞词（Chorus 常与和弦同块）。落位：方框印在**下一谱行**
音符上方 → 归到该行、标记 x 所在**小节的首音**（`JpNum.sectionMark`）→ `<direction><words>`。
`musicxml.ts` 吐 `<lyric number>`，下游 `score/musicxml.ts` 导入器接管 → 排版/存 `.Words`。
仅 PaddleOCR 后端(`recognizeTexts`)支持，tesseract/null 后端跳过歌词。自然区域分块 rec 实测 W1 98.9%/W2 96.5%
（早期逐字/拼接 rec 仅 ~85%，差在破坏自然排版+细笔画字漏检）——回归 `node bench-lyrics.mjs`。
**实测准确率**（`日光之下简谱.jpg` 真实照片 vs GT jpwabc，token 级 Levenshtein）：
PaddleOCR + 修减时线过检后，**完整 token ~95.5%、仅数字+小节线 ~96.2%**（纯数字 100%；
对比 tesseract 初版仅 ~25% / ~44%）。歌词逐音节对齐：W1 **98.9%** / W2 **96.5%**（自然区域分块 rec）。
回归：`node measure-all.mjs`(音符/八度/附点/小节/slur-tie/歌词/标题/词曲，全 7 档、CSV 逐曲+平均) +
`node bench-lyrics.mjs`(歌词)。**Gemini 整页方式仍是更准的一路**。
回归脚本：`node measure-all.mjs`（自动扫 `testdata/` 每个歌谱文件夹，需本地 Edge；用 `window.__omr` 跑真实管线；
可加子串参数只测部分曲，如 `node measure-all.mjs 从前`）。
**页眉识别**（`header.ts`，标题/作词作曲/调号/速度）：首选 **DBNet 文本检测(det)整片识别**——
`paddleocr.ts` 的 `recognizeRegion(bin, 音符上方区域)` 用 det 模型自动找文本行框、逐行 rec(`recognizeCanvas`
放宽宽上限至 2048 免长英文著作者行被压扁)，再按字号/行首前缀归类：行首 `作/词/曲/编/译`+冒号→credit
（前缀允许顿号/斜杠分列的 `词、曲：`，名字允许顿号并列多人 `游智婷、曾祥怡`）、
最大字号中文行→标题(去 `557.` 编号前缀)、著作者前缀冒号统一全角 `：`、`parseMeta` 解析 `1=♭B`/`♩=76`。
det 漏检时退回**连通域几何法**(大/小字分层 + `splitBlocks` 按 x 间隙切区 + `mergeStackedColumns` 把粗体复杂字
如 督/赢 上下裂块竖向并回整字)。实测 5 首测试曲标题 100%、词曲 99.0%（det A/B 对几何法只赢不输：日光之下
词曲 100 vs 几何 92.9；几何法标题曾因 督/赢 裂块丢字、按大间隙切半只剩"得城市"）。
回归 `node measure-all.mjs` 的「标题」「词曲」两档。

## ABC 记谱导入（`src/abc/`）

导入 **ABC 记谱**（`.abc`）：拖入或「打开」`.abc` → 转 MusicXML → 复用现有 MusicXML 导入路径
（`importBytes` 识别 `.abc` → `abcToMusicXml` → 改名 `.musicxml` 走 `loadMusicXml`，天然享受多声部
→混排、乐句排版、`_lastImportMeta` 等既有行为）。**全量忠实移植自 Willem Vree 的 abc2xml.py**
（`~/proj/zanmeigepu/abc2xml.py`，2181 行，LGPL），非子集裁剪：

- `src/abc/pyparsing.ts` — pyparsing 迷你 shim（只实现 abc2xml 用到的有界子集组合子 + `+|^~<<` 运算符）。
  **关键语义**：默认跳空白、`leaveWhitespace()` 递归**复制**子节点后再关空白（不污染共享叶子）、
  parse action 按 `fn.length` 变参调用 `(instring,loc,toks)`、`loc` 为跳空白后的匹配起点（beam 断裂检测靠它）。
- `src/abc/eltree.ts` — 极简 `xml.etree` shim（`Element/set/get/append/insert/remove/find/findall/findtext/text` + `tostring`）。
- `src/abc/abc2xml.ts` — `abc_grammar`/`pObj`/模块 helper/`stringAlloc`/~1200 行 `MusicXml` 类 逐段翻译；
  公开 `abcToMusicXml(abcText, {pageCredits=true}): string`。**函数/类名与 python 对应**，改行为前先核对 abc2xml.py 原文。
- `src/abc/credits.ts` — 移植 `download_score.py` 的 `post_process_xml_metadata`（zanmeigepu 下载管线的
  **后处理**）：从 C: 字段（`作词：`/`作曲：`/`词曲：`/`编曲：`）还原作者，删掉 `<identification>` 里的
  `<creator>`，改成页面定位的 `<credit>`（A4 fallback 坐标，或读 `<defaults>`）。`abcToMusicXml` 默认调用；
  无这些前缀的 ABC 不加 credit（等同裸 abc2xml）。附带修好了 jpeditor 里作词/作曲的显示（原先 WordsByAndMusicBy 空）。
  易错处（已处理）：python `n*string` 重复→`.repeat`、`//`→`Math.trunc`、tuple 键 dict→`TMap`、
  dict.get 默认值、可变默认参数、`re.sub` 函数替换、`(?<!\\)` 负向后顾。**注意 Write 工具会把某些
  字面空格 `" "` 写成 NUL**——落文件后 `file src/abc/abc2xml.ts` 应报 UTF-8 而非 data。

**验证**：`node abc-check.mjs` 经浏览器 bundle（`window.__abc2musicxml`）转 3 组 fixture 做**规范化 token
diff**——zanmeigepu（含 page credits）比**已发布的 `zanmeigepu_score.xml`**（=abc2xml+后处理，9288 token/
53 小节）、合成用例（无作者前缀 → 不加 credit）比本机 `python3 abc2xml.py`，均实测**逐字节一致**（覆盖
多声部/连奏/重复/volta/和弦/装饰/broken-rhythm/调号变更 等）。`node abc-shot.mjs <abc> out.png`
经 `window.__app.importBytes` 走 `.abc` 全链路渲染核对。回归 musicxml/eltree/pyparsing 后跑这两个脚本。

## 重新生成 ANTLR 解析器

改了 `src/jpword/Jpwabc.g4` 后（需 JDK，本机在 `/opt/homebrew/opt/openjdk/bin`）：

```bash
java -jar /tmp/antlr-4.13.2-complete.jar -Dlanguage=TypeScript -o /tmp/gen -visitor src/jpword/Jpwabc.g4
# 把生成的 *.ts 拷到 src/jpword/parser/，给每个文件首行加 `// @ts-nocheck`
```
运行时用 npm 的 `antlr4` 包（浏览器构建），导入写 `from "antlr4"`、生成文件用 `./X.js` 后缀
（bundler 解析到 `.ts`）。

## 乐句排版（`src/score/phrase.ts`）

工具栏「按乐句重排」：不用导入时的行结构，按乐句重新断行。`computePhraseBreaks(part)` 在候选断点上跑
类 Knuth-Plass 的 DP（行长以**小节数**计，目标 4、下限 3、上限 7），断点强度来自歌词标点/延长号/长音/
休止/终止线/重复段边界。`scoreToJpwabc(score,{phrase:true})` 消费其结果；换页由 `jpscore.ts::balanceVoicePages`
按「段末行号 `_pageLines` + 段内每页至多 4 行」重排。

- **段落分段**：`Measure.sectionMark`（来自 MusicXML `<direction>` 的 `<rehearsal>`/段落词 `<words>`，
  段落词表见 `score/musicxml.ts::SECTION_WORD_RE`——**不含 Fine/D.S.**，那是终止记号不是段落起点）→
  `PhraseBreaks.sectionStarts`。段首**硬换行 + 另起一页**（主歌/副歌不同页），且**每段独立跑 DP**
  （否则 DP 会为凑均匀行长把上一段末尾并进本段首行）。只有 1 行的段（如前奏）不单独占页、并入下一段。
  段界落在段首小节前；那里若 slur/tie 未闭合（长音 tie 连到段首音，如 `5__|5---|5`）**顺延到弧闭合处**
  ——延续音留在上一页、弧才画得完整（跨页的弧渲染不出来）。**只顺延到弧闭合，不再往后凑整小节**：
  段首小节就此拆成两半，但段落的起句（超长音收尾之后、重复段的第一个音、带唱词的那个音）留在新页
  行首。凑整小节会把整个起句让给上一页，反而丢了段落开头。
  **副歌（refrain）起点同样是段界**：jpscore 本就会在它之前强制断行并分页，phrase 不知情就会按自己的
  乐句信号在别处断，两者叠加把中间那点内容甩成孤零零一行（「从前所珍爱」曾一行只剩一个休止）。
- **重复优先作行首**：旋律指纹与**歌词指纹**各自按位移扫出**极大**重复连续段（≥2 小节，逐个长度枚举
  会把所有子段边界也塞进来、等于没有边界），其两端给 `BASE_BREAK` 满分 → 在此断行完全免罚。
  重复乐句排进相同行结构是简谱惯例，也最贴近原谱分行（日光之下前两行因此与原图一致）。
- **slur/tie 先栈式配对**：识别出的弧常不成对，一个悬空起始就让 depth 永不归零、此后再无候选断点，
  整曲退化成一整行（「主祢真伟大」第 13 小节起）。未配对的起始/收尾一律不计深度。
- **行长约束是软惩罚**：可断点稀疏时（副歌里弧线跨小节连成一片）硬禁会无解。除小节数外还限
  **每行格数** `MAX_CELLS=25`（格 = 音符 1 + 每根增时线 `DASH_W=0.7`——增时线渲染得比数字窄，
  按 1 整格算会高估长音行、把「超长音收尾」挤到下一行去），否则密集副歌会排出 28 格的行、超页宽被折行。
  能在 5 小节 / 30 格内完整收于句号的句子允许稍宽，并惩罚句号前的提前拆行；更长的句子仍可在逗号或音乐
  信号处换行。段落标题若落在新小节、而上一句的 1~2 个收尾音占用该小节开头，则段界移到句号之后。
  `MIN_MEAS` 对非段末行是硬约束，但**与 `MIN_CELLS=14` 满足其一即可**：行从小节中间起头时（前一行
  在长音 tie 收尾处断）按小节数算会偏小，内容量其实够。段末/曲末行虽可短，也**加软罚**——否则会
  甩出只有一小节的尾巴。
- **行内断点（非小节末）另加罚 6，但只压弱信号**：简谱通常在小节线换行；而句号/长音/延长号/重复边界
  （score≥4）落在小节内时，那本就是乐句真正的收尾处，不该因「没赶上小节线」被罚。弧收尾本身只给 1 分
  （让它进入候选——密集副歌里小节末全被跨小节的弧封锁时，那是唯一能切开长行的地方）；但**它收的若是
  一个长音**（`5---|5)` 这种 tie 延续），把长音的 4 分带过来 → 乐句就在这里收尾，断点跟着落在小节内。
- **重复边界顺延过长音 tie 组**：边界之后若紧跟 `(5---|5)` 这样的长音弧，那是上一乐句的延音收尾、
  歌词也还是上一句的末字（「手心中」的「中」），不该充当新乐句的开头 → 边界顺延到弧闭合之后。
  与段界的顺延规则一致。

回归无自动脚本，用 `window.__app.setPhraseLayout(true)` 取 `.Voice` 各行的「小节数/格数」人工核对。
当前 9 首基线：**每行都落在 3~5 节 / 11~25 格**（主祢真伟大 9 行、日光之下 6 行、耶稣普治 4 行…；
从小节中间起头的行会显示 2 节但格数够）。出现「整段一行」「1 小节一行」都是退化。

## 播放速度（issue #2）

试听与导出 MIDI 的速度 = **谱面标注 ♩=** × **用户倍率**，两者都在 `score/timeline.ts::playTempo`
里折算，`TEMPO = 90` 退化成"谱面没标速度"时的兜底值。

- **谱速来源与往返**：MusicXML `<sound tempo>`（OMR 页眉的 `♩=76`、ABC 的 `Q:` 都吐这个）
  → `score/musicxml.ts::parseSound` → `PlayData.tempo` → `jpscore.ts` 写 `.Title` 的
  `Tempo = 76` → `jpwimport.ts` 读回。**必须经 .jpwabc 走一圈**：导入是 xml→jpwabc 文本→
  编辑器重解析，不落进 `.Title` 就会在这一步丢掉。`.Title` 本就是自由的 `键 = 值` 表
  （`TitleSection.parse` 通吃），加键不用动 ANTLR 语法。
- **倍率**：工具条「试听」旁的下拉（`SPEED_STEPS`，×0.5~×2），存进 localStorage 的渲染设置，
  经 `App.playOptions()` 同时喂给试听和 MIDI 导出。播放中改倍率会按新速重播——音已排进
  Web Audio 队列，改不了只能重来。

## 约定

- 严格模式 TS，`noUnusedLocals/Parameters`。生成代码用 `// @ts-nocheck` 豁免。
- 文件编码：`.jpwabc` 读时 BOM 探测（回退 UTF-16LE/UTF-8），存时 UTF-16LE + BOM。
- Tauri 能力在 `src-tauri/capabilities/default.json`；新增插件要同时改 Cargo.toml、
  `src-tauri/src/lib.rs`、capabilities、`package.json`。
- 提交信息用简要中文，不要 `Co-Authored-By` 尾注。

## 进度

Phase 0（脚手架）、Phase 1（解析→模型→导入→排版→SVG 渲染）、Phase 2（编辑器 + 实时重排 +
文件读写 + 翻页）已完成。Phase 3（点选/选中高亮/对话框）、4（导出 MIDI/PNG/PPTX）、
5（Rust MusicXML 导入）、6（选项面板/打包）待做。
简谱 OMR（图片→MusicXML，两路：Gemini/agy + musicpp 本地移植）已落地进编辑器（见上节）。
musicpp 本地路数字 OCR 已从 tesseract.js 换成 PaddleOCR（onnxruntime-web，数字实测 100%），
并新增歌词识别 + 逐音节↔音符对齐（见 OMR 节）。rec 模型 PP-OCRv4 → v5_mobile → **PP-OCRv6_small**
（字典 6623→18708 字、「祂」4/4 全对），配合 jianpu.ts 矮块补高 + 空心环校验，6 曲音符 100%、歌词/词曲 ~100%（见 OMR 节）。
ABC 记谱导入（`.abc`→MusicXML→排版）已落地：全量忠实移植 abc2xml.py 到 `src/abc/`，与原脚本输出
逐字节一致（见 ABC 节）。
