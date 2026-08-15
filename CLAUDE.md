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
- `src/jpword/hanconv.ts` — 简繁转换（工具栏「简繁」）。词表用 opencc-js，按方向动态
  `import()`（`opencc-js/cn2t` / `opencc-js/t2cn`，各自独立 chunk，首屏不加载）。只转
  `.Title` 的字段值与 `.Words` 的歌词内容；歌词行先把非 ASCII 内容字符抽出拼成整串再送词表
  （跨过 `/`、`-`、`()` 等记号，否则 `日光/之下` 会被拆开导致词汇级转换失效），转换结果按原位
  逐字回填，长度对不上就退回逐字转换，绝不错位。
- `src/editor/` — `app.ts`（编辑器↔实时重排↔翻页↔文件 I/O 控制器）、`highlight.ts`
  （CodeMirror 装饰）、`fileio.ts`（UTF-16LE 编解码 + Tauri 运行时探测）。
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

- **[OMR 简谱识别](docs/实现/OMR-简谱识别.md)**（`src/omr/`，最长的一篇）——图片/PDF → MusicXML。
  两路：`gemini`（agy CLI，仅桌面版，更准）与 `musicpp`（全本地：连通域几何 + PaddleOCR PP-OCRv6_small，
  浏览器离线）。14 首 GT 基线：音符/八度/附点/小节/对位/标题/词曲 100%，slur-tie 99.8%、歌词 99.5%。
  回归 `node measure-all.mjs`、`node bench-lyrics.mjs`、`node check-gt.mjs`。
  篇中逐条记录了几何启发式的判据与反例（八度点/附点/减时线/衬词行/歌词标点/反复房/页眉著作者…），
  **动那些阈值前必看**——每条都是拿具体曲子换来的。
- **[乐句排版](docs/实现/乐句排版.md)**（`src/score/phrase.ts`）——工具栏「按乐句重排」的 DP 与代价项
  （行长目标、整句独占一行、断点凭据、段落/副歌分页）。回归 `node phrase-lines.mjs [曲名子串]`。
- **[ABC 记谱导入](docs/实现/ABC-导入.md)**（`src/abc/`）——abc2xml.py 的全量忠实移植（含 pyparsing /
  etree shim）。改前先核对 python 原文，回归 `node abc-check.mjs`、`node abc-shot.mjs`。
- **[混排](docs/实现/混排.md)**（`src/mixed/`）——移植自 C++ 工程 musicpp（`~/proj/musicpp`），
  含测试 musicxml 的位置。改混排行为前先核对 musicpp 原文。
- **[播放速度](docs/实现/播放速度.md)**（`score/timeline.ts`）——谱面 `♩=` × 用户倍率，
  以及它怎么经 `.Title` 的 `Expression` 字段往返 `.jpwabc`。
- **[MusicXML 导出](docs/实现/MusicXML-导出.md)**（`score/musicxmlout.ts`、`musicxmlpatch.ts`、
  `musicxmllayout.ts`）——工具栏「导出 → MusicXML」。**有 MusicXML 底本（OMR/ABC/导入的 xml）
  就在底本上做增量 patch，绝不整体重生成**（.jpwabc 承载的信息更少，重生成 = 降采样）；
  patch 刻意不碰 barline/ending/repeat/direction 等 jpwabc 表达不了的结构。全量序列化那条路
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
