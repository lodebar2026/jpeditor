# 模型：`ScoreDoc`

## 职责

歌谱的**唯一语义模型**，五种源格式（`.pu` / `.jpwabc` / `.123` / `.abc` / `.musicxml`）与简谱识别结果都读进它、从它写出，
各排版器、试听、导出、双向定位都从它取。结构照 MusicXML 分层、`degree`+`pitch` 并存、元素稳定 `id` 带 `SourceSpan`——
这几条是双向光标同步与「按 id 高亮/写回断点」的地基。

围绕它的机制：**格式适配器表**（`editor/formats.ts`）、**格式能力表**（`model/capability.ts`）、
**双向定位**（`editor/sync.ts`）、**保存策略**（`.musicxml` 没改过给原文，改过经 `toxml.ts` 整份重写）。

## 各排版器从它取什么

**改模型或引擎输入之前先看这张表。**

| 消费者 | 取法 | 引擎内部结构 |
|---|---|---|
| 简谱引擎（`layout/`：`.jpwabc` 两档、各格式展开档、成书） | `model/jianpuinput.ts` 投影出只读输入（`layout/input.ts`），按 MusicXML 形状 / 简谱形状 / `.jpwabc` 三个分支 | `Line` / `NoteEntry`（符杠分组、段落词挪位记在引擎里，不写回输入） |
| 文本谱原样档（`layout/original/compose.ts`） | 排版行视图 `pu/slots.ts::docView` | `layout/original/place.ts` 的定位结构 |
| 五线谱混排（`mixed/`） | `mixed/layout.ts::layoutStaff` 建版面态；MusicXML 原文的坐标/符干/字体经 `xmlsurface.ts` 查询 | `StaffLayout` 及各 `*Layout` 节点（`src` 引用模型元素） |
| 试听 / MIDI | `playdoc.ts::playSourceOfDoc` / `playsong.ts::playSourceOfSong` | `score/timeline.ts` |
| 断句 | `phrasedoc.ts` / `phrasesong.ts` 拼断句输入（带 `idOf`） | `score/phrase.ts` |

`PuDoc`（`src/pu/ast.ts`）已退役：只是 `parsePuAst` → `puToScoreDoc` 之间的中间结果，`parsePu` 直出 `ScoreDoc`。
乐句重排改写原文要的行号/列号在模型上（`Print.source` / `textSources`、`LyricLineInfo.source` / `sources`）。

## 入口

| 文件 | 作用 |
|---|---|
| `src/model/doc.ts` | 类型定义（883 行）。层级：`ScoreDoc → Song → Part → Measure → Element` |
| `src/model/helpers.ts` | 遍历/查询/构造 |
| `src/model/breaks.ts` | 断行读写对：`breaksOf`（模型 → 行首元素）/ `applyBreaks`（行首元素 → 模型，替换原有断行） |
| `src/model/jianpu.ts` | **简谱语义层**：音高↔度数、相对调号临时记号延续（`AccidentalCarry`，两个方向共用）、`attrsAt`、减时线/增时线/附点（`jianpuShape`）、和弦原文、旋律取音、延音线/跨元素记号按 id 找对端 |
| `src/model/fromxml.ts` | ← MusicXML（**直通**：语义进模型，每个模型对象绑到原节点） |
| `src/model/xmlsurface.ts` | **MusicXML 表层**：模型外的旁表（WeakMap，对象 → 原节点）+ 查询函数（`xmlPos`、`measureWidth`、`noteStem`、`xmlAlign`、`xmlFont`、`staffDetailsOf`、`printLayout`、`defaultsFonts`），五线谱引擎从这里读；导出版面的 `EngravedLayout` 也定义在这 |
| `src/model/toxml.ts` | → MusicXML（**唯一写出端**，全量序列化） |
| `src/model/xmlproject.ts` | 简谱来源 → MusicXML 形状的投影（音高、divisions、记号原名、跨行小节…），`toxml.ts` 先过它 |
| `src/model/deconames.ts` | 音符记号的别名表（`decoKey`）：拼音短名 / ABC 名 / MusicXML 名 / 中文名 → 文本谱短名。模型里原名照存，简谱排版、文本谱写出、MusicXML 投影用前先归一 |
| `src/model/jianpuproject.ts` | 反方向：MusicXML 形状 → 简谱形状（增时线、减时线、和弦原文、长音中途的和弦），`slots.ts` 与 123 写出端先过它。原生 ABC 时值只在 `divisions` 里、不带减时线/增时线，也经它投（音上的延音线配成 `tied`） |
| `src/model/frompu.ts` | ← 文本谱语法树（**无损**：文本谱的全部排版信息都进来，`pu-scoredoc-check` 全语料逐字段还原零差异） |
| `src/pu/slots.ts` | → **排版行视图**（`docView`）：线性化规则只写一次，原样档排版器 / 展开档投影 / 双向定位共用；行里每个符号带 `ElementId` |
| `src/model/jianpuinput.ts` | → **简谱引擎输入**（`jianpuInputOfXml` / `jianpuInputOfDoc` / `jianpuInputOfJpw`），和弦带元素 id；判据是谱面（`jianpu-svg-dump`） |
| `src/model/fromjpw.ts` | ← `.jpwabc`（`JpwFile` 直出，带 span；小节中间的 `$` 另记 `Chord.lineBreakAfter`） |
| `src/omr/todoc.ts` | ← 简谱识别结果（`RecognizedScore` 直出简谱形状，与 `j123/parse.ts` 同口径；不经 MusicXML） |
| `src/model/tojpw.ts` | → `.jpwabc`（`emitJpwabc`；写出端只经输入接口读谱，两侧输入由 `playdoc.ts::jpwInputOfDoc` / `playsong.ts::jpwInputOfSong` 拼） |
| `src/model/phrasedoc.ts` / `src/pu/phrasesong.ts` | 断句输入（MusicXML 形状 / 简谱形状），同一份小节视图也满足演唱顺序的输入 |
| `src/model/playdoc.ts` / `src/model/playsong.ts` | **演唱顺序**（`PlayData`）、试听输入（`PlaySource`）与 `.jpwabc` 写出端输入：反复、房号、跳转、多段歌词逐段、`Song.playOrder`；推理本体在 `score/playorder.ts`。回归 `playorder-check --cmp` |
| `src/model/capability.ts` | **格式能力表**：每种格式装得下什么 + `planSave`（另存为会丢什么） |

Node 侧经 `src/cli/j123.ts` → `dist-cli/j123.js` 使用（`npm run build:cli`）。

## 设计依据（不是凭空设计）

| 依据 | 内容 |
|---|---|
| `scripts/census-123.mjs` | 500 首实测：`<harmony>` 100% 的曲目都有（12646 个）、`<print new-system>` 100%、`lyric number` 到 8 段 |

## 关键判据

- **绝对音高与简谱度数并存、可互推**。`Note.pitch`（MusicXML 侧）+ `Note.degree`（123 侧），
  换算走简谱语义层 `jianpu.ts::pitchFromDegree` / `degreeFromPitch`，正向**直接转调
  `score/jppitch.ts::jpPitch`**——那个文件开头就立了规矩「两份实现一旦漂移，往返数字就会错，故只留这一处」。
  简谱引擎输入与混排简谱叠层都调语义层（`jianpu-semantic-check` 三方逐音比）。
- **临时记号只按音高延续判，不照抄来源的提醒记号**；旋律音与全部音各一份延续状态，任一要印就印
  （判据与定性清单在 `jianpu.ts` 文件头）。
  已验：`fifths -7..7` 的无点「1」与 `jppitch.ts` 注释记载的值逐个吻合（bB=58、bA=68、#C=61、
  bD=61、#F=bG=66、bE=63、bC=59；A 调不降八度、B 调降八度）。
- **元素一律带稳定 `id`**（`IdGen` 分配）。`Mark`、歌词锚点、`playOrder` 的 skip/limit 全部引用 id——
  `PuDoc` 用数组下标区间，插一个元素就全错。
- **增时线是可挂载的独立对象**（`Chord.sustains[]`，各有 id），而时值仍记在 `Chord.duration` 上：
  语义上 `5 - -` 是一个三拍音符（与 MusicXML 一致），但**和弦可以挂在增时线上**（语料实测 190 次）。
- **`Space` 元素**承载 `y`（无时值占位，专供挂和弦）与 `x`（不可见休止）。
- **`Element.voice` 在文本来源里恒为 1，唯一的例外是 ABC 的 `&`**（小节内临时多声部，§7.4）：
  分支的元素照原文顺序留在同一个 `Measure` 里、只是 `voice` 不同，小节内的实际起点由投影写进
  `Chord/Space.onset`（缺省是「前一个元素的终点」，`toxml.ts` 据此补 `<backup>`）。
  读这个模型的地方要按 `voice` 分轨算时间，别把一小节的时值一路加下去（见 [源格式-abc家族](源格式-abc家族.md)）。
- **`playOrder` 与 `style` 是 MusicXML 装不下的两样**（`<ending>` 只能整小节），
  只在 `ScoreDoc` 与 `.123` 里活着。
- 五线谱侧字段（`clef`/`staves`/`transpose`/`pedal`/`octaveShift`/`partGroups`/`defaults`/`technical`）
  **已由 `fromxml.ts` 填充**（`scripts/staff-fields-check.mjs` 的合成夹具逐样断言过，
  真实语料 1035 份的填充率也在那里）。
- **派生量不存进模型、只经查询层取**（唱名、减时线条数、调号上下文、演唱顺序…，见 `model/jianpu.ts`、`score/playorder.ts`）：
  存了就有同名字段两种口径（`Chord.beams` 在 MusicXML 来源是 `<beam>` 列表、在简谱来源是减时线条数，靠 `isXmlShaped` 分），
  要管编辑后的失效，指针有环不能序列化。**断行例外**——它是「这份谱怎么印」的事实，跨格式都有，随文档保存、往返。
- **MusicXML 的表层不进模型**（与「派生量不存」同一原则）：版面坐标、小节宽、符干、
  `justify/halign/valign`、歌词与文字的字体、`<print>` 的系统/谱表间距、`<staff-details>`、`<defaults>` 的 `word-font/music-font/system-layout`，
  以及写出端不认识的一切属性与子节点，都留在原节点上——`fromxml.ts` 把模型对象（`Song`/`Part`/`Measure`/`Print`/`MeasureAttrs`/`Chord`/`Note`/
  `Lyric`/`Harmony`/`Direction`/`Barline`/`Credit`/`Mark` 两端）绑过去（`xmlsurface.ts`，WeakMap，不在模型里、不随克隆走）。
  五线谱引擎经查询函数现读；写出端 `toxml.ts` 先建树，再按 `OWNS`（写出端管的属性/子节点）之外**通用回填**原节点。
  留在模型里的只有跨格式有人读写的：`Print.newSystem/newPage`、`Measure.implicit`、`Chord.cue/typeSize`（试听跳过、选旋律音）、
  `Defaults.scaling/pageLayout/lyricFont`（转 123/ABC 的纸与字号）、`Credit` 各字段（识别、页眉字体）。
  `layout-attr-check` 568 份「改一个音 → 整份重写」：点名的坐标逐份计数一致，**其余全部元素与属性逐份不降**
  （只有写出端的语义归一除外：`<elision>` 并字、`<group-barline>`、起止同音的 `<tied>`）。
  **`fromxml.ts` 新读一个语义字段，要在 `OWNS` 里认领**，否则原节点那份会被回填、与模型打架。
- `Harmony.kindText` 的**空串要留**：`<kind text="">` 是「不印后缀」，与缺省不同（混排按 `null` / `""` 分）。
- **换行口径是 MusicXML 的**：`Print.newSystem/newPage` 表示「本小节**起**新系统」。源码的 `$` 写在小节之后，
  解析器先按「之后」收集、收尾经 `helpers.ts::breaksAfterToStart` 翻过来；写出端用 `breakAfter` 反向。
  最后一小节之后的换行记 `Part.endBreak`。**小节中间的换行**（`.jpwabc` 弱起谱）另记在前一个和弦的 `Chord.lineBreakAfter` 上，
  只是印刷位置提示：小节级那份照记，只认小节级换行的消费者不用管它（同一小节再有「小节末换行」就与它并成一处，
  只剩半个小节的一行写不出来）。**读写对在 `model/breaks.ts`**：`breaksOf` 读出行首元素，`applyBreaks` 把一组行首
  写回（替换原有断行；小节中间的按 `inline` / `snap` / `source` 三种口径落，多声部一律顺延，多声部文本谱不重断）。
  乐句重排（`relayout.ts`）、导出 MusicXML 照简谱视图重断（`xmlproject.ts`）、跨格式另存为（`App.convertTo`）都经它。
  回归 `break-roundtrip-check`：写回 → 六种写出端 → 读回，断点集合不变（ABC 没有换页记号，只比断行位置，能力表记 `pageBreak`）。
- **文本谱专有字段**（`doc.ts` 里注释写明「文本谱」的那些：`SourceOrnament`、`InlineItem`、`Print.system/texts/lyricLines`、
  `Chord.continued`、`Mark.startLead/endTrail/leadInPreviousLine/continuationLevels`、`Ending.startOffset/endOffset/pair`…）
  **是排版信息，不是给导出用的**：没有它们谱面就少画或画错（例如弧线端点落在小节线上时简谱引擎认为没收口，弧会接到下一行）。
  改 `frompu.ts` 后必须跑 `pu-scoredoc-check`。
- **`source: SourceSpan` 不是可有可无的**：编辑器的双向光标/选择同步（`editor/sync.ts`）
  按它建「源文本偏移 → 元素 id」的索引。新增元素类型时**一定要把 span 填对**。
- **只给编辑用的原文位置**：`Chord/Sustain/Space.attachedSources`（和弦名、装饰、注记各自的原文）、`Mark.openSource/closeSource`
  （弧的 `(` 与 `)`）、`Part.breakSources`（`$`、`$(…)`、`[fenye]`）。可视化编辑按它们选中、删除挂在音符上的记号与换行符；
  排版、写出端、试听都不读，比对类回归（`pu-scoredoc-check`）要忽略它们。
- **`Chord.srcId`（派生模型才有）**：文本格式进五线谱/混排时写成 MusicXML 再读回，元素 id 另编一套；写出时 `<note id="jp<源 id>">`
  （`ToXmlOptions.sourceIds`，只这条内部路径开）、`fromxml` 读回成 `srcId`，五线谱与代码区靠它互相定位。导出文件不带。

## 回归

回归脚本、语料与基线不在本仓库（本地私有仓库）。

## 已知限制

- 扩展 meta（英文标题、经文、标签、分类…）没有字段：设计为 `Song.meta`（map + 键注册表），各格式映射见 [../样式机制.md](../样式机制.md) §9，落地见 [../待办.md](../待办.md) §2.3 P1
- 123 / 文本谱的作者一律记成 `composer`，不区分词曲（P1 按标签拆）
- 承接前音的增时线（`Chord.continued`）不需要支持：123 写不出，导出 MusicXML 按普通音符写
