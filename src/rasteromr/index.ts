// 位图五线谱识别入口。全链不碰 DOM（要进 `src/cli/index.ts` 那条 Node 链）。
//
// 与 `src/staffomr/` 的分工：那边吃**文字层完整**的矢量 PDF（Finale/Sibelius 直出，
// 音乐符号是 Maestro/Opus/Anastasia 的真字符）；这边吃**整页是一张位图**的
// （PageMaker/Distiller 出的合唱谱，文字层只剩页眉页脚）。
//
// **下游共用**：本模块只负责把位图变成 `Staff` / `Seg` / `Sym` / 文本 `PObj`，
// 装进 `SPage` 之后一律交给 `src/staffomr/page.ts` 往下那一整条
// （符头/符干/符杠/小节/时值/和弦/声部/弧线/MusicXML），**那边一行不改**。
export * from "./rasterpage";
export * from "./staffline";
export * from "./prims";
export * from "./adapt";
export * from "./rasterglyphs";
export * from "./notehead";
export * from "./lyric";
export * from "./contour";
export * from "./ledger";
export * from "./wedge";
export * from "./dynamics";
export * from "./slur";
export * from "./recognize";
