# 模型：`ScoreDoc`

## 职责

歌谱的**语义模型**，123 格式（简谱主格式）与 MusicXML（五线谱主格式）共用。
这是 `docs/进度.md` 里 **R2（语义中间层）** 的落地，将来是项目唯一的语义模型。

## 四个模型的分工与终局

**改任何一个之前先看这张表。**

| 模型 | 现在 | 终局 |
|---|---|---|
| **`ScoreDoc`**（`src/model/doc.ts`） | 123 的原生模型 | **唯一语义模型**，其余向它汇聚 |
| `Score`（`src/score/score.ts`） | 简谱排版/MIDI/乐句断句吃它，**装不下和弦/力度/多声部** | 退役；排版改吃 `ScoreDoc` |
| `MixedScore`（`src/mixed/model.ts`，2952 行） | 五线谱**语义 + 排版**混在一起（tenths） | 语义并入 `ScoreDoc`；`loader.ts` 只留排版 |
| `PuDoc`（`src/pu/ast.ts`） | 文本谱 AST（扁平元素流 + 下标区间配对） | 退役；文本谱解析器改产 `ScoreDoc` |

## 入口

| 文件 | 作用 |
|---|---|
| `src/model/doc.ts` | 类型定义（571 行）。层级：`ScoreDoc → Song → Part → Measure → Element` |
| `src/model/helpers.ts` | 遍历/查询/构造 + **音高互推** |
| `src/model/topu.ts` | → `PuDoc`（**临时桥**，借现成的排版与导出） |
| `src/model/frompu.ts` | ← `PuDoc`（文本谱语料迁移） |
| `src/model/fromscore.ts` | ← `Score`（`.jpwabc` / MusicXML 迁移） |

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
  **已定义但未填充**，等 `ScoreDoc ↔ MusicXML` 直通那一轮再填——位置先留正确，免得将来改结构。

## 回归

```bash
npm run build:cli
PU_CORPUS=<文本谱语料根> HYMN500=<500首语料根> node scripts/j123-migrate.mjs
```

## 已知限制

- `topu.ts` 是临时桥，有损：`playOrder` 的 skip/limit、曲号、样式引用、五线谱侧字段转不过去
- `fromscore.ts` 受 `Score` 限制：和弦/力度/多声部在上游就没有（不是这里丢的）
- `ScoreDoc ↔ MusicXML` 直通未做，MusicXML 导出仍借 `topu.ts → puToMusicXml`
