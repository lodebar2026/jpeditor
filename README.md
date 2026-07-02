# jpeditor-web

> 开源的简谱（JP-Word / `.jpwabc`）在线排版与编辑器 · An open-source jianpu (numbered
> musical notation) editor & typesetter.

[![Release](https://img.shields.io/github/v/release/lodebar2026/jpeditor-web?display_name=tag)](https://github.com/lodebar2026/jpeditor-web/releases)
[![Live demo](https://img.shields.io/badge/%F0%9F%8C%90%20Live%20demo-online-2b6cb0)](https://lodebar2026.github.io/jpeditor-web/)
![Platform](https://img.shields.io/badge/platform-Web%20%7C%20macOS%20%7C%20Windows-555)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**🌐 在线试用 / Live demo：<https://lodebar2026.github.io/jpeditor-web/>**

简谱（JP-Word / `.jpwabc`）排版与编辑器。

左侧高亮代码编辑器，右侧实时简谱预览，支持点选、翻页、**简谱与五线谱混排**（加载 MusicXML
排版）、MusicXML 导入、**简谱图片识别（OMR）**，以及导出 PDF / PNG / MIDI / 矢量 PPTX。

![界面](docs/screenshot.png)

## English

**jpeditor** is an open-source editor and typesetter for **jianpu** (Chinese
numbered musical notation) in the `.jpwabc` (JP-Word) format. Edit the score as
text on the left and see a live SVG preview on the right. It supports **mixed
jianpu + staff (Western) notation** typeset from MusicXML, MusicXML import,
**optical music recognition (OMR)** of jianpu images, and export to
**PDF / PNG / MIDI / vector PPTX**. It runs **in the browser**
(no install) and as a lightweight **Windows / macOS desktop app** (Tauri 2).

- 🌐 Live demo: <https://lodebar2026.github.io/jpeditor-web/>
- ⬇️ Desktop downloads: [Releases](https://github.com/lodebar2026/jpeditor-web/releases)

## 特性

- **`.jpwabc` 实时编辑**：CodeMirror 6 编辑器 + 语法高亮，编辑即重排重渲染
- **SVG 矢量渲染**：乐谱以 SVG 绘制，分辨率无关；用浏览器 `getBBox` /
  `getComputedTextLength` 测量，与渲染同一引擎、天然一致
- **点选与高亮**：点击音符/歌词即选中（CSS 高亮，不重渲染），状态栏显示信息
- **分页**：按比例自动分页（16:9 / 4:3 / A4），可设每页行数
- **简谱图片识别（OMR）**：拖入简谱照片/截图即识别为 MusicXML 再导入排版。**本地识别**、
  浏览器/桌面均可、可离线：连通域几何启发 + PaddleOCR PP-OCRv4 数字/歌词识别，含逐音节↔音符
  对齐与页眉标题/词曲/调号识别
  - **识别核对视图**：识别后自动进入「识别 / 排版」可切换模式，把识别结果按源图坐标叠加在二值图上
    比对——支持原位叠加 / 附近浮窗 / 仅原图三种视图；点选识别对象即选中对应 `.jpwabc` 代码，
    悬停高亮并弹出整行 / 页眉浮窗，便于逐音校对
- **乐句分析排版**：MusicXML / OMR 导入时按乐句自动断行——综合歌词标点、音乐信号（延长号 /
  终止线 / 长音 / 休止 / 连线）与重复旋律结构，在小节边界找乐句断点并凑成疏密适中的行长
  （每页至多 4 行、末页 3+2）
- **文件**：打开 / 保存 / 另存为 / 拖拽打开（UTF-16LE 编解码，兼容 JP-Word）

## 安装与使用

- **浏览器在线版**（免安装）：<https://lodebar2026.github.io/jpeditor-web/>
- **桌面版下载**：[Releases](https://github.com/lodebar2026/jpeditor-web/releases)
- macOS 首次打开提示“已损坏”或“无法验证开发者”？见
  [docs/macOS-打不开.md](docs/macOS-打不开.md)（应用未签名，属正常现象，一条命令即可解决）。

## 技术栈

完整技术框架、架构要点与项目结构见 [docs/技术栈.md](docs/技术栈.md)。

## 开发

构建、运行与无头校验命令见 [docs/开发.md](docs/开发.md)。

## 进度

各阶段完成情况与打包产物体积见 [docs/进度.md](docs/进度.md)。

## 许可

随附 Bravura 字体（SIL OFL，见 `public/redist`）。
