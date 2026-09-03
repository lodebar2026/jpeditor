# ABC 记谱导入（`src/abc/`）

导入 **ABC 记谱**（`.abc`）：拖入或「打开」`.abc` → 转 MusicXML → 复用现有 MusicXML 导入路径
（`importBytes` 识别 `.abc` → `abcToMusicXml` → 改名 `.musicxml` 走 `loadMusicXml`，天然享受多声部
→混排、乐句排版、`_lastImportMeta` 等既有行为）。**全量忠实移植自 Willem Vree 的 abc2xml.py**
（`~/proj/zanmeigepu/abc2xml.py`，2181 行，LGPL），非子集裁剪：

- `src/abc/pyparsing.ts` — pyparsing 迷你 shim（只实现 abc2xml 用到的有界子集组合子 + `+|^~<<` 运算符）。
  **关键语义**：默认跳空白、`leaveWhitespace()` 递归**复制**子节点后再关空白（不污染共享叶子）、
  parse action 按 `fn.length` 变参调用 `(instring,loc,toks)`、`loc` 为跳空白后的匹配起点（beam 断裂检测靠它）。
- `src/abc/eltree.ts` — 极简 `xml.etree` shim（`Element/set/get/append/insert/remove/find/findall/findtext/text` + `tostring`）。
- `src/abc/abc2xml.ts` — `abc_grammar`/`pObj`/模块 helper/`stringAlloc`/~1200 行 `MusicXml` 类 逐段翻译；
  公开 `abcToMusicXml(abcText, {pageCredits=true}): string`。**函数/类名与 python 对应**，改行为前先核对 abc2xml.py 原文。
- `src/abc/credits.ts` — 移植 `download_score.py` 的 `post_process_xml_metadata`（zanmeigepu 下载管线的
  **后处理**）：从 C: 字段（`作词：`/`作曲：`/`词曲：`/`编曲：`）还原作者，删掉 `<identification>` 里的
  `<creator>`，改成页面定位的 `<credit>`（A4 fallback 坐标，或读 `<defaults>`）。`abcToMusicXml` 默认调用；
  无这些前缀的 ABC 不加 credit（等同裸 abc2xml）。附带修好了 jpeditor 里作词/作曲的显示（原先 WordsByAndMusicBy 空）。
  易错处（已处理）：python `n*string` 重复→`.repeat`、`//`→`Math.trunc`、tuple 键 dict→`TMap`、
  dict.get 默认值、可变默认参数、`re.sub` 函数替换、`(?<!\\)` 负向后顾。**注意 Write 工具会把某些
  字面空格 `" "` 写成 NUL**——落文件后 `file src/abc/abc2xml.ts` 应报 UTF-8 而非 data。

**验证**：`node scripts/abc-check.mjs` 经浏览器 bundle（`window.__abc2musicxml`）转 3 组 fixture 做**规范化 token
diff**——zanmeigepu（含 page credits）比**已发布的 `zanmeigepu_score.xml`**（=abc2xml+后处理，9288 token/
53 小节）、合成用例（无作者前缀 → 不加 credit）比本机 `python3 abc2xml.py`，均实测**逐字节一致**（覆盖
多声部/连奏/重复/volta/和弦/装饰/broken-rhythm/调号变更 等）。`node scripts/abc-shot.mjs <abc> out.png`
经 `window.__app.importBytes` 走 `.abc` 全链路渲染核对。回归 musicxml/eltree/pyparsing 后跑这两个脚本。
