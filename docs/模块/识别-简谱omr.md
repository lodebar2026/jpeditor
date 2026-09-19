# 识别：简谱 OMR（图片 / PDF）

**判据全录** → [../实现/OMR-简谱识别.md](../实现/OMR-简谱识别.md)（1193 行）、[../实现/矢量PDF识别.md](../实现/矢量PDF识别.md)（2441 行）

## 职责

简谱图片/PDF → 123（经 `ScoreDoc`）/ 文本谱原文。**不产出 MusicXML**（要的话就是 123 文档的导出；只有五线谱识别出 MusicXML）。**全本地、可离线**（连通域几何启发 + PaddleOCR）。
另含矢量（文字转曲）PDF 的对象层抽取。

## 入口

| 函数/文件 | 作用 |
|---|---|
| `recognizeMusicppDetailed` | `src/omr/recognize.ts:16` 顶层编排 |
| `src/omr/jianpu.ts`（1240 行） | 几何启发式主管线 |
| `src/omr/lyrics.ts`（962 行） | 歌词识别与逐音节↔音符对齐 |
| `src/omr/header.ts` | 页眉标题/词曲/调号（PP-OCRv4 DBNet 文本检测整片识别；调号认不出时按单字符 + 位置兜底） |
| `src/omr/paddleocr.ts` | PP-OCR 推理 |
| `src/omr/overlay.ts` | 识别核对叠加层 |
| `src/omr/emit.ts` | 输出格式注册表 |
| `src/omr/todoc.ts` / `topu.ts` | → 简谱形状的 `ScoreDoc`（123 由它 `emit123`）/ → 文本谱原文 |
| `src/omr/vector.ts` / `inventory.ts` / `glyphdict.ts` | 矢量 PDF 对象层、归类、形状字典 |
| `src/editor/omrctl.ts` | 编辑器侧控制器（识别 → 出文本 → 叠加核对 → 点选定位） |

## 吃什么吐什么

```
图片/PDF → 预处理/二值化 → 连通域 → 归类 → OCR（数字/歌词）→ RecognizedScore
        → ScoreDoc → 123 / 文本谱原文（换格式只重走 emitter，绝不重跑识别）
```

## 关键判据

- **`src/omr/vector.ts` 及其 import 链不得触碰 canvas / OffscreenCanvas / document**——Node CLI 要 import 它。
- PDF 栅格化**必须**用 `getDocument({wasmUrl})`。
- **归类判据一改就要重跑 `scripts/gen-glyphdict.mjs`**。
- 矢量路的硬指标是**未归类对象数**。
- OCR 兜底后仍读不出的字形**宁可留空也不编造**（`■` 一项曾多出 337 处）。
- 干净谱面上减时线粘着点/数字：**按本页统计线粗剥掉线带、剩下的每块都得认得出**，认不出就整块不动（`stripUnderline`）。
- 歌词识别的缓存按**条的内容指纹**寻址——判据一动缓存就落空，**掉一点先别当退化**。

## 回归

回归脚本、语料与基线不在本仓库（本地私有仓库）。

## 已知限制

- **矢量 PDF 路只有 CLI 走**，编辑器未接（`isVectorPdf` 无调用方）
- 版权说明/注记行可能被当成歌词行
- 矢量路：和弦剩 4.5% 差异、调号 17 首（原书转过调）、反复与房号只记录不计入差异、
  OCR 形近字误判、标点互换约 100 处、升号/上标 7 混进歌词约 400 处
