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
const SHORT_RATIO = 0.4;      // 中间行短于版心容量的这个比例 = 过短
const LAST_PAIR_RATIO = 0.6;  // 末两行的长度比低于此 = 不均匀
// 同一首里「最短行 ÷ 最长行」低于此 = 行长悬殊（末行除外，末行本来可以短）。
// 原书每一行都差不多长；只按容量排会一行顶格、一行半幅（051 曾排成 12/14/24 格）。
const EVEN_RATIO = 0.5;
const LONG_HEAD_BEATS = 2;    // 行首这么长的音 + 标点 = 上一句的收尾被甩到了行首
const OVERLAP_TOL = 0.5;      // 歌词墨迹相压超过这么多 pt 才算（pen 位置有舍入）
// 房号（volta）那三条，口径见 layout.ts::addEnding 的头注释（照文本谱那一路的印刷原版）。
const ENDING_ROW_TOL = 20;    // 两条房号横线 y 差在这以内 = 同一条谱行（谱行间距远大于此）
const ENDING_SAME_Y_TOL = 0.5;// 同一行的房号横线 y 差超过这么多 = 没对齐
const ENDING_MIN_GAP = 1.0;   // 同一行相邻两条房号横线的净距下限（两房共用一条小节线，各让 0.12em）

/** 一档检查的违例集合。 */
const kinds = {
  L1: "行首残小节里只有休止",
  L2: "中间行过短（一小节 / 不足容量四成）",
  L3: "行首是半拍休止、且弱起与本曲其余行不一致",
  L4: "行首是带标点的长音（上一句的收尾）",
  L5: "末两行长短悬殊",
  L6: "段落词挂出版心",
  L7: "相邻歌词墨迹相压",
  L8: "同一首里行长悬殊",
  L9: "房号数字里有非法字符（只许数字与半角句点）",
  L10: "同一谱行里多个房号不等高",
  L11: "相邻两个房号的横线连在一起",
  L12: "转调标记压住和弦",
  L13: "谱面越出版心",
  L14: "行首那个字带着句读标点（上一句的尾巴被甩到了行首）",
  L15: "句末标点之后的收气休止被甩到了行首",
  L16: "行末断在无词的拖腔上、而那个字还没收尾（词被劈开）",
};
const bad = Object.fromEntries(Object.keys(kinds).map((k) => [k, []]));
let substSkipped = 0; // 因字体回退判不了的相邻歌词对（见 L7）
const hit = (k, id, note) => bad[k].push({ id, note });

// ────────────────────────────────────────────── 逐行事实（L1~L5）
for (const song of lineDoc.songs) {
  if (only && !only.includes(song.id)) continue;
  const ls = song.lines ?? [];
  if (!ls.length) continue;
  const cap = song.cells || 0;

  ls.forEach((l, i) => {
    const last = i === ls.length - 1;
    // L1 半小节休止起头（整小节休止不算——完整的休止小节归上一行或下一行都行）
    if (!l.head.hasNote && !l.head.full) hit("L1", song.id, `第 ${i + 1} 行：${l.head.dur} 拍休止 + 小节线`);
    // L2 中间行过短
    if (!last && !l.section) {
      if (l.bars <= 1 && l.beats < (l.head.full ? 4 : 8))
        hit("L2", song.id, `第 ${i + 1} 行只有 ${l.bars} 小节 / ${l.cells} 格`);
      else if (cap > 0 && l.cells < cap * SHORT_RATIO)
        hit("L2", song.id, `第 ${i + 1} 行 ${l.cells} 格 / 容量 ${cap}`);
    }
    // L4 行首带标点的长音
    if (i > 0 && l.head.firstBeats >= LONG_HEAD_BEATS && l.head.firstPunct > 0)
      hit("L4", song.id, `第 ${i + 1} 行以 ${l.head.firstBeats} 拍「${l.tail.text ? "" : ""}」长音 + 标点起头`);
    // ── 这一轮补的三档，与 phrase.ts::headPenalty 的 (c)/(b2)/(g) 一一对应。
    // L14 行首那个字带着句读标点、而**上一行自己没收尾**：一句话的最后一个字落到了行首
    //     （077 的「当；」）。上一行收在标点上时不算——那时行首的「啊，」「哦！」是新一句
    //     自己的开头（020 每段都从「啊，」起唱）。L4 是它的子集（那一档另要求是长音）。
    //     上一行行末落在无词的拖腔上时，要往前追到真正的字（`lastWordPunct`）。
    if (i > 0 && l.head.firstPunct > 0 && ls[i - 1].tail.punct === 0 && ls[i - 1].tail.lastWordPunct === 0)
      hit("L14", song.id, `第 ${i + 1} 行以「${l.head.text}」起头，上一行没收尾`);
    // L15 上一行收在句读标点上、这一行却从休止起头：那口气是上一句唱完的收气，该留在上一行
    //     （077 的「历风霜；」之后那个休止）。
    //     **除非这样起头正好凑成本曲的标准弱起**——那时休止是下一句弱起的一部分，挪下来
    //     反而齐头（363《倾听我的心》六行都是「半拍休止 + 半拍弱起音」）。标准弱起拿
    //     **第 1 行**的行首残小节当基准（第 1 行就是曲首那个弱起），与
    //     phrase.ts::headPenalty 的 pickupStd 同一口径。
    const pickup = ls[0]?.head.dur ?? 0;
    if (i > 0 && l.head.rest && ls[i - 1].tail.punct > 0
        && !(pickup > 0 && Math.abs(l.head.dur - pickup) < 0.01))
      hit("L15", song.id, `第 ${i + 1} 行从休止起头（${l.head.dur} 拍，本曲弱起 ${pickup} 拍），上一行收在「${ls[i - 1].tail.text}」`);
    // L16 行末落在无词的拖腔上、而拖腔所属的那个字没有标点收尾：句子还没唱完就断了，
    //     词被劈成两半（077 的「殷」＋「勤服事…」）。末行不算。
    if (i < ls.length - 1 && !l.tail.text && l.tail.lastWordPunct === 0 && !l.tail.beats_isRest)
      hit("L16", song.id, `第 ${i + 1} 行断在拖腔上（往前最近的字没有标点）`);
  });

  // L3 **行首那个半拍休止**：它是下一句起唱前的留白，本该留在上一行行尾。
  // 但「半拍休止 + 半拍音符」这种弱起本身没问题——只要与本曲多数行一样长就行
  //（用户口径：为了工整，各行都以同样长的不完整小节起头是对的）。判据与
  // phrase.ts::headPenalty 的那一条一一对应，这里只是把它验出来。
  const heads = ls.map((l) => Number(l.head.dur.toFixed(3)));
  if (heads.length > 1) {
    const tally = new Map();
    for (const b of heads) tally.set(b, (tally.get(b) ?? 0) + 1);
    const mode = [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    ls.forEach((l, i) => {
      if (i === 0) return; // 第一行的弱起就是本曲的弱起，断句挪不动它
      if (!(l.head.rest && l.head.firstDur > 0 && l.head.firstDur <= 0.5)) return;
      if (Math.abs(l.head.dur - mode) > 0.01)
        hit("L3", song.id, `第 ${i + 1} 行以半拍休止起头、弱起 ${l.head.dur} 拍，本曲多数是 ${mode} 拍`);
    });
  }

  // L8 全曲行长悬殊：主歌顶着版心、副歌只有半幅这种（051/052/062/378 都是这一类）。
  // 末行不算——它本来就可以短。
  {
    const cs = ls.slice(0, -1).map((l) => l.cells);
    if (cs.length > 1) {
      const lo = Math.min(...cs), hi = Math.max(...cs);
      if (hi > 0 && lo / hi < EVEN_RATIO) hit("L8", song.id, `最短 ${lo} 格 / 最长 ${hi} 格`);
    }
  }

  // L5 每段末两行（段界把曲子分段；末段就是曲末）
  const segs = [[]];
  for (const l of ls) {
    segs[segs.length - 1].push(l);
    if (l.section) segs.push([]);
  }
  for (const seg of segs) {
    if (seg.length < 2) continue;
    const [a, b] = seg.slice(-2);
    const lo = Math.min(a.cells, b.cells), hi = Math.max(a.cells, b.cells);
    if (hi > 0 && lo / hi < LAST_PAIR_RATIO) hit("L5", song.id, `末两行 ${a.cells} / ${b.cells} 格`);
  }
}

// ────────────────────────────────────────────── 版面几何（L6/L7）
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
        hit("L6", id, `p${dp.pageNo}「${it.text}」x ${x0.toFixed(1)}~${x1.toFixed(1)}，版心 ${left.toFixed(1)}~${right.toFixed(1)}`);
    }
  }
  // ── L13 谱面越出版心。两条口径：
  //   **按墨迹算**，不按字号——全角标点的墨只占方框一角，拿字号当宽度处处都报越界（假越界 8.7pt）。
  //   **末尾标点悬挂不算越界**——行末那个句号伸到版心外是中文排版的常规（全书 59 首都有），
  //   真正的越界是正文伸出去。
  // 两个真的来源都修过了：段落词撑开把整行拉长（layout.ts::spreadForSectionWords 越出 57pt）、
  // 对开页镜像没补偿（drawlist.ts::shiftDrawPageX，偶数页整体偏右 12.2pt）。
  {
    // 含**半角 CJK 标点** `｡､`：这批字书里的字体没有，pdfwrite 换成全角等价字画出来
    // （与 L7 主动跳过的是同一批），照样是行末悬挂的标点。
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
    if (Number.isFinite(mx) && mx > right + 0.5) hit("L13", id, `p${dp.pageNo} 右缘 ${mx.toFixed(1)} > ${right.toFixed(1)}（${who}）`);
    if (Number.isFinite(mn) && mn < left - 0.5) hit("L13", id, `p${dp.pageNo} 左缘 ${mn.toFixed(1)} < ${left.toFixed(1)}`);
  }

  // ── L9~L11 房号（volta）：文本判字符，横线判高度与间距
  for (const it of dp.items) {
    if (it.t === "text" && it.cls === "ending" && /[^0-9.]/.test(it.text))
      hit("L9", id, `p${dp.pageNo} 房号「${it.text}」`);
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
        hit("L10", id, `p${dp.pageNo} 同一行 ${r.length} 个房号，y ${r.map((b) => b.y.toFixed(1)).join(" / ")}`);
      const byX = [...r].sort((a, b) => a.x0 - b.x0);
      for (let i = 0; i + 1 < byX.length; i++) {
        const gap = byX[i + 1].x0 - byX[i].x1;
        if (gap < ENDING_MIN_GAP)
          hit("L11", id, `p${dp.pageNo} 相邻房号净距 ${gap.toFixed(2)}pt`);
      }
    }
  }

  // ── L12 转调标记压住和弦：两者同处音符上方那一带，转调该在上方（layout.ts::liftKeySigOverChords）
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
          hit("L12", id, `p${dp.pageNo}「${k.text}」压住和弦「${c.text}」`);
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
        hit("L7", id, `p${dp.pageNo}「${a.text}」压住「${b.text}」${(aEnd - bStart).toFixed(1)}pt`);
    }
  }
}

// ────────────────────────────────────────────── 定点断言（用户点名的那批）
/** 每条：曲号 → [档, 期望违例数（一律 0）]，另加几条只对这首成立的具体期望。 */
const SPOT = {
  "020": ["L1"],
  // 逐首看下来补进来的那一批（行长要匀、中间不许甩短行）。
  // **一个曲号只许写一条**——原来 374/378/419 各写了两遍，后一条把前一条覆盖掉，
  // 它们的 L8 断言被静默吃了大半年。
  "022": ["L2"], "051": ["L8", "L2"], "052": ["L8"], "058": ["L2"], "062": ["L8"],
  "077": ["L2", "L14", "L15", "L16"], "286": ["L2"], "319": ["L2"], "390": ["L2"], "405": ["L6"],
  "378": ["L8", "L2"], "419": ["L8", "L2"],
  // 374《跟随救主》的 L8 暂不断言：前三行是同一句歌词的三次反复（各 13 格），
  // 第 5 行按谱面就是 23 格，最短/最长 = 0.48 卡在阈值边上。断句本身没问题。
  "374": ["L2"],
  "024": ["L6"], "371": ["L6"], "381": ["L6"],
  "125": ["L5"], "404": ["L5"],
  "372": ["L1", "L3"], "402": ["L1", "L3"],
  "373": ["L4"],
  "376": ["L7"],
  // ── 这一轮点名的十二首（断句权重重整 + 五处绘制修正）
  "064": ["L9"],                    // 房号数字里不许有中点：`1·2.` → `1.2.`
  "068": ["L2"],                    // 在「兴起」前断句（长音 + 标点）
  "070": ["L1"],
  "095": ["L2", "L8"], "118": ["L2", "L8"],  // 四行、行长要匀
  // 096 的期望是「Fine 处断开」（见下面的曲目专属断言）。**不判 L2**：Fine 前那一段
  // 本来就短，强制断开必然留下一个短行——按新口径「稀疏」不算毛病，路标读得出来才要紧。
  "096": [],
  "120": ["L6", "L13"],             // 「（副歌）」不许挂出版心，也不许把整行撑出版心
  "144": ["L12"],                   // 转调标记不许压和弦
  "158": ["L11"],                   // 两个房号不许连在一起
  "169": ["L10"],                   // 同一行的房号要等高
  "175": ["L2"],                    // 在「能大力，」后断句
  "363": ["L2", "L8", "L16"],       // 六行、三对平行乐句（另见下面的专属断言）
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
  // 096《哈利路亚！感谢主》：Fine 落在主歌多段歌词中间，那一处要断开。
  // Fine 的小节由 rebuild 从 playData 收集后传给断句（jumpMeasures），这里只验「断开了」：
  // 行末收在句号上、且不是曲末。
  const ls = linesOf("096");
  if (ls && ls.length > 1 && !ls.slice(0, -1).some((l) => l.tail.punct === 6))
    spotFails.push(`096 Fine 处应断开（行末收在句号上），实际各行行末：${ls.map((l) => l.tail.text).join(" / ")}`);
}

// ────────────────────────────────────────────── 汇总
const counts = Object.fromEntries(Object.entries(bad).map(([k, v]) => [k, v.length]));
const songsWith = Object.fromEntries(Object.entries(bad).map(([k, v]) => [k, new Set(v.map((x) => x.id)).size]));
console.log(`底本：${lineDoc.songs.length} 首 / ${drawDoc.pages.length} 页${substSkipped ? `（字体回退跳过 ${substSkipped} 对歌词）` : ""}`);
for (const k of Object.keys(kinds)) {
  const sample = bad[k].slice(0, 3).map((x) => `${x.id} ${x.note}`).join("｜");
  console.log(`  ${k} ${kinds[k]}：${counts[k]} 处 / ${songsWith[k]} 首${sample ? `　例：${sample}` : ""}`);
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
