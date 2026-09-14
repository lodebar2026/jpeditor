# 源格式：MusicXML 与 ABC

**判据全录** → [../实现/MusicXML-导出.md](../实现/MusicXML-导出.md)、[../实现/ABC-导入.md](../实现/ABC-导入.md)

## 职责

MusicXML 双向（导入为 `ScoreDoc`/`Score`/`MixedScore`；导出只有一份写出端 `model/toxml.ts`，见 [导出.md](导出.md)）。

**ABC 已搬走**：`.abc` 现在是原生可编辑保存的源格式，读写都在
[源格式-abc家族.md](源格式-abc家族.md)（与 123 共用基类）。本页只留 `abc2xml` 作为
**对照基准与 fallback** 的那部分。

## 入口

| 函数 | 文件 | 作用 |
|---|---|---|
| `loadMusicXml(xml)` | `src/score/musicxml.ts:476` | → `Score`（只读第一声部） |
| `loadMixedXml(xml)` | `src/mixed/loader.ts:1925` | → `MixedScore`（五线谱/混排） |
| `loadScoreDoc(xml)` | `src/model/fromxml.ts` | → `ScoreDoc`（**直通，读得最全**；读不懂的挂 `Measure.raw`） |
| `scoreDocToMusicXml(doc)` | `src/model/toxml.ts` | **唯一写出端**；简谱来源先经 `model/xmlproject.ts` 投影 |
| `projectForJianpu(song)` | `src/model/jianpuproject.ts` | MusicXML 形状 → 简谱形状（简谱档排版、转 123 之前） |
| `annotateLayout(...)` | `src/score/musicxmllayout.ts` | 版面注入 |
| `abcToMusicXml(abc, opts)` | `src/abc/abc2xml.ts:2150` | ABC → MusicXML（**只作对照基准与 fallback**，日常路径走 `parseAbc`） |

`src/score/xmldom.ts` 是 DOM 后处理公共件（`child`/`children`/`childText`/`setText`/`insertOrdered`/`fragment`）。

## 吃什么吐什么

- 导入：`.xml`/`.musicxml` → `Score`（简谱路）或 `MixedScore`（五线谱/混排路）
- 导出：有底本且没改过 → 原文零损耗；否则 → 唯一写出端整份重写
- ABC：`.abc` → `parseAbc` → `ScoreDoc`（原生，保住源字符偏移）。原生读不动才回落
  `abcToMusicXml` → MusicXML 那条老路（只读、定位到小节级，状态栏提示降级）

## 关键判据

- **全量重写不丢东西靠 `Measure.raw`**：`fromxml.ts` 读不懂的节点原样挂着、`toxml.ts` 原位吐回。
  所以以前「有底本就 patch」的取舍（`.jpwabc` 装得少、重生成 = 降采样）已经退役，增量 patch 删了。
- MusicXML 形状的文档（首小节带 `attrs.divisions`）不经投影，重写逐字节稳定。
- `.jpwabc` 的房号由 `.Repeat` 反推（`xmlproject.ts::voltasOfPlayOrder`，读 `Song.playOrder`），并自动给除最后一房外每房补 backward repeat。
- **`annotateLayout` 不引用 `JinpuPainter`**：屏幕上的简谱版面不导给第三方；底本自带 `<defaults>` 时整体跳过。
- MuseScore 兼容：有任何 `<credit>` 就不再用 `<work-title>` 生成标题 → 缺 title credit 时补一条；
  `<part-name>` 留空并 `print-object="no"`。
- ABC 是**全量忠实移植** abc2xml.py（非子集裁剪），函数/类名与 python 对应，**改行为前先核对原文**。
  它现在的角色是对照基准与 fallback，`abc-check.mjs` 要求它与 python 原脚本逐字节一致——
  **所以这个文件一行都不要动**。
- ⚠️ Write 工具会把某些字面空格写成 NUL——落文件后 `file src/abc/abc2xml.ts` 应报 UTF-8 而非 data。

## 回归

```bash
node scripts/xml-roundtrip.mjs      # .jpwabc：R 往返 / L 版面 + 反复 + 房号 + 符杠合法性 + 作者行
node scripts/xml-direct-check.mjs   # 直通：568 份读入 + 全量重写后十类元素计数不降
node scripts/jianpu-shape-check.mjs # MusicXML → 简谱形状：逐音对照 loadMusicXml → Score
node scripts/staff-fields-check.mjs # 五线谱侧字段的填充与往返
node scripts/xml-lyrics-check.mjs   # Sibelius 段号、lyric-font、非歌词标签不吞段
node scripts/omr-export-check.mjs   # 真实识别：未改动直出底本、点选映射、改一处整份重写不丢元素
node scripts/abc-check.mjs          # 与 python 原脚本逐字节对比
node scripts/abc-shot.mjs           # 拖入 .abc 端到端渲染
```

## 已知限制

- `.Repeat` 的 skip/limit **不表达**（`<ending>` 只能整小节）
- 长音中间不在整拍上的和弦简谱写不出（提前到音符上，挂不下的进丢失清单）
- 多声部只保 `parts[0]` 的往返（导入端只读第一声部），但全部 part 照常输出
- 跨行小节未合并时会出现 `48+16` 这类时值不满的成对小节（GT 里也如此）
- ABC 导出已有（`abcfamily/emitabc.ts`）；本页这条路仍是单向
