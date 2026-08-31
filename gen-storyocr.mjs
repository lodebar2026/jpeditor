// 整行 OCR 补字：把**一整行**文字的字形合成一张长条送行识别，再与该行已知字对齐，
// 把未读字形的字投票定案。
//
// 与 gen-glyphocr.mjs 的分工：那一步是**逐类**送（一个字形一张 48×48 图），
// 花边框正文、目录条目里剩下的那 1188 类正是它啃不动的残渣——单字孤立送识别，
// 宋体小字的「日/曰」「未/末」「己/已」根本分不开。行识别有上下文，同一个字形
// 在几十行里出现，投票一取多数就稳了。
//
// 顺带纠**标点错标**：花边框正文里 `，` 被标成「9」、`。` 被标成「O」（当初逐类 OCR
// 的锅），行识别在上下文里不会读错。改已有标注比补空更险，所以闸更严（≥3 票且 ≥0.75）。
//
//   npm run build && npm run build:cli && node page-report.mjs   # 先有 pdf-layout.json
//   node gen-storyocr.mjs [--dry] [--pages=5-40]
//
// 产物：写 校对.db 的 glyph_fix（source='ocr-line' / 'ocr-line-fix'）与 unread_glyph.guess_char，
// 另出 pdf-out/storyocr-report.json。**不动 glyphdict.json**——那是识别基线，
// 补的字只服务于重排（与 gen-backfill.mjs 同一条纪律）。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { serveDist, launchPage } from "./scripts/harness.mjs";
import { loadCli, CORPUS_PDF } from "./scripts/node-harness.mjs";
import { openDb, loadGlyphFixes, recordGlyphFixes, updateUnreadGuess } from "./scripts/checkdb.mjs";

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
);
const DRY = "dry" in flags;
/** 识别引擎：`both`（默认，两个都跑、投票）/ `vision`（Apple Vision）/ `paddle`（PP-OCR）。
 *  Vision 对**拉丁文字与标点**强得多——PP-OCR 是中文模型，把「Charlotte」读成
 *  「Char10tte」、逗号整行整行地漏、开引号读不出；而且 Vision 不用起浏览器，
 *  直接从原 PDF 裁那一块，连字形都不用重画。 */
const ENGINE = flags.engine ?? "both";
const LAYOUT = flags.layout ?? "pdf-layout.json";
const DICT = flags.dict ?? "testdata/500/glyphdict.json";
const UNREAD = "�";

/**
 * 一个字符占多宽（用来预测**墨迹**宽度，不是排版的字身）：
 * ASCII（数字、拉丁字母、半角标点）半身，汉字一身，
 * **中日文标点只算 0.35**——它们的字身是满格，墨迹却小得多
 *（句号 3.1/10.4 = 0.30、逗号 0.14、书名号 0.39、全角括号 0.29）。
 * 按一身算的话「》。1719」要 40.8pt，那个块只有 27.4，整段就被判成对不上而弃掉
 *（077「书名《圣诗灵歌》。1719年」的年份就是这么丢的）。
 */
const CJK_PUNCT = /[\u3000-\u303f\uff01-\uff20\uff3b-\uff40\uff5b-\uff65]/;
const charEm = (ch) => (/[\x20-\x7e]/.test(ch) ? 0.5 : CJK_PUNCT.test(ch) ? 0.35 : 1);
const emOf = (t) => [...t].reduce((a, c) => a + charEm(c), 0);
const median = (v) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : 0);

/** d 串的各条子路径包围盒（只需 M 分段与坐标，指令字母当分隔符）。 */
const subBoxes = (d) =>
  d
    .split("M")
    .slice(1)
    .map((seg) => {
      const nums = (seg.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      const xs = nums.filter((_, i) => i % 2 === 0);
      const ys = nums.filter((_, i) => i % 2 === 1);
      return xs.length && ys.length
        ? { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
        : null;
    })
    .filter(Boolean);


const cli = await loadCli();
const dict = JSON.parse(await readFile(DICT, "utf8"));
const { pages } = JSON.parse(await readFile(LAYOUT, "utf8"));

// 代表键：同一字形的分身都指向它（gen-glyphmerge 写的 `g`）。定案要落到**整组**，
// 否则分身查表时用的是自己的键，还是读不出。
const repOf = (k) => dict.classes[k]?.g ?? k;
const membersOf = new Map();
for (const c of Object.values(dict.classes)) {
  const g = repOf(c.key);
  if (!membersOf.has(g)) membersOf.set(g, []);
  membersOf.get(g).push(c.key);
}
const shapeOf = new Map(); // key → {d,bbox}
for (const c of Object.values(dict.classes)) if (c.d && c.bbox) shapeOf.set(c.key, c);

// `--dry` 只是不写库，**该读的照读**：不加载已有的补字，满屏都是「未读」，
// 送识别的行数、分段成败、trace 全都不作数。
const db = openDb();
const fixes = loadGlyphFixes(db);
const dictChar = new Map();
for (const c of Object.values(dict.classes)) if (c.char) dictChar.set(c.key, c.char);
/** 这个字形现在读作什么（人工/上一轮定案优先），读不出给 null。 */
const charOf = (key) => fixes[key] ?? fixes[repOf(key)] ?? dictChar.get(key) ?? null;

// ── 开工前先体检：**两头多出来的句读点**
//
// 上一轮（以及更早）的行识别给多字块补字时，会顺手把段末的句号也塞进块里：
// 「而作。」那个块只有 21.6pt 宽——两个汉字的位置，第三个字根本站不下，
// 于是排出来就是「而作。。」（块里一个、后面那个独立的句号对象一个）。
// 宽度分不开（句号的墨迹只有 3pt，加不加都在阈值内），**字形能**：
// 句读点是个矮矮的小点（墨迹高不到块高的四成、宽高比接近 1），
// 块的最后一组子路径要不是这么个点，那个句号就是补出来的。首部同理。
// 全书 29 类，清一色「两个汉字 + 多余的句号」或「数字 + 多余的顿号」。
{
  const SENT_PUNCT = /[。，、；：]/;
  const smallDot = (g, H) => g && g.y1 - g.y0 <= H * 0.4 && (g.x1 - g.x0) / Math.max(g.y1 - g.y0, 0.01) >= 0.6 && (g.x1 - g.x0) / Math.max(g.y1 - g.y0, 0.01) <= 1.7;
  const rows = [];
  for (const [key, ch] of Object.entries(fixes)) {
    const c = shapeOf.get(key);
    if (!c || [...ch].length < 2) continue;
    if (!SENT_PUNCT.test(ch[0]) && !SENT_PUNCT.test(ch[ch.length - 1])) continue;
    const bs = subBoxes(c.d).sort((a, b) => a.x0 - b.x0);
    if (!bs.length) continue;
    const H = Math.max(...bs.map((b) => b.y1)) - Math.min(...bs.map((b) => b.y0)) || 1;
    const gs = [];
    for (const b of bs) {
      const last = gs[gs.length - 1];
      if (last && b.x0 <= last.x1 + H * 0.02) {
        last.x1 = Math.max(last.x1, b.x1);
        last.y0 = Math.min(last.y0, b.y0);
        last.y1 = Math.max(last.y1, b.y1);
      } else gs.push({ ...b });
    }
    let t = ch;
    if (SENT_PUNCT.test(t[t.length - 1]) && !smallDot(gs[gs.length - 1], H)) t = t.slice(0, -1);
    if (t.length > 1 && SENT_PUNCT.test(t[0]) && !smallDot(gs[0], H)) t = t.slice(1);
    if (t && t !== ch) rows.push({ shape_key: key, char: t, source: "ocr-line-fix" });
  }
  if (rows.length) {
    console.log(`两头多出来的句读点：剥掉 ${rows.length} 类（${rows.slice(0, 6).map((r) => r.char).join(" ")}${rows.length > 6 ? " …" : ""}）`);
    if (!DRY) recordGlyphFixes(db, rows);
    for (const r of rows) fixes[r.shape_key] = r.char;
  }
}

// ── 体检之二：**块的墨迹比它读出来的字宽得多**
//
// 077「贵。1707年」里那个四位数的块，字典只学到一个「7」——不是未读，是**读少了**，
// 于是它成了锚点，行识别再也没机会纠。宽度露馅：一个「7」预测 5.2pt 的墨迹，
// 那个块有 18.9pt，三倍半。这种一律**退回未读**，让本轮补字重新定案。
// 只挡「宽得多」这一头：标点的墨迹本来就比预测窄（「，」1.5 对 3.6），不在此列。
if (!DRY) {
  const del = db.prepare(`DELETE FROM glyph_fix WHERE shape_key=? AND confirmed_by IS NULL`);
  const suspects = new Map(); // key → [可疑实例数, 总实例数]
  const scan = (chars) => {
    const known = chars.filter((c) => charOf(c.key) && [...charOf(c.key)].length >= 2 && !/[\x20-\x7e]/.test(charOf(c.key)));
    const u = median(known.map((c) => c.w / emOf(charOf(c.key))));
    if (!(u > 0)) return;
    for (const c of chars) {
      const ch = fixes[c.key];
      if (!ch || !shapeOf.has(c.key)) continue;
      const rec = suspects.get(c.key) ?? [0, 0];
      rec[1]++;
      if (c.w > u * emOf(ch) * 2) rec[0]++;
      suspects.set(c.key, rec);
    }
  };
  for (const p2 of pages) {
    for (const b of p2.storyBoxes) for (const l of b.lines) scan(l.chars);
    if (p2.kind === "score" || p2.kind === "toc" || p2.kind === "index" || p2.kind === "front-matter") for (const l of p2.textLines) scan(l.chars);
  }
  const dropped = [...suspects].filter(([, [bad, all]]) => bad && bad === all).map(([k]) => k);
  for (const k of dropped) {
    del.run(k);
    delete fixes[k];
  }
  if (dropped.length) console.log(`墨迹比读出来的字宽一倍以上：退回未读 ${dropped.length} 类`);
}

// ── 要送识别的行：花边框正文 + 目录/索引/前言页的文本行。
//    乐谱页的歌词行不送——那一路有 GT，gen-glyphdict 已经自举过，再送只会添乱。
const pageFilter = (n) => {
  if (!flags.pages) return true;
  return String(flags.pages)
    .split(",")
    .some((part) => {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
      return m && n >= +m[1] && n <= (m[2] ? +m[2] : +m[1]);
    });
};

const lines = [];
for (const p of pages) {
  if (!pageFilter(p.page)) continue;
  const take = (chars, role) => {
    // 没有字形类、但**自带 ch** 的也要收：注解正文里的连接号在矢量层是一条独立的细横线
    //（`bookmeta.ts::withInlineDashes` 把它插回行里），它没有 `shapeKey`，
    // 却是个实打实的锚点——「(诗 29:1-2)」少了它，「29:1」那一段就一路吃到「2」跟前。
    const cs = chars.filter((c) => shapeOf.has(c.key) || (!c.key && c.ch));
    if (cs.length < 4) return; // 太短的行没有上下文，行识别不比逐类强
    if (!cs.some((c) => c.ch === UNREAD || !charOf(c.key))) {
      // 一行里一个未读字都没有，也还是要送——标点错标就藏在这种行里。
      // 但只送含标点嫌疑（当前读作 9 / O / 0 之类）的，省一半推理。
      // 另一族藏在这种行里的是**块内丢了标点的数字**：经文出处「(诗 118:24)」
      // 在矢量层是一个对象，逐类 OCR 学到的 char 是「11824」——冒号在块内部，
      // 不是独立字形，逐类怎么送都补不回来。整行送才有上下文。
      const digits = cs.some((c) => /^\d{3,}$/.test(charOf(c.key) ?? ""));
      if (!digits && !cs.some((c) => /^[9Oo0IlXS]$/.test(charOf(c.key) ?? ""))) return;
    }
    lines.push({ page: p.page, role, chars: cs.map((c) => ({ key: c.key, ch: c.ch, x: c.x, y: c.y, w: c.w, h: c.h })) });
  };
  // 框内按**视觉行**送（`groupBoxRows` 与 bookmeta 同一口径）：矮元素（引号、句读点）
  // 在 `groupLines` 那一层会掉出正文行自成一组，单送没上下文，行识别读不出。
  for (const b of p.storyBoxes) for (const row of cli.groupBoxRows(b.lines)) take(row, "story");
  // 乐谱页上的注解：022 那种**双细线框**里的经文，以及无框的经文。花边框那一路
  // 走 storyBoxes，这一路以前整个漏在外面——「(代上 16:23)」的数字全书都没补过。
  for (const grp of cli.scoreAnnotationGroups(p, cli.clusterRuleFrames(p.frames)))
    for (const row of cli.groupBoxRows(grp.lines)) take(row, "story");
  // 目录/索引**不能**按 y 聚行——索引是多栏排，同一 y 的两栏会被并成一行。
  if (p.kind === "toc" || p.kind === "index" || p.kind === "front-matter")
    for (const l of p.textLines) take(l.chars, p.kind === "front-matter" ? "story" : "toc");
}
console.log(`送识别的行 ${lines.length}（story ${lines.filter((l) => l.role === "story").length}，目录/索引 ${lines.filter((l) => l.role === "toc").length}）`);
if (!lines.length) process.exit(0);

// ── 送识别
const texts = new Array(lines.length).fill("");

/** Apple Vision：直接从原 PDF 裁**这一行的矩形**送系统 OCR（`tools/vision-ocr`，
 *  批量走 stdin——一行一个进程的话，进程启动就占掉四分之三的时间）。
 *  拿到的可能不止一行（矩形边上蹭到邻行），按 y 取与本行最近的那一条。 */
function runVision() {
  const items = lines.map((l) => {
    const x0 = Math.min(...l.chars.map((c) => c.x));
    const x1 = Math.max(...l.chars.map((c) => c.x + c.w));
    const y0 = Math.min(...l.chars.map((c) => c.y));
    const y1 = Math.max(...l.chars.map((c) => c.y + c.h));
    const pad = Math.max(1.5, (y1 - y0) * 0.12);
    return { page: l.page, x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  });
  const r = spawnSync("tools/vision-ocr", ["--batch"], {
    input: JSON.stringify({ pdf: CORPUS_PDF, scale: 6, items }),
    maxBuffer: 1 << 28,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`vision-ocr 跑不起来（先 swiftc 编译，见 tools/vision-ocr.swift）：${r.stderr || r.error}`);
  const { results } = JSON.parse(r.stdout);
  results.forEach((rs, i) => {
    if (!rs.length) return;
    const mid = items[i].y + items[i].h / 2;
    texts[i] = rs.sort((a, b) => Math.abs(a.y + a.h / 2 - mid) - Math.abs(b.y + b.h / 2 - mid))[0].text;
  });
}

async function runPaddle() {
  const { port, close } = await serveDist("dist");
  const { page, browser } = await launchPage({ quiet: true });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => !!window.__omr, null, { timeout: 60000 });

  const BATCH = 32;
  for (let i = 0; i < lines.length; i += BATCH) {
    const chunk = lines.slice(i, i + BATCH).map((l) => ({
      chars: l.chars.map((c) =>
        shapeOf.has(c.key)
          ? { d: shapeOf.get(c.key).d, bbox: shapeOf.get(c.key).bbox, x: c.x, y: c.y, w: c.w, h: c.h }
          : { rect: true, x: c.x, y: c.y, w: c.w, h: c.h }, // 连接号那条细横线：本来就是个实心矩形
      ),
    }));
    const got = await page.evaluate(async (items) => {
      const omr = await window.__omr;
      window.__ocr ??= omr.paddleOcrBackend();
      const canvases = items.map((it) => {
        // 行的墨迹包络（页面坐标，y 向下）
        const x0 = Math.min(...it.chars.map((c) => c.x));
        const x1 = Math.max(...it.chars.map((c) => c.x + c.w));
        const y0 = Math.min(...it.chars.map((c) => c.y));
        const y1 = Math.max(...it.chars.map((c) => c.y + c.h));
        // 高度按**字格**放大一点：标点只占字格下部，按墨迹包络铺满会把整行顶歪
        const pad = (y1 - y0) * 0.18;
        const H = y1 - y0 + pad * 2;
        const s = 40 / H;
        const cw = Math.min(2048, Math.max(48, Math.round((x1 - x0) * s) + 8));
        const cv = new OffscreenCanvas(cw, 48);
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, cw, 48);
        ctx.fillStyle = "#000";
        const vOff = (48 - H * s) / 2;
        const cy = (pageY) => (pageY - (y0 - pad)) * s + vOff;
        for (const c of it.chars) {
          if (c.rect) {
            ctx.fillRect(4 + (c.x - x0) * s, cy(c.y), Math.max(1, c.w * s), Math.max(1, c.h * s));
            continue;
          }
          const [gx0, gy0, gx1, gy1] = c.bbox;
          const gh = Math.max(gy1 - gy0, 0.01);
          const gw = Math.max(gx1 - gx0, 0.01);
          ctx.save();
          // 字形自带坐标是 PDF 系（y 朝上），画布朝下，所以 y 要取负缩放；
          // 锚点是这个字**自己的**下缘（与 relayout.mjs::placeGlyph 同一口径）。
          ctx.translate(4 + (c.x - x0) * s, cy(c.y + c.h));
          ctx.scale((c.w / gw) * s, -(c.h / gh) * s);
          ctx.translate(-gx0, -gy0);
          ctx.fill(new Path2D(c.d));
          ctx.restore();
        }
        return cv;
      });
      return await window.__ocr.recognizeTexts(canvases);
    }, chunk);
    got.forEach((t, k) => (texts[i + k] = t ?? ""));
    if ((i / BATCH) % 10 === 0) process.stdout.write(`\r  ${Math.min(i + BATCH, lines.length)}/${lines.length}…`);
  }
  process.stdout.write("\r");
  await browser.close();
  close();

}

/** 跑一个引擎，结果写进 `texts`。 */
async function runEngine(name) {
  texts.fill("");
  const t0 = Date.now();
  if (name === "vision") runVision();
  else await runPaddle();
  console.log(`${name} 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ── 锚点分段投票
//
// **不能按字对齐**：这本书的花边框正文里，一段连排的字常常合成**一个** path 对象
//（gen-glyphocr 的整行分支已经给它标了多字符的 char），所以一行的元素序列里
// 有的元素代表 12 个字、有的只代表 1 个。按字做 DP 会把长度算错，整条判成错位
//（实测 30 行里 18 行被 alignSeq 判 null，其实识别结果好得很）。
//
// 改成：已知元素当**锚点**在 OCR 串里定位，锚点之间的残余文本分给那一段里的未知元素。
// 一段里只有一个未知元素 → 整段给它；有多个 → 只有「都是单字且字数正好对上」才逐字给，
// 否则留给人工（宁可不补，也不能补错）。
// OCR 串里留得下的字符。**半角标点也要留**：经文出处「(代上 16:23)」印的是半角
// 括号与冒号，剔掉的话这一行的括号锚点全落空，中间的「代上」「16」「23」三个未知
// 元素并成一段，字数对不上就整段弃掉——全书的经文出处就是这么丢了数字的。
const OKCH = /[一-鿿　-〿！-～0-9A-Za-z·♭#「」《》()[\]:;,.\-]/;
/**
 * 一段 OCR 文本按宽度校准：剥掉两头多出来的标点，取与墨迹宽度最吻合的那个写法。
 * 宽度是硬凭据——OCR 多读一个字符，宽度立刻对不上（「(代上」要 2.5 个字身，
 * 那个对象只有 19.0pt ≈ 2 个）。差得离谱的直接判 null，宁可不补。
 */
function trimToWidth(text, w, u) {
  const cands = new Set([text, text.replace(/^[^\p{L}\p{N}]+/u, ""), text.replace(/[^\p{L}\p{N}]+$/u, "")]);
  cands.add(text.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, ""));
  const errOf = (t) => Math.abs(w - u * emOf(t));
  const base = errOf(text);
  let best = { t: text, err: base };
  for (const t of cands) {
    if (!t || t === text) continue;
    const err = errOf(t);
    if (err < best.err) best = { t, err };
  }
  // **只有显著更优才剥**（误差降到原文的一半以下）。字身宽是拿汉字块估的，
  // 对西文偏大——「E.」（9.2pt）按 1 个字身算差 4.2，剥成「E」差 2.5，
  // 一律取小的话点就没了，而剥完的单个拉丁字母又会被 takeable 挡掉，整块全丢。
  // 「(代上」那种真该剥的差得远（5.5 → 0.6），这条闸拦不住它。
  if (best.t !== text && best.err > base / 2) best = { t: text, err: base };
  return best.err > Math.max(u * emOf(best.t) * 0.3, u * 0.35) ? null : best.t;
}
/**
 * 一段 OCR 文本按**宽度**分给该段里的几个未知元素。
 *
 * 花边框正文里一段连排的字常常合成一个 path 对象，所以「元素」与「字」不是一一对应；
 * 但每个元素的宽度是精确的，字身总数也算得出来，两者一除就是这一行的字身宽 u。
 * DP 找一种切法使 Σ|实宽 − u·段字身| 最小，再逐段验收：偏差超过 35%（或 0.3 个字身）
 * 的一律不要——宁可不补，也不能补错。
 */
function splitByWidth(elems, items, text, uLine) {
  const k = items.length;
  const ws = items.map((j) => elems[j].w);
  const total = ws.reduce((a, b) => a + b, 0);
  // 段的两头先按**整行**的字身宽校准：锚点在 OCR 串里重复出现时段界会挪一格
  //（p54 那行的行首「“」被 OCR 读成「(」，「(」锚点匹配到前一个，段就多带了一个括号）。
  // 段内自估字身宽是自洽的——多带一个字符，u 就跟着缩，验收照样过；
  // 只有拿整行的 u 来量才露馅。
  const t0 = uLine ? trimToWidth(text, total, uLine) : text;
  if (!t0) return null;
  const cs = [...t0];
  if (k < 2 || cs.length < k || cs.length > 24) return null;
  const em = [0];
  for (const c of cs) em.push(em[em.length - 1] + charEm(c));
  const u = uLine || total / em[cs.length];
  if (!(u > 0)) return null;
  const cost = (a, b, i) => Math.abs(ws[i] - u * (em[b] - em[a]));
  const INF = Infinity;
  // best[i][j]：前 i 个字符分给前 j 个元素的最小代价；from 记回溯点
  const best = Array.from({ length: cs.length + 1 }, () => new Array(k + 1).fill(INF));
  const from = Array.from({ length: cs.length + 1 }, () => new Array(k + 1).fill(-1));
  best[0][0] = 0;
  for (let j = 1; j <= k; j++)
    for (let i = j; i <= cs.length - (k - j); i++)
      for (let a = j - 1; a < i; a++) {
        const v = best[a][j - 1] + cost(a, i, j - 1);
        if (v < best[i][j]) {
          best[i][j] = v;
          from[i][j] = a;
        }
      }
  if (best[cs.length][k] === INF) return null;
  const parts = [];
  let i = cs.length;
  for (let j = k; j > 0; j--) {
    const a = from[i][j];
    parts.unshift(cs.slice(a, i).join(""));
    i = a;
  }
  for (let x = 0; x < k; x++) {
    const want = u * [...parts[x]].reduce((a, c) => a + charEm(c), 0);
    if (Math.abs(ws[x] - want) > Math.max(want * 0.35, u * 0.3)) return null;
  }
  return parts;
}

/**
 * 这个块的**两头**是不是一条扁横条（连接号）。
 *
 * 「1483－」「1808～1889」这种块，逐类 OCR 学到的 char 只有数字，连接号在块内部
 * 或块末尾，不是独立字形——037 的生卒年就这么成了「1483 1546」。
 * 让 OCR 的匹配串在两头各多带一个标点是危险的（「(诗 150:6)」的「150」会顺手
 * 把冒号吃进去），所以要**字形说了算**：只有那一头的子路径确实是条扁横条
 *（宽高比 ≥ 2.5、只占整块高度的三成以内）才许带。
 */
const dashEnds = (d) => {
  const bs = subBoxes(d).sort((a, b) => a.x0 - b.x0);
  if (!bs.length) return { head: false, tail: false };
  const h = Math.max(...bs.map((b) => b.y1)) - Math.min(...bs.map((b) => b.y0)) || 1;
  // 子路径按 x 聚成字符组（数字之间本来就有字距），只看两头那一组
  const gs = [];
  for (const b of bs) {
    const last = gs[gs.length - 1];
    if (last && b.x0 <= last.x1 + h * 0.02) {
      last.x1 = Math.max(last.x1, b.x1);
      last.y0 = Math.min(last.y0, b.y0);
      last.y1 = Math.max(last.y1, b.y1);
      last.n++;
    } else gs.push({ ...b, n: 1 });
  }
  /** 独立的一件小标点，**分两族**：横着的是连接号，方的是句读点。 */
  const kind = (g) => {
    if (!g || g.n !== 1) return null;
    const w = g.x1 - g.x0;
    const hh = Math.max(g.y1 - g.y0, 0.01);
    if (w / hh >= 2.5 && hh <= h * 0.3) return "dash";
    if (hh <= h * 0.4 && w / hh >= 0.6 && w / hh <= 1.7) return "dot";
    return null;
  };
  return { head: kind(gs[0]), tail: kind(gs[gs.length - 1]) };
};
/** 结果里有非 ASCII（汉字、书名号…）就把半角句读点还原成全角
 *  ——`gt` 是 NFKC 过的，「，」在那儿是 ","，照抄会把全角标点排成半角。 */
const toFullPunct = (t) =>
  /[^\x00-\x7f]/.test(t) ? t.replace(/,/g, "，").replace(/;/g, "；").replace(/:/g, "：").replace(/\./g, "。") : t;
const RE_ESC = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const fill = new Map(); // repKey → Map(text → 票数)
const digitFix = new Map(); // repKey → Map(text → 票数)：改**已有**标注（块内补回标点）
const bump = (m, key, ch, n = 1) => {
  const g = repOf(key);
  if (!m.has(g)) m.set(g, new Map());
  m.get(g).set(ch, (m.get(g).get(ch) ?? 0) + n);
};
let aligned = 0;
const trace = [];
const rejects = [];
/**
 * 一个引擎跑完之后：锚点分段 → 投票。
 *
 * **两个引擎都跑（`--engine=both`，默认）**：PP-OCR 是中文专精，正文与人名拼写更准
 *（`Charlotte Elliott`、中点 `·`），却把引号整行整行地丢；Apple Vision 对拉丁与标点强，
 * 引号、开引号都在，中文偶尔认岔（「为」读成「汐」）。两边投同一票就是 4 票，稳；
 * 意见不合各 2 票、比例 0.5 卡在 0.6 那道闸外，自动弃权留给人工——正是想要的。
 */
function alignAndVote(engine) {
  for (let i = 0; i < lines.length; i++) {
    const gt = [...(texts[i] ?? "").trim().normalize("NFKC")].filter((c) => OKCH.test(c)).join("");
    const elems = lines[i].chars.map((c) => ({ ...c, text: charOf(c.key) ?? (c.key ? null : (c.ch ?? null)) }));
    if (gt.length < 3) continue;
    // 两道保险，防止「一个 OCR 小错被写成整类的定案」：
    //  1) 字数要与宽度对得上——一个单字宽的元素收下五个字，那多半是分段错位。
    //  2) **标点大小的元素只收标点**：`James·Black` 的中点被 OCR 读成 M，
    //     不挡的话全书的中点都会变成 M（实测就出过一次）。
    const hs = elems.map((e) => e.h).sort((a, b) => a - b);
    const body = hs[Math.floor(hs.length * 0.7)] || 1;
    const cellW = median(elems.map((e) => e.w)) || 1;
    // 这一行的**字身宽**：只拿多字汉字块估（标点的墨迹比字身窄得多，单字块噪声也大）。
    // 用来验收补进去的字——宽度是硬凭据，OCR 多读一个字符宽度立刻对不上。
    const uLine =
      median(
        elems
          .filter((e) => e.text && [...e.text].length >= 2 && !/[\x20-\x7e]/.test(e.text))
          .map((e) => e.w / emOf(e.text)),
      ) || cellW;

    // 全角标点 + **半角标点**：英文人名、曲号里用的是半角 `( ) - : ,`
    //（037「《坚固保障》(61首)」的右括号、「Martin Luther 1483-1546」的连字符都是半角，
    //  只认全角的话它们永远补不回来）。
    const PUNCT_OK = /^[\u3000-\u303f\uff01-\uff20\uff3b-\uff40\uff5b-\uff65·～()\-:;,.[\]]+$/;
    /** 只占字身下部的句读点——它们的墨迹必然矮。括号、引号、书名号不在此列（那些是高的）。 */
    const LOW_PUNCT = /^[。，、．·,.]+$/;
    const reject = (why, j, text) => {
      if (rejects.length < 400) rejects.push({ engine, why, text, w: +elems[j].w.toFixed(1), h: +elems[j].h.toFixed(1), page: lines[i].page });
      return false;
    };
    const takeable = (j, text) => {
      const e = elems[j];
      const n = [...text].length;
      // 孤零零一个拉丁字母不收：署名里的中点「·」被 OCR 读成 M、I 读成 l 这类
      // 一旦定案就是全书的中点都变字母。这种留给人工确认表。
      if (n === 1 && /[A-Za-z]/.test(text)) return reject("孤立拉丁字母", j, text);
      // **句读点只能落在矮元素上**。这一条是反向的保险：原先只管「矮元素只收标点」，
      // 却没管「句读点不许收在高元素上」——括号又窄又高（h/body≈0.9），宽度只有三分之一格，
      // `want` 因此算成 1，OCR 把它读成「。」时一路畅通。全书 11 个类这么被标成了句号，
      // 其中 2.5×10.5 / 3.0×9.1 明显是括号，9.5×9.9 / 10×9.9 那几个干脆是整个汉字
      //（真正的「。」只有 3.1×3.1）。这些错标后来又成了模糊匹配的参照，会把错扩散出去。
      if (LOW_PUNCT.test(text) && e.h / body > 0.45) return reject("句读点落在高元素上", j, text);
      if (e.h / body <= 0.45) {
        // **扁横条是「一」，不是标点**。行识别读得出它（全书 24 处），但这里故意不定案：
        // 这几个形状类在歌词里有 477 个实例，写进 `glyph_fix` 就推翻了
        //「歌词里的一不进字典、只按几何认」那条纪律（见 inventory.ts 的 lyricYi）。
        // 注解那边由 `bookmeta.ts::hbarAsYi` 在出文本时认——只影响注解，不动字典。
        if (text === "一") return false;
        return n === 1 && PUNCT_OK.test(text) ? true : reject("矮元素只收单个标点", j, text);
      }
      // 字数闸按**字身**算，不按「元素宽度的中位数」当格宽：一行里元素有宽有窄
      //（「全地都要向耶和华歌唱」98pt 与引号 3.3pt 同在一行），中位数根本不是字格；
      // p54 那行的中位数是 3.3，「代上」那个 19pt 的对象于是被要求装下 3 个字。
      const want = Math.max(1, e.w / uLine);
      const got = emOf(text);
      return got >= want * 0.5 && got <= want * 2 + 0.5 ? true : reject(`字数与宽度对不上（要 ${want.toFixed(1)} 得 ${got}）`, j, text);
    };
    // 锚点：已知且长度 ≥1 的元素，按序在 OCR 串里找。找不到就跳过这个锚点
    //（OCR 会漏掉逗号，也会读错个别字，锚点少一个不影响分段）。
    let cur = 0;
    const segs = []; // { from, to, items:[元素下标] }
    let pending = [];
    for (let j = 0; j < elems.length; j++) {
      const e = elems[j];
      if (!e.text) {
        pending.push(j);
        continue;
      }
      // 锚点比对要**全半角归一**：`gt` 已经 NFKC 过（全角括号、冒号都成了半角），
      // 而字典里那些字是全角（「作词：」的冒号）。不归一的话「(诗 150：6)」的冒号
      // 锚点永远落空，「150」那一段就一路吃到「6」跟前，补出个「150:」来。
      const t = e.text.normalize("NFKC");
      // **同一个锚点在 gt 里出现好几次**时，按宽度挑：单字的「2」在「29:12」里有两个，
      // 取第一个的话「29:1」那一段就成了空段，前面 18.99pt 的未读块什么也分不到。
      // 拿这一段里待分的元素总宽与候选段文本的字身数一比，哪个吻合取哪个。
      let at = gt.indexOf(t, cur);
      let len = t.length;
      if (at >= 0 && pending.length) {
        const wSeg = pending.reduce((a, j2) => a + elems[j2].w, 0);
        let best = null;
        for (let p2 = at; p2 >= 0; p2 = gt.indexOf(t, p2 + 1)) {
          const err = Math.abs(wSeg - uLine * emOf(gt.slice(cur, p2)));
          if (!best || err < best.err) best = { at: p2, err };
        }
        if (best) at = best.at;
      }
      // 块尾/块首那条横条要单独问一句：`indexOf` 找得到「1483」（它是「1483-」的前缀），
      // 光看 at < 0 会漏掉尾部多一个连接号的那一族（037 的生卒年就是这样）。
      // 块的两头**多着一件标点**是常事：「1483－」的连字符、「》，」的逗号——
      // 逐类 OCR 学到的 char 只有主体，那件标点在块内部，不是独立字形。
      // 只有**字形上确实多着那么一件**（两头那一组是一笔的矮点或扁条）才许 OCR 多带一个，
      // 否则「(诗 150:6)」的「150」会顺手把冒号吃进去。
      const PUNCT_ANY = /[:.\-~～–—,，。、；;：]/;
      const ends = shapeOf.has(e.key) ? dashEnds(shapeOf.get(e.key).d) : { head: null, tail: null };
      // **纯数字块只认连接号**：目录条目的曲号后面跟着引导点，「279」的尾巴上
      // 认出个矮点就写成「279.」，全书目录会被改得一塌糊涂。生卒年那一横不在此列。
      const digits = /^\d+$/.test(t);
      const ok = (k) => k === "dash" || (k === "dot" && !digits);
      const headOK = ok(ends.head) && !PUNCT_ANY.test(t[0]);
      const tailOK = ok(ends.tail) && !PUNCT_ANY.test(t[t.length - 1]);
      if ((at < 0 || headOK || tailOK) && shapeOf.has(e.key) && (/^\d{3,}$/.test(t) || headOK || tailOK)) {
        // **块内丢了标点的数字**：这个元素读作「11824」，OCR 读出的是「118:24」。
        // 数字序列一字不差、只是中间多了标点——这一条硬到不用投票边际：
        // 在 gt 里按「数字之间允许插入一个 : . - 」重找，命中就连带把这个类改对
        //（`source=ocr-line-fix`，比补空更险，所以闸另设 0.75）。
        // 连接号那一族也算：年份区间用的是「～」，经文出处用的是「-」。
        const P = "[:.\\-~～–—,;]";
        const DASH = "[-~～–—]";
        const DOT = "[,;:.，。、；：]";
        const side = (k) => (k === "dash" ? DASH : DOT) + "?";
        // 纯数字块的连接号可能在**中间**（「1808～1889」），别的块只看两头。
        const body = /^\d{3,}$/.test(t) ? [...t].join(`${P}?`) : RE_ESC(t);
        const re = new RegExp(`${headOK ? side(ends.head) : ""}${body}${tailOK ? side(ends.tail) : ""}`);
        const m = re.exec(gt.slice(cur));
        if (m && m[0] !== t) {
          at = cur + m.index;
          len = m[0].length;
          bump(digitFix, e.key, toFullPunct(m[0]), 2);
        }
      }
      if (at < 0) continue; // 这个锚点没找到（OCR 读错或漏），并进下一段
      if (pending.length) segs.push({ from: cur, to: at, items: pending });
      pending = [];
      cur = at + len;
    }
    if (pending.length) segs.push({ from: cur, to: gt.length, items: pending });
    // 一行都没分出段也要记进 trace——**整行已知**的那些正是靠 `digitFix` 纠错的
    //（「1808～1889」那种块内丢标点的行），出了问题只能从这里看。
    // **有未读元素的行优先记**：那才是补字没成的现场，整行已知的行记满 20 条就够了。
    const hasHole = elems.some((e) => !e.text);
    if (hasHole ? trace.length < 120 : trace.filter((t) => !t.hole).length < 20)
      trace.push({ engine, page: lines[i].page, hole: hasHole, now: elems.map((e) => e.text ?? UNREAD).join(""), ocr: gt, segs: segs.length });
    if (!segs.length) continue;
    aligned++;
    /**
     * 段文本按宽度校准：**锚点在 OCR 串里重复出现**时，段的边界会挪一格。
     * p54 那行 OCR 把行首的「“」也读成了「(」，于是「(」锚点匹配到前一个，
     * 「代上」那个元素分到的是「(代上」——19.0pt 的墨迹装不下 2.5 个字身。
     * 拿整行的字身宽一验就露馅，剥掉两头的标点再验，取最吻合的那个。
     */
    const calibrate = (j, text) => ([...text].length < 2 ? text : trimToWidth(text, elems[j].w, uLine));
    for (const sg of segs) {
      const text = gt.slice(sg.from, sg.to);
      if (!text) continue;
      if (sg.items.length === 1) {
        const t = calibrate(sg.items[0], text);
        if (t && takeable(sg.items[0], t)) bump(fill, elems[sg.items[0]].key, toFullPunct(t), 2);
      } else if (sg.items.length === [...text].length && sg.items.every((j) => elems[j].w < elems[j].h * 3)) {
        [...text].forEach((ch, k) => takeable(sg.items[k], ch) && bump(fill, elems[sg.items[k]].key, ch));
      } else {
        // 字数对不上：按**宽度**切。经文出处「(代上 16:23)」在矢量层是三个对象
        //（「代上 」19.0pt、「16」8.8、「23」9.3），OCR 又读不出括号和冒号，
        // 于是一整段「代上1623」落给三个未知元素——按字数判等于直接放弃，
        // 全书的经文出处就是这么只剩「(经)」的。宽度是硬凭据：汉字占一个字身、
        // ASCII 占半身，一段里字身总数与总宽度之比就定出字身宽 u，再按 u 切。
        const cuts = splitByWidth(elems, sg.items, text, uLine);
        if (cuts) cuts.forEach((t, k) => takeable(sg.items[k], t) && bump(fill, elems[sg.items[k]].key, toFullPunct(t), 2));
      }
    }
  }
}

for (const eng of ENGINE === "both" ? ["vision", "paddle"] : [ENGINE]) {
  await runEngine(eng);
  alignAndVote(eng);
}
console.log(`分段成功 ${aligned}/${lines.length} 行（两轮合计）`);

const decide = (m, minVotes, minRatio) => {
  const out = [];
  for (const [g, votes] of m) {
    const tot = [...votes.values()].reduce((a, b) => a + b, 0);
    const [ch, n] = [...votes].sort((a, b) => b[1] - a[1])[0];
    out.push({ g, ch, votes: n, total: tot, ratio: n / tot, ok: n >= minVotes && n / tot >= minRatio });
  }
  return out;
};
const fillRows = decide(fill, 2, 0.6);
const okFill = fillRows.filter((r) => r.ok);
// 改已有标注比补空更险，闸另设（≥2 票且 ≥0.75）——判据本身很硬（数字序列一字不差），
// 险的是 OCR 把标点位置放错，那种只会在票数分散时露头。
const okDigitFix = decide(digitFix, 2, 0.75).filter((r) => r.ok);
if (okDigitFix.length)
  console.log(
    `块内补回标点 ${okDigitFix.length} 类：${okDigitFix.slice(0, 12).map((r) => r.ch).join(" ")}${okDigitFix.length > 12 ? " …" : ""}`,
  );

// ── 标点：不靠 OCR，靠字形与尺寸定案
//
// PP-OCR 会把行里的逗号**整个漏掉**（实测每一行都漏），所以标点补不回来。
// 但它们在矢量层是干净的：把这些类的轮廓渲染出来一眼就认得（见 gen-glyphsheet.mjs），
// 当初逐类 OCR 把「，」读成 9、「。」读成 O、年份区间的「～」留成空。
// 判据是**墨迹高只有正文的三成**（实测 h/body 中位 0.29，真数字与字母都 ≥0.7），
// 加上它当前被读成什么——两条一起才动手，只满足一条的留给人工。
const PUNCT_BY_LABEL = { 9: "，", O: "。", 0: "。" };
const punctVote = new Map(); // repKey → Map(char → 票数)
for (const p2 of pages) {
  const scan = (chars) => {
    const hs = chars.map((c) => c.h).sort((a, b) => a - b);
    const body = hs[Math.floor(hs.length * 0.7)] || 1;
    for (const c of chars) {
      if (c.h / body > 0.45) continue;
      const now = charOf(c.key);
      const want = now && PUNCT_BY_LABEL[now];
      if (!want) continue;
      const g = repOf(c.key);
      if (!punctVote.has(g)) punctVote.set(g, new Map());
      punctVote.get(g).set(want, (punctVote.get(g).get(want) ?? 0) + 1);
    }
  };
  for (const b of p2.storyBoxes) for (const l of b.lines) scan(l.chars);
  if (p2.kind === "toc" || p2.kind === "index" || p2.kind === "front-matter") for (const l of p2.textLines) scan(l.chars);
}
const punctRows = decide(punctVote, 3, 0.9).filter((r) => r.ok);

// 落库：定案的写 glyph_fix（**整组每个分身各一行**，按精确键查也命中）；
// 没定案的把最高票写进 unread_glyph.guess_char 供人工确认。
const expand = (rows, source) =>
  rows.flatMap((r) => (membersOf.get(r.g) ?? [r.g]).map((key) => ({ shape_key: key, char: r.ch, source })));
// ── 收尾：**块里夹着的标点**（判据在 `glyphdict.ts::blockPunct`，与 gen-glyphfuzzy 共用）
//
// 这一步要放在补字之后：060 的「1:4」是这一轮才被行识别认出「14」的，
// 冒号夹在块中间、不是独立字形，只有拿字形再走一遍才排得回去。
const blockRows = [];
{
  const latest = { ...fixes };
  for (const r of [...expand(okFill, ""), ...expand(okDigitFix, "")]) latest[r.shape_key] = r.char;
  for (const [key, c] of shapeOf) {
    const ch = latest[key] ?? dictChar.get(key);
    const t = ch && c.d ? cli.blockPunct(c.d, ch) : null;
    if (t) blockRows.push({ shape_key: key, char: t, source: "rule-dash-inblock" });
  }
  if (blockRows.length)
    console.log(`块里夹着的标点 ${blockRows.length} 类：${blockRows.slice(0, 8).map((r) => r.char).join(" ")}${blockRows.length > 8 ? " …" : ""}`);
}
if (!DRY) {
  recordGlyphFixes(db, expand(okFill, "ocr-line"));
  recordGlyphFixes(db, expand(okDigitFix, "ocr-line-fix"));
  recordGlyphFixes(db, expand(punctRows, "rule-punct"));
  recordGlyphFixes(db, blockRows);
  updateUnreadGuess(
    db,
    fillRows.filter((r) => !r.ok).flatMap((r) => (membersOf.get(r.g) ?? [r.g]).map((key) => ({ shape_key: key, guess_char: r.ch, confidence: r.ratio }))),
  );
  db.close();
}

await mkdir("pdf-out", { recursive: true });
await writeFile(
  "pdf-out/storyocr-report.json",
  JSON.stringify(
    {
      lines: lines.length,
      aligned,
      filled: okFill.length,
      punct: punctRows.length,
      pendingGuess: fillRows.length - okFill.length,
      fillSample: okFill.slice(0, 40).map((r) => ({ ch: r.ch, votes: r.votes, ratio: +r.ratio.toFixed(2) })),
      trace,
      rejects,
      punctRows: punctRows.map((r) => ({ ch: r.ch, votes: r.votes })),
    },
    null,
    2,
  ),
);
console.log(
  `补字定案 ${okFill.length} 组（${DRY ? "dry，未写库" : "已写 glyph_fix"}），标点纠正 ${punctRows.length} 组（实例 ${punctRows.reduce((a, r) => a + r.total, 0)}），` +
    `留给人工 ${fillRows.length - okFill.length} 组`,
);
console.log(`标点明细: ${[...new Set(punctRows.map((r) => r.ch))].join(" ")}`);
console.log("→ pdf-out/storyocr-report.json");
