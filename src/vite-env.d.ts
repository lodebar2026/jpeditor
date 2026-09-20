/// <reference types="vite/client" />

/** 构建期注入（vite.config.ts 的 define），值取 package.json 的 version。 */
declare const __APP_VERSION__: string;
