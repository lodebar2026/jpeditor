# 源格式：MusicXML 与 ABC

**判据全录** → [../实现/MusicXML-导出.md](../实现/MusicXML-导出.md)、[../实现/ABC-导入.md](../实现/ABC-导入.md)

## 职责

MusicXML 双向（导入为 `ScoreDoc`；简谱档与成书经 `model/jianpuinput.ts` 投影、五线谱/混排由 `ScoreDoc` 建版；导出只有一份写出端 `model/toxml.ts`，见 [导出.md](导出.md)）。

**ABC 已搬走**：`.abc` 现在是原生可编辑保存的源格式，读写都在
[源格式-abc家族.md](源格式-abc家族.md)（与 123 共用基类）。本页只留 `abc2xml` 作为
**对照基准与 fallback** 的那部分。

## 入口

| 函数 | 文件 | 作用 |
|---|---|---|
| `jianpuInputOfXml(song)` | `src/model/jianpuinput.ts` | `ScoreDoc`（MusicXML 形状）→ 简谱引擎输入（只读第一声部、和弦取最高音；成书与 ABC 回落） |
| `layoutStaff(doc)` | `src/mixed/layout.ts` | `ScoreDoc` → `StaffLayout`（五线谱/混排的版面态，只读 `ScoreDoc` 与其表层 `xmlsurface.ts`） |
| `loadScoreDoc(xml)` | `src/model/fromxml.ts` | → `ScoreDoc`（**直通**：语义进模型，表层绑在原节点上，见 `model/xmlsurface.ts`） |
| `scoreDocToMusicXml(doc)` | `src/model/toxml.ts` | **唯一写出端**；简谱来源先经 `model/xmlproject.ts` 投影 |
| `projectForJianpu(song)` | `src/model/jianpuproject.ts` | MusicXML 形状 → 简谱形状（简谱档排版、转 123 之前） |
| `engraveScoreDoc(doc, page)` | `src/mixed/engrave.ts` | 导出的版面坐标：五线谱引擎排一遍（与屏幕同一套），坐标装进 `EngravedLayout` 交给写出端，不写进模型 |
| `abcToMusicXml(abc, opts)` | `src/abc/abc2xml.ts:2150` | ABC → MusicXML（**只作对照基准与 fallback**，日常路径走 `parseAbc`） |

`src/score/xmldom.ts` 是 DOM 读取小工具（`child`/`children`/`childText`），`fromxml.ts` 用。

## 吃什么吐什么

- 导入：`.xml`/`.musicxml` → `ScoreDoc`（简谱档、五线谱/混排、成书共用）
- 导出：有底本且没改过 → 原文零损耗；否则 → 唯一写出端整份重写
- ABC：`.abc` → `parseAbc` → `ScoreDoc`（原生，保住源字符偏移）。原生读不动才回落
  `abcToMusicXml` → MusicXML 那条老路（只读、定位到小节级，状态栏提示降级）

## 关键判据

- **全量重写不丢东西靠表层回填**：`fromxml.ts` 只读语义，模型对象绑到原节点（`xmlsurface.ts`）；`toxml.ts` 从模型写语义，
  原节点上写出端不管的属性与子节点通用回填（`toxml.ts::OWNS` 列出写出端管的）。坐标、字体、slur 贝塞尔、`<supports>`、
  `<score-instrument>` 这类因此不必逐项进模型。
  所以以前「有底本就 patch」的取舍（`.jpwabc` 装得少、重生成 = 降采样）已经退役，增量 patch 删了。
- MusicXML 形状的文档（首小节带 `attrs.divisions`）不经投影，重写逐字节稳定。
- `.jpwabc` 的房号由 `.Repeat` 反推（`xmlproject.ts::voltasOfPlayOrder`，读 `Song.playOrder`），并自动给除最后一房外每房补 backward repeat。
- **导出的版面由五线谱引擎给**（`engraveScoreDoc`）：纸取设置、断行照简谱视图的行、坐标就是屏幕上五线谱的坐标，
  读回来走「带版面」那条路、排出来与导出前一致。以前另有一套 DOM 版面注入（A4 常量表、每行 4 小节、音符均分），已删。
  底本自带 `<defaults>` 或小节宽/`default-x` 时一字不改。
- MuseScore 兼容：有任何 `<credit>` 就不再用 `<work-title>` 生成标题 → 缺 title credit 时补一条；
  `<part-name>` 留空并 `print-object="no"`。
- ABC 是**全量忠实移植** abc2xml.py（非子集裁剪），函数/类名与 python 对应，**改行为前先核对原文**。
  它现在的角色是对照基准与 fallback，`abc-check.mjs` 要求它与 python 原脚本逐字节一致——
  **所以这个文件一行都不要动**。
- ⚠️ Write 工具会把某些字面空格写成 NUL——落文件后 `file src/abc/abc2xml.ts` 应报 UTF-8 而非 data。

## 回归

回归脚本、语料与基线不在本仓库（本地私有仓库）。

## 已知限制

- `.Repeat` 的 skip/limit **不表达**（`<ending>` 只能整小节）
- 长音中间不在整拍上的和弦简谱写不出（提前到音符上，挂不下的进丢失清单）
- 多声部只保 `parts[0]` 的往返（导入端只读第一声部），但全部 part 照常输出
- 跨行小节未合并时会出现 `48+16` 这类时值不满的成对小节（GT 里也如此）
- ABC 导出已有（`abcfamily/emitabc.ts`）；本页这条路仍是单向
