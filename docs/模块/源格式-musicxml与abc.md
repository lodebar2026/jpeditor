# 源格式：MusicXML 与 ABC

**判据全录** → [../实现/MusicXML-导出.md](../实现/MusicXML-导出.md)（283 行）、[../实现/ABC-导入.md](../实现/ABC-导入.md)

## 职责

MusicXML 双向（导入为 `Score`/`MixedScore`，导出**有底本则增量 patch**）；ABC 单向导入（转 MusicXML）。

## 入口

| 函数 | 文件 | 作用 |
|---|---|---|
| `loadMusicXml(xml)` | `src/score/musicxml.ts:476` | → `Score`（只读第一声部） |
| `loadMixedXml(xml)` | `src/mixed/loader.ts:1925` | → `MixedScore`（五线谱/混排） |
| `scoreToMusicXml(score, opts)` | `src/score/musicxmlout.ts:704` | 全量序列化 |
| `patchMusicXml(...)` | `src/score/musicxmlpatch.ts` | **增量 patch**（首选路径） |
| `annotateLayout(...)` | `src/score/musicxmllayout.ts` | 版面注入 |
| `abcToMusicXml(abc, opts)` | `src/abc/abc2xml.ts:2150` | ABC → MusicXML |

`src/score/xmldom.ts` 是 DOM 后处理公共件（`child`/`children`/`childText`/`setText`/`insertOrdered`/`fragment`）。

## 吃什么吐什么

- 导入：`.xml`/`.musicxml` → `Score`（简谱路）或 `MixedScore`（五线谱/混排路）
- 导出四条路径：底本未改 → 原文零损耗；有改动 → patch；patch 对齐失败（匹配率 <50%）→ 兜底全量并
  `setStatus` 提示降级；无底本 → 全量
- ABC：`.abc` → `abcToMusicXml` → 改名 `.musicxml` → 复用 MusicXML 导入路（天然享受多声部、
  混排、乐句排版、`_lastImportMeta`）

## 关键判据

- **有底本就 patch，绝不重生成**：`.jpwabc` 承载的信息比 MusicXML 少，整体重生成 =
  把底本降采样一遍（丢 `<print>` 行结构、`<credit>` 版式、`<direction>`、divisions 精度、
  `<time-modification>`、`<fermata>`、房号与反复的小节线结构）。
- **patch 刻意不碰**：`<barline>`/`<ending>`/`<repeat>`、`<direction>`、`<print>`、`<credit>` 页码、
  `<time-modification>`、`<fermata>`、`<identification>`，以及任何不认识的元素。
  代价：在 `.jpwabc` 里改小节线/反复不会反映到导出的 MusicXML——**这是刻意的取舍**。
- 房号由 `.Repeat` 反推（`deriveVoltas`），并自动给除最后一房外每房补 backward repeat。
- **`annotateLayout` 不引用 `JinpuPainter`**：屏幕上的简谱版面不导给第三方；底本自带 `<defaults>` 时整体跳过。
- MuseScore 兼容：有任何 `<credit>` 就不再用 `<work-title>` 生成标题 → 缺 title credit 时补一条；
  `<part-name>` 留空并 `print-object="no"`。
- ABC 是**全量忠实移植** abc2xml.py（非子集裁剪），函数/类名与 python 对应，**改行为前先核对原文**。
- ⚠️ Write 工具会把某些字面空格写成 NUL——落文件后 `file src/abc/abc2xml.ts` 应报 UTF-8 而非 data。

## 回归

```bash
node scripts/xml-roundtrip.mjs      # R/P/L 三组 + 反复 + 符杠合法性 + 作者行
node scripts/xml-lyrics-check.mjs   # Sibelius 段号、lyric-font、非歌词标签不吞段
node scripts/omr-export-check.mjs   # 以真实识别原文为底本的导出/patch 回归
node scripts/abc-check.mjs          # 与 python 原脚本逐字节对比
node scripts/abc-shot.mjs           # 拖入 .abc 端到端渲染
```

## 已知限制

- `.Repeat` 的 skip/limit **不表达**（`<ending>` 只能整小节）
- 小节中间的 `LineBreak` 在全量序列化里丢失（`<print>` 只能落小节边界）；patch 路径不受影响
- 多声部只保 `parts[0]` 的往返（导入端只读第一声部），但全部 part 照常输出
- 跨行小节未合并时会出现 `48+16` 这类时值不满的成对小节（GT 里也如此）
- **没有 ABC 导出**
