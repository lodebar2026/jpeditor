import { defineConfig, type Plugin } from "vite";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error import.meta.dirname 在 Vite 的 ESM 配置里可用（node ≥20 亦有）
const here = typeof import.meta.dirname === "string" ? import.meta.dirname : dirname(fileURLToPath(import.meta.url));

// pdf.js v6 的位图解码器 wasm（jbig2 兼管 CCITTFax G4，供 OMR 读扫描版乐谱 PDF）来自
// `pdfjs-dist` 包，版本随 package-lock 锁定 → 不入库，改为构建/开发启动时从 node_modules 拷到
// public/redist/pdfjs/（pdf.js 按固定文件名 fetch `${wasmUrl}jbig2.wasm`，故不能走 Vite ?url 的 hash 资源）。
function copyPdfjsWasm(): Plugin {
  const files = ["jbig2.wasm", "jbig2_nowasm_fallback.js", "openjpeg.wasm", "openjpeg_nowasm_fallback.js", "qcms_bg.wasm"];
  const src = `${here}/node_modules/pdfjs-dist/wasm`;
  const dst = `${here}/public/redist/pdfjs`;
  const copy = () => { mkdirSync(dst, { recursive: true }); for (const f of files) copyFileSync(`${src}/${f}`, `${dst}/${f}`); };
  return { name: "copy-pdfjs-wasm", buildStart: copy, configureServer: copy };
}

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// GitHub Pages 项目页部署在子路径下（BASE_PATH=/jpeditor/）。Tauri 桌面构建
// 不设此 env，base 保持 "/"，桌面包资源解析不受影响。
// @ts-expect-error process is a nodejs global
const base = process.env.BASE_PATH || "/";

// https://vite.dev/config/
export default defineConfig(async () => ({
  base,
  plugins: [copyPdfjsWasm()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // 跨源隔离：让 onnxruntime-web 拿到 SharedArrayBuffer 以开 wasm 多线程（OMR rec 推理 ~2x）。
    // 全站资源同源，COEP require-corp 无副作用。多线程初始化带超时回退，开不起来会自动退单线程。
    // 注意：生产 GitHub Pages 无法设响应头 → 那里非隔离，desiredThreads 自动返回 1（仍享数字批量加速）。
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
