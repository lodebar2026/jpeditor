# MusicXML 导出

工具栏「导出 → MusicXML」，以及 `.musicxml` 改动后存回、识别核对文本存到 XML 路径。
目标是把简谱（文本谱 / 123 / ABC / `.jpwabc` / 识别结果）交给 MuseScore、Finale、Sibelius
这类软件，且**尽可能不丢信息**。

## 只有一份写出端

| 文件 | 职责 |
|---|---|
| `src/model/toxml.ts::scoreDocToMusicXml` | **唯一写出端**：MusicXML 形状的 `ScoreDoc` → 文本。按固定元素次序序列化，`Measure.raw` 原位吐回 |
| `src/model/xmlproject.ts::projectForMusicXml` | **投影**：简谱来源留空的语义字段补齐成 MusicXML 形状（见下） |
| `src/mixed/engrave.ts::engraveScoreDoc` | 版面坐标：五线谱引擎按设置里的纸排一遍，`<defaults>`、分行分页、系统/谱表间距、小节宽、音符 `default-x`、歌词/和弦/文字 `default-y`、标题块写回模型 |
| `src/editor/export.ts::buildMusicXml` | 调度：有底本且没改过给底本，否则整份重写 |

只有这一份写出端、不做底本增量 patch：`ScoreDoc` 加上 `Measure.raw` 装得下 MusicXML 的内容，整份重写不是降采样。

识别结果的两份**直出**（`omr/musicxml.ts`、`staffomr/toxml.ts`）不在此列：那是识别产物的原始出口，
产出的就是底本。

### 调度

| 场景 | 导出 |
|---|---|
| 混排预览（`app.mode === "mixed"`） | 底本原文（五线谱原文） |
| `.jpwabc` | `scoreDocToMusicXml(jpwToScoreDoc(f))`（与 123 同一条投影） |
| 其余（文本谱 / 123 / ABC，含简谱识别出的 123 核对文本） | `scoreDocToMusicXml(app.currentScoreDoc())` |
| `.musicxml` 文档 | 文档里就是 XML（原文，或 `editScoreDoc` 整份重写过的） |

文本格式导出时再经 `engraveScoreDoc` 补版面坐标（`export.ts::sourceMusicXml`）；带版面的原样不动。

简谱识别产物（`App.importOmrDoc`）：识别结果直出 `ScoreDoc`（`omr/todoc.ts`）、`emit123` 成 123 文本进代码区，
之后就是普通 123 文档，没有 MusicXML 底本；点选映射由 `omr/meta.ts` 重解析 123 取源区间。

## 反方向：MusicXML → 简谱形状（`model/jianpuproject.ts`）

`.musicxml` 的简谱档（`pu/slots.ts::docView`）与 123 写出端（`Emitter123.emitSong`）之前先投一次，模型本身不动。
MusicXML 的 `beams` 是 `<beam>` 元素、`dots` 是 `<dot>`、长音是 `type="half"`；简谱侧读的是减时线条数、简谱附点、增时线。
不投的话附点二分画成附点四分、没连杠的八分音符当四分、结构化和弦一个都不显示。

- **时值**按 `<type>` + 附点定名义时值（没有 type 的整小节休止才按 divisions 折算）：四分以上拆增时线（附点二分 = `5 - -`），
  四分以下按基本时值定减时线；长休止拆成几个 0。
- **和弦**：结构化的补原文（`harmonyToText`）。`fromxml.ts` 保留一个音前的全部 `<harmony>`（后面的进 `Chord.laterHarmonies`，
  各带 `offset`），投影时按拍位挂到增时线上。小节末还欠着的 `<harmony>`（`fromxml` 放在 `y` 占位符上）位置是
  **小节末 + offset**（负值往回数，常落在前面长音的中间），按这个位置找落点；`y` 本身拆掉——简谱侧会把它画成一拍隐藏休止。
- **对照基准**是简谱引擎输入的 MusicXML 形状分支（`jianpuInputOfXml` 按 `<type>` 读时值），`scripts/jianpu-shape-check.mjs` 逐音比。

## 投影：判据与要害

**判据**：首小节带 `attrs.divisions` 的是 MusicXML 形状（`fromxml.ts` 读进来的），**原样返回**——
`.musicxml` 重写因此逐字节不受投影影响（568 份实测）。其余在克隆上投影，不改调用方的文档。
简谱来源（`frompu`/`j123`/`fromjpw`）一律不写 `attrs.divisions`，时值以一个四分音符 = 48 记名义时值。

改 `xmlproject.ts` 之前先读这几条，每条都对应一个对拍出来的问题（全部文本谱语料新旧写出端对拍）：

- **小节中间换行拆成两个小节**（`splitInlineBreaks`）。MusicXML 只能在小节线处换行：源文在小节中间换行的
  （123/`.jpwabc` 的小节中间 `$`，模型里是 `Chord.lineBreakAfter`），前半右线写隐藏线 `<bar-style>none`，
  后半 `implicit="yes"`、编号 `X1`…、起新行，两半时值合起来仍是整小节；同一处换行在下一小节上另记的那份小节级 `print` 删掉。
  - 只拆**源文写明的**：简谱视图一行排不下、自己在小节中间折的行首（`applyLineStarts`）只是简谱版面宽度的产物，仍顺延到下一小节——
    否则窄纸上会拆出一串五线谱并不在那里断行的半小节（《再次将我更新》实测）。多声部各声部切点对不齐，也顺延。
  - 不在音符中间切（增时线上的换行按宿主和弦之后算）；切点落在连音中间的不拆、顺延。
  - 后半接着前半：符杠按原小节里的拍位分组（`autoBeams` 的 `onset`），真符杠在切点收口（`closeBeams`）；
    **临时记号接着延续**（投影的 `AccidentalCarry` 与读回的 `jianpu.ts::continuesMeasure` 同口径）——
    否则后半的 `4` 丢掉前半 `#4` 的延续、音高就错了，读回简谱也丢还原号（`.jpwabc` 351 实测）。
  - 五线谱引擎不给 implicit 小节印小节号（MuseScore 导出的 `X1` 原来会印在行首）。
- **跨行接着写的小节**（文本谱行尾不写小节线、下一行接着写同一小节，模型里是两个小节）：下一段起新行就同上拆法；
  不换行的并成一个。判据是「上一小节没有右线」——所以简谱来源的每个小节都要有右线，否则会被整首并成一个小节。
- **没有元素的小节不成小节**（行首 `|:`、两根线挨着）：房号起点、左反复、线上的记号（`|:&hs`）、行结构、拍号顺延到下一小节。
- **右线上的 `|:` 是下一小节的左反复**，heavy-light 线型跟着挪过去——右线留着 heavy-light 导入端直接报错。
- **临时记号在小节内延续**，按唱名键记，小节线处清空（跨行并回的小节自然接着用，拆开的后半接着前半）。
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
- **符杠**：文本谱/123 的 `beams` 是减时线层数的占位（全是 continue），一个 begin 都没有的声部按拍自动分组（见下「符杠」）。
- **歌词**：段号区间（文本谱 `C1-2:`）展开成逐段的 `<lyric>`；副歌行（`refrain`）写 `number="chorus"`，与导入端互逆。
- **各 part 按组对齐**：文本谱一组不一定含全部声部，投影开头先 `alignparts.ts::alignPartsBySystem` 补无声小节（缺席的组、同组偏短的段尾），
  否则 part 小节数不等、后出现的声部被挤到开头（issue 11；《同一首歌》三个 part 由 53/41/12 小节对齐到 53）。
- **`<voice>` 一律写 1**：简谱来源一个 part 就是一个声部，文本谱 `Q2:` 的声部号是 part 的事；写 2 导入端读不出音符。
- **头部**：没有 `<credit>` 时由副标题、作者、`TR/TL` 生成（空串不写）；数字速度写首小节 metronome。

**不表达的**：承接前音的增时线（`Chord.continued`，文本谱 `5 - | - -`）按普通音符写、不补 tie；
挂在增时线上的歌词（文本谱 `-@`）不写——MusicXML 里增时线不是独立的音符。

## `.jpwabc`

`jpwToScoreDoc` → `xmlproject` 投影 → 唯一写出端，与 123/文本谱同一条路。`fromjpw` 只填简谱度数、
不填绝对音高（从前照抄的假 `pitch` 八度恒为 0，会让投影层整首掉到第 0 八度），调号取 `.Title`，速度进 `Song.tempos`，
房号由 `Song.playOrder` 反推（`xmlproject.ts::voltasOfPlayOrder`）。符杠与 123 一样按拍自动分组。
`scripts/jpw-xml-check.mjs` 对 582 份读回快照守基线。

### 反复与房号

反复**不展开**，导出的小节数与谱面一致。`fromjpw` 在模型小节线上记 `repeat: forward/backward`
（`:|` 与终止线 `|]` 线型都是 light-heavy，光看线型分不开）。
右侧只有房号终点、没有线型时也要出一根右线（否则房号 stop 丢掉）。

`.jpwabc` 不在小节上标房号，而是用 `.Repeat` 段列出每一遍唱哪些小节。`voltasOfPlayOrder()`（原 `deriveVoltas()`）把它翻回 `<ending>`：

1. 算出每个小节被哪几遍唱到，按「连续且遍集合相同」切成段；
2. 找**分岔点**——某段的遍集合是前一段的真子集，说明反复体在这里分头；
3. 从分岔点往后连续收段，直到各段遍集合的并集**恰好等于**分岔前的全集，这一组段就是各房。
   并集对不上、遍次有重叠、或只收到一段，就放弃——那不是房，只是「某一遍唱得短一点」。

《沧海一声笑》推出三房 `1,2,3,5` / `4` / `6`，**与 OMR 从原图识别出的房号逐字一致**；
《因有主同在》的 `1-28V1 / 1-8V2` 正确地不成房。**除最后一房外，每房末尾补 `<repeat direction="backward"/>`**，
否则外部软件走不出正确的演唱顺序。模型上已有房号（MusicXML 来源）时不再叠加推断。

### 符杠

简谱来源（文本谱/123/`.jpwabc`，含简谱识别出的 123）的 `beams` 只是减时线层数的占位，投影时**按拍自动分组**
（`xmlproject.ts::autoBeams`）——不写的话读入端各按各的规则猜，跨拍、弱起处常与原谱不一致：

- 分组：x/8 且拍数是 3 的倍数三个八分一组，其余一拍一组；组里是起点落在同一拍、带减时线、不超过一拍的相邻元素，
  四分音符/四分休止打断。弱起小节（首小节不满）按小节末尾对齐拍位。
- **休止符不带 `<beam>`**（没有符干），但带减时线的休止留在组里，符杠从上方跨过（`5_ 0_ 3_` 下划线本就连过休止）；
  组首组尾的休止落在符杠外，只剩一个实音的组不连。
- 逐层：第 L 层只在第 L−1 层连上的音之间找连续段，≥2 个实音 begin/continue/end，只剩一个写 hook
  （在上一层那段里是头一个朝后 forward，否则 backward）。
- 读入端（`fromxml.ts`/`jianpuproject.ts`）按 `<type>` 定减时线条数，不读分组，所以往返不受影响。

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

版面坐标由**五线谱引擎**给（`mixed/engrave.ts::engraveScoreDoc`）：与屏幕上的五线谱同一套——
同一张纸（设置里五线谱/混排那张，`App.staffPage`）、同一套断行（简谱视图实际排出的行当优选断点，见 [混排](混排.md) 自动铺排）、
同一套自动铺排，排完把结果写回 `ScoreDoc` 再由写出端序列化。不碰 DOM。

- 写回的：`<defaults>`（scaling 7mm/40tenths、page-layout、边距）、每行首小节的 `<print new-system|new-page>` 与
  `system-layout`（页首 `top-system-distance`、其余 `system-distance`）、多谱表的 `staff-layout`、各小节 `width`、
  音符 `default-x`、猜出来的符干方向（`<stem>`，符杠组已统一）、歌词/和弦 `default-y`、自动放置的速度/文字记号的 `default-y` 与字号、标题块。
- 源文带来的换行先清掉，一律按排出来的。
- 读回来走「带版面」那条路（`hasEmbeddedLayout`），排出来与导出前一致。以前那套 DOM 注入（A4 常量表 1233×1596、
  没有分行凭据时每行 4 小节、音符按小节宽均分）的坐标是粗略值：次行起不给谱号调号留位，读回来行首音压在谱号下，已删。
- 底本自带 `<defaults>`（abc2xml 会输出）或小节宽/`default-x` 时**一字不改**：作者已给的版面比排出来的更贴切。
- 本写出端投影出来的一律署 `<encoding><software>jpeditor</software>`：混排引擎据此认 `<harmony><offset>`（长音中间换和弦；
  musicpp 只认 MuseScore 写的）。

### `<credit>` 的坐标：另一个坐标系

**`<credit>` 的原点在页面左下角、y 轴向上**，和小节里那些 `default-y`（相对五线谱顶线）不是
一回事。不写坐标的话 MuseScore 按缺省 0 处理，那正是页面底边——词曲行会掉到页脚。
标题块由 `layoutpass.ts::autoLayoutHeader` 排：标题居中放页顶，著作者行居中堆在标题下方，逐行下移（字号 pt）。

还有一条 MuseScore 的规则要迁就：**只要文件里有任何 `<credit>`，它就完全以 credit 为准，
不再拿 `<work-title>` 生成标题框**。所以缺 title credit 时补一条。

`<part-name>` 一律留空并带 `print-object="no"`：Dorico/MuseScore 会把它当乐器名显示在谱前，简谱没有这个概念。

## 简谱识别的弧线配对（`omr/todoc.ts::pairArcs`）

识别出的弧线端点难免出错，建模型时先配对（导出 MusicXML 时模型里已经是配好的 Mark）：

1. **剔除孤立记号**。谱面漏写一个 `)` 是常事——一个未闭合的 start 会把后续每个 stop 都吃掉，
   从那里开始所有弧线连锁错位（《主祢真伟大》实测 14 处重叠）。
2. **给重叠的 slur 编 `number`**。
3. **端点落在休止符上的圆滑线整条作废**（识别错误；只丢一端会剩半条弧，MuseScore 把它一路拖到下一条 slur）。
4. **tie 两端必须同音高、都不是休止符**，否则剔除。

小节时值凑不满会被下游拟合成怪时值（Dorico 按 `<duration>` 重排出双附点）——根因在识别侧修，不在导出侧补休止。

## 回归

回归脚本、语料与基线不在本仓库（本地私有仓库）。

## 已知不往返 / 容差

- `.Repeat` 段的 skip/limit（房内接入偏移、只唱到第 n 个音符）不表达——`<ending>` 只能整小节。
- 同一小节里连着三行都没有小节线时并成一个小节，中间那次换行留不住（语料 1 份）。
- 跨小节线的多连音（`(y1g---|7)`）写出后导入端配不上对（语料 1 份）。
- 长音中间**不在整拍上**的和弦（落在附点那半拍里）简谱写不出：提前挂到音符上，还挂不下的进丢失清单（`harmonyOffset`）。
- 多声部只保 `parts[0]` 的往返（导入端本就只读第一声部），但全部 part 照常输出。
