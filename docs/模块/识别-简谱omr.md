# 识别：简谱 OMR（图片 / PDF）

**判据全录** → [../实现/OMR-简谱识别.md](../实现/OMR-简谱识别.md)（972 行）、[../实现/矢量PDF识别.md](../实现/矢量PDF识别.md)（2438 行）

## 职责

简谱图片/PDF → MusicXML / 文本谱原文 / `.jpwabc`。**全本地、可离线**（连通域几何启发 + PaddleOCR）。
另含矢量（文字转曲）PDF 的对象层抽取。

## 入口

| 函数/文件 | 作用 |
|---|---|
| `recognizeMusicppDetailed` | `src/omr/recognize.ts:38` 顶层编排 |
| `src/omr/jianpu.ts`（1240 行） | 几何启发式主管线 |
| `src/omr/lyrics.ts`（962 行） | 歌词识别与逐音节↔音符对齐 |
| `src/omr/header.ts` | 页眉标题/词曲/调号（PP-OCRv4 DBNet 文本检测整片识别） |
| `src/omr/paddleocr.ts` | PP-OCR 推理 |
| `src/omr/overlay.ts` | 识别核对叠加层 |
| `src/omr/emit.ts` | 输出格式注册表 |
| `src/omr/topu.ts` / `musicxml.ts` | → 文本谱原文 / → MusicXML |
| `src/omr/vector.ts` / `inventory.ts` / `glyphdict.ts` | 矢量 PDF 对象层、归类、形状字典 |
| `src/editor/omrctl.ts` | 编辑器侧控制器（识别 → 出文本 → 叠加核对 → 点选定位） |

## 吃什么吐什么

```
图片/PDF → 预处理/二值化 → 连通域 → 归类 → OCR（数字/歌词）→ RecognizedScore
        → MusicXML / 文本谱原文 / .jpwabc（换格式只重走 emitter，绝不重跑识别）
```

## 关键判据

- **`src/omr/vector.ts` 及其 import 链不得触碰 canvas / OffscreenCanvas / document**——Node CLI 要 import 它。
- PDF 栅格化**必须**用 `getDocument({wasmUrl})`。
- **归类判据一改就要重跑 `scripts/gen-glyphdict.mjs`**。
- 矢量路的硬指标是**未归类对象数**。
- OCR 兜底后仍读不出的字形**宁可留空也不编造**（`■` 一项曾多出 337 处）。
- 歌词识别的缓存按**条的内容指纹**寻址——判据一动缓存就落空，**掉一点先别当退化**。

## 回归

```bash
node scripts/measure-all.mjs      # 批量实测准确率（音符/slur-tie/歌词/标题/词曲/对位 多档）
node scripts/bench-lyrics.mjs     # 歌词逐音节对齐（按 verse 汉字 CER）
node scripts/bench-diff.mjs       # 识别 ↔ GT 的音符 token 逐项 diff
node scripts/bench-meta.mjs       # 页眉元信息对 GT
node scripts/check-align.mjs      # 歌词↔音符「对位」（逐音符序列 Levenshtein）
node scripts/omr-node-check.mjs   # Node ↔ 浏览器逐字符一致性（Node CLI 的验收依据）
node scripts/shot-recog.mjs       # 识别模式 + 叠加层渲染
node scripts/omr-cli.mjs <图…>    # CLI
```

## 已知限制

- **矢量 PDF 路只有 CLI 走**，编辑器未接（`isVectorPdf` 无调用方）
- 版权说明/注记行可能被当成歌词行
- 矢量路：和弦剩 4.5% 差异、调号 17 首（原书转过调）、反复与房号只记录不计入差异、
  OCR 形近字误判、标点互换约 100 处、升号/上标 7 混进歌词约 400 处
