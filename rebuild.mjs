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
const meta = { song: new Map(), section: new Map(), annotation: new Map(), toc: [], index: [], front: [], tiles: [], tilesByStyle: new Map() };
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
    for (const t of meta.tiles) {
      const a = meta.tilesByStyle.get(t.style_id) ?? [];
      a.push({ slot: t.slot, w: t.w, h: t.h, pitch: t.pitch, ox: t.ox ?? 0, oy: t.oy ?? 0, path: t.path });
      meta.tilesByStyle.set(t.style_id, a);
    }
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

/** 调号拍号整体上抬多少（pt）。原书实测的基线紧挨着第一条谱行，而首行音符上方还有和弦。 */
const KEYMETER_LIFT = 5;
/** 抬完之后与首行和弦/音符之间至少留这么多（pt）。 */
const KEYMETER_GAP = 1.5;

/** 页的装饰：页眉与页码。**一页一次**——半页起排时一页上有两首，
 *  跟着曲子走的东西（曲号/标题/署名/调号拍号）在 decorateSong 里，这里只管页自己的。 */
function decoratePage(dp, ctx) {
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
}

/** 曲的装饰：曲号 / 标题 / 调号拍号 / 词曲署名。**每首一次**，只在本曲起始的那一页。
 *  `ctx.dy` 是半页起排的整体下移量（页顶起排为 0）——标题块的四条基线都跟着走，
 *  页眉页码不动（那是页的属性，不是曲的）。 */
function decorateSong(dp, ctx) {
  const st = style;
  const tb = st.titleBlock;
  const { left, right } = contentEdges(st, dp.pageNo);
  const center = (left + right) / 2;
  const odd = dp.pageNo % 2 === 1;
  const dy = ctx.dy ?? 0;
  const put = (text, role, y, align, x) => {
    if (!text) return;
    const size = ctx.sizes?.[role] ?? st.roles[role].size;
    dp.items.push({ t: "text", y, text, size, role, align, xs: [x], box: { x, w: 0 } });
  };

  put(ctx.id.replace(/^0+(?=\d)/, ""), "songNumber", tb.numberBaseline + dy, odd ? "right" : "left", odd ? right : left);
  put(ctx.title, "title", tb.titleBaseline + dy, "center", center);
  // 调号拍号：原书写作「1=♭B  4/4  (1=A)」，拍号上下叠排、中间一条细横线，
  // 括号里是移调建议。musicxml 只有 fifths/beats，装不下这些，所以走 song_meta
  //（读不到库时退回按 musicxml 推断，只出「1=X」加一个平铺的拍号）。
  if (ctx.km) {
    // **整体往上抬一点**（用户口径）：原书实测的 `keyMeterBaseline` 下面紧接着就是第一条
    // 谱行，而拍号是**上下叠排**的（分母还在基线下方 0.98 个墨迹高），首行音符上方又挂着
    // 和弦——271《切慕见祢》的分母 `4` 就压在和弦 `Bm` 上（实测 2.9pt）。
    // 先按常量抬 `KEYMETER_LIFT`，再按**这一首**首行的和弦/音符墨迹顶兜底：
    // 抬完仍压着就继续抬到让开为止（首页左上角那一片除了曲号只有它，抬得动）。
    const base = tb.keyMeterBaseline + dy - KEYMETER_LIFT;
    const items = cli.keyMeterItems(st, ctx.km, left + 2.3, base, measure, ctx.sizes?.keyMeter);
    const boxOf = (it) => {
      const x0 = it.t === "rect" ? it.x : (it.xs?.[0] ?? it.box?.x ?? 0);
      const w = it.t === "rect" ? it.w : measure(it.role, it.text, it.size);
      const top = it.t === "rect" ? it.y : it.y - it.size * 0.72;
      const bot = it.t === "rect" ? it.y + it.h : it.y;
      return { x0, x1: x0 + w, top, bot };
    };
    const kmBoxes = items.map(boxOf);
    const kmBot = Math.max(...kmBoxes.map((b) => b.bot));
    let need = 0;
    for (const it of dp.items) {
      if (it.t !== "text" || (it.role !== "chord" && it.role !== "note")) continue;
      const x0 = it.xs?.[0] ?? 0;
      const x1 = x0 + measure(it.role, it.text, it.size);
      const top = it.y - it.size * 0.72;
      if (top > kmBot || !kmBoxes.some((b) => b.x1 > x0 && b.x0 < x1 && b.bot > top)) continue;
      need = Math.max(need, kmBot - top + KEYMETER_GAP);
    }
    for (const it of items) it.y -= need;
    dp.items.push(...items);
  }
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
  credits.forEach((t, i) => put(t, "credit", tb.creditFirstBaseline + dy + i * tb.creditLineGap, "right", right - 8.7));
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

/** 浏览器里的排版主体。**整本那一层调它两次**：一次按整页高（delta = 0）看这首占几页，
 *  半页起排时再按 `h − delta` 排一次（见 packSong）。 */
const RENDER_SONG = async ([xmlText, st, id, sectionRows, delta, compact]) => {
      const B = await window.__book;
      /** 这一首**自然叠起来有多高**（各谱行高之和 + 行间最小净距），
       *  给整本那一层的装箱器当「半页起排放不放得下」的预判用——
       *  排完之后再量已经晚了（layoutVertically 会把行撑满页高，量到的是页高不是内容高）。 */
      let naturalH = 0;
      /** Score → 每页的 DrawPage[]（含首页给标题块让位的整页平移）。
       *
       *  `delta` = **半页起排**的整体下移量：页高按 `h − delta` 排（分页与撑行都跟着缩），
       *  排完整页下移 delta。页顶起排时 delta = 0，与老行为逐位一致。 */
      const renderPages = (score) => {
        const p = new B.JinpuPainter(B.fontSizeFor(st, "lyric"));
        B.applyBookStyle(p.layout.options, st);
        // SMuFL 元数据（延长号、跳转记号的包围盒）不注入的话，layout 会抛 "no smufl bbox"。
        // 页面里已经加载过一份，直接借用（App 的构造参数就是它）。
        p.layout.options.smuflMeta = window.__app.meta;
        p.score = score;
        p.resize(st.page.w, st.page.h - delta, null);
        // 第 1 页（第 0 页是排版器自带的标题页）的自然高：谱行高之和 + (n−1) 道最小行距
        const measureNatural = () => {
          const pg = p.layout.pages[1];
          const rows = pg ? pg.children : [];
          return rows.reduce((a, c) => a + c.height, 0) + Math.max(0, rows.length - 1) * p.layout.options.staffDist;
        };
        naturalH = measureNatural();
        // **紧排**（一页两首时用）：layoutVertically 会把谱行撑满页高（行距上限 maxLineDist），
        // 整页只有一首时那样最好看，但两首同页就摊不开了——把页高改成「内容自然高」再排一遍，
        // 行距就落到下限 staffDist，这一首只占它真正需要的那么高（原书两首同页正是这个样子）。
        if (compact) {
          const opt = p.layout.options;
          p.resize(st.page.w, opt.marginTop + naturalH + 0.5 + opt.marginBottom, null);
          naturalH = measureNatural();
        }
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
          // **平移不许把内容推进页脚**（347《生命的执着》的末行歌词压在页码上；
          // 全书 75 页有这个毛病）。引擎是按 `page.margin` 排的，排完这里再整页下移
          // `want − noteTop` 给标题块让位，从前这一步一点下界都没有——版心下界
          // （`footerTop`）只在半页起排与注解那两处用过，整页独占的曲子从不过闸。
          // 让位与不侵页脚冲突时，让位那一头认输：首行略高于原书那条线，总比压着页码强。
          const footerTop = st.titleBlock.footerBaseline - st.roles.footer.size * 1.6;
          const inkBottom = Math.max(
            ...probe.items.map((t) =>
              t.t === "text" ? t.y + t.size * 0.25 : t.t === "line" ? Math.max(t.y1, t.y2) : -Infinity,
            ),
            -Infinity,
          );
          let dy = delta + want - noteTop;
          if (Number.isFinite(inkBottom) && inkBottom + dy > footerTop) dy = footerTop - inkBottom;
          out.push(Number.isFinite(noteTop) ? mk(dy) : mk(delta));
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
      let phraseLines = [];
      let contentWidth = 0;
      let targetUsed = 0;
      let mode = "phrase";
      let pairsFrom = 0;
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
          // **「放不放得下」一律拿真实坐标判**（用户口径：「不要算格数，真实坐标排一遍，
          // 放不下再补刀」）。量的是排版器折行时用的那套自然坐标，且与断点无关，
          // 所以整首量一次，断句/选档/补刀/合并都用它。见 applybreaks.ts::FitMetric。
          const fitMetric = B.measureChordSpans(score, st, window.__app.meta);
          const brk = B.computePhraseBreaks(score.parts[0], {
            fit: fitMetric,
            targetMeas,
            lenWeight: st.layout.phraseLenWeight,
            breakWeight: st.layout.phraseBreakWeight,
            // **断句只看内容**：与纸张有关的分（行长目标、行数、稀疏）一律不算，
            // 「排不排得下」只在下面的模式阶梯里用。见 phrase.ts::PhraseOptions.contentOnly。
            contentOnly: st.layout.phraseContentOnly !== false,
            jumpMeasures,
            parallelWeight: st.layout.phraseParallelWeight ?? 6,
            // 平行乐句开头的**断点强度**（用户口径：要明显高于逗号）
            parallelScore: st.layout.phraseParallelScore ?? 8,
            // 行末收在长音上（与平行开头是一对，见 PhraseOptions.tailLongWeight）
            tailLongWeight: st.layout.phraseTailLongWeight ?? 0,
            // 成书专用的两条权重（编辑器那条路默认不开，基线不动）：
            // 短呼语句（「哈利路亚！」）的句末标点减半、重复段按长度加分。
            // 短呼语句的字数门槛：**4**（「哈利路亚！」「阿们！」那一档）。
            // 原来是 5，正好把 283《我们的生活》的「生命里丰富，」也折了——逗号本来只值 4 分，
            // 折成 2 就掉到「行内断点要另付 6 分」的门槛（`sc >= 4`）之下，那一刀于是让给了
            // 前一条零凭据的小节线，「生命｜里丰富，」被劈成两行（原书是「…生命里丰富，」收行）。
            shortSentenceWords: 4,
            repeatLenBonus: true,
            // 摊匀行长（跑两遍 DP，见 phrase.ts）：原书每一行都差不多长，
            // 只按容量排会一行顶格、一行半幅（051 的 12/14/24 格）。
            evenWeight: st.layout.phraseEvenWeight ?? 0,
            // 别把一句话的最后一小截甩到下一行开头（419「却成了祝福。」）
            tailWeight: st.layout.phraseTailWeight ?? 0,
            // 纸张在断句层**只当平局裁判**：放得下的那套方案与最优方案差这么多以内就用它
            //（见 PhraseOptions.fitSlack）。
            fitSlack: st.layout.phraseFitSlack ?? 0,
            // 行数多的方案优先（内容层，与版心无关）
            moreRowsSlack: st.layout.phraseMoreRowsSlack ?? 0,
            maxCells: cells,
            maxSentenceCells: cells,
            // 容量是排版器**数出来的个数**（音符与增时线各算一个），不是折算过的格数
            cellsAreItems: true,
          });
              // **整首的排版模式阶梯**（B 每 2 句一行 → A 一句一行 → C 均匀排版）：
          // 「排不排得下」只在这里用，断句本身不看纸张。见 applybreaks.ts::chooseLineLayout。
          // 记账：并之前有几行。「两句并一句要求整首并，要么全并要么不并」（用户口径），
          // line-check 的 D9 靠这两个数验——pairs 档的行数必须正好是并之前的一半。
          // **断句本身的结果**（补刀之前）：快照分两份存，一份记断句、一份记最终排版
          // ——「断句变了」与「补刀变了」是两码事，混在一份里查不出是哪一层动了。
          const preLines = B.describeLines(score.parts[0], brk, st.layout.phraseMidBreak);
          phraseLines = preLines.map((l) => ({ tail: l.tail.lastWord || l.tail.text, dur: Number(l.dur.toFixed(3)) }));
          const linesBefore = preLines.length;
          // **「放不放得下」一律拿真实坐标判**（用户口径：「不要算格数，真实坐标排一遍，
          // 放不下再补刀」）。量的是排版器折行时用的那套自然坐标，且与断点无关，
          // 所以整首量一次，下面的选档/补刀/合并都用它。见 applybreaks.ts::FitMetric。
          mode = B.chooseLineLayout(score.parts[0], brk, cells, {
            useMidBreaks: st.layout.phraseMidBreak,
            allowPairs: st.layout.phraseMergeShort !== false,
            fit: fitMetric,
          });
          pairsFrom = mode === "pairs" ? linesBefore : 0;
          // 容量保险：C 档之外的两档也可能有个别行放不下，按乐句凭据在行内部补刀
          B.enforceLineCapacity(score.parts[0], brk, cells, targetMeas, st.layout.phraseMidBreak, fitMetric);
          // 上面几步会造出新的行首（DP 管不到），再兜两次：行首不留半小节休止、
          // 补刀留下的碎行并回上一行（见 applybreaks.ts 两个函数的注释）。
          B.tidyLineHeads(score.parts[0], brk, { useMidBreaks: st.layout.phraseMidBreak, cells, fit: fitMetric });
          // 对称的另一半：行末不留半个小节的休止（用户口径「不管行首还是行尾」，J09）
          B.tidyLineTails(score.parts[0], brk, { useMidBreaks: st.layout.phraseMidBreak, cells, fit: fitMetric });
          B.mergeSliverLines(score.parts[0], brk, st.layout.phraseMidBreak, cells, fitMetric);
          // 逐行事实（行首残小节 / 行末标点 / 格数…）留给 line-check.mjs 断言；
          // Chord 是对象，跨不过 page.evaluate 的序列化，只带纯数据出去。
          const rawLines = B.describeLines(score.parts[0], brk, st.layout.phraseMidBreak);
          const measured = B.measureLines(score.parts[0], rawLines, fitMetric);
          contentWidth = measured.width;
          lineInfo = rawLines.map((l, li) => ({
            cells: l.cells, dur: l.dur, fromMi: l.fromMi, toMi: l.toMi, bars: l.bars, beats: l.beats,
            head: { ...l.head }, tail: { ...l.tail }, headFp: l.headFp, section: l.section, mid: !!l.chord,
            // 这一行的**真实宽度**（自然坐标，未 justify）。「放不放得下 / 是不是太短」
            // 一律按它判，别按格数（见 applybreaks.ts::FitMetric）。
            width: Math.round(measured.widths[li] * 100) / 100,
            // 行首那个断点是**容量补刀**落的（见 applybreaks.ts::LineInfo.fromCut）：
            // line-check 的 D2 据此豁免（拆分导致的弱起不一致不算错误）。
            fromCut: l.fromCut,
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
      const fit = { iters, cells, width: Math.round(contentWidth * 100) / 100, target: targetUsed, mode, pairsFrom, jump: jumpSeen, overflow: st.layout.phrase ? Math.max(0, B.countStaffRows(pageItems) - expectLines) : 0 };
      // 装饰层（标题/曲号/页眉页脚）在 Node 侧排，但字号得按**浏览器实测的墨迹比例**反算，
      // 否则同一个 size 在不同字体里墨迹大小不一样（见 browser.ts::fontSizeFor）。
      const sizes = {};
      for (const r of ["title", "songNumber", "category", "credit", "keyMeter", "header", "footer", "sectionWord", "story", "toc", "tocHeading", "tocSub", "frontTitle"]) sizes[r] = B.fontSizeFor(st, r);
      // creator 是 Map<type, text>（musicxml 的 <creator type="composer">…）
      const cr = score.creator instanceof Map ? [...score.creator] : Object.entries(score.creator ?? {});
      return { phraseLines, pages: out, naturalH, title: score.title, credits: cr.map(([type, text]) => ({ type, text })), sizes, fit, lines: lineInfo };
};

/** 排一首：delta = 0 是页顶起排，> 0 是半页起排（页高按 h − delta 排，排完整页下移）。 */
const renderSong = (s, xml, delta, compact = false) =>
  page.evaluate(RENDER_SONG, [xml, style, s.id, meta.section.get(s.id) ?? [], delta, compact]);

for (const s of picked) {
  const xml = await readFile(s.musicxml, "utf8");
  let res;
  try {
    res = await renderSong(s, xml, 0);
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
    // `fullPages` = 按整页高排的那一版；`pages` 由装箱器定（半页起排时会换成合过页的那一份）
    fullPages: res.pages,
    pages: res.pages,
    n: res.pages.length,
    naturalH: res.naturalH ?? 0,
    dy: 0,
    src: { s, xml },
    ctx: { sizes: res.sizes, id: s.id, title: res.title, credits: res.credits, category: s.category ?? "", km },
  });
  perSong.push({ id: s.id, title: res.title, pages: res.pages.length, fit: res.fit });
  perLines.push({ id: s.id, title: res.title, phraseLines: res.phraseLines ?? [], cells: res.fit?.cells ?? 0, width: res.fit?.width ?? 0, target: res.fit?.target ?? 0, mode: res.fit?.mode ?? "", pairsFrom: res.fit?.pairsFrom ?? 0, lines: res.lines ?? [] });
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

// 版心下界：按页脚基线往上留 1.6 个字，不用 footer.band（那是页脚出现过的 y 范围下沿，
// 比可用高度保守 30pt——原书的花边框压到 535，band 才 518）。
const footerTop = style.titleBlock.footerBaseline - style.roles.footer.size * 1.6;

// ────────────────────────────────────────────────────────── 装箱（半页起排 + 正反面）
//
// **在浏览器还活着的时候做**：半页起排要按缩短的页高重排一遍（renderSong 的 delta），
// 排完才知道整首放不放得进上一首下面那截空间。
//
// 两条判据：
//   **半页起排**  一页装得下不止一首（原书 25 处如此）。只收「整首恰好排成 1 页」的，
//                 排成两页就作废、另起一页——排版引擎一页只有一个高度，
//                 跨页续排的首页做不到「矮一截」。
//   **正反面**    物理页 p 与 p+1 同属一张纸当且仅当 p 是奇数（第 1 页是首张纸的正面）。
//                 所以页数 ≥ 2 的曲子**必须起于偶数物理页**，否则唱到一半要翻面。
//                 落在奇数页时先试着**撤掉最近一次半页起排**（页数同样加一，但加出来的是
//                 一页真的谱），撤不了才空一页——空页留给注解填（见 placeAnnotations）。
//
// 物理页号 = 前置页数 + 下标 + 1，所以装箱前先把前置页排一遍拿页数（buildFront 的头注释）。
const frontLen = only && !("parts" in flags) ? 0 : buildFront(new Map()).length;
const scorePages = [];
const midStarts = [];  // 半页起排记账（也是撤销的现场）：{ id, b, dp, pageIdx, delta, prev, itemCount, songCount, prevYTo }
const holes = [];      // 正反面约束留下的空页：{ page, song }
const undone = [];     // 为正反面撤掉的半页起排：{ song, page }
/** 下标 i 的乐谱页排出来是第几个物理页（决定对开镜像与正反面）。 */
const pageNoAt = (i) => frontLen + i + 1;

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

function blankPage() {
  return { pageNo: 0, label: "", w: style.page.w, h: style.page.h, meta: { kind: "score", songs: [] }, items: [] };
}

/** 曲号基线 → 首行音符墨迹上缘（标题块占的高）。 */
const TITLE_H = style.titleBlock.firstSystemTop - style.titleBlock.numberBaseline;

/** 最近一个「页数 ≥ 2 的曲子」起始页的下标。撤销半页起排时不能越过它
 *  ——在它后面插一页会把它整体挪一页，正反面又错了。 */
let lastMultiStart = -1;

/**
 * 正反面差一页时的**首选补救：撤掉最近一次半页起排**（那一首改成独占一页），
 * 页数同样加一，但加出来的是一页真的谱，不是一页近乎全白的纸。
 * 撤不了（中间夹着别的跨页曲、或压根没有可撤的）才空一页。
 */
function undoLastMid() {
  for (let k = midStarts.length - 1; k >= 0; k--) {
    const m = midStarts[k];
    if (m.pageIdx < lastMultiStart) return false; // 越过跨页曲了，撤了反而把它挪歪
    const dp = scorePages[m.pageIdx];
    if (dp !== m.dp) continue;
    // 把并进去的 item 与 y 带还原
    dp.items.length = m.itemCount;
    dp.meta.songs.length = m.songCount;
    const prev = dp.meta.songs[dp.meta.songs.length - 1];
    if (prev) prev.yTo = m.prevYTo;
    // 这一首改成独占一页，插在原来那页后面
    const b = m.b;
    b.pages = b.fullPages;
    b.ownItems = b.fullPages[0].items;
    b.dy = 0;
    b.fullPages[0].meta.songs = [{ id: b.id, title: b.title, first: true, yFrom: 0, yTo: style.page.h }];
    b.fullPages[0].cat = b.ctx.category;
    b.fullPages[0].sizes = b.ctx.sizes;
    scorePages.splice(m.pageIdx + 1, 0, b.fullPages[0]);
    midStarts.splice(k, 1);
    // 后面几条半页起排的页下标跟着后移
    for (const mm of midStarts) if (mm.pageIdx > m.pageIdx) mm.pageIdx++;
    undone.push({ song: b.id, page: pageNoAt(m.pageIdx + 1) });
    return true;
  }
  return false;
}

/** 一首歌独占若干整页（老行为）。必要时为正反面补救（撤一次半页起排，或空一页）。 */
function packAlone(b) {
  // 正反面：物理页 p 与 p+1 同属一张纸当且仅当 p 是奇数，所以页数 ≥ 2 的曲子
  // 必须起于**偶数**物理页，否则唱到一半要翻面。
  if (b.n >= 2 && pageNoAt(scorePages.length) % 2 === 1 && !(undoLastMid() && pageNoAt(scorePages.length) % 2 === 0)) {
    const blank = blankPage();
    blank.cat = b.ctx.category;
    blank.sizes = b.ctx.sizes;
    holes.push({ page: pageNoAt(scorePages.length), song: b.id });
    scorePages.push(blank);
  }
  if (b.n >= 2) lastMultiStart = scorePages.length;
  b.pages = b.fullPages;
  b.ownItems = b.fullPages[0].items;
  b.dy = 0;
  for (const [i, dp] of b.fullPages.entries()) {
    dp.meta.songs = [{ id: b.id, title: b.title, first: i === 0, yFrom: 0, yTo: style.page.h }];
    dp.cat = b.ctx.category;
    dp.sizes = b.ctx.sizes;
    scorePages.push(dp);
  }
}

/**
 * 半页起排：把 b 接排在**当前末页**已有内容的下面。放得下就落下去，返回 true。
 *
 * 原书最常见的样子不是「两首短曲拼一页」，而是**上一首的跨页尾巴下面接下一首**
 *（032 占了 p64 整页 + p65 上半，033 就从 p65 的 287 起排）。所以这里不挑上一首是整页
 * 还是尾页，一律拿末页的**实际内容底**算。
 *
 * 只收「整首恰好排成 1 页」的：排成两页那是跨页续排，排版引擎一页只有一个高度，
 * 首页做不到矮一截。
 */
async function packMid(b) {
  const cur = scorePages[scorePages.length - 1];
  const tb = style.titleBlock;
  if (b.n !== 1 || !cur || !cur.meta.songs.length) return false;
  const delta = Math.round((contentBottom(cur) + tb.midStartGap - tb.numberBaseline) * 100) / 100;
  if (delta <= 0) return false;
  // 先按自然高预判（省掉一次白排）：标题块 + 各谱行叠起来的高度要塞得进版心剩下的部分。
  // naturalH 是排版器给的**内容真高**——排完再量没用，layoutVertically 会把行撑到行距上限。
  if ("packlog" in flags)
    console.log(`  · ${b.id} 上一首底 ${contentBottom(cur).toFixed(1)} delta ${delta.toFixed(1)} 自然高 ${b.naturalH.toFixed(1)} 需要到 ${(tb.numberBaseline + delta + TITLE_H + b.naturalH).toFixed(1)}（版心下界 ${footerTop.toFixed(1)}）`);
  if (tb.numberBaseline + delta + TITLE_H + b.naturalH > footerTop) return false;
  let res = null;
  try {
    // compact = 按内容自然高排（不撑行距）——接排在别人下面，摊开就出版心了
    res = await renderSong(b.src.s, b.src.xml, delta, true);
  } catch {
    return false; // 缩了页高排不出来就当放不下，另起一页（不该炸整本）
  }
  if (res.pages.length !== 1) return false;
  const src = res.pages[0];
  if (contentBottom(src) > footerTop) return false;
  const yFrom = tb.numberBaseline + delta - (b.ctx.sizes?.songNumber ?? style.roles.songNumber.size);
  const prev = cur.meta.songs[cur.meta.songs.length - 1];
  // 撤销要用的现场：并之前这一页有几个 item / 几首、上一首原来的 yTo
  const undo = { itemCount: cur.items.length, songCount: cur.meta.songs.length, prevYTo: prev?.yTo ?? style.page.h };
  if (prev) prev.yTo = yFrom;
  cur.items.push(...src.items);
  cur.meta.songs.push({ id: b.id, title: b.title, first: true, yFrom, yTo: style.page.h });
  b.pages = [cur];
  b.ownItems = src.items;
  b.dy = delta;
  midStarts.push({ id: b.id, b, dp: cur, pageIdx: scorePages.length - 1, delta, prev: prev?.id ?? null, ...undo });
  return true;
}

for (const b of songBlocks) if (!(await packMid(b))) packAlone(b);

console.log(
  `装箱：乐谱 ${scorePages.length} 页；半页起排 ${midStarts.length} 首` +
    `；正反面撤回半页起排 ${undone.length} 首、留空 ${holes.length} 页` +
    (holes.length ? `（${holes.slice(0, 8).map((h) => `p${h.page}→${h.song}`).join(" ")}${holes.length > 8 ? " …" : ""}）` : ""),
);

await browser.close();
await close();
if (errors.length) console.log(`⚠ 控制台错误 ${errors.length}：`, errors.slice(0, 3));

// ────────────────────────────────────────────────────────── 装订
//
// 页码分两套，照原书：**前置页（前言 + 目录）自成一套**，乐谱页从 1 重新起，
// 后附的索引接着乐谱页往下数（实测原书 PDF 638 页印的是 606）。
// 所以目录里的曲目页码**不随目录页数变化**，两遍法一轮就收敛——
// 但循环还是留着（上限 3 轮）并记账，免得改了页码规则之后没人发现不收敛了。

/** 某一框的八片母题。样式 id 认不出来时退回任意一套——总比不画强（框宽都一样）。 */
function tilesOf(styleId) {
  return meta.tilesByStyle.get(styleId) ?? meta.tilesByStyle.values().next().value ?? [];
}

/**
 * 注解（圣诗故事 / 经文）落位。
 *
 * **字号一律用统计字号**（`roles.story.size`，全书 9.8pt），行距按 `annGapRatio` 折算。
 * 库里 `annotation.size` / 逐框行距那几列是**原书的实测值**，只留给 A 路 `relayout.mjs`
 * 保真复现原件用——原书同一批花边框 6.5~10.5 各不相同，那是当年人工挤版挤出来的，
 * 不是要复现的排版意图。老代码那两级「缩字号 9.8→6.0 / 缩行距」阶梯**已撤掉**。
 *
 * 放不下就**换个地方**，不再压字号：候选页按「离本曲多近」排，第一个放得下的就用。
 *   1. 本曲末页　　2. 同一对开跨页的另一页　　3. 之后 K 页　　4. 之前 K 页
 *   （正反面判据留下的空页就在这一档被填掉）　　5. 全书空位最多的那页
 * 整轮都不行才回头压谱面（只压本曲末页、只压本曲那几行），再不行才记账报出来。
 */
/** 邻近半径（页）。超过这个距离就不算「跟着这首歌」了，只能进「全书任意空位」那一档。 */
const ANN_NEAR_PAGES = 4;
/** 压谱面时，行间空隙最多收掉这么多（留 75%）。再紧谱行就挤成一坨了。 */
const SQUEEZE_MAX = 0.25;

/**
 * 把一页的谱行往上收，腾出 `need` 那么多空间给注解。
 *
 * 只压**行与行之间的空隙**，每一行整体刚体上移——行内的音符/歌词/和弦相对位置分毫不动
 * （那些是排版引擎按简谱纵向栅格算出来的，动一下八度点和 slur 就全错位了）。
 * 第一行不动，后面每行依次多移一点。
 *
 * 返回真正腾出来的量（可能不足 need）。
 */
function squeezePage(dp, need, yMin = 0) {
  if (need <= 0) return 0;
  // 行锚：歌词行的 y。没有歌词就没法认行，不压。
  // **只收 yMin 以下的行**：半页起排的页上有两首，压的是注解所跟那一首，
  // 把上一首的谱行也拖上去就成了两首之间越贴越近。
  const ys = [...new Set(dp.items.filter((i) => i.t === "text" && i.role === "lyric" && i.y >= yMin).map((i) => Math.round(i.y * 10) / 10))].sort((a, b) => a - b);
  if (ys.length < 2) return 0;
  // 相邻锚之间差得太近的是同一谱行的多段歌词（多节），不算换行
  const rows = [ys[0]];
  for (const y of ys.slice(1)) if (y - rows[rows.length - 1] > 20) rows.push(y);
  if (rows.length < 2) return 0;
  const gaps = [];
  for (let i = 1; i < rows.length; i++) gaps.push(rows[i] - rows[i - 1]);
  // 每道空隙最多收 SQUEEZE_MAX；总共能收多少
  const room = gaps.reduce((a, g) => a + g * SQUEEZE_MAX, 0);
  const take = Math.min(need, room);
  if (take <= 0.5) return 0;
  const per = take / gaps.length;
  // 行边界：两个锚的中点。每个 item 按 y 归行，行 k 上移 k*per。
  const bounds = [];
  for (let i = 1; i < rows.length; i++) bounds.push((rows[i - 1] + rows[i]) / 2);
  const rowOf = (y) => {
    let k = 0;
    while (k < bounds.length && y > bounds[k]) k++;
    return k;
  };
  for (const it of dp.items) {
    const y = it.t === "line" ? Math.min(it.y1, it.y2) : it.y;
    if (y === undefined || y < yMin) continue;
    const d = rowOf(y) * per;
    if (!d) continue;
    if (it.t === "line") {
      it.y1 -= d;
      it.y2 -= d;
    } else it.y -= d;
    if (it.t === "path" && it.d) it.d = shiftPathY(it.d, -d);
  }
  return take;
}

/** 路径整体上下平移（花边框/圆滑线那些已经落成绝对坐标的 path）。 */
function shiftPathY(d, dy) {
  return d.replace(/(-?\d*\.?\d+)(\s+)(-?\d*\.?\d+)/g, (_m, a, sp, b) => `${a}${sp}${(Number(b) + dy).toFixed(2)}`);
}

function placeAnnotations() {
  const size = style.roles.story.size;           // 全书统一：统计出来的注解字号
  const lineGap = size * annGapRatio;            // 行距也统一，不再逐框存绝对值
  const idxOf = new Map(scorePages.map((dp, i) => [dp, i]));
  // 版心上界：空页上没有任何内容，`contentBottom` 是 0，注解就会顶到页眉上去
  //（正反面判据留下的空页正是这种）。一律从续页谱行的那条线起排。
  const contentTop = style.titleBlock.contSystemTop;
  const free = new Map(scorePages.map((dp) => [dp, footerTop - Math.max(contentBottom(dp), contentTop)]));
  /** 本页最下面那首（注解落在谁的下面）。空页报 null。 */
  const hostOf = (dp) => dp.meta.songs[dp.meta.songs.length - 1] ?? null;

  const build = (a, dp, top) =>
    cli.annotationBlock(style, {
      text: a.text,
      framed: !!a.framed,
      // 022/023 那种双细线矩形框：几何用 gen-bookmeta 实测的外圈/内圈/空隙
      frame: a.frame_kind ?? (a.framed ? "tile" : "none"),
      frameOuter: a.frame_outer || undefined,
      frameInner: a.frame_inner || undefined,
      frameGap: a.frame_gap || undefined,
      ...pageEdges(dp.pageNo),
      top,
      lineGap,
      // 花边母题**逐框各不相同**（全书 106 套），按 frame_style 取这一框的八片；
      // 老库只有全书通用的横竖两片，那时 109 个框的花边都画错了。
      tiles: tilesOf(a.frame_style),
      frameEdges: a.frame_edges || undefined,
      measure,
      size,
    });

  /** 试着把 a 排进 dp。放得下就落下去并扣掉空间，返回 true。 */
  const tryPut = (a, dp) => {
    const room = free.get(dp);
    const block = build(a, dp, footerTop - room);
    if (block.height > room) return false;
    dp.items.push(...block.items);
    free.set(dp, room - block.height - size);
    return true;
  };

  const rows = [];   // 逐条记账，出 CSV 与日志
  let placed = 0;
  let squeezed = 0;
  const lost = [];

  for (const b of songBlocks) {
    const anns = meta.annotation.get(b.id) ?? [];
    if (!anns.length) continue;
    const home = b.pages[b.pages.length - 1];
    const hi = idxOf.get(home);
    for (const a of anns) {
      // 候选页：本曲末页 → 同一对开跨页的另一页 → 之后 K 页 → 之前 K 页 → 全书空位最大的那页。
      // 对开跨页 = (偶, 奇+1)：偶数页的另一半在右边，奇数页的在左边。
      const cands = [home];
      const spread = scorePages[home.pageNo % 2 === 0 ? hi + 1 : hi - 1];
      if (spread) cands.push(spread);
      for (let d = 1; d <= ANN_NEAR_PAGES; d++) if (scorePages[hi + d]) cands.push(scorePages[hi + d]);
      for (let d = 1; d <= ANN_NEAR_PAGES; d++) if (scorePages[hi - d]) cands.push(scorePages[hi - d]);
      cands.push([...scorePages].sort((x, y) => free.get(y) - free.get(x))[0]);

      let at = null;
      let didSqueeze = 0;
      for (const dp of cands) {
        if (!dp || dp === at) continue;
        if (tryPut(a, dp)) { at = dp; break; }
      }
      // 哪儿都放不下才回头压谱面——**只压本曲末页、只压本曲那几行**（半页起排的页上有两首）。
      if (!at) {
        const host = hostOf(home);
        const want = build(a, home, footerTop - free.get(home)).height - free.get(home);
        const got = squeezePage(home, want, host?.yFrom ?? 0);
        if (got > 0.5) {
          free.set(home, free.get(home) + got);
          if (tryPut(a, home)) { at = home; didSqueeze = got; squeezed++; }
        }
      }
      if (!at) {
        lost.push({ song: b.id, title: b.title });
        continue;
      }
      placed++;
      const host = hostOf(at);
      rows.push({
        song: b.id, title: b.title,
        homePage: home.pageNo, atPage: at.pageNo,
        hostSong: at === home ? b.id : (host?.id ?? ""),
        hostTitle: at === home ? b.title : (host?.title ?? "空页"),
        squeeze: Math.round(didSqueeze * 10) / 10,
      });
    }
  }
  return { placed, left: lost.length, lost, squeezed, rows };
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

/** 前置页：前言（主祷文/使徒信经）→ 目录 →（附录扉页跟在目录后，原书就印在目录页之间）。
 *
 *  **装箱前就要调一次**：物理页号 = 前置页数 + i + 1，而「两页曲必须起于偶数页」这条
 *  正反面判据看的就是物理页的奇偶。目录的**页数只跟条目数有关**（一条一行），
 *  与条目上印的页码数值无关，所以拿一份空的 pageOfSong 先算，算出来的页数就是最终页数
 *  ——装订时再用真页码排一遍，两者页数不等的话下面会报警。 */
function buildFront(pageOfSong) {
  const prose = meta.front.filter((f) => f.kind === "prose").map((f) => ({ kind: "prose", title: f.title, body: f.body }));
  const dividers = meta.front.filter((f) => f.kind === "divider").map((f) => ({ kind: "divider", title: f.title, body: "" }));
  // 各角色的字号（浏览器侧按墨迹比例反算过的）。每首返回的都一样，取第一首即可；
  // 一首都没排出来时退回 roles[*].size（bookparts 内部有同样的兜底）。
  const roleSizes = songBlocks[0]?.ctx?.sizes ?? {};
  let out = cli.frontPages(style, prose, { startPageNo: 1, measure });
  const toc = meta.toc.length ? cli.tocPages(style, tocItems(pageOfSong), { startPageNo: out.length + 1, measure, title: "目录", sizes: roleSizes }) : [];
  out = [...out, ...toc, ...cli.frontPages(style, dividers, { startPageNo: out.length + toc.length + 1, measure })];
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
  // **拿本首自己那一份 item**（`ownItems`）：半页起排时这一页上还有上一首的歌词，
  // 照页取会捞到上一首的首句。
  const first = (b.ownItems ?? b.pages[0]?.items ?? [])
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
  front = buildFront(pageOfSong);
  const roleSizes = songBlocks[0]?.ctx?.sizes ?? {};
  // 后附索引：接着乐谱页往下编号
  back = [];
  for (const [name, title] of [["title", "诗题笔划索引"], ["firstline", "歌词首句索引"]]) {
    const items = indexItems(name, firstLines);
    if (items.length) back.push(...cli.indexPages(style, items, { startPageNo: 1, measure, title, sizes: roleSizes }));
  }
  if (same) break;
}

// 前置页数自检：装箱时按估值定了物理页奇偶（正反面判据靠它），排出来必须一样多。
// 不一致说明目录的页数受了页码数值影响（不该），那样正反面就整体错了一页。
if (front.length !== frontLen)
  console.log(`⚠ 前置页数与装箱时的估值不符：装箱按 ${frontLen} 页算，实际 ${front.length} 页——正反面判据整体错位，请复查 buildFront`);

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

// 装饰层（标题/曲号/署名/页眉页码）等页号定下来再加——页眉与曲号要按奇偶换边。
// **页眉页码一页一次**（半页起排时一页两首，跟着曲子走会印两遍），标题块每首一次。
for (const dp of scorePages) {
  // 真的一片空白的页（正反面判据留下的、又没排进注解）不印页眉页码——书里的空白页本来就不印
  if (!dp.meta.songs.length && !dp.items.length) continue;
  decoratePage(dp, { category: dp.cat ?? "", sizes: dp.sizes, label: dp.label });
}
for (const b of songBlocks) decorateSong(b.pages[0], { ...b.ctx, dy: b.dy });
for (const dp of [...front, ...back]) decoratePage(dp, { label: dp.label, category: "" });

pages.push(...front, ...scorePages, ...back);
console.log(
  `装订：前置 ${front.length} 页（前言 ${meta.front.filter((f) => f.kind === "prose").length} + 目录）、` +
    `乐谱 ${scorePages.length} 页、索引 ${back.length} 页；目录两遍法 ${rounds} 轮`,
);
// 注解逐条报账（用户口径：框里不加所属曲目标注，但日志要把**原曲与新曲**两边的
// 编号和标题都打出来）。同样的字段另出一份 CSV，便于人工核对。
const annMoved = ann.rows.filter((r) => r.atPage !== r.homePage);
console.log(`注解排入 ${ann.placed}/${[...meta.annotation.values()].flat().length}，字号一律 ${style.roles.story.size}pt` +
  `；排在本曲末页 ${ann.rows.length - annMoved.length} 条、挪到别页 ${annMoved.length} 条、压过谱面 ${ann.squeezed} 条` +
  (ann.left ? `；**没排下 ${ann.left} 条**：${ann.lost.map((l) => l.song).join(" ")}` : "") +
  (noKeyMeter.length ? `；没有调号拍号的 ${noKeyMeter.length} 首：${noKeyMeter.slice(0, 5).join(" ")}` : ""));
for (const r of annMoved)
  console.log(`  注解 原曲 ${r.song}《${r.title}》p${r.homePage} → 落在 p${r.atPage}` +
    `＝${r.hostSong ? `${r.hostSong}《${r.hostTitle}》` : r.hostTitle}` +
    (r.squeeze ? `（压谱面 ${r.squeeze}pt）` : ""));

await mkdir(OUTDIR, { recursive: true });
const name = flags.name ?? (only ? `rebuild-${only.join("-")}.pdf` : "诗歌500首-重排版.pdf");
const out = `${OUTDIR}/${name}`;
const r = await writePdf({ style, source: "rebuild", pages }, { out, title: "诗歌500首（重排版）" });
await writeFile(`${OUTDIR}/rebuild-drawlist.json`, JSON.stringify({ style: style.id, songs: perSong, pages }, null, 0));
// 逐行事实：line-check.mjs 的底本（版面判据的常驻断言，见那个脚本）
await writeFile(`${OUTDIR}/rebuild-lines.json`, JSON.stringify({ style: style.id, songs: perLines }, null, 0));
console.log(`重排版 PDF → ${out}（${r.pages} 页，${(r.bytes / 1048576).toFixed(2)} MB，缺字 ${r.missing.length}）`);
console.log(`曲目 ${perSong.length}/${picked.length}${failed.length ? `，失败 ${failed.length}：${failed.slice(0, 5).map((f) => f.id).join(" ")}` : ""}`);
const q = (t) => `"${String(t ?? "").replace(/"/g, "\"\"")}"`;
const startPageOf = new Map(songBlocks.map((b) => [b.id, b.pages[0].pageNo]));
const midOf = new Map(midStarts.map((m) => [m.id, m]));
await writeFile(
  `${OUTDIR}/rebuild.csv`,
  "\ufeff曲号,曲名,页数,起始物理页,半页起排\n" +
    perSong.map((s) => `${s.id},${q(s.title)},${s.pages},${startPageOf.get(s.id) ?? ""},${midOf.has(s.id) ? "是" : ""}`).join("\n"),
);
// 注解逐条：原曲 / 落位页 / 落位页上的曲目（人工核对用）
await writeFile(
  `${OUTDIR}/rebuild-annotations.csv`,
  "\ufeff曲号,曲名,本曲末页,实排页,落位页曲号,落位页曲名,压谱面pt\n" +
    ann.rows.map((r) => `${r.song},${q(r.title)},${r.homePage},${r.atPage},${r.hostSong},${q(r.hostTitle)},${r.squeeze}`).join("\n"),
);
if ("db" in flags) {
  const { newRunId, recordRun, recordMetrics } = await import("./scripts/checkdb.mjs");
  const db = openDb();
  const runId = newRunId("rebuild");
  recordRun(db, { run_id: runId, route: "rebuild", config: style.id, artifact: out, page_count: r.pages, byte_size: r.bytes, cmd: "rebuild.mjs" });
  recordMetrics(db, runId, {
    pages: r.pages, songs: perSong.length, front_pages: front.length, index_pages: back.length,
    annotations_placed: ann.placed, annotations_left: ann.left, font_missing: r.missing.length,
    annotations_moved: annMoved.length, annotations_squeezed: ann.squeezed,
    mid_page_starts: midStarts.length, duplex_holes: holes.length,
    key_meter_missing: noKeyMeter.length, section_words: [...meta.section.values()].flat().length,
  });
  db.close();
  console.log(`→ 校对.db：批次 ${runId}`);
}
if (r.missing.length) console.log("  缺字明细:", JSON.stringify(r.missing.slice(0, 6)));
if (r.fallbacks.length) console.log("  字体回退:", r.fallbacks.slice(0, 6).map((f) => `${f.ch}:${f.from}→${f.to}`).join(" "));
