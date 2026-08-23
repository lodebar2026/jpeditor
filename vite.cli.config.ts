// Node CLI 构建：把 src/ 里不碰 DOM 的模块打成一个 Node ESM 产物（dist-cli/index.js），
// 供仓库根的 page-report.mjs / pdf-diff.mjs 等**不起浏览器**的脚本 import。
// 与 app 共用同一份源码，避免矢量抽取逻辑分叉成两份。
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false, // 别把 public/redist 拷进来
  build: {
    ssr: "src/cli/index.ts",
    outDir: "dist-cli",
    emptyOutDir: true,
    target: "node20",
    minify: false,
    rollupOptions: { output: { entryFileNames: "index.js" } },
  },
});
