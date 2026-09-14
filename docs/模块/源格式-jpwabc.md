# 源格式：`.jpwabc`

**格式规范与语料实证** → [../格式/jpwabc.md](../格式/jpwabc.md)（段结构、字段、音乐体、`.Repeat`、11 项不支持、3 条缺陷）

## 职责

JP-Word `.jpwabc` 的分段、词法语法解析，`.jpwabc` → `ScoreDoc`（直出，带源偏移），`ScoreDoc` → `.jpwabc`，以及过渡期的 `.jpwabc` → `Score`（渲染输入）。

## 入口

| 函数 | 文件 | 作用 |
|---|---|---|
| `JpwFile.fromString(s)` | `src/jpword/jpwfile.ts:283` | 文本 → 分段（失败返回 null） |
| `parseVoiceText(text)` | `src/jpword/parse.ts:9` | `.Voice` 正文 → ANTLR 树 |
| `jpwToScoreDoc(f)` | `src/model/fromjpw.ts` | `JpwFile` → `ScoreDoc`（不经 `Score`，音符/小节线带 `SourceSpan`）。转 123/ABC、能力表、双向定位索引都走它 |
| `fromJpw(f)` | `src/score/jpwimport.ts:303` | `JpwFile` → `Score`。**过渡期只当编辑器渲染输入**，R2 阶段 9 随 `Score` 删 |
| `emitJpwabc(doc)` | `src/model/tojpw.ts` | `ScoreDoc` → `.jpwabc` 文本（只写第一声部）。写出端 `writeJpwabc` 只经输入接口读谱，`Score` 结构上也满足 |
| `TokenData` | `src/jpword/tokens.ts:27` | 分词器，**仅供语法高亮**，非语义解析 |
| `hanconv` | `src/jpword/hanconv.ts` | 简繁转换（只转 `.Title` 字段值与 `.Words` 歌词） |

文法 `src/jpword/Jpwabc.g4`；生成码 `src/jpword/parser/`，**勿手改**，每文件首行 `// @ts-nocheck`。

## 吃什么吐什么

```
.jpwabc 文本（UTF-16LE+BOM 或 UTF-8）
  → JpwFile（TitleSection / VoiceSection / WordsSection / RepeatSection / LayoutSection）
  → ANTLR 树
  ├→ ScoreDoc（fromjpw.ts：先按 jpwimport 口径切「源文小节」，歌词按它落点，再落成模型小节）
  └→ Score（jpwimport.ts，编辑器渲染；双向定位按和弦次序把两边配起来，app.ts::_buildJpwSync）
```

## 关键判据

- **`)` 二义**：前面的音符还欠着 `(` 就先收弧，欠完了才轮到三连音。反例 158《一件礼物》。
- **无点「1」的绝对音高**：B3(59)…A4(69)；只有 B/bB 调整体降八度。判据两处同源
  （`score.ts::getBasePitch` / `jppitch.ts::jpTonicOctaveShift`），依据《简谱通用规范》23–24 页。
- **`[|]` 不可见小节线必须照写**：少一根，重解析时两小节并成一个、`.Repeat` 的小节编号整体错位。
- **曲首就写 `|:`** 有专门处理：不能另开空小节，否则歌词整体错后一小节。
  （`|:|` 连写时 `fromJpw` 仍多开一个空小节——160、D01、J14 试听开头多一小节静音；`fromjpw` 落模型时并掉，歌词落点口径两边相同。）
- **两条 `.jpwabc` 读入路判据同源**：`fromjpw.ts` 照搬 `jpwimport.ts`（阶段 3 逐字段双跑 568 份一致），改其一必改其二。
  `fromjpw` **不填绝对音高**（`.jpwabc` 只有度数），导出 MusicXML 由投影层按度数 + 调号推。
- **歌词段锚点 `W2@m,n` 的小节序号**：只有小节**中间**的换行才算开出一个小节，小节末的不算——读入端（`assignLyrics`）
  与写出端（`tojpw.ts::LyricProcessor`）必须同口径，否则多段歌词起点在第一行之后错位。
- **`jpToStep` 按调号拼写**，不按 fifths：否则 `1=#C`/`1=bD`/`1=#F`/`1=bG` 四个调整首排不出来。
- 简繁转换要把非 ASCII 内容字符**抽出拼成整串**再送词表（跨过 `/`、`-`、`()`），否则
  `日光/之下` 会被拆开导致词汇级转换失效；长度对不上退回逐字转换，绝不错位。

## 回归

```bash
node scripts/check-gt.mjs          # testdata 下各 .jpwabc 能正常解析排版
node scripts/xml-roundtrip.mjs     # 与 MusicXML 往返
node scripts/jpw-emit-check.mjs --dual --cmp   # 写出端：MusicXML/文本谱来源逐字节一致 + .jpwabc 往返定点
node scripts/jpw-xml-check.mjs     # 导出 MusicXML：582 份读回快照与旧路基线一致
node scripts/sync-check.mjs        # 双向定位（含 .jpwabc 两档）
node scripts/shot.mjs              # 渲染通用回归
```

## 已知限制

- 装不下和弦、力度、多声部、副标题、曲号（**刻意不扩语法**）
- `{C:…}` 会污染音符解析；`::`/`:|:` 抛错；写出端 `|:[1` 不合自身文法——三条均语料 0 例，优先级低
- ANTLR 重生成需 JDK + ANTLR 4.13.2，并给生成文件逐个加 `// @ts-nocheck`
