# MusicXML 导出

工具栏「导出 → MusicXML」，以及 `.musicxml` 改动后存回、识别核对文本存到 XML 路径。
目标是把简谱（文本谱 / 123 / ABC / `.jpwabc` / 识别结果）交给 MuseScore、Finale、Sibelius
这类软件，且**尽可能不丢信息**。

## 只有一份写出端

| 文件 | 职责 |
|---|---|
| `src/model/toxml.ts::scoreDocToMusicXml` | **唯一写出端**：MusicXML 形状的 `ScoreDoc` → 文本。按固定元素次序序列化，`Measure.raw` 原位吐回 |
| `src/model/xmlproject.ts::projectForMusicXml` | **投影**：简谱来源留空的语义字段补齐成 MusicXML 形状（见下） |
| `src/model/fromscore.ts`（`forMusicXml`） | `.jpwabc` 的 `Score` 进 `ScoreDoc` 时带上 `playData` 的速度/跳转/段落标记、房号、拼好的音高、符杠、连音比例 |
| `src/score/musicxmllayout.ts` | 版面注入：`<defaults>`、分行、小节宽度、`default-x` |
| `src/editor/export.ts::buildMusicXml` | 调度：有底本且没改过给底本，否则整份重写 |

以前有三份全量写出端（文本谱走排版行视图的 `pu/toxml.ts`、`.jpwabc` 走 `Score` 的
`score/musicxmlout.ts`、`.musicxml` 走 `model/toxml.ts`）外加底本增量 patch
（`score/musicxmlpatch.ts`）。patch 存在的前提是「`.jpwabc`/`Score` 比 MusicXML 装得少，
重生成 = 降采样」；`ScoreDoc` 加上 `Measure.raw` 装得下之后，这个前提不成立了，四份并成一份。

识别结果的两份**直出**（`omr/musicxml.ts`、`staffomr/toxml.ts`）不在此列：那是识别产物的原始出口，
产出的就是底本。

### 调度

| 场景 | 导出 |
|---|---|
| 混排预览（`app.mode === "mixed"`） | 底本原文（五线谱原文） |
| 识别核对、123 文本一字未改（`App.importUnchanged`） | 底本原文，零损耗 |
| `.jpwabc` | `scoreDocToMusicXml(scoreToScoreDoc(score, { forMusicXml: true }))` |
| 其余（文本谱 / 123 / ABC / 改过的识别核对文本） | `scoreDocToMusicXml(app.currentScoreDoc())` |
| `.musicxml` 文档 | 文档里就是 XML（原文，或 `editScoreDoc` 整份重写过的） |

最后都过一遍 `annotateLayout`。

简谱识别产物（`App.importOmrMusicXml`）：识别 XML 当底本存在 `mixedXmlText`，经
`loadScoreDoc → emit123` 转成 123 文本进代码区；点选映射由 `editor/omrmeta.ts` 重解析 123 取源区间。

## 反方向：MusicXML → 简谱形状（`model/jianpuproject.ts`）

`.musicxml` 的简谱档（`pu/slots.ts::docView`）与 123 写出端（`Emitter123.emitSong`）之前先投一次，模型本身不动。
MusicXML 的 `beams` 是 `<beam>` 元素、`dots` 是 `<dot>`、长音是 `type="half"`；简谱侧读的是减时线条数、简谱附点、增时线。
不投的话附点二分画成附点四分、没连杠的八分音符当四分、结构化和弦一个都不显示。

- **时值**按 `<type>` + 附点定名义时值（没有 type 的整小节休止才按 divisions 折算）：四分以上拆增时线（附点二分 = `5 - -`），
  四分以下按基本时值定减时线；长休止拆成几个 0。
- **和弦**：结构化的补原文（`harmonyToText`）。`fromxml.ts` 保留一个音前的全部 `<harmony>`（后面的进 `Chord.laterHarmonies`，
  各带 `offset`），投影时按拍位挂到增时线上。小节末还欠着的 `<harmony>`（`fromxml` 放在 `y` 占位符上）位置是
  **小节末 + offset**（负值往回数，常落在前面长音的中间），按这个位置找落点；`y` 本身拆掉——简谱侧会把它画成一拍隐藏休止。
- **对照基准**是 `loadMusicXml → Score`（`parseDuration`），`scripts/jianpu-shape-check.mjs` 逐音比。

## 投影：判据与要害

**判据**：首小节带 `attrs.divisions` 的是 MusicXML 形状（`fromxml.ts` 读进来的），**原样返回**——
`.musicxml` 重写因此逐字节不受投影影响（568 份实测）。其余在克隆上投影，不改调用方的文档。
简谱来源（`frompu`/`j123`/`fromscore`）一律不写 `attrs.divisions`，时值以一个四分音符 = 48 记名义时值。

改 `xmlproject.ts` 之前先读这几条，每条都对应一个对拍出来的问题（全部文本谱语料新旧写出端对拍）：

- **跨行接着写的小节要并回去**。文本谱/123 行尾不写小节线、下一行接着写同一小节，模型里是两个小节；
  MusicXML 表达不了小节中间换行，拆成两个短小节时值就不对。并成一个，换行顺延到并完之后的下一小节。
  判据是「上一小节没有右线」——所以 `fromscore`（`forMusicXml`）要给 `Score` 的每个小节补一根普通右线，
  否则 MusicXML 读回的 `Score` 会被整首并成一个小节。
- **没有元素的小节不成小节**（行首 `|:`、两根线挨着）：房号起点、左反复、线上的记号（`|:&hs`）、行结构、拍号顺延到下一小节。
- **右线上的 `|:` 是下一小节的左反复**，heavy-light 线型跟着挪过去——右线留着 heavy-light 导入端直接报错。
- **临时记号在小节内延续**，按唱名键记，小节线处清空（跨行并回的小节自然接着用）。
- **音高**：`jppitch.ts::jpPitch`（唱名 + 八度点 + 调号）定 step/octave，alter = 调号升降 + 延续的临时记号。
  调号只有拼写（`bB`）没有 fifths 时用 `MusicCommon.keyNameToFifth`。
- **时值**：`type/dots` 按含增时线的名义时值重算；连音按记号覆盖的位置数 n（增时线各占一个）取 n:n−1，
  divisions 缩放后不是整数时整体放大。连音比例已经带着的（`.jpwabc`）用带着的。
- **记号**：弧线/连音端点落在增时线上归到宿主音符；倒置、起止同音、交叠的连音丢掉；重叠的弧线分配 number。
  延音线由 `Note.tie` 按「下一个音、同唱名同八度」配成 `tied` 对，配不上的两头都去掉。
  渐强渐弱的起止各落一个 `<wedge>` direction——**跨行的要合成一条**，旧写出端只写起点不写收尾（68 份 wedge 起止不等）。
- **记号原名**（`&dy`/`!dy!`）映射成 `<articulations>`/`<ornaments>`；力度、术语、伴奏括弧、Fine/D.C./D.S.、coda/segno
  变成带 offset 的 `<direction>`。本来就是 MusicXML 元素名的原样留下。
- **增时线上的和弦**：`<harmony>` 排在所辖音符之前，拍位写进 `Harmony.offset`。
- **符杠**：文本谱/123 的 `beams` 是减时线层数的占位（全是 continue），一个 begin 都没有的声部不写。
- **歌词**：段号区间 `w1-3:` 展开成逐段的 `<lyric>`；副歌行（`refrain`）写 `number="chorus"`，与导入端互逆。
- **`<voice>` 一律写 1**：简谱来源一个 part 就是一个声部，文本谱 `Q2:` 的声部号是 part 的事；写 2 导入端读不出音符。
- **头部**：没有 `<credit>` 时由副标题、作者、`TR/TL` 生成（空串不写）；数字速度写首小节 metronome。

**不表达的**：承接前音的增时线（`Chord.continued`，文本谱 `5 - | - -`）按普通音符写、不补 tie；
挂在增时线上的歌词（文本谱 `-@`）不写——MusicXML 里增时线不是独立的音符。

## `.jpwabc`（`fromscore.ts` 的 `forMusicXml`）

`Score` 里有些东西迁移到 123 用不上、MusicXML 却要，只在导出时带上（迁移报表口径不变）。

**(a) 音高走简谱表述，不走 pitch。** `jpSpelling()` = `jpPitch(数字, 八度点, fifths)` 定 step/octave +
按**音高差**（pitch − 该数字在本调的自然音高）定临时记号。原因：`.jpwabc` 来源的 Score 只设了
`pitch` 和 `step`，`octave`/`alter` 恒 0；且不能读 `nt.jpAlter`——那只标在记号出现的那个音上，
同小节后续同音级由 `AccidentalStat` 延续。

**(b) fifths 要推断。** `jpwimport` 从不给 `Measure.key` 赋值，照抄会把 `1=bB` 导成 C 调 + 满谱临时记号。
`keyChange` 只有 MusicXML 导入路径会置 true；否则走 `deriveFifths`——按 `pitch − 12*jpOctave − stepToPitch(number)`
取众数得主音音高，再按音名字母取众数得主音字母，两者**同时**吻合才认（`#F` 与 `bG` 的 basePitch 都是 66）。

**(c) 连音比例**由实际时值与名义时值之比得出（`timeMod`），divisions 仍记名义时值，投影层统一缩放。

**(d) voice**：`.jpwabc` 来源从 0 起、MusicXML 来源从 1 起，统一 `max(1, voice)`。

### 反复与房号

反复**不展开**，导出的小节数与谱面一致。`jpwimport` 在 `BarlineEntry.repeat` 上记下 `|:`/`:|`
（`:|` 与终止线 `|]` 都映射成 `LIGHT_HEAVY`，光看 style 分不开）。
MusicXML 读回的 `Score` 左反复线既在 `Measure.leftBarline` 上、又多一个 BarlineEntry，转换时并成一根（否则每往返一轮多一根）；
右侧只有房号终点、没有线型时也要出一根右线（否则房号 stop 丢掉）。

`.jpwabc` 不在小节上标房号，而是用 `.Repeat` 段列出每一遍唱哪些小节。`deriveVoltas()` 把它翻回 `<ending>`：

1. 算出每个小节被哪几遍唱到，按「连续且遍集合相同」切成段；
2. 找**分岔点**——某段的遍集合是前一段的真子集，说明反复体在这里分头；
3. 从分岔点往后连续收段，直到各段遍集合的并集**恰好等于**分岔前的全集，这一组段就是各房。
   并集对不上、遍次有重叠、或只收到一段，就放弃——那不是房，只是「某一遍唱得短一点」。

《沧海一声笑》推出三房 `1,2,3,5` / `4` / `6`，**与 OMR 从原图识别出的房号逐字一致**；
《因有主同在》的 `1-28V1 / 1-8V2` 正确地不成房。**除最后一房外，每房末尾补 `<repeat direction="backward"/>`**，
否则外部软件走不出正确的演唱顺序。Score 上已有房号（MusicXML 来源）时不再叠加推断。

### 符杠

一拍之内相邻的减时线音符连成一组，逐层输出 begin/continue/end；组内某层只有一个音符时输出 hook。
分组直接复用 **`Measure.autoBeamGroup()`**（排版引擎用的就是它，导出与屏幕上看到的分组天然一致）。
**休止符不带 `<beam>`**：简谱的减时线画在休止符下面，分组时休止符留在段内保持连续，只由实音符承载，
符杠跨过休止符（beam over rest）。`omr/musicxml.ts::beamsOfMeasure` 是识别直出那边的同规则实现。

`<beam number>` 是**层号**：按下标算，不能 `indexOf(值)`——两层同为 begin 时会都写成 1
（`.musicxml` 重写原先就有这个 bug，500 首里 280 处）。

## 写出端的硬规矩（`toxml.ts`）

- `<measure>` 子元素顺序：print → 左线 → attributes → direction → (harmony/note)* → raw → 右线。
  **顺序错了 MuseScore 会拒绝打开或静默错位**。
- note 子元素顺序：`grace?, chord?, (pitch|unpitched|rest), duration, tie*, voice, type, dot*, accidental?,
  time-modification?, notehead?, staff?, beam*, notations?, lyric*`。
- `<tie>` 是播放语义、`<tied>` 是记号，两者都写；本应用的导入器只读 `<tied>`，MuseScore/Dorico 要两者齐全。
- 节奏音符（有声无音高）写 `<unpitched>` + 斜线符头；不可见休止 `x` 写 `<rest print-object="no">` 且占时值。

## 版面

`annotateLayout(doc, opt)` 是独立 pass，**不引用 `JinpuPainter`**——本应用屏幕上的简谱排版
（可变纸张、乐句重排、翻页）不是给第三方看的版面，硬塞过去只会让 MuseScore 显示得又挤又怪。

- **分行照原图**：底本里现成的 `<print new-system>` 原样沿用（识别直出按 `RecognizedScore.rows` 逐行写）。
  一个 `<print>` 都没有时才按 `measuresPerSystem`（默认 4）合成——《基督更美》整首都是跨行小节，底本确实没有分行凭据。
- **版面参数**：写死的 A4 常量表（`<scaling>` 7mm/40tenths，page 1233×1596，margin 70，
  system-distance 110 / top 170），按每行实际小节数把行宽分掉（按音符数加权，`+2` 常数项
  避免单音符小节被压扁），小节内 `default-x` 均分。
- 底本自带 `<defaults>`（abc2xml 会输出）时**整体跳过**：作者已给的版面比合成的更贴切。

### `<credit>` 的坐标：另一个坐标系

**`<credit>` 的原点在页面左下角、y 轴向上**，和小节里那些 `default-y`（相对五线谱顶线）不是
一回事。不写坐标的话 MuseScore 按缺省 0 处理，那正是页面底边——词曲行会掉到页脚。
`layoutCredits()` 按谱面惯例摆：标题居中放页顶，著作者行右对齐排在标题下方，逐行下移。

还有一条 MuseScore 的规则要迁就：**只要文件里有任何 `<credit>`，它就完全以 credit 为准，
不再拿 `<work-title>` 生成标题框**。所以缺 title credit 时补一条。

`<part-name>` 一律留空并带 `print-object="no"`：Dorico/MuseScore 会把它当乐器名显示在谱前，简谱没有这个概念。

## 识别直出那边的配对（`omr/musicxml.ts`）

识别路径导出的就是底本原文，不经过模型，所以弧线配对与符杠要自己做：

1. **剔除孤立记号**。谱面漏写一个 `)` 是常事——一个未闭合的 start 会把后续每个 stop 都吃掉，
   从那里开始所有弧线连锁错位（《主祢真伟大》实测 14 处重叠）。
2. **给重叠的 slur 写 `number`**。
3. **端点落在休止符上的圆滑线整条作废**（识别错误；只丢一端会剩半条弧，MuseScore 把它一路拖到下一条 slur）。
4. **tie 两端必须同音高、都不是休止符**，否则剔除。

`QUARTER`（= `<divisions>`）取 16 而不是 4：32 分音符时 `QUARTER/8` 取 4 会得到 0.5 被 `round` 成 1。
小节时值凑不满会被下游拟合成怪时值（Dorico 按 `<duration>` 重排出双附点）——根因在识别侧修，不在导出侧补休止。

## 回归

```bash
npm run build
node scripts/xml-roundtrip.mjs [曲名子串]    # 14 首 .jpwabc + ABC 底本：R 往返 / 反复 / 房号 / 符杠 / L 版面
node scripts/omr-export-check.mjs [曲名子串]  # 真跑一遍识别：未改动直出底本、点选映射、改一处后整份重写不丢元素、弧线与符杠合法
HYMN500=… node scripts/xml-direct-check.mjs   # 568 份 .musicxml 全量重写：十类关键元素计数不降、往返稳定
HYMN500=… node scripts/jianpu-shape-check.mjs # 568 份 MusicXML → 简谱形状：简谱档与转 123 后逐音对照 loadMusicXml → Score
node scripts/pu-export-check.mjs              # 文本谱夹具：音符序列、XML 可解析、无空小节
```

`scripts/xml-roundtrip.mjs` 的 R 组定点性从**第二轮**起算（第一轮 jpw→XML 会被导入端归一：
`findRefrain` 把尾段歌词折成 chorus、首小节 `<attributes>` 让 `keyChange` 变 true），断言 `X2 === X1`
且 Score 快照逐字段相同。

## 已知不往返 / 容差

- `.Repeat` 段的 skip/limit（房内接入偏移、只唱到第 n 个音符）不表达——`<ending>` 只能整小节。
- 同一小节里连着三行都没有小节线时并成一个小节，中间那次换行留不住（语料 1 份）。
- 跨小节线的多连音（`(y1g---|7)`）写出后导入端配不上对（语料 1 份）。
- 长音中间**不在整拍上**的和弦（落在附点那半拍里）简谱写不出：提前挂到音符上，还挂不下的进丢失清单（`harmonyOffset`）。
- 多声部只保 `parts[0]` 的往返（导入端本就只读第一声部），但全部 part 照常输出。
