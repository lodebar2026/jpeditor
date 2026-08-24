// 从乐谱数据重排出成书 PDF（B 路）。
//
//   npm run build && node rebuild.mjs --one=028          # 单曲，出 pdf-out/rebuild-028.pdf
//   node rebuild.mjs --book=testdata/500/book.json       # 整本
//
// 拓扑：排版引擎依赖 common/measure.ts 的 getBBox，只能在浏览器里跑；pdf-lib 只能在 Node。
// 中间格式是 DrawList（src/pdflayout/drawlist.ts）：页内把页面树扁平化成绝对坐标 + 逐字笔位，
// Node 侧照着画，两端不必共享字体度量。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { serveDist, launchPage } from "./scripts/harness.mjs";
import { loadCorpus, gtKeyTime, loadCli, songRank } from "./scripts/node-harness.mjs";
import { writePdf } from "./scripts/pdfwrite.mjs";
import { makeMetrics } from "./scripts/textmetrics.mjs";
import { openDb, readTable } from "./scripts/checkdb.mjs";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")));
const OUTDIR = flags.out ?? "pdf-out";
const style = JSON.parse(await readFile(flags.style ?? "testdata/500/bookstyle.json", "utf8"));
const only = flags.one ? String(flags.one).split(",") : null;

const { songs, categories } = await loadCorpus();
const cli = await loadCli();
const metrics = await makeMetrics(style);
const measure = metrics.advance;

// ── 书级元数据（gen-bookmeta.mjs 从原书版面规格提取，见 src/pdflayout/bookmeta.ts）。
//    没有库也能跑，只是排不出调号拍号原文、段落词、注解、目录与索引。
const meta = { song: new Map(), section: new Map(), annotation: new Map(), toc: [], index: [], front: [], tiles: [] };
if (!("nometa" in flags)) {
  try {
    const db = openDb();
    for (const r of readTable(db, "song_meta")) meta.song.set(r.song_no, r);
    for (const r of readTable(db, "section_word", "song_no, note_ordinal")) {
      if (!meta.section.has(r.song_no)) meta.section.set(r.song_no, []);
      meta.section.get(r.song_no).push(r);
    }
    for (const r of readTable(db, "annotation", "seq")) {
      if (!meta.annotation.has(r.song_no)) meta.annotation.set(r.song_no, []);
      meta.annotation.get(r.song_no).push(r);
    }
    meta.toc = readTable(db, "toc_row", "seq");
    meta.index = readTable(db, "index_row", "seq");
    meta.front = readTable(db, "front_page", "source_page");
    meta.tiles = readTable(db, "ornament_tile");
    db.close();
    console.log(`书级元数据：调号拍号 ${meta.song.size}，段落词 ${[...meta.section.values()].flat().length}，注解 ${[...meta.annotation.values()].flat().length}，目录 ${meta.toc.length} 行，索引 ${meta.index.length} 行`);
  } catch (e) {
    console.log(`⚠ 读不到书级元数据（${String(e.message ?? e).split("\n")[0]}），只排谱面`);
  }
}
/** 注解正文的**行距比例**（行距 ÷ 字号）。原书每一框的字号都不一样（按剩余空间缩排），
 *  所以不能存一个绝对行距，得存比例：框高 ÷ (行数−1) ÷ 这一框的字号。 */
const annGapRatio = (() => {
  const rs = [];
  for (const a of [...meta.annotation.values()].flat()) {
    const n = String(a.text ?? "").split("\n").length;
    if (a.framed && n > 2 && a.box_h > 0 && a.size > 2) rs.push((a.box_h - 10) / (n - 1) / a.size);
  }
  rs.sort((x, y) => x - y);
  return rs.length ? Number(rs[Math.floor(rs.length / 2)].toFixed(3)) : 1.5;
})();
const picked = [...songs.values()].filter((s) => (only ? only.includes(s.id) : true) && s.musicxml);
if (!picked.length) {
  console.error(`没有可排的曲目（--one=${flags.one ?? ""}）`);
  process.exit(1);
}

/** 版心左右缘（对开页镜像：奇数书页 inner 在左）。 */
function contentEdges(style, pageNo) {
  const m = style.page.margin;
  const odd = pageNo % 2 === 1;
  const left = odd ? m.inner : m.outer;
  return { left, right: style.page.w - (odd ? m.outer : m.inner) };
}

/** 成书骨架：曲号 / 标题 / 词曲署名 / 调号拍号 / 页眉 / 页码。
 *  排版引擎只管谱面，这些是整本那一层的事（原书整本一套版式，位置见 style.titleBlock）。 */
function decorate(dp, ctx) {
  const st = style;
  const tb = st.titleBlock;
  const { left, right } = contentEdges(st, dp.pageNo);
  const center = (left + right) / 2;
  const put = (text, role, y, align, x) => {
    if (!text) return;
    const size = ctx.sizes?.[role] ?? st.roles[role].size;
    dp.items.push({ t: "text", y, text, size, role, align, xs: [x], box: { x, w: 0 } });
  };

  // 页眉在装订侧、曲号在切口侧（实测：奇数书页页眉靠左、曲号靠右，偶数页镜像）
  const odd = dp.pageNo % 2 === 1;
  if (st.header.enable && ctx.category) put(ctx.category, "header", tb.headerBaseline, odd ? "left" : "right", odd ? left : right);
  if (st.footer.enable && ctx.label)
    put(st.footer.format.replace("{n}", ctx.label), "footer", tb.footerBaseline, "center", center);

  if (!ctx.first) return;
  put(ctx.id.replace(/^0+(?=\d)/, ""), "songNumber", tb.numberBaseline, odd ? "right" : "left", odd ? right : left);
  put(ctx.title, "title", tb.titleBaseline, "center", center);
  // 调号拍号：原书写作「1=♭B  4/4  (1=A)」，拍号上下叠排、中间一条细横线，
  // 括号里是移调建议。musicxml 只有 fifths/beats，装不下这些，所以走 song_meta
  //（读不到库时退回按 musicxml 推断，只出「1=X」加一个平铺的拍号）。
  if (ctx.km) dp.items.push(...cli.keyMeterItems(st, ctx.km, left + 2.3, tb.keyMeterBaseline, measure, ctx.sizes?.keyMeter));
  // 词曲署名：原书写「作词：X」「作曲：Y」两行，右对齐。
  // 这批 musicxml 的 <creator> 里已经带好了标签、多行写在一个字段里（Finale 导出的样子），
  // 只有没带标签时才按 type 补一个。
  const LABEL = { lyricist: "作词", poet: "作词", composer: "作曲", arranger: "编曲" };
  const credits = (ctx.credits ?? []).flatMap((c) =>
    String(c.text ?? "")
      .split(/\r?\n/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => (/[:：]/.test(t) ? t : `${LABEL[c.type] ?? c.type}：${t}`)),
  );
  credits.forEach((t, i) => put(t, "credit", tb.creditFirstBaseline + i * tb.creditLineGap, "right", right - 8.7));
}

const { port, close } = await serveDist();
const { browser, page, errors } = await launchPage();
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!window.__book);

const pages = [];
const perSong = [];
const failed = [];
const songBlocks = [];
const noKeyMeter = [];

/** 本曲各页里的音符（阅读顺序）。段落词按序号锚在它们身上。 */
function noteItems(dps) {
  const out = [];
  for (const dp of dps) {
    const ns = dp.items.filter((it) => it.t === "text" && it.role === "note" && /^[0-9]$/.test(it.text));
    ns.sort((a, b) => a.y - b.y || a.xs[0] - b.xs[0]);
    for (const n of ns) out.push({ dp, it: n });
  }
  return out;
}

/** 段落词落位：锚点音符的正上方、和弦那一带。 */
let sectionWordSize = style.roles.sectionWord.size;
function placeSectionWords(dps, rows) {
  if (!rows.length) return;
  const notes = noteItems(dps);
  if (!notes.length) return;
  // 字号要按**墨迹比例**反算（浏览器侧实测的那一份），直接拿 roles.size 当字号会小一圈
  const size = sectionWordSize;
  for (const r of rows) {
    const anchor = notes[Math.min(r.note_ordinal, notes.length - 1)];
    if (!anchor) continue;
    // 音符的墨迹上缘：Times 的数字墨迹约占 0.66em（见 browser.ts::fontSizeFor 那套口径）
    const inkTop = anchor.it.y - anchor.it.size * 0.66;
    const y = inkTop - style.metrics.chordToNoteEm * style.roles.note.size;
    const text = r.text;
    const x = anchor.it.xs[0];
    const w = measure("sectionWord", text, size);
    // 和弦占的也是这一带。撞上了就往上抬一行——原书是排版时人工避开的，
    // 重排的断行不一样，撞不撞只能现算。
    const hit = anchor.dp.items.some(
      (it) =>
        it.t === "text" &&
        it.role === "chord" &&
        Math.abs(it.y - y) < size * 0.6 &&
        it.xs[0] < x + w &&
        x < it.xs[it.xs.length - 1] + measure("chord", it.text.slice(-1), it.size),
    );
    if (process.env.DIAG) console.log(`  DIAG 段落词 ${text} y=${y.toFixed(1)} x=${x.toFixed(1)} w=${w.toFixed(1)} 撞和弦=${hit}`);
    anchor.dp.items.push({
      t: "text", y: hit ? y - size * 1.6 : y, text, size, role: "sectionWord", align: "left",
      xs: [x], box: { x, w: 0 },
    });
  }
}
for (const s of picked) {
  const xml = await readFile(s.musicxml, "utf8");
  let res;
  try {
    res = await page.evaluate(
    async ([xmlText, st, id]) => {
      const B = await window.__book;
      /** Score → 每页的 DrawPage[]（含首页给标题块让位的整页平移）。 */
      const renderPages = (score) => {
        const p = new B.JinpuPainter(B.fontSizeFor(st, "lyric"));
        B.applyBookStyle(p.layout.options, st);
        // SMuFL 元数据（延长号、跳转记号的包围盒）不注入的话，layout 会抛 "no smufl bbox"。
        // 页面里已经加载过一份，直接借用（App 的构造参数就是它）。
        p.layout.options.smuflMeta = window.__app.meta;
        p.score = score;
        p.resize(st.page.w, st.page.h, null);
        const out = [];
        // 第 0 页是排版器给单曲加的独立标题页，成书里不要
        for (let i = 1; i < p.pageCount; i++) {
          const mk = (dy) =>
            B.pageItemsToDrawPage(p.layout.pages[i], st.page.w, st.page.h, {
              style: st,
              options: p.layout.options,
              pageNo: out.length + 1,
              offset: { x: 0, y: dy },
              meta: { kind: "score", songs: [{ id, title: score.title, first: out.length === 0 }] },
            });
          // 先排一遍量出首行音符的墨迹上缘，再整页平移，让它落到原书那条线上
          //（首页要给标题块让位，续页顶到版心）。平移在页内做：路径坐标已经烘进 d 了。
          const probe = mk(0);
          const noteTop = Math.min(
            ...probe.items.filter((t) => t.t === "text" && t.role === "note").map((t) => t.y - t.size),
          );
          const want = out.length === 0 ? st.titleBlock.firstSystemTop : st.titleBlock.contSystemTop;
          out.push(Number.isFinite(noteTop) ? mk(want - noteTop) : probe);
        }
        return out;
      };
      // 乐句排版 + 版面：**迭代到不再被二次折行为止**。
      //
      // 乐句分析按「格数」定行长，排版器按**像素宽度**折行，两者只是近似对应
      //（歌词字数、长音、和弦都会让同样的格数占不同的宽度）。
      // 一旦排版器在断点之外又折了一刀，行尾就会甩出两三个音的尾巴
      //（实测 006 一行塞满 + 一行只剩 "3 2 1--"）。
      // 所以排完数一下谱行数：多出来就把格数收紧再排，最多四轮。
      let cells = B.measureCellsPerLine(B.loadMusicXml(xmlText), st, window.__app.meta);
      let score = null;
      let pageItems = null;
      for (let iter = 0; iter < 4; iter++) {
        score = B.loadMusicXml(xmlText);
        let expect = 1;
        if (st.layout.phrase && score.parts[0]) {
          score.clearSystemBreak();
          const brk = B.computePhraseBreaks(score.parts[0], {
            targetMeas: st.layout.phraseTargetMeas,
            lenWeight: st.layout.phraseLenWeight,
            breakWeight: st.layout.phraseBreakWeight,
            maxCells: cells,
            maxSentenceCells: cells,
          });
          B.enforceLineCapacity(score.parts[0], brk, cells, st.layout.phraseTargetMeas);
          const ab = B.applyPhraseBreaks(score.parts[0], brk, {
            linesPerPage: st.layout.linesPerPage,
            useMidBreaks: st.layout.phraseMidBreak,
          });
          expect = ab.lines + 1;
        }
        pageItems = renderPages(score);
        if (!st.layout.phrase || B.countStaffRows(pageItems) <= expect || cells <= 8) break;
        cells = Math.max(8, cells - 2);
      }
      const out = pageItems;
      // 装饰层（标题/曲号/页眉页脚）在 Node 侧排，但字号得按**浏览器实测的墨迹比例**反算，
      // 否则同一个 size 在不同字体里墨迹大小不一样（见 browser.ts::fontSizeFor）。
      const sizes = {};
      for (const r of ["title", "songNumber", "category", "credit", "keyMeter", "header", "footer", "sectionWord", "story", "toc", "tocHeading", "tocSub", "frontTitle"]) sizes[r] = B.fontSizeFor(st, r);
      // creator 是 Map<type, text>（musicxml 的 <creator type="composer">…）
      const cr = score.creator instanceof Map ? [...score.creator] : Object.entries(score.creator ?? {});
      return { pages: out, title: score.title, credits: cr.map(([type, text]) => ({ type, text })), sizes };
    },
      [xml, style, s.id],
    );
  } catch (e) {
    // 一首排不出来不该炸整本：记账、跳过、继续
    failed.push({ id: s.id, title: s.title, error: String(e?.message ?? e).split("\n")[0] });
    console.log(`  ✗ ${s.id} ${s.title}：${failed[failed.length - 1].error}`);
    continue;
  }
  // 调号拍号优先用原书原文（song_meta），读不到库时退回 musicxml 推断
  const dbKm = meta.song.get(s.id);
  const gt = dbKm ? null : gtKeyTime(xml);
  const km = dbKm
    ? { tonic: dbKm.tonic, beats: dbKm.beats, beatType: dbKm.beat_type, altTonic: dbKm.alt_tonic }
    : gt && gt.beats
      ? { tonic: gt.key, beats: gt.beats, beatType: gt.beatType, altTonic: null }
      : null;
  if (!km) noKeyMeter.push(s.id);
  // 段落词：原书印在和弦带里，锚在第 n 个音符上（gen-bookmeta 记的 note_ordinal）。
  // 排版引擎不认这东西，所以在整本这一层按音符落位摆——**不动 layout.ts**。
  if (res.sizes?.sectionWord) sectionWordSize = res.sizes.sectionWord;
  placeSectionWords(res.pages, meta.section.get(s.id) ?? []);
  songBlocks.push({
    id: s.id,
    title: res.title,
    pages: res.pages,
    ctx: { sizes: res.sizes, id: s.id, title: res.title, credits: res.credits, category: s.category ?? "", km },
  });
  perSong.push({ id: s.id, title: res.title, pages: res.pages.length });
  if (only || picked.length < 30) console.log(`  ${s.id} ${res.title}：${res.pages.length} 页`);
}

await browser.close();
await close();
if (errors.length) console.log(`⚠ 控制台错误 ${errors.length}：`, errors.slice(0, 3));

// ────────────────────────────────────────────────────────── 装订
//
// 页码分两套，照原书：**前置页（前言 + 目录）自成一套**，乐谱页从 1 重新起，
// 后附的索引接着乐谱页往下数（实测原书 PDF 638 页印的是 606）。
// 所以目录里的曲目页码**不随目录页数变化**，两遍法一轮就收敛——
// 但循环还是留着（上限 3 轮）并记账，免得改了页码规则之后没人发现不收敛了。

const scorePages = songBlocks.flatMap((b) => b.pages);
// 版心下界：按页脚基线往上留 1.6 个字，不用 footer.band（那是页脚出现过的 y 范围下沿，
// 比可用高度保守 30pt——原书的花边框压到 535，band 才 518）。
const footerTop = style.titleBlock.footerBaseline - style.roles.footer.size * 1.6;

/** 一页上内容的最低处（注解要摆在它下面）。路径类算不出包围盒，
 *  按文字与矩形算——最低的本来就是末条歌词。 */
function contentBottom(dp) {
  let y = 0;
  for (const it of dp.items) {
    if (it.t === "text") y = Math.max(y, it.y + it.size * 0.25);
    else if (it.t === "rect") y = Math.max(y, it.y + it.h);
    else if (it.t === "line") y = Math.max(y, Math.max(it.y1, it.y2));
  }
  return y;
}

/** 注解（圣诗故事 / 经文）：本曲末页有空就排，放不下顺延到之后第一处放得下的页。 */
function placeAnnotations() {
  const endsOn = new Map(); // 页 → 在这一页收尾的曲目
  for (const b of songBlocks) {
    const last = b.pages[b.pages.length - 1];
    if (!endsOn.has(last)) endsOn.set(last, []);
    endsOn.get(last).push(b.id);
  }
  const queue = [];
  let placed = 0;
  for (const dp of scorePages) {
    for (const id of endsOn.get(dp) ?? []) for (const a of meta.annotation.get(id) ?? []) queue.push(a);
    if (!queue.length) continue;
    const m = pageEdges(dp.pageNo);
    let free = footerTop - contentBottom(dp);
    while (queue.length) {
      const a = queue[0];
      const top = footerTop - free;
      // **按剩余空间缩字号**：原书也是这么干的（同一批花边框里字号从 6.5 到 10.5 都有，
      // 谱行占得多的那页就把故事压小）。从本书的中位字号往下试到 6.5pt 为止，
      // 行距按比例跟着缩；再放不下就顺延到后面的页。
      let block = null;
      // 下限 6.0：原书最小的一框是 6.5pt，重排的谱面偶尔比原书占得高一点点
      // （010 差了 17pt），再留半档才放得下。
      for (let sz = style.roles.story.size; sz >= 6.0; sz -= 0.25) {
        const b = cli.annotationBlock(style, {
          text: a.text,
          framed: !!a.framed,
          left: m.left,
          right: m.right,
          top,
          lineGap: sz * annGapRatio,
          tiles: meta.tiles,
          measure,
          size: sz,
        });
        if (b.height <= free) {
          block = b;
          break;
        }
      }
      if (!block && process.env.DIAG) console.log(`  DIAG 注解 ${a.song_no} 排不下：可用 ${free.toFixed(1)}，行距比 ${annGapRatio}`);
      if (!block) break;
      dp.items.push(...block.items);
      free -= block.height + style.roles.story.size;
      queue.shift();
      placed++;
    }
  }
  return { placed, left: queue.length };
}

function pageEdges(pageNo) {
  const m = style.page.margin;
  const odd = pageNo % 2 === 1;
  return { left: odd ? m.inner : m.outer, right: style.page.w - (odd ? m.outer : m.inner) };
}

/** 目录条目：**按曲目表生成**（原书目录里有一批曲号没读出来，照抄会缺条），
 *  原书目录只提供顺序里的分类标题落在哪个曲号之前。 */
function tocItems(pageOfSong) {
  const norm = (t) => String(t ?? "").replace(/[\s（）()]/g, "");
  // 一级分类标题**按名字挂到该分类的第一首**（album.txt 有权威的分类区间）。
  // 不能一律「挂到下一个条目的曲号」：原书附录那几页把经文短歌重新从 1 编号，
  // 「附录」「短歌」会跟着挂到 001 上，三个标题一起堆在目录开头（实测就是这样）。
  const firstOfCat = new Map();
  for (const c of categories) {
    const first = [...songBlocks].sort((x, y) => songRank(x.id) - songRank(y.id)).find((b) => songs.get(b.id)?.category === c.name);
    if (first) firstOfCat.set(norm(c.name), first.id);
  }
  const headings = new Map(); // 曲号 → 落在它前面的标题
  const add = (id, h) => headings.set(id, (headings.get(id) ?? []).concat([h]));
  let pend = [];
  let lastRank = -1;
  for (const r of meta.toc) {
    if (r.kind !== "entry") {
      const cat = firstOfCat.get(norm(r.text));
      if (r.kind === "category" && cat) add(cat, { kind: "category", text: r.text });
      else pend.push({ kind: r.kind, text: r.text });
      continue;
    }
    if (!r.song_no) continue;
    const rank = songRank(r.song_no);
    // 曲号回退说明进了附录那一套重编号，之前攒着的标题就别硬挂了（记账丢掉）
    if (rank < lastRank) pend = [];
    lastRank = rank;
    if (pend.length) {
      for (const h of pend) add(r.song_no, h);
      pend = [];
    }
  }
  const out = [];
  for (const b of [...songBlocks].sort((x, y) => songRank(x.id) - songRank(y.id))) {
    for (const h of headings.get(b.id) ?? []) out.push(h);
    out.push({ kind: "entry", songNo: b.id, title: b.title ?? "", page: pageOfSong.get(b.id) ?? 0 });
  }
  return out;
}

/** 索引条目：顺序与分节标题照原书，条目内容从语料取
 *  （诗题索引取曲名、首句索引取第一段歌词首句），长度按原书那一条截。 */
function indexItems(name, firstLines) {
  const out = [];
  for (const r of meta.index) {
    if (r.index_name !== name) continue;
    if (r.kind === "heading") {
      out.push({ kind: "heading", text: r.text, songNo: null });
      continue;
    }
    const b = songBlocks.find((x) => x.id === r.song_no);
    let text = r.text;
    if (b) {
      const want = name === "title" ? b.title : (firstLines.get(b.id) ?? b.title);
      // 首句取法与原书不一定一样（原书截得比较狠），所以按原书那一条的字数封顶
      if (want) text = [...want].length > [...r.text].length + 2 ? [...want].slice(0, [...r.text].length).join("") : want;
    }
    out.push({ kind: "entry", text, songNo: r.song_no });
  }
  return out;
}

const firstLines = new Map();
for (const b of songBlocks) {
  // 首句 = 第一段歌词的头一行。用排版结果里的歌词item 反推最省事：
  // 第一页第一条歌词行就是首句（叠排时段号在最前，去掉）。
  const first = b.pages[0]?.items
    .filter((it) => it.t === "text" && it.role === "lyric")
    .sort((a, c) => a.y - c.y || a.xs[0] - c.xs[0])[0];
  if (first) firstLines.set(b.id, String(first.text).replace(/^\d+[.、]?/, "").trim());
}

let rounds = 0;
let pageOfSong = new Map();
let front = [];
let back = [];
for (let iter = 0; iter < 3; iter++) {
  rounds = iter + 1;
  // 乐谱页的印刷页码：从 1 起，一页一号
  const next = new Map();
  scorePages.forEach((dp, i) => {
    dp.label = String(i + 1);
    for (const b of songBlocks) if (b.pages[0] === dp) next.set(b.id, i + 1);
  });
  const same = next.size === pageOfSong.size && [...next].every(([k, v]) => pageOfSong.get(k) === v);
  pageOfSong = next;
  if (same && iter) break;
  // 单曲试排（--one）默认不出前置页与索引：那几十页会把要看的那一页埋掉。
  // 要连书级内容一起看就加 --parts。
  if (only && !("parts" in flags)) {
    front = [];
    back = [];
    break;
  }
  // 前置页：前言（主祷文/使徒信经）→ 目录 →（附录扉页跟在目录后，原书就印在目录页之间）
  const prose = meta.front.filter((f) => f.kind === "prose").map((f) => ({ kind: "prose", title: f.title, body: f.body }));
  const dividers = meta.front.filter((f) => f.kind === "divider").map((f) => ({ kind: "divider", title: f.title, body: "" }));
  front = cli.frontPages(style, prose, { startPageNo: 1, measure });
  const toc = meta.toc.length ? cli.tocPages(style, tocItems(pageOfSong), { startPageNo: front.length + 1, measure, title: "目录" }) : [];
  front = [...front, ...toc, ...cli.frontPages(style, dividers, { startPageNo: front.length + toc.length + 1, measure })];
  // 后附索引：接着乐谱页往下编号
  back = [];
  for (const [name, title] of [["title", "诗题笔划索引"], ["firstline", "歌词首句索引"]]) {
    const items = indexItems(name, firstLines);
    if (items.length) back.push(...cli.indexPages(style, items, { startPageNo: 1, measure, title }));
  }
  if (same) break;
}

// 物理页号（决定对开镜像）与印刷页码（页脚印的那个数）
front.forEach((dp, i) => {
  dp.pageNo = i + 1;
  dp.label = String(i + 1);
});
scorePages.forEach((dp, i) => {
  dp.pageNo = front.length + i + 1;
  dp.label = String(i + 1);
});
back.forEach((dp, i) => {
  dp.pageNo = front.length + scorePages.length + i + 1;
  dp.label = String(scorePages.length + i + 1);
});

// 注解要等页号定下来再排：版心左右缘按页奇偶换边
const ann = placeAnnotations();

// 装饰层（标题/曲号/署名/页眉页码）等页号定下来再加——页眉与曲号要按奇偶换边
for (const b of songBlocks)
  b.pages.forEach((dp, i) => decorate(dp, { ...b.ctx, first: i === 0, label: dp.label }));
for (const dp of [...front, ...back]) decorate(dp, { first: false, label: dp.label, category: "" });

pages.push(...front, ...scorePages, ...back);
console.log(
  `装订：前置 ${front.length} 页（前言 ${meta.front.filter((f) => f.kind === "prose").length} + 目录）、` +
    `乐谱 ${scorePages.length} 页、索引 ${back.length} 页；目录两遍法 ${rounds} 轮`,
);
console.log(`注解排入 ${ann.placed}/${[...meta.annotation.values()].flat().length}${ann.left ? `，放不下 ${ann.left} 条` : ""}` +
  (noKeyMeter.length ? `；没有调号拍号的 ${noKeyMeter.length} 首：${noKeyMeter.slice(0, 5).join(" ")}` : ""));

await mkdir(OUTDIR, { recursive: true });
const name = flags.name ?? (only ? `rebuild-${only.join("-")}.pdf` : "诗歌500首-重排版.pdf");
const out = `${OUTDIR}/${name}`;
const r = await writePdf({ style, source: "rebuild", pages }, { out, title: "诗歌500首（重排版）" });
await writeFile(`${OUTDIR}/rebuild-drawlist.json`, JSON.stringify({ style: style.id, songs: perSong, pages }, null, 0));
console.log(`重排版 PDF → ${out}（${r.pages} 页，${(r.bytes / 1048576).toFixed(2)} MB，缺字 ${r.missing.length}）`);
console.log(`曲目 ${perSong.length}/${picked.length}${failed.length ? `，失败 ${failed.length}：${failed.slice(0, 5).map((f) => f.id).join(" ")}` : ""}`);
await writeFile(`${OUTDIR}/rebuild.csv`, "\ufeff曲号,曲名,页数\n" + perSong.map((s) => `${s.id},"${(s.title ?? "").replace(/"/g, "\"\"")}",${s.pages}`).join("\n"));
if ("db" in flags) {
  const { newRunId, recordRun, recordMetrics } = await import("./scripts/checkdb.mjs");
  const db = openDb();
  const runId = newRunId("rebuild");
  recordRun(db, { run_id: runId, route: "rebuild", config: style.id, artifact: out, page_count: r.pages, byte_size: r.bytes, cmd: "rebuild.mjs" });
  recordMetrics(db, runId, {
    pages: r.pages, songs: perSong.length, front_pages: front.length, index_pages: back.length,
    annotations_placed: ann.placed, annotations_left: ann.left, font_missing: r.missing.length,
    key_meter_missing: noKeyMeter.length, section_words: [...meta.section.values()].flat().length,
  });
  db.close();
  console.log(`→ 校对.db：批次 ${runId}`);
}
if (r.missing.length) console.log("  缺字明细:", JSON.stringify(r.missing.slice(0, 6)));
if (r.fallbacks.length) console.log("  字体回退:", r.fallbacks.slice(0, 6).map((f) => `${f.ch}:${f.from}→${f.to}`).join(" "));
