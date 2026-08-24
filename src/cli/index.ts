// Node CLI 侧的入口：汇出矢量路需要的模块，由 `npm run build:cli`（vite --ssr）打成
// dist-cli/index.js 供仓库根的 .mjs 脚本 import。
//
// **这里只能汇出不碰 DOM 的模块**——page-report.mjs / pdf-diff.mjs 不起浏览器。
// 碰 canvas/OffscreenCanvas/document 的（decode.ts、paddleocr.ts、lyrics.ts 的 buildStrip、
// common/measure.ts 及一切依赖它的排版件）一律不许进这条 import 链。
export * from "../omr/vector";
export * from "../omr/bookprofile";
export * from "../omr/inventory";
export * from "../omr/glyphdict";
export * from "../pdflayout/spec";
export * from "../pdflayout/bookstyle";
export * from "../pdflayout/stats";
export * from "../pdflayout/drawlist";
export * from "../pdflayout/align";
export type { Binary, Component, Rect, JpNum, StaffRow, RecognizedScore, TextRegion } from "../omr/types";
