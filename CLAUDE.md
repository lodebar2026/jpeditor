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
npm run build && node shot.mjs /tmp/out.png   # 截 #score-pane + 诊断
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

Phase 0（脚手架）、Phase 1（解析→模型→导入→排版→SVG 渲染）、Phase 2（编辑器 + 实时重排 +
文件读写 + 翻页）已完成。Phase 3（点选/选中高亮/对话框）、4（导出 MIDI/PNG/PPTX）、
5（Rust MusicXML 导入）、6（选项面板/打包）待做。
