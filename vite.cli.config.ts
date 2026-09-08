// Node CLI 构建：把 src/ 里不碰 DOM 的模块打成 Node ESM 产物，供**不起浏览器**的脚本 import。
// 与 app 共用同一份源码，避免逻辑分叉成两份。两个入口：
//   dist-cli/index.js —— 矢量 PDF 版面那一摊（page-report.mjs / pdf-diff.mjs 等）
//   dist-cli/omr.js   —— 位图简谱识别（omr-cli.mjs、measure-all.mjs 等）
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false, // 别把 public/redist 拷进来
  build: {
    ssr: true,
    outDir: "dist-cli",
    emptyOutDir: true,
    target: "node20",
    minify: false,
    rollupOptions: {
      input: { index: "src/cli/index.ts", omr: "src/cli/omr.ts" },
      output: { entryFileNames: "[name].js", chunkFileNames: "[name].js" },
    },
  },
});
