# jpeditor-web

简谱（JP-Word / `.jpwabc`）与文本谱的排版与编辑器：Tauri 2 + TypeScript + SVG。
排版、渲染、模型、编辑全在前端 TS；Rust 只做原生加速（见架构决策 A3/A4）。

文档分四层，**动某一块之前先翻对应那层**——那些阈值和判据多半是拿具体曲子换来的，别照直觉改：

- [docs/需求.md](docs/需求.md) 做什么 · [docs/架构.md](docs/架构.md) 怎么分层、哪些决策不要推翻
- [docs/模块/](docs/模块/) 每个模块一页：职责/入口/判据/回归/限制（16 篇）
- [docs/格式/](docs/格式/) 格式规范：[123格式](docs/格式/123格式.md)（新，设计稿）、[jpwabc](docs/格式/jpwabc.md)；
  样式定制见 [docs/样式机制.md](docs/样式机制.md)
- [docs/实现/](docs/实现/) 判据与踩坑全录（各模块页开头有指向对应篇的链接）

## 命令

构建、类型检查、桌面调试命令见 [docs/架构.md](docs/架构.md)「技术栈与构建」。
回归脚本、语料与基线不在本仓库（本地私有仓库，从本仓库根跑 `node ../dev/scripts/xxx.mjs`）；
`scripts/` 只留发布链路：`release.sh`、`pack-omr.mjs`、`win-crt.mjs`、`vcredist.mjs`。

## 约定

- 测试语料与 GT（`testdata/`）只留本地，不入库；`testdata/` 只放语料与 GT，回归基线、快照、报告等派生数据放本地私有仓库。
  各模块页的「回归」一节同此。
- 提交信息用简要中文，不要 `Co-Authored-By` 尾注。
- TS 严格模式 + `noUnusedLocals/Parameters`；生成代码用 `// @ts-nocheck` 豁免。
- ANTLR 生成码在 `src/jpword/parser/`，**勿手改**；重生成步骤见 [源格式-jpwabc](docs/模块/源格式-jpwabc.md)。
- **PUA 码位用 `String.fromCharCode(0x...)`**，切勿在源码里写字面 PUA 字符（Write 工具会损坏字节）。
- 数 XML 元素的正则一律写 `<name[ >]`（否则 `<note>` 会命中 `<notehead>`）。
- `window.__app` / `window.__book` 运行时暴露（`src/main.ts`）供无头校验用。
- Tauri 新增插件要同改的四处见 [编辑器与播放](docs/模块/编辑器与播放.md)「Tauri 外壳」；其余见各模块页。
