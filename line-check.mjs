// 成书重排的**版面判据断言**：那些「排出来就是难看」的毛病，一条一条变成可执行的检查。
//
//   npm run build && node rebuild.mjs --book=…   # 先跑出底本
//   node line-check.mjs                          # 断言（不起浏览器）
//   node line-check.mjs --write-baseline         # 认可当前全书数字，写基线
//
// 底本两份，都由 rebuild.mjs 产出：
//   pdf-out/rebuild-lines.json     逐行事实（applybreaks.ts::describeLines）
//   pdf-out/rebuild-drawlist.json  逐页绝对坐标（段落词落位、歌词有没有压字）
//
// 输出两层：**全书基线门槛**（各档违例数不得高于 testdata/500/line-check-baseline.json）
// 与**定点断言**（用户点名的那十几首，逐条写死期望）。任一层不过就退出码 1。
//
// 档号分两族（见 FAMILY）：**D = 断句**（行首 → 行末 → 行长 → 整首口径），
// **V = 版面**（绘制与几何）。旧编号 L1~L17 已作废，对照见 git 历史；
// 其中旧 L5「末两行悬殊」已并入 D8「段内行长悬殊」。
import { readFile, writeFile } from "node:fs/promises";
import { makeMetrics } from "./scripts/textmetrics.mjs";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")));
const OUTDIR = flags.out ?? "pdf-out";
const BASELINE = flags.baseline ?? "testdata/500/line-check-baseline.json";
const only = flags.one ? String(flags.one).split(",") : null;

const style = JSON.parse(await readFile(flags.style ?? "testdata/500/bookstyle.json", "utf8"));
const metrics = await makeMetrics(style);

const lineDoc = JSON.parse(await readFile(`${OUTDIR}/rebuild-lines.json`, "utf8"));
const drawDoc = JSON.parse(await readFile(`${OUTDIR}/rebuild-drawlist.json`, "utf8"));

// ── 判据的阈值。都是「明显难看」那一档，不是审美偏好。
const SHORT_RATIO = 0.4;      // 中间行短于**同段中位时值**的这个比例 = 过短（按时值，见下）
// 同一段里「最短行 ÷ 最长行」（**按时值**）低于此 = 行长悬殊。**末行也算**。
// 原书每一行都差不多长；只按容量排会一行顶格、一行半幅（051 曾排成 12/14/24 格）。
const EVEN_RATIO = 0.5;
const LONG_HEAD_BEATS = 2;    // 行首这么长的音 + 标点 = 上一句的收尾被甩到了行首
const OVERLAP_TOL = 0.5;      // 歌词墨迹相压超过这么多 pt 才算（pen 位置有舍入）
// 房号（volta）那三条，口径见 layout.ts::addEnding 的头注释（照文本谱那一路的印刷原版）。
const ENDING_ROW_TOL = 20;    // 两条房号横线 y 差在这以内 = 同一条谱行（谱行间距远大于此）
const ENDING_SAME_Y_TOL = 0.5;// 同一行的房号横线 y 差超过这么多 = 没对齐
const ENDING_MIN_GAP = 1.0;   // 同一行相邻两条房号横线的净距下限（两房共用一条小节线，各让 0.12em）

/**
 * **两族检查**（用户口径：检查应该区分断句问题和非断句问题）：
 *
 *   断句　断点落在哪儿、行长匀不匀——`applybreaks.ts` / `phrase.ts` 的事，
 *         改断句判据看这一族的数字。
 *   版面　绘制与几何（房号、转调标记、段落词落位、墨迹相压、越出版心）——
 *         `layout.ts` / `bookparts.ts` 的事，与断句无关，断句改动**不该**动到它们。
 *
 * 分开报是为了看清「这一轮改的是断句，版面那一族一动没动」。基线仍按档存，两族共用。
 */
const FAMILY = {
  断句: ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9"],
  版面: ["V1", "V2", "V3", "V4", "V5", "V6", "V7"],
};

/** 一档检查的违例集合。 */
const kinds = {
  // ── 断句：断点落在哪儿、行长匀不匀
  D1: "行首残小节里只有休止",
  D2: "行首是半拍休止、且弱起与本曲其余行不一致",
  D3: "行首是带标点的长音（上一句的收尾）",
  D4: "行首那个字带着句读标点（上一句的尾巴被甩到了行首）",
  D5: "句末标点之后的收气休止被甩到了行首",
  D6: "行末断在无词的拖腔上、而那个字还没收尾（词被劈开）",
  D7: "中间行过短（一小节 / 不足同段中位时值四成）",
  D8: "段内行长悬殊（含末行；按时值）",
  D9: "两句并一句没有整首并（一半并一半没并）",
  // ── 版面：绘制与几何，与断句无关
  V1: "段落词挂出版心",
  V2: "相邻歌词墨迹相压",
  V3: "谱面越出版心",
  V4: "转调标记压住和弦",
  V5: "房号数字里有非法字符（只许数字与半角句点）",
  V6: "同一谱行里多个房号不等高",
  V7: "相邻两个房号的横线连在一起",
};
const bad = Object.fromEntries(Object.keys(kinds).map((k) => [k, []]));
let substSkipped = 0; // 因字体回退判不了的相邻歌词对（见 V2）
const hit = (k, id, note) => bad[k].push({ id, note });
const round1 = (v) => Math.round(v * 10) / 10;

// ────────────────────────────────────────────── 逐行事实（D1~D8）
for (const song of lineDoc.songs) {
  if (only && !only.includes(song.id)) continue;
  const ls = song.lines ?? [];
  if (!ls.length) continue;
  const cap = song.cells || 0;

  // 段内**非末行**的时值中位数：D7「过短」拿它当基准（用户口径：D7 也改用时值判断）。
  // 不拿容量当分母了——容量是纸张的事，而「这一行短不短」是与**同段其它行**比出来的；
  // 格数更不行（掺着增时线与歌词字数，见 D8）。
  const segMedDur = (() => {
    const segs = [[]];
    ls.forEach((l, i) => { if (i < ls.length - 1) segs[segs.length - 1].push(l.dur); if (l.section) segs.push([]); });
    const med = new Map();
    let si = 0;
    ls.forEach((l, i) => {
      const xs = [...(segs[si] ?? [])].sort((a, b) => a - b);
      med.set(i, xs.length ? xs[Math.floor(xs.length / 2)] : 0);
      if (l.section) si++;
    });
    return med;
  })();
  ls.forEach((l, i) => {
    const last = i === ls.length - 1;
    // D1 半小节休止起头（整小节休止不算——完整的休止小节归上一行或下一行都行）
    if (!l.head.hasNote && !l.head.full) hit("D1", song.id, `第 ${i + 1} 行：${l.head.dur} 拍休止 + 小节线`);
    // D7 中间行过短
    if (!last && !l.section) {
      const med = segMedDur.get(i) ?? 0;
      if (l.bars <= 1 && l.beats < (l.head.full ? 4 : 8))
        hit("D7", song.id, `第 ${i + 1} 行只有 ${l.bars} 小节 / ${l.dur} 拍`);
      else if (med > 0 && l.dur < med * SHORT_RATIO)
        hit("D7", song.id, `第 ${i + 1} 行 ${l.dur} 拍 / 同段中位 ${med} 拍`);
    }
    // D3 行首带标点的长音
    //     行首那个字**自成一句**时不算（上一行行末就带着标点）：131《无他，只有耶稣宝血》
    //     的「血！」是感叹词长音、142《圣灵请来》的「来，」是命令语气，两个标点之间只有
    //     一个字，这种起头是可以接受的（用户口径）。与 D4 同一条豁免。
    //     **补刀造出来的行首也不算**（用户口径，与 D2 同一条豁免）：补刀是在一行*内部*
    //     落刀救容量，那一行本来就放不下，后半截从哪儿起头由剩下的落点定，
    //     不是断句挑错了地方（030《主赐福如春雨》的「手，」）。
    if (i > 0 && !l.fromCut && l.head.firstBeats >= LONG_HEAD_BEATS && l.head.firstPunct > 0
        && ls[i - 1].tail.punct === 0 && ls[i - 1].tail.lastWordPunct === 0)
      hit("D3", song.id, `第 ${i + 1} 行以 ${l.head.firstBeats} 拍长音 + 标点起头`);
    // ── 这一轮补的三档，与 phrase.ts::headPenalty 的 (c)/(b2)/(g) 一一对应。
    // D4 行首那个字带着句读标点、而**上一行自己没收尾**：一句话的最后一个字落到了行首
    //     （077 的「当；」）。上一行收在标点上时不算——那时行首的「啊，」「哦！」是新一句
    //     自己的开头（020 每段都从「啊，」起唱）。D3 是它的子集（那一档另要求是长音）。
    //     上一行行末落在无词的拖腔上时，要往前追到真正的字（`lastWordPunct`）。
    //     **补刀造出来的行首不算**（用户口径，与 D2/D3 同一条豁免）。
    if (i > 0 && !l.fromCut && l.head.firstPunct > 0 && ls[i - 1].tail.punct === 0 && ls[i - 1].tail.lastWordPunct === 0)
      hit("D4", song.id, `第 ${i + 1} 行以「${l.head.text}」起头，上一行没收尾`);
    // D5 上一行收在句读标点上、这一行却从休止起头：那口气是上一句唱完的收气，该留在上一行
    //     （077 的「历风霜；」之后那个休止）。
    //     **除非这样起头正好凑成本曲的标准弱起**——那时休止是下一句弱起的一部分，挪下来
    //     反而齐头（363《倾听我的心》六行都是「半拍休止 + 半拍弱起音」）。标准弱起拿
    //     **第 1 行**的行首残小节当基准（第 1 行就是曲首那个弱起），与
    //     phrase.ts::headPenalty 的 pickupStd 同一口径。
    const pickup = ls[0]?.head.dur ?? 0;
    if (i > 0 && l.head.rest && ls[i - 1].tail.punct > 0
        && !(pickup > 0 && Math.abs(l.head.dur - pickup) < 0.01))
      hit("D5", song.id, `第 ${i + 1} 行从休止起头（${l.head.dur} 拍，本曲弱起 ${pickup} 拍），上一行收在「${ls[i - 1].tail.text}」`);
    // D6 行末落在无词的拖腔上、而拖腔所属的那个字没有标点收尾：句子还没唱完就断了，
    //     词被劈成两半（077 的「殷」＋「勤服事…」）。末行不算。
    // **整行没有词的不算**：那是前奏/间奏（028《全然向祢》的前奏独占一行，
    // 行末当然落在无词的音上）。`lastWord` 是往前找到的最近一个字，全行无词时它是空的。
    if (i < ls.length - 1 && !l.tail.text && l.tail.lastWord && l.tail.lastWordPunct === 0 && !l.tail.beats_isRest)
      hit("D6", song.id, `第 ${i + 1} 行断在拖腔上（往前最近的字没有标点）`);
  });

  // D2 **行首那个半拍休止**：它是下一句起唱前的留白，本该留在上一行行尾。
  // 但「半拍休止 + 半拍音符」这种弱起本身没问题——只要与本曲多数行一样长就行
  //（用户口径：为了工整，各行都以同样长的不完整小节起头是对的）。判据与
  // phrase.ts::headPenalty 的那一条一一对应，这里只是把它验出来。
  // **基准按段各算各的**：主歌与副歌本来就可以是两种弱起（087《父意成全》主歌两行
  // 从 2 拍起头、副歌两行从 1 拍起头），全曲一个众数会把其中一半判成毛病。
  // 与 phrase.ts::pickupStdAt 同一口径。
  {
    const segOf = [];
    let seg = 0;
    ls.forEach((l, i) => { if (i > 0 && l.section) seg++; segOf.push(seg); });
    // **补刀造出来的行首不算**（用户口径：拆分导致的弱起不一致不是错误）。补刀是在一行
    // *内部*落刀救容量，落点由乐句凭据定，后半截自然可能从半拍休止起头——那是「这一行
    // 本来就放不下」的后果，不是断句挑错了地方。众数统计也要跳过它们，否则基准被带偏。
    const tallies = new Map();
    ls.forEach((l, i) => {
      if (l.fromCut) return;
      const t = tallies.get(segOf[i]) ?? new Map();
      const b = Number(l.head.dur.toFixed(3));
      t.set(b, (t.get(b) ?? 0) + 1);
      tallies.set(segOf[i], t);
    });
    // 每段第一行的行首就是那一段的基准（见下面 `i === 0 || l.section` 那一行）——
    // **与基准一样长的行首一律不算毛病**，哪怕它不是众数：144《求圣灵吹我》没有弱起、
    // 整首六句都从「小节头上的八分休止」起唱（`0 3 2 3 5 6 1`），另有两行从上一句的
    // 长音尾巴接进来（3.5 拍），两种各占一半，众数一挑就把「与首行一模一样」的那几行
    // 判成了毛病。与 phrase.ts::startsLikeSong 同一口径。
    const segHead0 = new Map();
    ls.forEach((l, i) => { if (!segHead0.has(segOf[i])) segHead0.set(segOf[i], l.head.dur); });
    ls.forEach((l, i) => {
      if (i === 0 || l.section) return; // 每段第一行的弱起就是那一段的基准，断句挪不动它
      if (l.fromCut) return;            // 补刀造出来的行首（见上）
      if (Math.abs(l.head.dur - (segHead0.get(segOf[i]) ?? -1)) < 0.01) return;
      const t = tallies.get(segOf[i]);
      if (!t || t.size < 2) return;
      const mode = [...t].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
      if (!(l.head.rest && l.head.firstDur > 0 && l.head.firstDur <= 0.5)) return;
      if (Math.abs(l.head.dur - mode) > 0.01)
        hit("D2", song.id, `第 ${i + 1} 行以半拍休止起头、弱起 ${l.head.dur} 拍，本段多数是 ${mode} 拍`);
    });
  }

  // D9 **两句并一句要么全并、要么不并**（用户口径）。一半并一半不并的话行长反而更不齐
  //     ——020《向主歌唱》曾前四行各 4~5 小节没并、末两行并成 8 小节，那一行顶别人两个。
  //     `pairsFrom` 是并之前的行数（rebuild 记的），全并的结果必然是它的一半（向上取整）。
  if (song.mode === "pairs" && song.pairsFrom > 0) {
    const want = Math.ceil(song.pairsFrom / 2);
    if (ls.length !== want)
      hit("D9", song.id, `并前 ${song.pairsFrom} 行，全并该剩 ${want} 行，实际 ${ls.length} 行`);
  }

  // D8 **段内行长悬殊**：主歌顶着版心、副歌只有半幅这种（051/052/062/378 都是这一类）。
  //
  // **按段各算各的**（段界 = `l.section`）：用户口径「副歌可以接受比主歌长比较多，
  // 主歌内/副歌内每行尽量相近的长度」。全曲一把尺子会把「主歌每行 13 格、副歌每行 23 格」
  // 这种正常的谱也报出来。整段偏长归 `phrase.ts::quality` 的 outlier 管（那一项看全曲）。
  //
  // **一条判据、没有例外**（用户口径）：段内所有行一把尺子——含每段末行、含全曲末行。
  // 原来这里剔掉末行（`ls.slice(0, -1)`），末两行悬殊只好另开一档 D8 单独兜；
  // 两档本来就是同一件事，合成一档之后末行不再豁免（末句天然短的曲子从此也报，
  // 那正是要看见的事实）。
  //
  // **按时值算，不按格数**：格数掺着增时线与歌词字数（`Chord.beats` 本身就是增时线格数、
  // 不是时值），不是这一行在音乐上有多长——027《神啊！耶和华》按格数看是「行 2~7 参差」
  // （13/28），按时值才看得出真相是「第 1 行顶了别人两个」（11/24，行 2~7 只差 13/11）。
  // 与 `applybreaks.ts::pickCuts` 的工整项、`phrase.ts::quality` 的 outlier 同一把尺子。
  {
    const segs = [[]];
    ls.forEach((l) => {
      segs[segs.length - 1].push(l);
      if (l.section) segs.push([]);
    });
    for (const seg of segs) {
      if (seg.length < 2) continue;
      const ds = seg.map((l) => l.dur);
      const lo = Math.min(...ds), hi = Math.max(...ds);
      if (hi > 0 && lo / hi < EVEN_RATIO)
        hit("D8", song.id, `段内最短 ${round1(lo)} 拍 / 最长 ${round1(hi)} 拍`);
    }
  }
}

// ────────────────────────────────────────────── 版面几何（V1/V2）
/** 版心左右缘（对开页镜像，与 rebuild.mjs::contentEdges 同一口径）。 */
function edges(pageNo) {
  const m = style.page.margin;
  const odd = pageNo % 2 === 1;
  return { left: odd ? m.inner : m.outer, right: style.page.w - (odd ? m.outer : m.inner) };
}
const songOfPage = (dp) => dp.meta?.songs?.[0]?.id ?? "?";
for (const dp of drawDoc.pages) {
  if (dp.meta?.kind !== "score") continue;
  const id = songOfPage(dp);
  if (only && !only.includes(id)) continue;
  const { left, right } = edges(dp.pageNo);
  for (const it of dp.items) {
    if (it.t !== "text") continue;
    if (it.role === "sectionWord") {
      const x0 = Math.min(...it.xs);
      const x1 = Math.max(...it.xs) + metrics.advance("sectionWord", [...it.text].pop(), it.size);
      if (x0 < left - 0.5 || x1 > right + 0.5)
        hit("V1", id, `p${dp.pageNo}「${it.text}」x ${x0.toFixed(1)}~${x1.toFixed(1)}，版心 ${left.toFixed(1)}~${right.toFixed(1)}`);
    }
  }
  // ── V3 谱面越出版心。两条口径：
  //   **按墨迹算**，不按字号——全角标点的墨只占方框一角，拿字号当宽度处处都报越界（假越界 8.7pt）。
  //   **末尾标点悬挂不算越界**——行末那个句号伸到版心外是中文排版的常规（全书 59 首都有），
  //   真正的越界是正文伸出去。
  // 两个真的来源都修过了：段落词撑开把整行拉长（layout.ts::spreadForSectionWords 越出 57pt）、
  // 对开页镜像没补偿（drawlist.ts::shiftDrawPageX，偶数页整体偏右 12.2pt）。
  {
    // 含**半角 CJK 标点** `｡､`：这批字书里的字体没有，pdfwrite 换成全角等价字画出来
    // （与 V2 主动跳过的是同一批），照样是行末悬挂的标点。
    const HANG = /[，。、；：！？…”’）」』】》｡､｣,.;:!?)\]}]/u;
    let mx = -Infinity, mn = Infinity, who = "";
    for (const it of dp.items) {
      if (it.t !== "text") continue;
      if (!["note", "lyric", "chord", "sectionWord"].includes(it.role)) continue;
      const chars = [...it.text];
      // 末尾标点悬挂：右缘按最后一个**非标点**字算
      let k = chars.length - 1;
      while (k > 0 && HANG.test(chars[k])) k--;
      const r = it.xs[Math.min(k, it.xs.length - 1)] +
        (metrics.ink(it.role, chars[k], it.size)?.right ?? metrics.advance(it.role, chars[k], it.size));
      if (r > mx) { mx = r; who = `${it.role}「${it.text}」`; }
      mn = Math.min(mn, Math.min(...it.xs) + (metrics.ink(it.role, chars[0], it.size)?.left ?? 0));
    }
    if (Number.isFinite(mx) && mx > right + 0.5) hit("V3", id, `p${dp.pageNo} 右缘 ${mx.toFixed(1)} > ${right.toFixed(1)}（${who}）`);
    if (Number.isFinite(mn) && mn < left - 0.5) hit("V3", id, `p${dp.pageNo} 左缘 ${mn.toFixed(1)} < ${left.toFixed(1)}`);
  }

  // ── V5~V7 房号（volta）：文本判字符，横线判高度与间距
  for (const it of dp.items) {
    if (it.t === "text" && it.cls === "ending" && /[^0-9.]/.test(it.text))
      hit("V5", id, `p${dp.pageNo} 房号「${it.text}」`);
  }
  {
    // 房号横线是 `⌐` 形：起点在竖脚底、拐到横线、再往右。取 d 里所有点的**最高** y 作横线高度。
    const bars = [];
    for (const it of dp.items) {
      if (it.t !== "path" || it.cls !== "ending-line") continue;
      const n = (it.d.match(/-?[\d.]+/g) ?? []).map(Number);
      const xs = [], ys = [];
      for (let i = 0; i + 1 < n.length; i += 2) { xs.push(n[i]); ys.push(n[i + 1]); }
      if (!xs.length) continue;
      bars.push({ y: Math.min(...ys), x0: Math.min(...xs), x1: Math.max(...xs) });
    }
    bars.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    // 按 y 聚成谱行（谱行间距远大于 ENDING_ROW_TOL）
    const rows = [];
    for (const b of bars) {
      const r = rows[rows.length - 1];
      if (r && Math.abs(b.y - r[0].y) <= ENDING_ROW_TOL) r.push(b);
      else rows.push([b]);
    }
    for (const r of rows) {
      if (r.length < 2) continue;
      const lo = Math.min(...r.map((b) => b.y)), hi = Math.max(...r.map((b) => b.y));
      if (hi - lo > ENDING_SAME_Y_TOL)
        hit("V6", id, `p${dp.pageNo} 同一行 ${r.length} 个房号，y ${r.map((b) => b.y.toFixed(1)).join(" / ")}`);
      const byX = [...r].sort((a, b) => a.x0 - b.x0);
      for (let i = 0; i + 1 < byX.length; i++) {
        const gap = byX[i + 1].x0 - byX[i].x1;
        if (gap < ENDING_MIN_GAP)
          hit("V7", id, `p${dp.pageNo} 相邻房号净距 ${gap.toFixed(2)}pt`);
      }
    }
  }

  // ── V4 转调标记压住和弦：两者同处音符上方那一带，转调该在上方（layout.ts::liftKeySigOverChords）
  {
    const boxOf = (it, role) => {
      const chars = [...it.text];
      const first = chars[0], last = chars[chars.length - 1];
      const x0 = Math.min(...it.xs) + (metrics.ink(role, first, it.size)?.left ?? 0);
      const x1 = Math.max(...it.xs) + (metrics.ink(role, last, it.size)?.right ?? metrics.advance(role, last, it.size));
      // 墨迹上下缘按字号近似（西文字母/汉字都落在这个范围里，判「压没压上」够用）
      return { x0, x1, y0: it.y - it.size * 0.85, y1: it.y + it.size * 0.25 };
    };
    const keys = dp.items.filter((it) => it.t === "text" && it.cls === "key-change");
    if (keys.length) {
      const chords = dp.items.filter((it) => it.t === "text" && (it.cls === "chord" || it.role === "chord"));
      for (const k of keys) {
        const a = boxOf(k, "lyric");
        for (const c of chords) {
          const b = boxOf(c, "chord");
          if (b.x1 <= a.x0 || b.x0 >= a.x1 || b.y1 <= a.y0 || b.y0 >= a.y1) continue;
          hit("V4", id, `p${dp.pageNo}「${k.text}」压住和弦「${c.text}」`);
        }
      }
    }
  }

  // 同一基线上的歌词逐个比对右缘与下一个的左缘
  const rows = new Map();
  for (const it of dp.items) {
    if (it.t !== "text" || it.role !== "lyric") continue;
    const k = Math.round(it.y * 2) / 2;
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push(it);
  }
  for (const [, row] of rows) {
    row.sort((a, b) => Math.min(...a.xs) - Math.min(...b.xs));
    for (let i = 0; i + 1 < row.length; i++) {
      const a = row[i], b = row[i + 1];
      // 按**墨迹**算，不按 advance——全角标点的墨只占方框的一角，照 advance 算处处是「压字」
      const aCh = [...a.text].pop();
      const bCh = [...b.text][0];
      // 书里字体没有的字（半角 CJK 标点 `｡､`）由 pdfwrite 换成全角等价字画出来，
      // 画出来的比排版器量的宽——那是**字体回退**的账，不是排版判据的账，这里判不了，跳过。
      // 全书 121 处都是这一类，另见 docs/实现/矢量PDF识别.md。
      if (!metrics.hasGlyph("lyric", aCh) || !metrics.hasGlyph("lyric", bCh)) { substSkipped++; continue; }
      const aEnd = Math.max(...a.xs) + (metrics.ink("lyric", aCh, a.size)?.right ?? 0);
      const bStart = Math.min(...b.xs) + (metrics.ink("lyric", bCh, b.size)?.left ?? 0);
      if (aEnd - bStart > OVERLAP_TOL)
        hit("V2", id, `p${dp.pageNo}「${a.text}」压住「${b.text}」${(aEnd - bStart).toFixed(1)}pt`);
    }
  }
}

// ────────────────────────────────────────────── 定点断言（用户点名的那批）
/** 每条：曲号 → [档, 期望违例数（一律 0）]，另加几条只对这首成立的具体期望。 */
const SPOT = {
  // **020 / 374 原来各写了两遍**（第二遍在下面那批里），后一条把前一条静默覆盖掉——
  // 正是本表头一段警告的那个坑。这里合并成一条：并集。
  "020": ["D1", "D8"],   // 行长悬殊那一条原写作 L5「末两行悬殊」，已并入 D8（另见专属断言）
  // 逐首看下来补进来的那一批（行长要匀、中间不许甩短行）。
  // **一个曲号只许写一条**——原来 374/378/419 各写了两遍，后一条把前一条覆盖掉，
  // 它们的 D8 断言被静默吃了大半年。
  "022": ["D7"], "051": ["D8", "D7"], "052": ["D8"], "058": ["D7"], "062": ["D8"],
  "077": ["D7", "D4", "D5", "D6"], "286": ["D7"], "319": ["D7"], "390": ["D7"], "405": ["V1"],
  "378": ["D8", "D7"], "419": ["D8", "D7"],
  "374": ["D7", "D8"],   // 每行 2 小节（另见专属断言）
  "024": ["V1"], "371": ["V1"], "381": ["V1"],
  "125": ["D8"], "404": ["D8"],   // 原来写的是 L5（末两行悬殊），已并入 D8
  "372": ["D1", "D2"], "402": ["D1", "D2"],
  "373": ["D3"],
  "376": ["V2"],
  // ── 这一轮点名的十二首（断句权重重整 + 五处绘制修正）
  "064": ["V5"],                    // 房号数字里不许有中点：`1·2.` → `1.2.`
  "068": ["D7"],                    // 在「兴起」前断句（长音 + 标点）
  "070": ["D1"],
  "095": ["D7", "D8"], "118": ["D7", "D8"],  // 四行、行长要匀
  // 096 的期望是「Fine 处断开」（见下面的曲目专属断言）。**不判 D7**：Fine 前那一段
  // 本来就短，强制断开必然留下一个短行——按新口径「稀疏」不算毛病，路标读得出来才要紧。
  "096": [],
  "120": ["V1", "V3"],             // 「（副歌）」不许挂出版心，也不许把整行撑出版心
  "144": ["V4"],                   // 转调标记不许压和弦
  "158": ["V7"],                   // 两个房号不许连在一起
  "169": ["V6"],                   // 同一行的房号要等高
  "175": ["D7"],                    // 在「能大力，」后断句
  "363": ["D7", "D8", "D6"],       // 六行、三对平行乐句（另见下面的专属断言）
  "131": ["D3", "D4"],             // 「血！」是感叹词长音，这样起头可以接受
  "142": ["D3", "D4"],             // 「来，」是命令语气，同上
};
const spotFails = [];
for (const [id, ks] of Object.entries(SPOT)) {
  if (only && !only.includes(id)) continue;
  if (!lineDoc.songs.some((s) => s.id === id)) continue; // 没排这首就不判
  for (const k of ks) {
    const v = bad[k].filter((x) => x.id === id);
    if (v.length) spotFails.push(`${id} ${k}（${kinds[k]}）：${v.map((x) => x.note).join("；")}`);
  }
}
// 373《跟随我》：每一句都收在「跟随我」的长音上，四行一样长。
// 第 3 行例外——那一句的收尾是「生命，」，它的标点顺延到了弧尾那个无词音符上（tail 文本为空）。
{
  const s = lineDoc.songs.find((x) => x.id === "373");
  if (s && (!only || only.includes("373"))) {
    const tails = s.lines.map((l) => l.tail.text.replace(/[，。！？…；、：]$/, ""));
    const me = tails.filter((t) => t === "我").length;
    const cs = s.lines.map((l) => l.cells);
    const spread = Math.max(...cs) - Math.min(...cs);
    if (me < 3) spotFails.push(`373 应有 ≥3 行收在「我」上，实际：${tails.join(" / ")}`);
    if (spread > 2) spotFails.push(`373 四行应一样长，实际 ${cs.join(" / ")} 格`);
  }
}

// ── 这一轮点名那批的**曲目专属期望**：档位判的是通例，这里判「这一首该长什么样」。
/** 一首的逐行事实（没排这首就返回 null）。 */
const linesOf = (id) => (only && !only.includes(id) ? null : lineDoc.songs.find((s) => s.id === id)?.lines ?? null);
/** 行末/行首的字（剥掉标点好比对）。 */
const bare = (t) => String(t ?? "").replace(/[，。！？…；、：""''）]+$/u, "");
{
  // 068《天使报信》：「兴起！」是引文之后独立的一句呼召，该从行首起唱，
  // 上一行收在「再相亲，”」那个 4 拍长音 + 标点上（用户口径：长音 + 标点处断句）。
  const ls = linesOf("068");
  if (ls) {
    const at = ls.findIndex((l) => bare(l.head.text) === "兴");
    if (at <= 0) spotFails.push(`068 「兴起」应在某一行行首，实际各行行首：${ls.map((l) => l.head.text).join(" / ")}`);
    else if (!(ls[at - 1].tail.beats >= 2 && ls[at - 1].tail.punct > 0))
      spotFails.push(`068 「兴起」前一行应收在长音+标点上，实际「${ls[at - 1].tail.text}」${ls[at - 1].tail.beats} 拍`);
  }
}
{
  // 070《天使歌唱》：副歌那两句旋律开头相同，该各自成行、对齐着排。
  const ls = linesOf("070");
  if (ls) {
    const fps = ls.map((l) => l.headFp).filter(Boolean);
    if (new Set(fps).size === fps.length)
      spotFails.push(`070 应有两行开头旋律相同，实际各行指纹互不相同`);
  }
}
{
  // 095《复活良辰》/ 118《高歌和散那》：四行，且行长要匀（原书就是四行）。
  for (const id of ["095", "118"]) {
    const ls = linesOf(id);
    if (!ls) continue;
    if (ls.length !== 4) spotFails.push(`${id} 应排 4 行，实际 ${ls.length} 行`);
    const cs = ls.map((l) => l.cells);
    if (Math.max(...cs) - Math.min(...cs) > 2) spotFails.push(`${id} 四行应一样长，实际 ${cs.join(" / ")} 格`);
    // 一、二、四行是同一段旋律的三次再现，开头该对得齐
    const fps = ls.map((l) => l.headFp);
    if (!(fps[0] && fps[0] === fps[1] && fps[0] === fps[3]))
      spotFails.push(`${id} 一二四行开头旋律应相同，实际 ${fps.map((f) => f.slice(0, 12)).join(" | ")}`);
  }
}
{
  // 175《人惟以信得称义》：在「能大力，」之后断句；一二行开头旋律相同。
  const ls = linesOf("175");
  if (ls) {
    if (bare(ls[0]?.tail.text) !== "力") spotFails.push(`175 第 1 行应收在「能大力，」，实际「${ls[0]?.tail.text}」`);
    if (!(ls[0]?.headFp && ls[0].headFp === ls[1]?.headFp))
      spotFails.push(`175 一二行开头旋律应相同，实际 ${ls[0]?.headFp} | ${ls[1]?.headFp}`);
  }
}
{
  // 077《耶稣我主荣耀王》：用户逐处点过的三件事，各对应一条断句判据。
  const ls = linesOf("077");
  if (ls) {
    // ① 「殷勤服事」不许劈开：「殷」该在行首（headPenalty 的 (g) 条——断点落在无词的拖腔上、
    //    而那个字还没收尾）。
    if (!ls.some((l) => bare(l.head.text) === "殷"))
      spotFails.push(`077 「殷」应在某一行行首，实际各行行首：${ls.map((l) => l.head.text).join(" / ")}`);
    // ② 「厌弃难当；」不许劈开：「当；」不该落在行首（(c) 条——行首那个字带着句读标点）。
    if (ls.some((l) => bare(l.head.text) === "当"))
      spotFails.push(`077 「当；」不该在行首（「难当；」被劈开了）`);
    // ③ 「历风霜；」之后那个收气休止要留在同一行（(b2) 条）——所以「霜；」不该是行末。
    if (ls.some((l) => bare(l.tail.text) === "霜"))
      spotFails.push(`077 「霜；」不该是行末（它之后的休止该跟在同一行）`);
    // ④ 三句的开头是同一段旋律（`1 3 | 5 5 6 5 |`），该各自排在行首、对齐着看
    const tally = new Map();
    for (const l of ls) if (l.headFp) tally.set(l.headFp, (tally.get(l.headFp) ?? 0) + 1);
    if (Math.max(0, ...tally.values()) < 3)
      spotFails.push(`077 应有 ≥3 行开头旋律相同，实际 ${[...tally.values()].join("/")}`);
  }
}
{
  // 363《倾听我的心》：全曲是**三对平行乐句**，每对的开头旋律一样，该各自成行、对齐着排
  //（用户逐行给过谱：`0_ 5,_ |3. 3_ 2. …` 六行）。六行都从**小节中间的弱起**起唱，
  // 所以平行指纹的预扫不能只认「小节起点」，指纹也要先跳掉行首的休止——两处都栽过。
  const ls = linesOf("363");
  if (ls) {
    if (ls.length !== 6) spotFails.push(`363 应排 6 行，实际 ${ls.length} 行`);
    // 六行都该以**一拍的残小节**起头（凑整拍）：上一行行尾那个半拍休止要挪下来，
    // 与后面的半拍弱起音凑成一拍，与第 1 行一样（用户口径）。
    const dur = ls.map((l) => l.head.dur);
    if (dur.some((d) => Math.abs(d - dur[0]) > 0.01))
      spotFails.push(`363 六行的行首残小节应一样长（各 ${dur[0]} 拍），实际 ${dur.join(" / ")}`);
    const tally = new Map();
    for (const l of ls) if (l.headFp) tally.set(l.headFp, (tally.get(l.headFp) ?? 0) + 1);
    const pairs = [...tally.values()].filter((v) => v >= 2).length;
    if (pairs < 3) spotFails.push(`363 应有 3 对开头旋律相同的行，实际 ${pairs} 对（${[...tally.values()].join("/")}）`);
    // 「道不出」不许劈开：第 2 行不该收在「不」上
    if (ls.some((l) => bare(l.tail.text) === "不"))
      spotFails.push(`363 「道不出」被劈开了（有一行收在「不」上）`);
  }
}
{
  // 020《向主歌唱》：倒数第二行原来一行顶俩（28 格，其余各 17），该拆成两行。
  // 判据是「一行相当于其它行的两倍长」——按**时值**比，见 phrase.ts::quality 的 outlier。
  const ls = linesOf("020");
  if (ls) {
    if (ls.length !== 7) spotFails.push(`020 应排 7 行（倒数第二行要拆开），实际 ${ls.length} 行`);
  }
}
{
  // 374《跟随救主》：每行 2 小节（用户口径）。原来第 5 行 4 小节、其余各 2。
  const ls = linesOf("374");
  if (ls) {
    const bars = ls.map((l) => l.bars);
    if (bars.some((b) => b !== bars[0]))
      spotFails.push(`374 应每行 2 小节，实际 ${bars.join(" / ")}`);
  }
}
{
  // 一行不该长到顶别人两个：全书通例，这里对点名的几首写死
  //（用户口径：「拆开的依据是现在一行相当于其它行的 2 倍长度了」）。
  for (const id of ["020", "374", "363", "077"]) {
    const ls = linesOf(id);
    if (!ls || ls.length < 3) continue;
    const cs = [...ls.map((l) => l.cells)].sort((a, b) => a - b);
    const med = cs[Math.floor(cs.length / 2)] || 1;
    const longest = cs[cs.length - 1];
    if (longest / med > 1.6)
      spotFails.push(`${id} 有一行长到别人的 ${(longest / med).toFixed(2)} 倍（${ls.map((l) => l.cells).join("/")}）`);
  }
}
{
  // 096《哈利路亚！感谢主》：Fine 落在主歌多段歌词中间，那一处要断开。
  // Fine 的小节由 rebuild 从 playData 收集后传给断句（jumpMeasures），这里只验「断开了」：
  // 行末收在句号上、且不是曲末。
  const ls = linesOf("096");
  if (ls && ls.length > 1 && !ls.slice(0, -1).some((l) => l.tail.punct === 6))
    spotFails.push(`096 Fine 处应断开（行末收在句号上），实际各行行末：${ls.map((l) => l.tail.text).join(" / ")}`);
}

// ── **断句方案快照**：改对了的那几首，以后要一字不差地排成同样的样子。
//
// 档位断言（D1~D9）判的是通例、定点断言判的是「这一首该长什么样」的几条要点，
// 两者都留了余地；快照则把**整套断句**钉死：每一行的格数、小节数、行首残小节时值、
// 行首/行末的字、开头旋律指纹，一处对不上就报。改断句算法时这是最硬的那道门槛。
//
//   node line-check.mjs --write-snapshots   # 认可当前断句，重写快照
const SNAPSHOT_FILE = flags.snapshots ?? "testdata/500/line-snapshots.json";
/** **断句快照**（补刀之前）。用户口径：版心不该影响断句，快照只存最优断句结果、
 *  不判断是否补刀——所以分两份：这一份记断句本身，`SNAPSHOT_FILE` 记最终排版。
 *  「断句变了」与「补刀变了」是两码事，混在一份里查不出是哪一层动的。 */
const PHRASE_SNAPSHOT_FILE = flags["phrase-snapshots"] ?? "testdata/500/phrase-snapshots.json";
/** 收进快照的曲目：用户逐首核对过、认可了的那些。
 *  **158《一件礼物》/ 169《全新的你》不在其列**（用户口径，2026-08-27）：两首的排法
 *  本身已经认可（158 的「51 礼物」前断开、169 副歌每句「耶稣能／耶稣爱」各自成行），
 *  但结构复杂（长句 + 反复房 + 容量卡在边上），钉成快照只会让往后每一次断句改动都
 *  卡在它们身上、看不出真正的回退。两首的要点仍由 D1~D9 与下面的 V 档守着。
 *  **064《啊！圣善夜》同样摘掉**（用户口径，同日）：它的断句本来就是「前 4 行两两合并」
 *  那一套（27 / 25.5 拍），只因宽 318 / 321 差版心 312 那 2%~3% 被补刀劈成 9 行
 *  ——那是字号／边距阶梯的账，不该记在断句头上。
 *  **144《求圣灵吹我》同样摘掉**（用户口径，同日）：那首的排法（八行、两处 `0545`
 *  前各断一刀、句句平行）已经认可，但它整首卡在「一行只占版心四成」的边上，
 *  钉成快照等于把那条阈值也钉死了。 */
const SNAPSHOT_IDS = [
  "020", "068", "070", "077", "095", "096", "103", "118",
  "120", "175", "312", "355", "363", "374", "378",
  "490",
];
/**
 * 一行里要比对的事实：**这一句收在哪个字上**，以及**这一行有多少拍**。
 *
 * 断句方案说到底就是这两件事——断点落在哪儿（尾词认得出来），每行多长（时值）。
 * 格数、小节数、坐标那些是它们的派生物，记了反而让快照因为无关的改动而失效
 * （比如换个字体、调个字距，格数就变了，可断句一点没动）。
 */
//
// 尾词取 `lastWord`：行末落在延音（tie）或休止上时 `tail.text` 是空的，
// 可这一句唱到哪儿是明摆着的，往前找到那个字才知道「这一行收在哪里」。
const snapLine = (l) => ({ tail: l.tail.lastWord || l.tail.text, dur: Number((l.dur ?? 0).toFixed(3)) });
const snapshotOf = (song) => ({ lines: song.lines.map(snapLine) });

if ("write-snapshots" in flags) {
  const out = {};
  const pout = {};
  for (const id of SNAPSHOT_IDS) {
    const song = lineDoc.songs.find((s) => s.id === id);
    if (!song) continue;
    out[id] = snapshotOf(song);
    if (song.phraseLines?.length) pout[id] = { lines: song.phraseLines };
  }
  await writeFile(SNAPSHOT_FILE, JSON.stringify(out, null, 1) + "\n");
  await writeFile(PHRASE_SNAPSHOT_FILE, JSON.stringify(pout, null, 1) + "\n");
  console.log(`→ 排版快照 ${SNAPSHOT_FILE}（${Object.keys(out).length} 首）`);
  console.log(`→ 断句快照 ${PHRASE_SNAPSHOT_FILE}（${Object.keys(pout).length} 首）`);
  process.exit(0);
}

{
  let snaps = null;
  try { snaps = JSON.parse(await readFile(SNAPSHOT_FILE, "utf8")); } catch { /* 还没有快照 */ }
  // 断句快照（补刀之前）单独比一遍：报「断句方案变了」，与下面的「排版变了」分开
  try {
    const psnaps = JSON.parse(await readFile(PHRASE_SNAPSHOT_FILE, "utf8"));
    for (const [id, want] of Object.entries(psnaps)) {
      if (only && !only.includes(id)) continue;
      const song = lineDoc.songs.find((s) => s.id === id);
      if (!song?.phraseLines?.length) continue;
      const got = song.phraseLines;
      if (got.length !== want.lines.length) {
        spotFails.push(`${id} 断句变了：${want.lines.length} 行 → ${got.length} 行`);
        continue;
      }
      const diffs = [];
      got.forEach((g, i) => {
        const w = want.lines[i];
        if (g.tail !== w.tail) diffs.push(`第 ${i + 1} 行收在「${w.tail}」→「${g.tail}」`);
        if (Math.abs(g.dur - w.dur) > 0.01) diffs.push(`第 ${i + 1} 行 ${w.dur} 拍 → ${g.dur} 拍`);
      });
      if (diffs.length) spotFails.push(`${id} 断句变了：${diffs.slice(0, 4).join("；")}${diffs.length > 4 ? `（共 ${diffs.length} 处）` : ""}`);
    }
  } catch { /* 还没有断句快照 */ }
  if (!snaps) {
    console.log("（还没有断句方案快照，跑 --write-snapshots 立一份）");
  } else {
    for (const [id, want] of Object.entries(snaps)) {
      if (only && !only.includes(id)) continue;
      const song = lineDoc.songs.find((s) => s.id === id);
      if (!song) continue;                       // 没排这首就不判
      const got = snapshotOf(song);
      if (got.lines.length !== want.lines.length) {
        spotFails.push(`${id} 排版变了：${want.lines.length} 行 → ${got.lines.length} 行`);
        continue;
      }
      const diffs = [];
      got.lines.forEach((g, i) => {
        const w = want.lines[i];
        if (g.tail !== w.tail) diffs.push(`第 ${i + 1} 行收在「${w.tail}」→「${g.tail}」`);
        if (Math.abs(g.dur - w.dur) > 0.01) diffs.push(`第 ${i + 1} 行 ${w.dur} 拍 → ${g.dur} 拍`);
      });
      if (diffs.length) spotFails.push(`${id} 排版变了：${diffs.slice(0, 4).join("；")}${diffs.length > 4 ? `（共 ${diffs.length} 处）` : ""}`);
    }
  }
}

// ────────────────────────────────────────────── 汇总
const counts = Object.fromEntries(Object.entries(bad).map(([k, v]) => [k, v.length]));
const songsWith = Object.fromEntries(Object.entries(bad).map(([k, v]) => [k, new Set(v.map((x) => x.id)).size]));
console.log(`底本：${lineDoc.songs.length} 首 / ${drawDoc.pages.length} 页${substSkipped ? `（字体回退跳过 ${substSkipped} 对歌词）` : ""}`);
for (const [fam, ks] of Object.entries(FAMILY)) {
  const tot = ks.reduce((n, k) => n + counts[k], 0);
  console.log(`【${fam}】共 ${tot} 处`);
  for (const k of ks) {
    const sample = bad[k].slice(0, 3).map((x) => `${x.id} ${x.note}`).join("｜");
    console.log(`  ${k} ${kinds[k]}：${counts[k]} 处 / ${songsWith[k]} 首${sample ? `　例：${sample}` : ""}`);
  }
}
{
  const listed = new Set(Object.values(FAMILY).flat());
  const rest = Object.keys(kinds).filter((k) => !listed.has(k));
  if (rest.length) console.log(`【未归族】${rest.join(" ")}——补进 FAMILY 里`);
}

// `--by-song`：**按曲列出每首的问题**。档位汇总看的是「哪一类还没收拾干净」，
// 逐首列表看的是「这一首到底哪儿不对」——出问题曲目 PDF 之前照着它逐首核对。
if ("by-song" in flags) {
  const perSong = new Map();
  for (const [k, v] of Object.entries(bad))
    for (const x of v) {
      if (!perSong.has(x.id)) perSong.set(x.id, []);
      perSong.get(x.id).push({ k, note: x.note });
    }
  const title = new Map(lineDoc.songs.map((s) => [s.id, s.title]));
  const order = [...perSong.keys()].sort();
  console.log(`\n── 逐首（${order.length} 首有问题）`);
  for (const id of order) {
    const hits = perSong.get(id).sort((a, b) => a.k.localeCompare(b.k));
    console.log(`${id} ${title.get(id) ?? ""}`);
    for (const h of hits) console.log(`   ${h.k} ${kinds[h.k]}：${h.note}`);
  }
}

if ("write-baseline" in flags) {
  await writeFile(BASELINE, JSON.stringify({ songs: lineDoc.songs.length, counts }, null, 2) + "\n");
  console.log(`→ 基线已写入 ${BASELINE}`);
  process.exit(0);
}

let fail = false;
if (spotFails.length) {
  fail = true;
  console.log(`\n✗ 定点断言 ${spotFails.length} 条不过：`);
  for (const f of spotFails) console.log(`   ${f}`);
} else if (!only) {
  console.log("\n✓ 定点断言全过");
}

// 全书基线门槛：只在**排了整本**时才判（单曲试排的数字没有可比性）
let base = null;
try { base = JSON.parse(await readFile(BASELINE, "utf8")); } catch { /* 还没有基线 */ }
if (base && !only && lineDoc.songs.length >= base.songs * 0.9) {
  const worse = Object.keys(kinds).filter((k) => counts[k] > (base.counts[k] ?? 0));
  if (worse.length) {
    fail = true;
    console.log(`✗ 全书基线回退：${worse.map((k) => `${k} ${base.counts[k] ?? 0}→${counts[k]}`).join("，")}`);
  } else {
    const better = Object.keys(kinds).filter((k) => counts[k] < (base.counts[k] ?? 0));
    const gain = better.map((k) => `${k} ${base.counts[k]}→${counts[k]}`).join("，");
    console.log(better.length ? `✓ 全书基线变好（${gain}），记得 --write-baseline` : "✓ 全书基线持平");
  }
} else if (!base) {
  console.log("（还没有基线文件，跑 --write-baseline 立一个）");
}
process.exit(fail ? 1 : 0);
