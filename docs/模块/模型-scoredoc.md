# 模型：`ScoreDoc`

## 职责

歌谱的**语义模型**，123 格式（简谱主格式）与 MusicXML（五线谱主格式）共用。
这是 `docs/进度.md` 里 **R2（语义中间层）** 的落地，将来是项目唯一的语义模型。

`.pu` / `.jpwabc` / `.123` / `.abc` / `.musicxml` **五种格式都已原生编辑保存**
（做过什么见 [../进度.md](../进度.md)，还剩什么见 [../待办.md](../待办.md) §1）。
**结构没有改过**——照 MusicXML 分层、
`degree`+`pitch` 并存、元素稳定 `id` 带 `SourceSpan`，这几条正是双向光标同步的地基。
围绕它的四层机制里，**格式适配器表**（`editor/formats.ts`）、**格式能力表**
（`model/capability.ts`）、**双向定位**（`editor/sync.ts`）已落地；
**底本与保存策略**也已落地：`.musicxml` 打开无代码区，改动经 `toxml.ts` 整份重写，不再 patch。
文本谱/123/ABC 的排版、`Score`、MusicXML 导出、双向定位、试听高亮都直接吃它。

## 四个模型的分工与终局

**改任何一个之前先看这张表。**

| 模型 | 现在 | 终局 |
|---|---|---|
| **`ScoreDoc`**（`src/model/doc.ts`） | 文本谱/123/ABC/MusicXML 的排版与导出都吃它 | **唯一语义模型**，其余向它汇聚 |
| `Score`（`src/score/score.ts`） | 简谱排版/MIDI/乐句断句吃它，**装不下力度/多声部**；和弦只在 MusicXML 进来那一路留得住 | 退役；排版改吃 `ScoreDoc` |
| `MixedScore`（`src/mixed/model.ts`，2952 行） | 五线谱**语义 + 排版**混在一起（tenths） | 语义并入 `ScoreDoc`；`loader.ts` 只留排版 |
| `PuDoc`（`src/pu/ast.ts`） | 只剩文本谱解析器产物（进 `ScoreDoc` 之前）与乐句重排（改写原文要列号） | 解析器直接产 `ScoreDoc` 后退役 |

## 入口

| 文件 | 作用 |
|---|---|
| `src/model/doc.ts` | 类型定义（571 行）。层级：`ScoreDoc → Song → Part → Measure → Element` |
| `src/model/helpers.ts` | 遍历/查询/构造 + **音高互推** |
| `src/model/fromxml.ts` | ← MusicXML（**直通**，读不懂的挂 `Measure.raw` 原样留着） |
| `src/model/toxml.ts` | → MusicXML（**唯一写出端**，全量序列化） |
| `src/model/xmlproject.ts` | 简谱来源 → MusicXML 形状的投影（音高、divisions、记号原名、跨行小节…），`toxml.ts` 先过它 |
| `src/model/jianpuproject.ts` | 反方向：MusicXML 形状 → 简谱形状（增时线、减时线、和弦原文、长音中途的和弦），`slots.ts` 与 123 写出端先过它 |
| `src/model/frompu.ts` | ← `PuDoc`（**无损**：文本谱的全部排版信息都进来，`pu-scoredoc-check` 全语料逐字段还原零差异） |
| `src/pu/slots.ts` | → **排版行视图**（`docView`）：线性化规则只写一次，排版器/`scoreDocToScore`/双向定位共用；行里每个符号带 `ElementId` |
| `src/model/fromscore.ts` | ← `Score`（`.jpwabc` / MusicXML 迁移） |
| `src/model/capability.ts` | **格式能力表**：每种格式装得下什么 + `planSave`（另存为会丢什么） |

Node 侧经 `src/cli/j123.ts` → `dist-cli/j123.js` 使用（`npm run build:cli`）。

## 设计依据（不是凭空设计）

| 依据 | 内容 |
|---|---|
| `src/mixed/loader.ts` | 项目里 MusicXML 覆盖最全的读取实现，**88 个元素**——字段清单以它为基准 |
| `scripts/census-123.mjs` | 500 首实测：`<harmony>` 100% 的曲目都有（12646 个）、`<print new-system>` 100%、`lyric number` 到 8 段 |

## 关键判据

- **绝对音高与简谱度数并存、可互推**。`Note.pitch`（MusicXML 侧）+ `Note.degree`（123 侧），
  换算走 `helpers.ts::pitchFromDegree` / `degreeFromPitch`，而 `pitchFromDegree` **直接转调
  `score/jppitch.ts::jpPitch`**——那个文件开头就立了规矩「两份实现一旦漂移，往返数字就会错，故只留这一处」。
  反向换算目前与 `score.ts::Note.init` 同构（算式逐行照搬），**R2 收尾时应把 `init` 改为调用
  `degreeFromPitch`，消掉这份重复**。
  已验：`fifths -7..7` 的无点「1」与 `jppitch.ts` 注释记载的值逐个吻合（bB=58、bA=68、#C=61、
  bD=61、#F=bG=66、bE=63、bC=59；A 调不降八度、B 调降八度）。
- **元素一律带稳定 `id`**（`IdGen` 分配）。`Mark`、歌词锚点、`playOrder` 的 skip/limit 全部引用 id——
  `PuDoc` 用数组下标区间，插一个元素就全错。
- **增时线是可挂载的独立对象**（`Chord.sustains[]`，各有 id），而时值仍记在 `Chord.duration` 上：
  语义上 `5 - -` 是一个三拍音符（与 MusicXML 一致），但**和弦可以挂在增时线上**（语料实测 190 次）。
- **`Space` 元素**承载 `y`（无时值占位，专供挂和弦）与 `x`（不可见休止）。
- **`playOrder` 与 `style` 是 MusicXML 装不下的两样**（`<ending>` 只能整小节），
  只在 `ScoreDoc` 与 `.123` 里活着。
- 五线谱侧字段（`clef`/`staves`/`transpose`/`pedal`/`octaveShift`/`partGroups`/`defaults`/`technical`）
  **已由 `fromxml.ts` 填充**（`scripts/staff-fields-check.mjs` 的合成夹具逐样断言过，
  真实语料 1035 份的填充率也在那里）。
- **`Measure.raw` 是「全量重写不丢东西」的支点**：`fromxml.ts` 不认识的子节点序列化后挂在它上面，
  `toxml.ts` 原位吐回去。没有它，全量重写就会丢东西。
- **换行口径是 MusicXML 的**：`Print.newSystem/newPage` 表示「本小节**起**新系统」。源码的 `$` 写在小节之后，
  解析器先按「之后」收集、收尾经 `helpers.ts::breaksAfterToStart` 翻过来；写出端用 `breakAfter` 反向。
  最后一小节之后的换行记 `Part.endBreak`。
- **文本谱专有字段**（`doc.ts` 里注释写明「文本谱」的那些：`SourceOrnament`、`InlineItem`、`Print.system/texts/lyricLines`、
  `Chord.continued`、`Mark.startLead/endTrail/leadInPreviousLine/continuationLevels`、`Ending.startOffset/endOffset/pair`…）
  **是排版信息，不是给导出用的**：没有它们谱面就少画或画错（例如弧线端点落在小节线上时 `Score` 认为没收口，弧会接到下一行）。
  改 `frompu.ts` 后必须跑 `pu-scoredoc-check`。
- **`source: SourceSpan` 不是可有可无的**：编辑器的双向光标/选择同步（`editor/sync.ts`）
  按它建「源文本偏移 → 元素 id」的索引。新增元素类型时**一定要把 span 填对**。

## 回归

```bash
npm run build:cli
PU_CORPUS=<文本谱语料根> node scripts/pu-scoredoc-check.mjs     # PuDoc → ScoreDoc → PuDoc 逐字段零差异
PU_CORPUS=<文本谱语料根> HYMN500=<500首语料根> node scripts/j123-migrate.mjs
npm run build && HYMN500=<500首语料根> node scripts/musicxml-open-check.mjs   # .musicxml 打开/转换/重写
```

## 已知限制

- `fromscore.ts` 受 `Score` 限制：和弦/力度/多声部在上游就没有（不是这里丢的）
- 承接前音的增时线（`Chord.continued`）不需要支持：123 写不出，导出 MusicXML 按普通音符写
