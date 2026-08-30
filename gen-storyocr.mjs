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
import { serveDist, launchPage } from "./scripts/harness.mjs";
import { loadCli } from "./scripts/node-harness.mjs";
import { openDb, loadGlyphFixes, recordGlyphFixes, updateUnreadGuess } from "./scripts/checkdb.mjs";

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
);
const DRY = "dry" in flags;
const LAYOUT = flags.layout ?? "pdf-layout.json";
const DICT = flags.dict ?? "testdata/500/glyphdict.json";
const UNREAD = "�";

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

const db = DRY ? null : openDb();
const fixes = db ? loadGlyphFixes(db) : {};
const dictChar = new Map();
for (const c of Object.values(dict.classes)) if (c.char) dictChar.set(c.key, c.char);
/** 这个字形现在读作什么（人工/上一轮定案优先），读不出给 null。 */
const charOf = (key) => fixes[key] ?? fixes[repOf(key)] ?? dictChar.get(key) ?? null;

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
    const cs = chars.filter((c) => shapeOf.has(c.key));
    if (cs.length < 4) return; // 太短的行没有上下文，行识别不比逐类强
    if (!cs.some((c) => c.ch === UNREAD || !charOf(c.key))) {
      // 一行里一个未读字都没有，也还是要送——标点错标就藏在这种行里。
      // 但只送含标点嫌疑（当前读作 9 / O / 0 之类）的，省一半推理。
      if (!cs.some((c) => /^[9Oo0IlXS]$/.test(charOf(c.key) ?? ""))) return;
    }
    lines.push({ page: p.page, role, chars: cs.map((c) => ({ key: c.key, x: c.x, y: c.y, w: c.w, h: c.h })) });
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

// ── 行 → 长条画布 → PP-OCR 行识别
const { port, close } = await serveDist("dist");
const { page, browser } = await launchPage({ quiet: true });
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => !!window.__omr, null, { timeout: 60000 });

const t0 = Date.now();
const BATCH = 32;
const texts = new Array(lines.length).fill("");
for (let i = 0; i < lines.length; i += BATCH) {
  const chunk = lines.slice(i, i + BATCH).map((l) => ({
    chars: l.chars.map((c) => ({ d: shapeOf.get(c.key).d, bbox: shapeOf.get(c.key).bbox, x: c.x, y: c.y, w: c.w, h: c.h })),
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
console.log(`OCR 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await browser.close();
close();

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
/** 字身宽：ASCII（数字、拉丁字母、半角标点）半身，汉字与全角标点一身。 */
const charEm = (ch) => (/[\x20-\x7e]/.test(ch) ? 0.5 : 1);
const emOf = (t) => [...t].reduce((a, c) => a + charEm(c), 0);
/**
 * 一段 OCR 文本按宽度校准：剥掉两头多出来的标点，取与墨迹宽度最吻合的那个写法。
 * 宽度是硬凭据——OCR 多读一个字符，宽度立刻对不上（「(代上」要 2.5 个字身，
 * 那个对象只有 19.0pt ≈ 2 个）。差得离谱的直接判 null，宁可不补。
 */
function trimToWidth(text, w, u) {
  const cands = new Set([text, text.replace(/^[^\p{L}\p{N}]+/u, ""), text.replace(/[^\p{L}\p{N}]+$/u, "")]);
  cands.add(text.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, ""));
  let best = null;
  for (const t of cands) {
    if (!t) continue;
    const err = Math.abs(w - u * emOf(t));
    if (!best || err < best.err) best = { t, err };
  }
  if (!best) return null;
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

const median = (v) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : 0);
const fill = new Map(); // repKey → Map(text → 票数)
const bump = (m, key, ch, n = 1) => {
  const g = repOf(key);
  if (!m.has(g)) m.set(g, new Map());
  m.get(g).set(ch, (m.get(g).get(ch) ?? 0) + n);
};
let aligned = 0;
const trace = [];
for (let i = 0; i < lines.length; i++) {
  const gt = [...(texts[i] ?? "").trim().normalize("NFKC")].filter((c) => OKCH.test(c)).join("");
  const elems = lines[i].chars.map((c) => ({ ...c, text: charOf(c.key) }));
  if (gt.length < 3) continue;
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
    const at = gt.indexOf(e.text.normalize("NFKC"), cur);
    if (at < 0) continue; // 这个锚点没找到（OCR 读错或漏），并进下一段
    if (pending.length) segs.push({ from: cur, to: at, items: pending });
    pending = [];
    cur = at + e.text.normalize("NFKC").length;
  }
  if (pending.length) segs.push({ from: cur, to: gt.length, items: pending });
  if (!segs.length) continue;
  aligned++;
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
  const takeable = (j, text) => {
    const e = elems[j];
    const n = [...text].length;
    // 孤零零一个拉丁字母不收：署名里的中点「·」被 OCR 读成 M、I 读成 l 这类
    // 一旦定案就是全书的中点都变字母。这种留给人工确认表。
    if (n === 1 && /[A-Za-z]/.test(text)) return false;
    // **句读点只能落在矮元素上**。这一条是反向的保险：原先只管「矮元素只收标点」，
    // 却没管「句读点不许收在高元素上」——括号又窄又高（h/body≈0.9），宽度只有三分之一格，
    // `want` 因此算成 1，OCR 把它读成「。」时一路畅通。全书 11 个类这么被标成了句号，
    // 其中 2.5×10.5 / 3.0×9.1 明显是括号，9.5×9.9 / 10×9.9 那几个干脆是整个汉字
    //（真正的「。」只有 3.1×3.1）。这些错标后来又成了模糊匹配的参照，会把错扩散出去。
    if (LOW_PUNCT.test(text) && e.h / body > 0.45) return false;
    if (e.h / body <= 0.45) return n === 1 && PUNCT_OK.test(text);
    // 字数闸按**字身**算，不按「元素宽度的中位数」当格宽：一行里元素有宽有窄
    //（「全地都要向耶和华歌唱」98pt 与引号 3.3pt 同在一行），中位数根本不是字格；
    // p54 那行的中位数是 3.3，「代上」那个 19pt 的对象于是被要求装下 3 个字。
    const want = Math.max(1, e.w / uLine);
    const got = emOf(text);
    return got >= want * 0.5 && got <= want * 2 + 0.5;
  };
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
      if (t && takeable(sg.items[0], t)) bump(fill, elems[sg.items[0]].key, t, 2);
    } else if (sg.items.length === [...text].length && sg.items.every((j) => elems[j].w < elems[j].h * 3)) {
      [...text].forEach((ch, k) => takeable(sg.items[k], ch) && bump(fill, elems[sg.items[k]].key, ch));
    } else {
      // 字数对不上：按**宽度**切。经文出处「(代上 16:23)」在矢量层是三个对象
      //（「代上 」19.0pt、「16」8.8、「23」9.3），OCR 又读不出括号和冒号，
      // 于是一整段「代上1623」落给三个未知元素——按字数判等于直接放弃，
      // 全书的经文出处就是这么只剩「(经)」的。宽度是硬凭据：汉字占一个字身、
      // ASCII 占半身，一段里字身总数与总宽度之比就定出字身宽 u，再按 u 切。
      const cuts = splitByWidth(elems, sg.items, text, uLine);
      if (cuts) cuts.forEach((t, k) => takeable(sg.items[k], t) && bump(fill, elems[sg.items[k]].key, t, 2));
    }
  }
  if (trace.length < 60)
    trace.push({ page: lines[i].page, now: elems.map((e) => e.text ?? UNREAD).join(""), ocr: gt, segs: segs.length });
}
console.log(`分段成功 ${aligned}/${lines.length} 行`);

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
if (!DRY) {
  recordGlyphFixes(db, expand(okFill, "ocr-line"));
  recordGlyphFixes(db, expand(punctRows, "rule-punct"));
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
