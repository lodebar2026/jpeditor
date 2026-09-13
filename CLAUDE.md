# jpeditor-web

简谱（JP-Word / `.jpwabc`）与文本谱的排版与编辑器：Tauri 2 + TypeScript + SVG。
排版、渲染、模型、编辑全在前端 TS；Rust 只做文件 I/O 与对话框。

文档分四层，**动某一块之前先翻对应那层**——那些阈值和判据多半是拿具体曲子换来的，别照直觉改：

- [docs/需求.md](docs/需求.md) 做什么 · [docs/架构.md](docs/架构.md) 怎么分层、哪些决策不要推翻
- [docs/模块/](docs/模块/) 每个模块一页：职责/入口/判据/回归/限制（17 篇）
- [docs/格式/](docs/格式/) 格式规范：[123格式](docs/格式/123格式.md)（新，设计稿）、[jpwabc](docs/格式/jpwabc.md)；
  样式定制见 [docs/样式机制.md](docs/样式机制.md)
- [docs/实现/](docs/实现/) 判据与踩坑全录；[docs/架构与实现.md](docs/架构与实现.md) 是它们的摘要索引
- [docs/待办.md](docs/待办.md) 还要做什么（计划性待办，每条带验法）；
  [docs/遗留问题.md](docs/遗留问题.md) 具体曲目的未修问题（修掉一条删一条）

## 命令

```bash
npm run dev            # Vite 开发服务器
npm run build          # tsc 严格检查 + vite 打包
npx tsc --noEmit       # 仅类型检查
npm run tauri dev      # 桌面应用（需 Rust）
```

回归脚本全在 [scripts/](scripts/)（`node scripts/xxx.mjs`，一律从仓库根跑），
清单与用法见 [docs/架构与实现.md](docs/架构与实现.md) 的「命令」一节。

## 约定

- 测试语料与回归基线（`testdata/`）只留本地，不入库。
- 提交信息用简要中文，不要 `Co-Authored-By` 尾注。
- 代码与工程上的约定（TS 严格模式、文件编码、Tauri 插件要同改哪几处）见
  [docs/架构与实现.md](docs/架构与实现.md) 的「约定」一节。
