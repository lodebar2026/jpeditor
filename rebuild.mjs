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
import { loadCorpus, gtKeyTime } from "./scripts/node-harness.mjs";
import { writePdf } from "./scripts/pdfwrite.mjs";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")));
const OUTDIR = flags.out ?? "pdf-out";
const style = JSON.parse(await readFile(flags.style ?? "testdata/500/bookstyle.json", "utf8"));
const only = flags.one ? String(flags.one).split(",") : null;

const { songs } = await loadCorpus();
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
  if (st.footer.enable) put(st.footer.format.replace("{n}", String(dp.pageNo)), "footer", tb.footerBaseline, "center", center);

  if (!ctx.first) return;
  put(ctx.id.replace(/^0+(?=\d)/, ""), "songNumber", tb.numberBaseline, odd ? "right" : "left", odd ? right : left);
  put(ctx.title, "title", tb.titleBaseline, "center", center);
  put(ctx.keyMeter, "keyMeter", tb.keyMeterBaseline, "left", left + 2.3);
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
      for (const r of ["title", "songNumber", "category", "credit", "keyMeter", "header", "footer"]) sizes[r] = B.fontSizeFor(st, r);
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
  const km = s.musicxml ? gtKeyTime(xml) : null;
  res.pages.forEach((dp, i) => {
    dp.pageNo = pages.length + 1;
    decorate(dp, {
      sizes: res.sizes,
      first: i === 0,
      id: s.id,
      title: res.title,
      credits: res.credits,
      category: s.category ?? "",
      keyMeter: km && km.beats ? `1=${km.key}  ${km.beats}/${km.beatType}` : "",
    });
    pages.push(dp);
  });
  perSong.push({ id: s.id, title: res.title, pages: res.pages.length });
  if (only || picked.length < 30) console.log(`  ${s.id} ${res.title}：${res.pages.length} 页`);
}

await browser.close();
await close();
if (errors.length) console.log(`⚠ 控制台错误 ${errors.length}：`, errors.slice(0, 3));

await mkdir(OUTDIR, { recursive: true });
const name = flags.name ?? (only ? `rebuild-${only.join("-")}.pdf` : "诗歌500首-重排版.pdf");
const out = `${OUTDIR}/${name}`;
const r = await writePdf({ style, source: "rebuild", pages }, { out, title: "诗歌500首（重排版）" });
await writeFile(`${OUTDIR}/rebuild-drawlist.json`, JSON.stringify({ style: style.id, songs: perSong, pages }, null, 0));
console.log(`重排版 PDF → ${out}（${r.pages} 页，${(r.bytes / 1048576).toFixed(2)} MB，缺字 ${r.missing.length}）`);
console.log(`曲目 ${perSong.length}/${picked.length}${failed.length ? `，失败 ${failed.length}：${failed.slice(0, 5).map((f) => f.id).join(" ")}` : ""}`);
await writeFile(`${OUTDIR}/rebuild.csv`, "\ufeff曲号,曲名,页数\n" + perSong.map((s) => `${s.id},"${(s.title ?? "").replace(/"/g, "\"\"")}",${s.pages}`).join("\n"));
if (r.missing.length) console.log("  缺字明细:", JSON.stringify(r.missing.slice(0, 6)));
if (r.fallbacks.length) console.log("  字体回退:", r.fallbacks.slice(0, 6).map((f) => `${f.ch}:${f.from}→${f.to}`).join(" "));
