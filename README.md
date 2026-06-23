# jpeditor-web

> 开源的简谱（JP-Word / `.jpwabc`）在线排版与编辑器 · An open-source jianpu (numbered
> musical notation) editor & typesetter.

[![Release](https://img.shields.io/github/v/release/lodebar2026/jpeditor-web?display_name=tag)](https://github.com/lodebar2026/jpeditor-web/releases)
[![Live demo](https://img.shields.io/badge/%F0%9F%8C%90%20Live%20demo-online-2b6cb0)](https://lodebar2026.github.io/jpeditor-web/)
![Platform](https://img.shields.io/badge/platform-Web%20%7C%20macOS%20%7C%20Windows-555)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**🌐 在线试用 / Live demo：<https://lodebar2026.github.io/jpeditor-web/>**

简谱（JP-Word / `.jpwabc`）排版与编辑器 —— **Tauri 2 + TypeScript + SVG** 版。

由原 Kotlin/JVM + JavaFX + Skija 桌面应用迁移而来：体量更轻、跨平台分发更简单、单一现代技术栈。
左侧高亮代码编辑器，右侧实时简谱预览，支持点选、翻页、**简谱与五线谱混排**（加载 MusicXML
排版）、MusicXML 导入，以及导出 PDF / PNG / MIDI / 矢量 PPTX。

![界面](docs/screenshot.png)

## English

**jpeditor** is an open-source editor and typesetter for **jianpu** (Chinese
numbered musical notation) in the `.jpwabc` (JP-Word) format. Edit the score as
text on the left and see a live SVG preview on the right. It supports **mixed
jianpu + staff (Western) notation** typeset from MusicXML, MusicXML import, and
export to **PDF / PNG / MIDI / vector PPTX**. It runs **in the browser**
(no install) and as a lightweight **Windows / macOS desktop app** (Tauri 2).

- 🌐 Live demo: <https://lodebar2026.github.io/jpeditor-web/>
- ⬇️ Desktop downloads: [Releases](https://github.com/lodebar2026/jpeditor-web/releases)

## 特性

- **`.jpwabc` 实时编辑**：CodeMirror 6 编辑器 + 语法高亮，编辑即重排重渲染
- **SVG 矢量渲染**：乐谱以 SVG 绘制，分辨率无关；用浏览器 `getBBox` /
  `getComputedTextLength` 测量，与渲染同一引擎、天然一致
- **点选与高亮**：点击音符/歌词即选中（CSS 高亮，不重渲染），状态栏显示信息
- **分页**：按比例自动分页（16:9 / 4:3 / A4），可设每页行数
- **文件**：打开 / 保存 / 另存为 / 拖拽打开（UTF-16LE 编解码，兼容 JP-Word）

## 安装与使用

- **浏览器在线版**（免安装）：<https://lodebar2026.github.io/jpeditor-web/>
- **桌面版下载**：[Releases](https://github.com/lodebar2026/jpeditor-web/releases)
- macOS 首次打开提示“已损坏”或“无法验证开发者”？见
  [docs/macOS-打不开.md](docs/macOS-打不开.md)（应用未签名，属正常现象，一条命令即可解决）。

## 技术栈

外壳 Tauri 2（Rust） · 前端 TypeScript + Vite · 编辑器 CodeMirror 6 ·
`.jpwabc` 用 ANTLR 4 解析 · 原生 SVG DOM 渲染 · Bravura（SMuFL）字体。
完整技术框架、架构要点与项目结构见 [docs/技术栈.md](docs/技术栈.md)。

## 开发

前置：Node ≥ 20、Rust（含 cargo）、（改文法时）JDK。

```bash
npm install

npm run dev          # Vite 开发服务器（仅前端）
npm run tauri dev    # 跑桌面应用（需 Rust）
npm run build        # tsc 严格检查 + 打包
npx tsc --noEmit     # 仅类型检查

# 无头渲染/交互校验（用本地 Edge，免下载 chromium）
npm run build && node shot.mjs /tmp/out.png
```

项目结构与数据流见 [docs/技术栈.md](docs/技术栈.md)。

## 进度

- [x] 脚手架、字体/测量基础设施
- [x] 解析 → 模型 → 导入 → 排版 → SVG 渲染
- [x] 编辑器 + 实时重排 + 文件读写 + 翻页
- [x] 点选/选中高亮 + 页面行数/选项（比例/字号/颜色）对话框
- [x] 导出 PNG / 矢量 PPTX / MIDI
- [x] MusicXML 导入 → `.jpwabc`（TypeScript，DOMParser）
- [x] 跨平台打包（`npm run tauri build`）

打包产物（Apple Silicon）：`jpeditor.app` ≈ 11MB、`.dmg` ≈ 4.6MB
（原 JVM + JavaFX + Skija 版含 JRE 通常 100MB+）。

> 已放弃原项目的 JAXB（MusicXML 改为 TypeScript 解析）与 IDML 导出。

## 许可

随附 Bravura 字体（SIL OFL，见 `public/redist`）。
