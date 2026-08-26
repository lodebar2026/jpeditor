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

/** 页眉排两行时的行距 ÷ 页眉墨迹高。原书 p382 实测：两行的墨迹顶差 13.9pt、墨迹高 8.9。 */
const HEADER_LINE_GAP = 1.56;

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
  // 页眉的分类名**长的排两行**：原书「信徒生活（灵交）」印成「信徒生活 / （灵交）」两行
  //（p382 那个页眉框高 22.4pt，正好两行）。括号那一截另起一行，两行都靠装订侧对齐。
  if (st.header.enable && ctx.category) {
    const hx = odd ? left : right;
    const align = odd ? "left" : "right";
    // 括号是**语料里的写法**，原书页眉印的是「信徒生活 / 灵交」两行、没有括号
    const two = /^(.+?)[（(](.+?)[）)]$/.exec(ctx.category);
    if (two) {
      put(two[1], "header", tb.headerBaseline, align, hx);
      put(two[2], "header", tb.headerBaseline + st.roles.header.size * HEADER_LINE_GAP, align, hx);
    } else {
      put(ctx.category, "header", tb.headerBaseline, align, hx);
    }
  }
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
const perLines = [];
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

/** 段落词的字号（浏览器侧按墨迹比例反算的那一份，随第一首返回值更新）。 */
let sectionWordSize = style.roles.sectionWord.size;

for (const s of picked) {
  const xml = await readFile(s.musicxml, "utf8");
  let res;
  try {
    res = await page.evaluate(
    async ([xmlText, st, id, sectionRows]) => {
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
      /** 段落词注入：按「第几个音符」挂到 Chord 上，排版引擎自己去摆（Line.addSectionWords）。
       *  整本那一层只管书级装饰，音符数据区的东西不在那里落位。 */
      const putSectionWords = (score) => {
        if (!sectionRows.length) return;
        const chords = [];
        for (const m of score.parts[0].measures) for (const e of m.entries) if (e.notes) chords.push(e);
        // 副歌那一条**优先挂到副歌真正的起句**上：`note_ordinal` 是按原书的音符序号记的，
        // 重排后（断行不同、反复展开方式不同）常常差着几个音，023 首就落在了副歌前一行。
        // Score 里副歌歌词带 `refrain` 标记（只有一段、各主歌共用的那些），拿它定位最稳。
        const refrainAt = chords.findIndex((c) =>
          (c.notes?.[0]?.lyrics ?? []).some((l) => l.refrain && l.text),
        );
        for (const r of sectionRows) {
          const at = /副歌/.test(r.text) && refrainAt >= 0 ? refrainAt : Math.min(r.note_ordinal, chords.length - 1);
          const c = chords[at];
          if (c) c.sectionWord = r.text;
        }
      };
      let cells = B.measureCellsPerLine(B.loadMusicXml(xmlText), st, window.__app.meta);
      let score = null;
      let pageItems = null;
      let expectLines = 1;
      let iters = 0;
      let lineInfo = [];
      let targetUsed = 0;
      let mode = "phrase";
      let jumpSeen = [];
      for (let iter = 0; iter < 6; iter++) {
        iters = iter + 1;
        score = B.loadMusicXml(xmlText);
        putSectionWords(score);
        let expect = 1;
        if (st.layout.phrase && score.parts[0]) {
          score.clearSystemBreak();
          // 行长目标：0 = 按版心容量折算（成书默认）。固定的小节数要靠「两两并短行」去凑满
          // 版心，而并行只能成对，段里落单的那一行就并不进去（377 副歌一行 12 小节、下一行 6）。
          const targetMeas = st.layout.phraseTargetMeas > 0
            ? st.layout.phraseTargetMeas
            : B.targetMeasForCells(score.parts[0], cells);
          targetUsed = targetMeas;
          // 跳转记号（Fine / D.C. / D.S. / To Coda）所在的小节：那里要**高优先级断开**
          //（096 的 Fine 落在主歌多段歌词中间）。它们只存在 playData 里，排版层拿不到。
          // **只取记号本身**（`jumpTo`：Fine / D.C. / D.S. / To Coda）。
          // `segno` / `coda` 是跳转的**目标**，不是唱到这儿要换行的地方——把它们也算进来，
          // 497《这世界非我家》就被强断成 7 行、其中一行只剩 2 格。
          const jumpMeasures = new Set();
          for (const [t] of score.playData?.jumpTo ?? []) jumpMeasures.add(t.mid);
          jumpSeen = [...jumpMeasures]; // 记账：跑完在 fit.jump 里，出了问题好查
          const brk = B.computePhraseBreaks(score.parts[0], {
            targetMeas,
            lenWeight: st.layout.phraseLenWeight,
            breakWeight: st.layout.phraseBreakWeight,
            // **断句只看内容**：与纸张有关的分（行长目标、行数、稀疏）一律不算，
            // 「排不排得下」只在下面的模式阶梯里用。见 phrase.ts::PhraseOptions.contentOnly。
            contentOnly: st.layout.phraseContentOnly !== false,
            jumpMeasures,
            parallelWeight: st.layout.phraseParallelWeight ?? 6,
            // 成书专用的两条权重（编辑器那条路默认不开，基线不动）：
            // 短呼语句（「哈利路亚！」）的句末标点减半、重复段按长度加分。
            shortSentenceWords: 5,
            repeatLenBonus: true,
            // 摊匀行长（跑两遍 DP，见 phrase.ts）：原书每一行都差不多长，
            // 只按容量排会一行顶格、一行半幅（051 的 12/14/24 格）。
            evenWeight: st.layout.phraseEvenWeight ?? 0,
            // 别把一句话的最后一小截甩到下一行开头（419「却成了祝福。」）
            tailWeight: st.layout.phraseTailWeight ?? 0,
            maxCells: cells,
            maxSentenceCells: cells,
            // 容量是排版器**数出来的个数**（音符与增时线各算一个），不是折算过的格数
            cellsAreItems: true,
          });
              // **整首的排版模式阶梯**（B 每 2 句一行 → A 一句一行 → C 均匀排版）：
          // 「排不排得下」只在这里用，断句本身不看纸张。见 applybreaks.ts::chooseLineLayout。
          mode = B.chooseLineLayout(score.parts[0], brk, cells, {
            useMidBreaks: st.layout.phraseMidBreak,
            allowPairs: st.layout.phraseMergeShort !== false,
          });
          // 容量保险：C 档之外的两档也可能有个别行超容量（格数是近似），按小节补刀
          B.enforceLineCapacity(score.parts[0], brk, cells, targetMeas, st.layout.phraseMidBreak);
          // 上面几步会造出新的行首（DP 管不到），再兜两次：行首不留半小节休止、
          // 按容量补刀留下的碎行并回上一行（见 applybreaks.ts 两个函数的注释）。
          B.tidyLineHeads(score.parts[0], brk, { useMidBreaks: st.layout.phraseMidBreak, cells });
          B.mergeSliverLines(score.parts[0], brk, st.layout.phraseMidBreak, cells);
          // 逐行事实（行首残小节 / 行末标点 / 格数…）留给 line-check.mjs 断言；
          // Chord 是对象，跨不过 page.evaluate 的序列化，只带纯数据出去。
          lineInfo = B.describeLines(score.parts[0], brk, st.layout.phraseMidBreak).map((l) => ({
            cells: l.cells, fromMi: l.fromMi, toMi: l.toMi, bars: l.bars, beats: l.beats,
            head: { ...l.head }, tail: { ...l.tail }, headFp: l.headFp, section: l.section, mid: !!l.chord,
          }));
          const ab = B.applyPhraseBreaks(score.parts[0], brk, {
            linesPerPage: st.layout.linesPerPage,
            useMidBreaks: st.layout.phraseMidBreak,
          });
          expect = ab.lines + 1;
        }
        expectLines = expect;
        pageItems = renderPages(score);
        const rows = B.countStaffRows(pageItems);
        if (!st.layout.phrase || rows <= expect || cells <= 8) break;
        // 收紧格数：**按折完之后最长的那条行**来定。按 rows/expect 的比例算会一步收过头——
        // 一条线只要溢出一格也会折成两行，比例就成了 2 倍，022《凡有气息当赞美》因此从
        // 30 格收到 15 格、排成 10 行（原书 6 行）。折出来的最长行才是这一首真的放得下多少。
        const fitCells = B.maxStaffRowCells(pageItems);
        cells = Math.max(8, Math.min(cells - 1, fitCells > 0 ? fitCells : cells - 1));
      }
      const out = pageItems;
      // 排版口径的自检：迭代了几轮、最后还有没有「断点之外又折一刀」（见下面的汇总打印）
      const fit = { iters, cells, target: targetUsed, mode, jump: jumpSeen, overflow: st.layout.phrase ? Math.max(0, B.countStaffRows(pageItems) - expectLines) : 0 };
      // 装饰层（标题/曲号/页眉页脚）在 Node 侧排，但字号得按**浏览器实测的墨迹比例**反算，
      // 否则同一个 size 在不同字体里墨迹大小不一样（见 browser.ts::fontSizeFor）。
      const sizes = {};
      for (const r of ["title", "songNumber", "category", "credit", "keyMeter", "header", "footer", "sectionWord", "story", "toc", "tocHeading", "tocSub", "frontTitle"]) sizes[r] = B.fontSizeFor(st, r);
      // creator 是 Map<type, text>（musicxml 的 <creator type="composer">…）
      const cr = score.creator instanceof Map ? [...score.creator] : Object.entries(score.creator ?? {});
      return { pages: out, title: score.title, credits: cr.map(([type, text]) => ({ type, text })), sizes, fit, lines: lineInfo };
    },
      [xml, style, s.id, meta.section.get(s.id) ?? []],
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
  songBlocks.push({
    id: s.id,
    title: res.title,
    pages: res.pages,
    ctx: { sizes: res.sizes, id: s.id, title: res.title, credits: res.credits, category: s.category ?? "", km },
  });
  perSong.push({ id: s.id, title: res.title, pages: res.pages.length, fit: res.fit });
  perLines.push({ id: s.id, title: res.title, cells: res.fit?.cells ?? 0, target: res.fit?.target ?? 0, mode: res.fit?.mode ?? "", lines: res.lines ?? [] });
  if (only || picked.length < 30) console.log(`  ${s.id} ${res.title}：${res.pages.length} 页`);
}

// 排版口径自检：容量（格数）只是像素宽度的近似，量偏了排版器就会在断点之外又折一刀。
// 迭代（先松并短行的余量、再收紧格数）能兜住，这里把兜的次数与没兜住的曲子亮出来。
{
  const fits = perSong.map((p) => p.fit).filter(Boolean);
  const retried = fits.filter((f) => f.iters > 1).length;
  const over = perSong.filter((p) => p.fit?.overflow > 0);
  const byMode = {};
  for (const f of fits) byMode[f.mode ?? "?"] = (byMode[f.mode ?? "?"] ?? 0) + 1;
  console.log(`排版模式：${Object.entries(byMode).map(([k, v]) => `${k} ${v}`).join("，")}`);
  console.log(`排版口径：${fits.length} 首中 ${retried} 首要重排（容量量偏了），仍有二次折行 ${over.length} 首` +
    (over.length ? `：${over.slice(0, 8).map((p) => `${p.id}(+${p.fit.overflow})`).join(" ")}` : ""));
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
          // 022/023 那种双细线矩形框：几何用 gen-bookmeta 实测的外圈/内圈/空隙
          frame: a.frame_kind ?? (a.framed ? "tile" : "none"),
          frameOuter: a.frame_outer || undefined,
          frameInner: a.frame_inner || undefined,
          frameGap: a.frame_gap || undefined,
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
  // 各角色的字号（浏览器侧按墨迹比例反算过的）。每首返回的都一样，取第一首即可；
  // 一首都没排出来时退回 roles[*].size（bookparts 内部有同样的兜底）。
  const roleSizes = songBlocks[0]?.ctx?.sizes ?? {};
  const toc = meta.toc.length ? cli.tocPages(style, tocItems(pageOfSong), { startPageNo: front.length + 1, measure, title: "目录", sizes: roleSizes }) : [];
  front = [...front, ...toc, ...cli.frontPages(style, dividers, { startPageNo: front.length + toc.length + 1, measure })];
  // 后附索引：接着乐谱页往下编号
  back = [];
  for (const [name, title] of [["title", "诗题笔划索引"], ["firstline", "歌词首句索引"]]) {
    const items = indexItems(name, firstLines);
    if (items.length) back.push(...cli.indexPages(style, items, { startPageNo: 1, measure, title, sizes: roleSizes }));
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

// **对开页镜像**：排版引擎一律从 margin.inner 起排（它只知道一个版心宽度），
// 偶数页因此整体偏右 inner − outer，装订侧边距就窄了那么多。页号定下来了才知道奇偶，
// 所以在这里搬（见 drawlist.ts::shiftDrawPageX——那时路径坐标已经烘进 d 里了）。
// 装饰层还没加，它本来就是按页号镜像摆的，不受影响。
{
  const mirror = style.page.margin.inner - style.page.margin.outer;
  if (mirror) for (const dp of scorePages) if (dp.pageNo % 2 === 0) cli.shiftDrawPageX(dp, -mirror);
}

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
// 逐行事实：line-check.mjs 的底本（版面判据的常驻断言，见那个脚本）
await writeFile(`${OUTDIR}/rebuild-lines.json`, JSON.stringify({ style: style.id, songs: perLines }, null, 0));
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
