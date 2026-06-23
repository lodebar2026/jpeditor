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

## macOS 打不开 / 提示"已损坏"或"无法验证开发者"

本应用没有花钱购买苹果的开发者签名，所以第一次打开时 macOS 会拦下来，提示
**"jpeditor 已损坏，无法打开"** 或 **"无法验证开发者"**。这是正常现象，软件本身没坏，
按下面任一步骤即可正常使用。

**前提**：先把 `jpeditor.app` 拖进"应用程序"（Applications）文件夹。

### 方法一：一条命令（推荐，所有 macOS 版本通用）

> 这是最可靠的办法。新版 macOS（15 Sequoia 起，尤其 26 Tahoe）不断收紧限制，
> 下面方法二的图形界面入口在新系统上时灵时不灵；而这条终端命令不受影响，
> 拿不准时直接用它。

1. 打开"启动台"或"应用程序" → "实用工具"，双击打开 **终端（Terminal）**。
2. 把下面这一整行**原样复制**进终端，按回车：

   ```bash
   xattr -cr /Applications/jpeditor.app
   ```

   - 这行命令的作用：清掉 macOS 给从网上下载的文件打的"隔离"标记，让系统不再拦截。
     它只针对这一个应用，安全无副作用。
   - 如果你没有把应用放进"应用程序"文件夹，就把命令末尾的
     `/Applications/jpeditor.app` 换成它实际所在的位置
     （最简单的办法：在终端里先敲 `xattr -cr ` 再加一个空格，
     然后把 `jpeditor.app` 图标直接拖进终端窗口，路径会自动填好），再按回车。
3. 回车后没有任何提示就代表成功了。现在双击 `jpeditor.app` 即可正常打开。

### 方法二：不用终端（仅较老系统可靠，按版本二选一）

**macOS 14（Sonoma）及更早**——右键打开：

1. 在"应用程序"文件夹里找到 `jpeditor.app`。
2. **按住 Control 键并点击**（或用触控板"右键单击"）它，在菜单里选 **"打开"**。
3. 弹出的警告窗口这次会多出一个 **"打开"** 按钮，点它即可。只需做一次。

**macOS 15（Sequoia）/ 26（Tahoe）**——苹果已移除"右键打开"，改走系统设置：

1. 先正常双击一次 `jpeditor.app`，让它被系统拦下（看到警告点"完成/取消"即可）。
2. 打开 **系统设置 → 隐私与安全性**，下拉到底部，若看到一行
   "已阻止 jpeditor 使用……"，点旁边的 **"仍要打开"**，再输入管理员密码确认。

> 重要：在 macOS 15.1 及更新的系统上，对未签名应用，上面这个 **"仍要打开"按钮
> 经常根本不出现**（弹窗只剩报错、无可点按钮）。一旦遇到这种情况，或提示的是
> **"已损坏"**，请直接用方法一的 `xattr`——它是唯一不受版本限制、必定有效的办法。

## 技术栈

| 层 | 选型 |
|---|---|
| 外壳 | Tauri 2（Rust） |
| 前端 | TypeScript + Vite |
| 编辑器 | CodeMirror 6 |
| `.jpwabc` 解析 | ANTLR 4（`Jpwabc.g4` 生成 TS） + `antlr4` 运行时 |
| 渲染 | 原生 SVG DOM |
| 字体 | Bravura（SMuFL） + 系统中文字体 |

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

## 项目结构

```
src/
  common/   Fraction、几何(Point/Rect/Matrix33)、SVG 测量基础设施
  smufl/    Bravura 元数据加载 + 字形码
  jpword/   .jpwabc 分段解析 + ANTLR 生成的词法/语法 + 高亮分词器
  score/    乐谱数据模型 + jpw 导入
  layout/   排版引擎 + SVG 渲染(painter)
  editor/   编辑器/渲染/翻页/文件 I/O 控制器、对话框
src-tauri/  Rust 后端（文件 I/O、对话框；导出待加）
public/redist/  Bravura 字体与元数据
```

数据流：`.jpwabc → JpwFile → ANTLR → fromJpw → Score → 排版 → SVG`。

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
