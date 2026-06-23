import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// GitHub Pages 项目页部署在子路径下（BASE_PATH=/jpeditor-web/）。Tauri 桌面构建
// 不设此 env，base 保持 "/"，桌面包资源解析不受影响。
// @ts-expect-error process is a nodejs global
const base = process.env.BASE_PATH || "/";

// https://vite.dev/config/
export default defineConfig(async () => ({
  base,

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
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
