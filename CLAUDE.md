# jpeditor-web

简谱（JP-Word / `.jpwabc`）与文本谱的排版与编辑器：Tauri 2 + TypeScript + SVG。
排版、渲染、模型、编辑全在前端 TS；Rust 只做文件 I/O 与对话框。

**模块相关的一切都在 [docs/架构与实现.md](docs/架构与实现.md)**——架构决策、数据流、
各模块的判据与踩坑记录；专题笔记在 [docs/实现/](docs/实现/)。**动某一块之前先翻对应那节**，
那些阈值和判据多半是拿具体曲子换来的，别照直觉改。

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
