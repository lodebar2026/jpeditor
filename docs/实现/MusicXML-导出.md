# MusicXML 导出

工具栏「导出 → MusicXML」。目标是把简谱（识别结果 / ABC 导入 / 手写 .jpwabc）交给
MuseScore、Finale、Sibelius 这类软件，且**尽可能不丢信息**。

涉及四个文件：

| 文件 | 职责 |
|---|---|
| `src/score/jppitch.ts` | 简谱数字 → 五线谱拼写（step/alter/octave）。原本内联在 `src/omr/musicxml.ts`，导出侧也要用，提出来共享，免得两份漂移。 |
| `src/score/musicxmlout.ts` | **全量序列化** Score → MusicXML。`loadMusicXml` 的逆运算。 |
| `src/score/musicxmlpatch.ts` | **增量 patch**：在 MusicXML 底本上只改用户真的改过的地方。 |
| `src/score/musicxmllayout.ts` | 版面注入：`<defaults>`、分行、小节宽度、`default-x`。 |
| `src/editor/export.ts::exportMusicXml` | 四条路径的调度。 |

## 核心取向：有底本就 patch，不重生成

`.jpwabc` 承载的信息**比 MusicXML 少**。丢的东西包括：`<print new-system>` 的原图行结构、
`<credit>` 的版式与页码、`<direction>`（段落标记 / 跳转 / 速度）、divisions 精度、
`<time-modification>`、`<fermata>`、房号与反复的小节线结构（jpwabc 的反复走 `.Repeat` 段的
演唱顺序，不是小节线）。所以**从当前 Score 整体重生成 = 把底本降采样一遍**。

底本从 `App.mixedXmlText`（`src/editor/app.ts:34`）取——`importBytes` 里 OMR 的
`omr.musicxml`、ABC 转换产物、直接拖入的 `.musicxml` 走的都是同一个分支，统统存在那里；
纯 `.jpwabc` 是 null。四条路径：

| 场景 | 导出 |
|---|---|
| 有底本 + 文本一字未改（`App.importUnchanged`） | 底本原文，零损耗 |
| 有底本 + 有改动 | `patchMusicXml(底本, 当前 Score)` |
| patch 对齐失败（匹配率 < 50%，或中间插入小节） | 兜底 `scoreToMusicXml`，`setStatus` 提示已降级 |
| 无底本（纯 .jpwabc） | `scoreToMusicXml` |

最后都过一遍 `annotateLayout`。

## patch 改什么、不碰什么

**改**：音高（`<pitch>` / `<rest/>`）、时值（`<duration>`/`<type>`/`<dot>`）、歌词
（整组重建 `<lyric>`）、`<notations>` 里的 tied / slur / tuplet、`<work-title>` 与
`credit-type="title"` 的标题、著作者 `<credit-words>`、和弦内音符数变化、和弦增删、
末尾小节增删。

**不碰**（这些 .jpwabc 里没有对应表达，按 Score 来只会把底本的信息删掉）：

- `<barline>` / `<ending>` / `<repeat>` —— 踩过：《沧海一声笑》的一/二房被整段删掉，
  因为 jpw 路径的 `Measure.endingLeft` 恒 false（房号在 `.Repeat` 段，不在小节上）。
  注意这只是 **patch 路径**的取舍；全量序列化路径会正确输出反复记号，见下节。
- `<direction>`（sectionMark、跳转、tempo）、`<print>`、`<credit>` 的页码与 `<credit-type>`、
  `<time-modification>`、`<fermata>`、`<identification>`、以及任何本模块不认识的元素。

代价：用户在 jpwabc 里改小节线 / 反复不会反映到导出的 MusicXML。这是刻意的取舍——
删掉底本已有的结构是更坏的结果。

### 对齐

底本 XML 的 `<note>` 序、`loadMusicXml(底本)` 的 Chord 序、`JpwMeta.noteRanges` 序三者一致
（见 `jpscore.ts:26`）。小节层与小节内各做一次「LCS 锚点 + 锚点间等长段按位配对」
（`alignWithEdits`）：LCS 认出没动过的项，两个锚点之间数量相同的一段就是「内容被改过」的项。

**签名比的是简谱表述**（`number`/`jpOctave`/`jpAlter`），不是 `Note.pitch`：jpwimport 的
basePitch 走 `getBasePitch`（A/B 用 48、其余 60），`Note.init` 又对 fifths 3/5/−2 做
`jpOctave+1`，直接比 MIDI pitch 有系统性 ±12 偏差，会把没改过的音判成改过。

**歌词签名只比文本，不比 verse 编号**：底本可能把某段标成 `number="chorus"`（导入端
`findRefrain` 推断的共用副歌），而从 .jpwabc 重建的 Score 按 W 段标成 `number="1"`。
唱出来是同一行字，判成改动只会白白覆盖底本更精确的表达。

## 全量序列化的四个要害

改 `musicxmlout.ts` 之前先读这四条，每条都对应一个真实的往返 bug。

**(a) divisions 取 lcm，`<duration>` 独立算。** `collectDivisions` 取全曲
`Chord.duration` 分母的最小公倍数（三连音得 3、减时线得 2^n）。`<duration>` 永远从
`Chord.duration` 算，**绝不从 `<type>` 反推**——三连音下两者本就不等，比例由
`<time-modification>`（nominal ÷ 实际）承担。同 `src/omr/musicxml.ts:38-44` 的注释。

**(b) 音高走 jp 表述，不走 `spellPitch(pitch)`。** `jpSpelling()` = `jpPitch(数字, 八度点,
fifths)` 定 step/octave + `accidentalOf()` 定临时记号。两点原因：`.jpwabc` 来源的 Score 只设
了 `pitch` 和 `step`，`octave`/`alter` 恒 0；且 `jpPitch` 里的 `extra` 修正正是为抵消
`Note.init` 对 fifths 3/5/−2 的 `jpOctave+1`。
`accidentalOf` 按**音高差**（pitch − 该数字在本调的自然音高）算临时记号，不能读 `nt.jpAlter`
——那只标在记号出现的那个音上，同小节后续同音级由 `AccidentalStat` 延续，jpAlter 是 `" "`
但音高实际带着升降。

**(c) fifths 要推断。** `jpwimport` 从不给 `Measure.key` 赋值（调号只活在 `JpState` 里），
照抄 `m.key.fifths` 会把 `1=bB` 导成 C 调 + 满谱临时记号。判据：`keyChange` 只有 MusicXML
导入路径会置 true；否则走 `deriveFifths`——按 `pitch − 12*jpOctave − stepToPitch(number)`
取众数得主音音高，再按 `(steps.indexOf(step) − (digit−1)) mod 7` 取众数得主音字母，
两者**同时**吻合才认。字母不可省：`#F` 与 `bG` 的 basePitch 都是 66。

**(d) `<type>`/`<dot>` 与导入端 `parseDuration` 严格互逆。** 正向是 `type→(beats,beams)`，
末尾 `dot===1 && beats>1 → beats*=1.5`。逆表见 `noteTypeOf`；不命中主表则按总时值兜底
（用 `Fraction` 精确比较，不用 1e-6）。休止符也要写 `<type>`，否则导入端 `case null` 当成全休止。

顺带修了导入端一处：`musicxml.ts` 的 `case "32nd"` 原本置 `beams = 4`（应为 3），并补了
`case "64th"`。不修则三减时线音符往返后多一条减时线。

### 反复记号（`|:` / `:|`）

反复**不展开**——`doRepeat` 只往 `playData.measures` 塞演唱顺序（PlayItem），不动
`part.measures`，导出的小节数与谱面一致。

但 `.jpwabc` 的反复记号原先到不了 MusicXML：`jpwimport` 把 `|:`/`:|` 只转成
`BarlineEntry.style`，而 `:|` 与终止线 `|]` 都映射成 `LIGHT_HEAVY`、光看 style 分不开，
导出后外部软件看到的只是一根终止线。为此给 `BarlineEntry` 加了 `repeat: "forward" |
"backward" | null`（新字段，没有别的代码读它，对现有行为零影响），`jpwimport` 在解析
`|:`/`:|` 时一并记下，导出侧 `hasRepeatForward`/`hasRepeatBackward` 据此写 `<repeat>`。

两个位置上的坑：

- `|:` 出现在小节**开头**，但解析时被 push 到**上一小节**的 entries 末尾。所以
  `hasRepeatForward(m, prev)` 要往回看一格；`effectiveBarline` 也要跳过它，
  否则上一小节的右端线型会被写成 `heavy-light`。
- `Measure.repeatForward/repeatBackward` 在 jpw 路径恒 false（那是 MusicXML 导入端才设的），
  两个 helper 都是「先看 Measure 标志、再看 BarlineEntry」，两种来源通吃。

### 房号（volta）：从 `.Repeat` 反推

`.jpwabc` 不在小节上标房号，而是用 `.Repeat` 段列出每一遍唱哪些小节（`1-4V1`、`1-3V4`、
`5-5V4`…，进 `PlayData.measures` 成 PlayItem）。`deriveVoltas()` 把它翻回 `<ending>`：

1. 算出每个小节被哪几遍唱到，按「连续且遍集合相同」切成段；
2. 找**分岔点**——某段的遍集合是前一段的真子集，说明反复体在这里分头；
3. 从分岔点往后连续收段，直到各段遍集合的并集**恰好等于**分岔前的全集，这一组段就是各房。
   并集对不上、遍次有重叠、或只收到一段，就放弃——那不是房，只是「某一遍唱得短一点」。

《沧海一声笑》的 `1-4V1 / 1-4V2 / 1-4V3 / 1-3V4 / 5-5V4 / 1-4V5 / 1-3V6 / 6-6V6 / …`
推出三房 `1,2,3,5` / `4` / `6`，**与 OMR 从原图识别出的房号逐字一致**——这是判据可靠的
最好证据（两条完全独立的路径得到同一个答案）。《因有主同在》的 `1-28V1 / 1-8V2` 则正确地
不成房（并集 `{1}` ≠ 全集 `{1,2}`）。

另外：**除最后一房外，每房末尾自动补 `<repeat direction="backward"/>`**。房唱完必须回到
`|:`，没有这个回头记号外部软件走不出正确的演唱顺序；jpwabc 里往往只在第一房末画了 `:|`。

两条守卫：Score 上已有 `endingLeft`/`endingRight`（MusicXML 来源）时不再叠加推断；
只有一个 pass 时直接返回空。

**仍不表达的**：房内的接入偏移（`.Repeat` 的 `11.2-20V4` 那个 `.2` = 跳过前 1 个音符）
与 `limit`，MusicXML 的 `<ending>` 只能整小节。

### 符杠（beam）

简谱的减时线就是五线谱的符杠，一拍之内相邻的减时线音符连成一组，逐层输出
`<beam number="n">begin|continue|end</beam>`；组内某层只有一个音符时输出 hook
（前面还有音就 `backward hook`，否则 `forward hook`——附点八分+十六分靠它表达）。

**休止符不能带 `<beam>`**——五线谱的符杠挂在符干上，休止符没有符干。但简谱的减时线是
**画在休止符下面**的（`5_ 0_ 3_` 下划线一路连过去），所以分组时休止符留在段内保持连续，
只由段内的**实音符**承载 begin/continue/end，符杠跨过休止符（这正是五线谱 beam over rest
的写法，与原图观感一致）。段内只剩一个实音符时：第 1 层不输出（那就是个带符尾的单音），
更高层才是 hook。

两条路径各有一份实现，规则相同：

- `musicxmlout.ts::collectBeams` 分组直接复用 **`Measure.autoBeamGroup()`**——排版引擎
  （layout.ts:1501）用的就是它，导出与屏幕上看到的分组因此天然一致。注意它有副作用
  （给 `chord.beamGroup` 赋值、把 entries 按 position 排序），幂等，layout 每次 resize 都会重算。
- `omr/musicxml.ts::beamsOfMeasure` 输入是 `JpNum` 没有 Measure，只能自己按拍切
  （8 分拍号一组 3 个八分，其余一拍一组）。识别底本必须自己写 beam，因为识别路径导出的
  就是底本原文，不经过 Score。

### slur / tie 的配对

`pairSlurTies()` 全曲扫一遍，做两件非做不可的事：

1. **剔除孤立记号**。谱面漏写一个 `)` 是常事——《主祢真伟大》第 3 行末 `(5__ |` 就没闭合。
   照单全输出的话，一个未闭合的 start 会把后续每个 stop 都吃掉，从那里开始所有弧线连锁错位，
   实测出 14 处重叠。
2. **给重叠的 slur 写 `number`**。MusicXML 靠 number 配对，缺省都是 1，两条弧线一旦重叠就
   分不清谁配谁。

配对用栈（后开先闭；简谱深度基本是 1，退化成顺序配对）。patch 路径共用同一份配对结果，
否则会把孤立记号写进底本。

**识别底本那侧同样要做**（`omr/musicxml.ts::pairArcs`）——识别路径导出的就是底本原文，
不经过 Score。那里还踩到过一个更隐蔽的：`noteXml` 的休止符分支原先直接 return、跳过
`<notations>`，《主祢真伟大》有一条圆滑线的 stop 端落在休止符上，于是凭空消失，只剩半条弧，
MuseScore 把它一路拖到下一条 slur——这就是「超长弧线」的来源。现在休止符也出 `<notations>`。

**端点落在休止符上的圆滑线**（识别路径）：整条弧作废。识别把弧线端点判到休止符上是识别错误
——弧线本该连到旁边的音符；只丢一端会剩半条弧，MuseScore 会把它一路拖到下一条 slur 那里去。
注意这只在识别侧做：人工写的 `.jpwabc` 里 slur 连休止符是合法记法，全量序列化那条路照写。

**tie 的额外规矩**：MusicXML 靠音高配对延音线，所以两端必须同音高、且都不能是休止符。
识别把两端读成不同音时那根本不是延音线，硬输出只会得到一条莫名其妙的长弧，剔除。

**tie 与 tied 都要写**：`<tie>` 是播放语义（挂在 `<duration>` 之后），`<tied>` 是记号
（在 `<notations>` 里）。本应用的导入器只读 `<tied>`，但 MuseScore/Dorico 要两者齐全。
note 子元素顺序：`(pitch|rest), duration, tie*, voice?, type?, dot*, time-modification?,
…, beam*, notations*, lyric*`——改 `noteXml` 时务必守住。

### 时值与 divisions

`omr/musicxml.ts` 的 `QUARTER`（= `<divisions>`）取 **16** 而不是 4：div=3（32 分音符）时
`base = QUARTER/8`，取 4 会得到 0.5 被 `round` 成 1，时值凭空翻倍；16 能精确表示到 64 分附点。

**小节时值凑不满会被下游拟合成怪时值**——Dorico 遇到时值不足的小节会按 `<duration>` 重排，
《主祢真伟大》就因此显示出双附点。根因是减时线多读了一条（见
[OMR 笔记](OMR-简谱识别.md) 的「减时线层数要验层距」），已在识别侧修掉，不在导出侧补休止：
补休止会把假音符写进识别结果，污染 GT 比对（实测把 measure-all 的对位准确率从 100% 打到 92%）。

仍有一类小节时值不满：**跨行小节没被合并**时会拆成 `48 + 16` 这样成对出现、加起来正好一小节的
两节（`因有主同在` 4 处、`我今来就你`/`哦愿我有千万舌头`/`从前所珍爱` 各 1 处）。GT 里也是这样，
属于 `rowEndsClosed` 的跨行判定范畴，未处理。

### 守卫

空小节补整小节 `<rest/>`（否则 `Measure.duration` getter 抛错）；chord 位置链有空档补
`<rest/>` 填平（导入端不处理 `<forward>`）；`"regular"` 线型不写 `<barline>`；右端线型兜底
只认排在最后一个音符**之后**的 `BarlineEntry`（`parseBarline` 对 `location="left"` 也会 push
一个 entry，不排除会把左端线型当成右端的）。

## 版面

`annotateLayout(doc, opt)` 是独立 pass，**不引用 `JinpuPainter`**——本应用屏幕上的简谱排版
（可变纸张、乐句重排、翻页）不是给第三方看的版面，硬塞过去只会让 MuseScore 显示得又挤又怪。

- **分行照原图**：底本里现成的 `<print new-system>` 原样沿用（`omr/musicxml.ts:152-173` 按
  `RecognizedScore.rows` 逐行写的，就是原图的「一行几个小节」）。底本一个 `<print>` 都没有时
  才按 `measuresPerSystem`（默认 4）合成——《基督更美》整首都是跨行小节（行末没画小节线，
  按 `rowEndsClosed` 的规则不凭空补），底本确实没有分行凭据，只能合成。
- **版面参数**：写死的 A4 常量表（`<scaling>` 7mm/40tenths，page 1233×1596，margin 70，
  system-distance 110 / top 170），按每行实际小节数把行宽分掉（按音符数加权，`+2` 常数项
  避免单音符小节被压扁），小节内 `default-x` 均分。
- 底本自带 `<defaults>`（abc2xml 会输出）时**整体跳过**：作者已给的版面比合成的更贴切。

### `<credit>` 的坐标：另一个坐标系

**`<credit>` 的原点在页面左下角、y 轴向上**，和小节里那些 `default-y`（相对五线谱顶线）不是
一回事。不写坐标的话 MuseScore 按缺省 0 处理，那正是页面底边——词曲行会掉到页脚。
`layoutCredits()` 按谱面惯例摆：标题居中放页顶（`default-y = 页高 − 边距 − 30`），
著作者行右对齐排在标题下方，逐行下移。`top-system-distance` 也相应放大到 240 给它们让位。

还有一条 MuseScore 的规则要迁就：**只要文件里有任何 `<credit>`，它就完全以 credit 为准，
不再拿 `<work-title>` 生成标题框**。我们的谱子只有词曲两条 credit，标题于是整个消失——
所以缺 title credit 时补一条。

`<part-name>` 一律留空并带 `print-object="no"`：Dorico/MuseScore 会把它当乐器名显示在谱前，
简谱没有这个概念（原先写死的 "Jianpu" 就这么冒出来的）。

## 回归

```bash
npm run build
node scripts/xml-roundtrip.mjs [曲名子串]   # 14 首 .jpwabc + 1 组 ABC 底本，R/P/L 三组断言
node scripts/omr-export-check.mjs [曲名子串] # 真跑一遍 OMR，用识别原文当底本走完整导出链路
```

`scripts/xml-roundtrip.mjs`：

- **R 组** 全量序列化往返。定点性从**第二轮**起算（第一轮 jpw→XML 会被导入端归一：
  `findRefrain` 把尾段歌词折成 chorus、首小节 `<attributes>` 让 `keyChange` 变 true、
  `dot+beats>1` 折算），断言 `X2 === X1` 且 Score 快照逐字段相同。
- **P 组** patch。`P1 空改动` 断言 `changed === 0`——这是最强的不变量，证明 patch 不会自己
  损坏底本。`P2` 施加模拟编辑（改数字 + 加八度点、改歌词首字、改标题）后断言改动生效，
  **且 `<print>`/`<credit>`/`<direction>`/`<time-modification>`/`<attributes>`/`<barline>`
  的节点数一个不少**——这条直接验「精确性」。
- **反复组** `.jpwabc` 里的 `|:`/`:|` 数量必须与导出的 `<repeat direction>` 数量相等
  （加上房末自动补的回头）、导入回来小节数不变（没被展开）、第二轮序列化仍原样吐回；
  `deriveVoltas` 推断出的每一房都要有 start/stop 一对 `<ending>` 且往返后仍在。
- **符杠合法性** 休止符不带 `<beam>`/`<tied>`，各层 beam 成对。
- **作者行** 源 `.jpwabc` 有 `WordsByAndMusicBy` 时，往返后不能丢。
- **L 组** 版面注入：分行不变、`<defaults><scaling>` 存在、`default-x` 在小节宽内单调递增、
  注入前后音乐内容（不含 newSystem/newPage）完全相同。
- **ABC 底本组**：`abcToMusicXml` 的产物当底本，另验「底本自带 `<defaults>` 时注入不覆盖」。

`scripts/omr-export-check.mjs` 跑真实识别，验 `App.importUnchanged`、patch 保全底本节点、分行照底本，
以及**弧线配对**与**符杠合法性**（底本与 patch 后各查一次：slur/tie 是否都闭合、有无孤立
stop、tie 两端音高是否相同、休止符有没有沾上 beam/slur/tie、beam 各层是否成对）。14 首全过（其中《基督更美》走合成分行）。

## 已知不往返 / 容差

- `.Repeat` 段的 skip/limit（房内接入偏移、只唱到第 n 个音符）不表达——`<ending>` 只能整小节。
  反复与房号本身都以记号导出，见上两节。
- 小节中间的 `LineBreak` entry 在全量序列化里丢失（`<print>` 只能落在小节边界）；patch 路径
  不受影响（底本的 `<print>` 原样留着）。
- 多声部只保 `parts[0]` 的往返（导入端本就只读第一声部），但全部 part 照常输出。
- ~~`jpwimport` 给「词曲」credit 写 `page=1` 而 `jpscore` 只收 `page===0`~~ 已修：`page` 是
  0 基页号（MusicXML 导入端也是 `attr−1`），写 1 让 `.jpwabc → Score → .jpwabc` 的作者行整条
  丢掉，导出的 MusicXML 里词曲还会落到第 2 页。回归里加了「作者行往返」断言。
