// 矢量路 CLI 的公共引导。与 scripts/harness.mjs 分工：
//   harness.mjs      —— 要浏览器的脚本（canvas / OCR wasm / SVG 测量）用，起 Edge + serve dist
//   node-harness.mjs —— **不起浏览器**的脚本用（矢量抽取 / 归类 / 字形字典 / 版面规格 / 对比）
// 断言与业务逻辑一律留在各脚本里，这里只放引导。
//
// 用法：import { openPdf, eachPage, parsePageRange, loadCorpus, cliOut } from "./scripts/node-harness.mjs";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { decodeJpwabc } from "./harness.mjs";

/** 500 首语料默认位置。用 env `HYMN500` 覆盖。 */
export const CORPUS_ROOT = process.env.HYMN500 ?? "/Users/jonah/Documents/诗歌/500首";
export const CORPUS_PDF = join(CORPUS_ROOT, "诗歌500首内页校再校对编定稿2019年2月.pdf");

/** dist-cli 产物（`npm run build:cli`）。 */
export async function loadCli() {
  const p = join(process.cwd(), "dist-cli", "index.js");
  if (!existsSync(p)) throw new Error("缺少 dist-cli/index.js —— 先跑 `npm run build:cli`");
  return import(p);
}

/** pdfjs 的 Node 构建（legacy，无需 worker；矢量路不解码位图，故不给 wasmUrl）。 */
export async function loadPdfjs() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

/** 打开 PDF，返回 { pdfjs, doc, OPS }。 */
export async function openPdf(path = CORPUS_PDF) {
  const pdfjs = await loadPdfjs();
  const bytes = new Uint8Array(await readFile(path));
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  return { pdfjs, doc, OPS: pdfjs.OPS };
}

/** "55-62" / "60" / "1,5,9" / 空 → 页号数组（1 基）。空表示全书。 */
export function parsePageRange(spec, numPages) {
  if (!spec) return Array.from({ length: numPages }, (_, i) => i + 1);
  const out = [];
  for (const part of String(spec).split(",")) {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(part.trim());
    if (m) {
      const a = Math.max(1, +m[1]);
      const b = Math.min(numPages, +m[2]);
      for (let i = a; i <= b; i++) out.push(i);
    } else if (/^\d+$/.test(part.trim())) {
      const n = +part.trim();
      if (n >= 1 && n <= numPages) out.push(n);
    }
  }
  return out.length ? out : Array.from({ length: numPages }, (_, i) => i + 1);
}

/** 逐页遍历并 cleanup（666 页不 cleanup 会吃光内存）。 */
export async function eachPage(doc, pages, fn) {
  for (const pn of pages) {
    const page = await doc.getPage(pn);
    try {
      await fn(page, pn);
    } finally {
      page.cleanup?.();
    }
  }
}

/** 曲号：文件名前缀 `001.` / `J07.` / `D12.` / `082A.`（同一曲号两个调）
 *  → "001" / "J07" / "D12" / "082A"。 */
export function songIdOf(filename) {
  const m = /^([JD]?\d{2,3}[AB]?)\./.exec(filename);
  return m ? m[1] : null;
}

/** 曲号排序键：数字段主序，J/D 段各自后置，A/B 变调作次序。 */
export function songRank(id) {
  const m = /^([JD]?)(\d+)([AB]?)$/.exec(id);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const base = m[1] === "J" ? 1000 : m[1] === "D" ? 2000 : 0;
  return (base + Number(m[2])) * 10 + (m[3] === "B" ? 1 : 0);
}

/** 载入 500 首语料索引：musicxml（主 GT）+ jpwabc（辅 GT）+ album.txt 分类。 */
export async function loadCorpus(root = CORPUS_ROOT) {
  const xmlDir = join(root, "500");
  const jpwDir = join(root, "jpw");
  const songs = new Map(); // id → { id, title, musicxml, jpwabc, mid, category }

  for (const f of await readdir(xmlDir)) {
    if (extname(f).toLowerCase() !== ".musicxml") continue;
    const id = songIdOf(f);
    if (!id) continue;
    const title = basename(f, extname(f)).slice(id.length + 1);
    songs.set(id, { id, title, musicxml: join(xmlDir, f), jpwabc: null, mid: null, category: null });
  }
  for (const f of await readdir(jpwDir)) {
    const id = songIdOf(f);
    if (!id) continue;
    const s = songs.get(id);
    if (!s) continue;
    const ext = extname(f).toLowerCase();
    if (ext === ".jpwabc") s.jpwabc = join(jpwDir, f);
    else if (ext === ".mid") s.mid = join(jpwDir, f);
  }

  // album.txt：`敬拜 赞美:001-038` / `经文短歌:J01-J38`
  const categories = [];
  try {
    const txt = await readFile(join(xmlDir, "album.txt"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = /^(.+?):([JD]?\d+)-([JD]?\d+)$/.exec(line.trim());
      if (!m) continue;
      categories.push({ name: m[1], from: m[2], to: m[3] });
    }
  } catch {
    /* 没有分类表也能跑 */
  }
  for (const c of categories) {
    const a = songRank(c.from);
    const b = songRank(c.to) + 9; // 让 410B 落在 410 的区间内
    for (const s of songs.values()) if (songRank(s.id) >= a && songRank(s.id) <= b) s.category = c.name;
  }

  return { songs, categories, xmlDir, jpwDir };
}

/** 读一首的 GT 文本：{ musicxml, jpwabc }。 */
export async function readSongGt(song) {
  const out = {};
  if (song.musicxml) out.musicxml = await readFile(song.musicxml, "utf8");
  if (song.jpwabc) out.jpwabc = decodeJpwabc(new Uint8Array(await readFile(song.jpwabc)));
  return out;
}

/** 产物目录：确保存在并返回路径拼接器。 */
export async function cliOut(dir) {
  await mkdir(dir, { recursive: true });
  return {
    dir,
    path: (...p) => join(dir, ...p),
    write: async (name, content) => writeFile(join(dir, name), content),
  };
}

/** CSV 一行（逗号/引号转义 + 不吃前导零）。 */
export function csvRow(cells) {
  return cells
    .map((c) => {
      const s = c == null ? "" : String(c);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

/** `.jpwabc` 文本 → 段名到内容的映射（`.Title` / `.Voice` / `.Words` / `.Layout` …）。
 *  文件是 CRLF，段头独占一行。 */
export function jpwSections(text) {
  const out = {};
  let cur = null;
  let buf = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\.(\w+)\s*$/.exec(line);
    if (m) {
      if (cur) out[cur] = buf.join("\n");
      cur = m[1];
      buf = [];
    } else if (cur) buf.push(line);
  }
  if (cur) out[cur] = buf.join("\n");
  return out;
}

/** `.Voice` 段 → 音符数字序列（0-7，0=休止）。
 *  八度点/减时线/增时线/小节线/圆滑线括号忽略；**升降号也不计**——谱面上它印在音符左上方、
 *  归类时落在和弦带里，与 .Voice 的写法口径不一致，两边一起剔除才比得准。 */
export function gtNoteDigits(voiceText) {
  // `$(...)` 是换行标记，`{(3}` 是三连音标记，`{YanYin}` 是演奏记号——都含数字或字母，先剔掉。
  // 注意 `{(3}` **没有右括号**：写成 `\{\([^)]*\)?\}?` 会让 `[^)]*` 一路吃到远处圆滑线的 `)`，
  // 把整段音符吞掉（实测 272 首因此只解析出 17 个音符，实际有 50+）。
  const cleaned = voiceText
    .replace(/\$\([^)]*\)/g, "")
    .replace(/\{\(\d+\}/g, "")
    .replace(/\{[^}]*\}/g, "");
  return (cleaned.match(/[0-7]/g) ?? []).join("");
}

/** `.Words` 段 → 每段歌词的汉字串（按 verse）。 */
export function gtLyricVerses(wordsText) {
  // `W1-3@9,3` 是**几段共用的副歌**（全书只有 013 首这么写）。谱面把它印在**第 1 段那一行**
  // 的后面（副歌那几个谱行只有一行词），所以它是第 1 段的一部分，不是「第 4 段」。
  // 试过摊给范围内的每一段，反而更糟——谱面只印一遍，第 2、3 段会各多出一整段（013 首 36→72 项）。
  const verses = [];
  const byVerse = new Map();
  let cur = null;
  for (const line of wordsText.split(/\r?\n/)) {
    const m = /^W(\d+)(?:-\d+)?(?:\([^)]*\))?@/.exec(line.trim());
    if (m) {
      const v = Number(m[1]);
      cur = byVerse.get(v);
      if (!cur) {
        cur = { verse: v, text: "" };
        byVerse.set(v, cur);
        verses.push(cur);
      }
    } else if (cur) cur.text += line;
  }
  // 页面上印着的东西要全留下，才能和页面字形一一对上：
  //  - `{1.[圣]}` 是「段号 + 该段首字」的壳，只留那个字：段号在谱面上**每个谱行都重印一次**，
  //    GT 里却只有一处，留着两边永远对不齐 → 识别侧也统一剔掉行首段号（见 collectSongGlyphs）
  //  - 标点（，。！？、；：等）谱面上都印着，必须保留
  //  - `/` 是续记号、`-` 是延长，谱面上不印成字 → 去掉
  const KEEP = /[\u4e00-\u9fff\u3000-\u303f\uff01-\uff5e0-9A-Za-z.]/g;
  return verses.map((v) => ({
    verse: v.verse,
    chars: (v.text.replace(/\{(\d+)\.\[(.)\]\}/g, "$2").replace(/[/\-]/g, "").match(KEEP) ?? []).join(""),
  }));
}


/**
 * pagemap 里**同一首、同一页的相邻条目合成一条**。
 *
 * gen-pagemap 偶尔会把一首在同一页上切成两段（124 首切在 y=230.7，D04 也一样），
 * 切口正好落在标题中间：两段各自取标题、再首尾相接，标题就成了「哈利路奇妙救主亚，」。
 * 下游按 y 区间取字，合成一条即可，不必去改 pagemap 的切法。
 */
export function mergePagemapEntries(map) {
  const out = [];
  for (const e of map) {
    const last = out[out.length - 1];
    if (last && last.id === e.id && last.page === e.page) {
      last.yFrom = Math.min(last.yFrom ?? 0, e.yFrom ?? 0);
      last.yTo = Math.max(last.yTo ?? Infinity, e.yTo ?? Infinity);
      last.startsHere = last.startsHere || e.startsHere;
      continue;
    }
    out.push({ ...e });
  }
  return out;
}

/**
 * 从一页的归类结果里，按曲目分区取出该首的字形序列。
 * gen-glyphdict.mjs 与 pdf-diff.mjs 共用——两边的取法必须一模一样，
 * 否则建字典时的位置和查字典时的位置对不上。
 *
 * @param entry pagemap 里的一条（含 page / yFrom / yTo / startsHere）
 * @returns { notes, chords, title, verses }，元素都是归类后的对象
 */
export function collectSongGlyphs(inv, entry, profile, shapeKey = null) {
  const yFrom = entry.yFrom ?? 0;
  const yTo = entry.yTo ?? Infinity;
  const mine = (cls) => inv.objs.filter((o) => o.cls === cls && !o.dup && o.obj.bbox.y >= yFrom && o.obj.bbox.y < yTo);
  // 归行用的下缘。`lyricYi`（歌词里的「一」）带 baseline：它自己的下缘比同行汉字高
  // 四五个点，不换成参照汉字的下缘就会被聚到别的行去。
  const bot = (o) => o.baseline ?? o.obj.bbox.y + o.obj.bbox.h;

  const notes = mine("note").sort((a, b) => a.row - b.row || a.obj.bbox.x - b.obj.bbox.x);
  const chords = mine("chord").sort((a, b) => a.row - b.row || a.obj.bbox.x - b.obj.bbox.x);
  const title = entry.startsHere ? mine("title").sort((a, b) => a.obj.bbox.x - b.obj.bbox.x) : [];

  // 歌词：每个谱行下方按**基线**聚成若干行，从上到下就是第 1、2、3… 段。
  // 不能按顶边聚：标点「，」「。」只占字格下部，顶边比同行汉字低一大截。
  const byRow = new Map();
  for (const o of [...mine("lyric"), ...mine("lyricYi")]) {
    const a = byRow.get(o.row) ?? [];
    a.push(o);
    byRow.set(o.row, a);
  }
  const verses = [];
  const dot = profile?.dotDiam ?? 2;
  /** 行首段号「1.」：第一个是窄字（数字），紧跟一个小点。 */
  const verseNoAt = (items) => {
    if (items.length < 2) return false;
    const a = items[0].obj.bbox;
    const b = items[1].obj.bbox;
    const narrow = a.w / Math.max(a.h, 0.1) < 0.72;
    const isDot = b.w <= dot * 2 && b.h <= dot * 2;
    return narrow && isDot && b.x >= a.x;
  };
  // **剔掉行首段号**：谱面上每个谱行都重印一次，GT 里只有一处。
  const stripVerseNo = (items) => (verseNoAt(items) ? items.slice(2) : items);

  // 字格大小：拿歌词对象高度的**四分之三分位**（汉字近方）。
  // 不能用中位数——歌词带里混进一整条花边框（每片才 4.3 高、几十片）时中位数会被拽小，
  // 下面「稀疏行」的门槛跟着失灵，真歌词行反被剔掉、花边框倒留了下来（474 首实测）。
  const heights = [...mine("lyric")].map((o) => o.obj.bbox.h).sort((a, b) => a - b);
  const cell = heights.length ? heights[Math.min(heights.length - 1, Math.floor(heights.length * 0.75))] : 10.5;

  // 先把每个谱行下方的歌词聚成行
  let dropped = 0;
  const perRow = [];
  for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
    const objs = byRow.get(row).sort((a, b) => bot(a) - bot(b));
    const lines = [];
    for (const o of objs) {
      const last = lines[lines.length - 1];
      if (last && bot(o) - last.y <= 4) last.items.push(o);
      else lines.push({ y: bot(o), items: [o] });
    }
    for (const ln of lines) ln.items.sort((a, b) => a.obj.bbox.x - b.obj.bbox.x);

    // **不是歌词的那几「行」要在归段之前扔掉**，否则它们会挤占段序、把整叠词串位。
    // 两种，判据都只看排布：
    //  - **稀疏行**：三五个对象铺满整个版心宽（曲末的小装饰、落在歌词带里的记号）。
    //    真歌词一字一个音符，再宽也密得多。
    //  - **掉队行**：与上一行隔着两三行的空当（曲末的经文出处「爱永远长存 诗：」、
    //    版权注记）。歌词各段是紧挨着叠起来的，隔那么远的不是下一段。
    // 落在真歌词行旁边的零星记号（圆滑线残片、升号）会自成一「行」，
    // 挤在第 1 段之前，把整叠段序推下去一位（068 首因此三段词全错位）。
    // 判据：只有一两个对象，而且贴着某条实打实的歌词行（不到一个字高）。
    const solid = lines.filter((ln) => ln.items.length >= 5);
    // 歌词行都从版心左边起排；一两个字、又不在行首那一栏的，是落进歌词带的零星记号
    // （041 首谱行间那个孤零零的「4」把整叠段序推了一位）。
    const leftEdge = solid.length ? Math.min(...solid.map((s2) => s2.items[0].obj.bbox.x)) : 0;
    const stray = (ln) =>
      ln.items.length <= 2 &&
      (solid.some((s2) => s2 !== ln && Math.abs(s2.y - ln.y) <= cell * 0.8) ||
        (ln.items.length === 1 && ln.items[0].obj.bbox.x > leftEdge + cell * 3));

    const keep = [];
    for (const ln of lines) {
      if (stray(ln)) {
        dropped += ln.items.length;
        continue;
      }
      const it = ln.items;
      const w = it[it.length - 1].obj.bbox.x + it[it.length - 1].obj.bbox.w - it[0].obj.bbox.x;
      if (it.length >= 2 && w > cell * 6 && (it.length * cell) / w < 0.3) {
        dropped += it.length;
        continue;
      }
      if (keep.length && ln.y - keep[keep.length - 1].y > cell * 3.5) {
        dropped += it.length;
        continue;
      }
      keep.push(ln);
    }
    perRow.push(keep.map((ln) => ln.items));
  }

  // 每行归到第几段：**认行首那个段号数字，别按它在谱行里排第几**。
  // 按下标排会被谱行里混进来的杂物整段带偏——升号「#」、`D.S.`、词曲署名都可能
  // 落进歌词带自成一「行」，排在真歌词之前，后面每一段就全串了位
  // （336 首因此第 1 段少了 16 字、多出一个第 6 段）。
  // 段号数字本身不必查字典：同一首里同一个数字的**轮廓**一模一样，
  // 拿段号最全的那个谱行当样板，后面各行按形状对回去即可。既能吸收杂物行，
  // 也能对上「某一段中途没词」的谱行（那一行的段号会跳号）。
  const keyOfLine = (ln) => (shapeKey && verseNoAt(ln) ? shapeKey(ln[0].obj.data) : null);
  const numbered = (ln) => verseNoAt(ln);
  const anchor = new Map(); // 段号字形 → 段序号
  const numberedVerse = new Set(); // 哪些段是「行首印着段号」的——它们不是折行，别归并
  const misprintedNo = []; // 谱面印错的段号：{ objs, want }（want 是按位置该有的段序，0 基）
  {
    let best = -1;
    let bestN = 1; // 只有一行带段号的谱行没有样板价值
    perRow.forEach((lines, i) => {
      const n = lines.filter(numbered).length;
      if (n > bestN) {
        bestN = n;
        best = i;
      }
    });
    if (best >= 0) {
      let vi = -1;
      for (const ln of perRow[best]) {
        if (!numbered(ln)) continue;
        vi++;
        const k = keyOfLine(ln);
        if (k && !anchor.has(k)) anchor.set(k, vi);
      }
    }
  }
  const useAnchor = anchor.size >= 2; // 这首确实每行印段号，才谈得上按段号归段
  for (const lines of perRow) {
    // 认不出段号的谱行（单段歌、副歌、末行）只能按上下次序排——那本来就是段序。
    // **必须以「行首那个字形在样板里查得到」为准**，不能只看「像不像段号」：
    // 混进歌词带的和弦行/音符行开头也常是「窄字 + 小点」（`7` 后面跟个减时点），
    // 一误判就把整个谱行切到 vi=0，三段词叠成一段（279 首第 2 页实测）。
    // 段号**重号**的谱行不能按段号归：那是谱面印错了（379 首第 2 谱行印成「1. 2. 4. 4.」，
    // 第 3 段那行被标成 4）。同一谱行里的歌词行自上而下就是段序，重号时按位置排回去，
    // 并把印错的那个段号记下来（调用方据此标红、给出应有的段号）。
    const wants = lines.filter((ln) => numbered(ln)).map((ln) => anchor.get(keyOfLine(ln)));
    const known = wants.filter((v) => v != null);
    const dupNo = new Set(known).size !== known.length;
    const anchored = useAnchor && !dupNo && lines.some((ln) => numbered(ln) && anchor.has(keyOfLine(ln)));
    if (!anchored) {
      lines.forEach((ln, vi) => {
        if (dupNo && numbered(ln)) {
          const got = anchor.get(keyOfLine(ln));
          // 位置说它是第 vi 段，段号却印着别的数 → 谱面这个段号印错了
          if (got != null && got !== vi) misprintedNo.push({ objs: ln.slice(0, 2), want: vi });
        }
        (verses[vi] ??= []).push(...(dupNo ? stripVerseNo(ln) : ln));
      });
      continue;
    }
    let vi = -1; // 还没遇到段号的行：杂物/续行先归到第 1 段
    for (const ln of lines) {
      if (numbered(ln)) {
        const k = keyOfLine(ln);
        const want = anchor.has(k) ? anchor.get(k) : vi + 1;
        vi = want > vi ? want : vi + 1; // 段号只能一路往下走
      }
      if (numbered(ln)) numberedVerse.add(Math.max(vi, 0));
      (verses[Math.max(vi, 0)] ??= []).push(...stripVerseNo(ln));
    }
  }
  for (let i = 0; i < verses.length; i++) verses[i] ??= []; // 跳号会留空洞，补齐免得下面的统计吃到 undefined

  // **把折行归并回对应段。**（归并是版面处理，不是内容差异——归并了多少处会报给调用方，
  //   由 pdf-diff 单列一栏记账，不让它污染「音符/歌词录错」那类真实差异。）
  // 歌词排不下时会折到下一行，那一行不是新的一段——不归并的话，一首四段的歌会被读成
  // 八段十段，多出来的每段只有一两个字（实测全书 50.9% 的曲目段数对不上）。
  //
  // 归并要**保守**：只动字数明显零碎的那几段。试过按「每谱行歌词行数的众数」定正式段数、
  // 把多出的行整体接回去，段数是对齐了，歌词准确率却从 91.4% 掉到 88.3%——
  // 一首歌里常有谱行只带一两段词（副歌、末行），众数定不准，一错就整段错位。
  let folds = 0;
  {
    const sizes = verses.map((v) => v.length);
    const peak = Math.max(0, ...sizes);
    const mainIdx = sizes.filter((n) => n >= peak * 0.5).length; // 正式段数
    if (mainIdx > 0) {
      const avgMain = sizes.slice(0, mainIdx).reduce((a, b) => a + b, 0) / mainIdx;
      for (let k = mainIdx; k < verses.length; k++) {
        if (!verses[k]?.length) continue;
        if (numberedVerse.has(k)) continue; // 行首自己印着段号，那就是一段，再短也不是折行
        if (verses[k].length >= avgMain * 0.25) continue; // 够长，是真的一段，别动
        verses[(k - mainIdx) % mainIdx].push(...verses[k]);
        folds += verses[k].length;
        verses[k] = [];
      }
    }
  }
  const kept = verses.filter((v) => v && v.length);
  return { notes, chords, title, verses: kept, folds, dropped, misprintedNo };
}

/**
 * 词曲署名里的字形，是不是**该进比对序列**的字（不是标点）。
 * GT 的 `WordsByAndMusicBy` 只留字与数，识别侧也得按同一口径剔掉标点，两边才对得齐。
 *
 * **高和宽要一起看**，单看哪一维都会误伤：
 *  - 只看宽：`i` `l` 只有 1.9 宽，跟 `(` 一样窄，一刀切会把这两个字母丢掉——GT 里却留着，
 *    序列一长一短就对不上，自举于是永远学不会它们（`William` 读成 `Wm11mam` 就是这么来的）。
 *  - 只看高：`e` `n` `r` `o` 这些没有上下伸的小写字母才 4.3~4.4 高，与冒号同档，
 *    按高度一刀切会把半个名字丢掉（`Heber` 读成 `Hb`）。
 * 两维一起就很干净：点/冒号又矮又窄（≤4.5 × ≤2.4），括号又高又窄（≥8.5 × ≤3），
 * 字母不会同时满足。
 *
 * gen-glyphdict.mjs（建库）与 pdf-diff.mjs（比对）共用——两边必须一模一样。
 */
export function isCreditWordGlyph(b) {
  if (b.h <= 4.5 && b.w <= 2.4) return false; // 「.」「：」
  if (b.h >= 8.5 && b.w <= 3) return false; // 「(」「)」
  return true;
}

/** 音名字母 → 音阶序号。简谱数字按**拼写**算（见 CLAUDE.md 里 jpToStep 那条刻意背离）。 */
const STEP_IDX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

/**
 * MusicXML → 简谱音符数字串（0-7，0=休止）。**以 musicxml 为准**那一路的音符来源。
 *
 * 简谱数字是「相对主音的音阶级数」：`fifths` 定主音（`FIFTHS_KEY`），
 * 数字 = (音名序号 − 主音序号 mod 7) + 1。**只看字母、不看升降号**——
 * 谱面上升降号印在音符左上方、是另一个对象，两边都不计（识别侧同样只取 0-7）。
 *
 * 和弦附音（`<chord/>`）不占格；`<rest/>` 记 0，谱面上休止就印作 `0`。
 */
export function xmlNoteDigits(musicxml) {
  // 注：`<note[ >]` 不能写成 `<note\b`——`\b` 在 `<note-size>`（`<defaults>` 里的）
  // 前面也成立，那一匹配会一路吞到第一个 `</note>`，把开头的调号和首音一起吃掉。
  const out = [];
  let tonic = 0;
  // **要按文档顺序走**，遇到 `<fifths>` 就换主音：曲中转调的谱面从那里起按新调记数字
  // （021/137 首 ♭E 转 F、144 首 F 转 G），只认第一个调号会让转调之后整段全错。
  let divisions = 1;
  let beatType = 4;
  for (const m of musicxml.matchAll(
    /<fifths>(-?\d+)<\/fifths>|<divisions>(\d+)<\/divisions>|<beat-type>(\d+)<\/beat-type>|<note[ >][\s\S]*?<\/note>/g,
  )) {
    if (m[1] !== undefined) {
      const key = FIFTHS_KEY[String(Number(m[1]))] ?? "C";
      tonic = STEP_IDX[key[key.length - 1]] ?? 0;
      continue;
    }
    if (m[2] !== undefined) {
      divisions = Number(m[2]) || 1;
      continue;
    }
    if (m[3] !== undefined) {
      beatType = Number(m[3]) || 4;
      continue;
    }
    const seg = m[0];
    if (/<chord\s*\/>/.test(seg)) continue;
    if (/<rest\s*\/?>/.test(seg)) {
      // **休止按拍数写 `0`**：谱面上二分休止印「0 0」、全休止印「0 0 0 0」，
      // musicxml 只记一个 `<rest>`（019 首因此报出 8 处「PDF 多出 0」）。
      // 一拍 = 拍号分母那个音符：4/4 是四分音符，6/8 是八分音符。
      out.push("0");
      continue;
    }
    const step = /<step>([A-G])<\/step>/.exec(seg)?.[1];
    if (!step) continue;
    out.push(String(((((STEP_IDX[step] - tonic) % 7) + 7) % 7) + 1));
  }
  return out.join("");
}

/**
 * MusicXML → 各段歌词（`<lyric number="N">` 按音符顺序拼）。
 * 一个音符上可能挂多段；段号就是 `number`。
 */
export function xmlLyricVerses(musicxml) {
  const byVerse = new Map();
  for (const m of musicxml.matchAll(/<note[ >][\s\S]*?<\/note>/g)) {
    for (const l of m[0].matchAll(/<lyric\b[^>]*number="(\d+)"[^>]*>([\s\S]*?)<\/lyric>/g)) {
      const v = Number(l[1]);
      const txt = [...l[2].matchAll(/<text>([^<]*)<\/text>/g)].map((x) => x[1]).join("");
      byVerse.set(v, (byVerse.get(v) ?? "") + txt);
    }
  }
  // 行首段号「1.」谱面上每个谱行都重印一次、识别侧按几何剔掉了，GT 侧也剔
  return [...byVerse.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([verse, text]) => ({ verse, chars: unescapeXml(text).replace(/^\s*\d+\s*[.．、]\s*/, "") }));
}

/** MusicXML → 曲名。 */
export function xmlTitle(musicxml) {
  const t = /<movement-title>([^<]*)<\/movement-title>/.exec(musicxml)?.[1] ?? /<work-title>([^<]*)<\/work-title>/.exec(musicxml)?.[1] ?? "";
  return unescapeXml(t).trim();
}

/** MusicXML → 词曲署名。
 *  全书 485 首把两行都塞在一个 `<creator type="composer">` 里（「作词：…\n作曲：…」），
 *  个别几首拆成 composer + lyricist 两条——**要按谱面的次序排：先词后曲**。 */
export function xmlCredit(musicxml) {
  const rank = { lyricist: 0, poet: 0, translator: 1, composer: 2, arranger: 3 };
  return [...musicxml.matchAll(/<creator\b[^>]*type="(\w+)"[^>]*>([\s\S]*?)<\/creator>/g)]
    .map((m) => ({ r: rank[m[1]] ?? 9, t: unescapeXml(m[2]) }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.t)
    .join("");
}

function unescapeXml(t) {
  return t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** MusicXML 的 `<harmony>` → 谱面上印的和弦文本序列。
 *  谱面写法是**升降号在前**（`#Fm`、`♭B`），与 MusicXML 的 root-step + root-alter 顺序相反。 */
export function gtHarmonies(musicxml) {
  const out = [];
  for (const m of musicxml.matchAll(/<harmony\b[^>]*>([\s\S]*?)<\/harmony>/g)) {
    const seg = m[1];
    const step = /<root-step>([A-G])<\/root-step>/.exec(seg)?.[1];
    if (!step) continue;
    const alter = Number(/<root-alter>(-?\d+)<\/root-alter>/.exec(seg)?.[1] ?? 0);
    const kindText = /<kind[^>]*\btext="([^"]*)"/.exec(seg)?.[1] ?? "";
    const bass = /<bass-step>([A-G])<\/bass-step>/.exec(seg)?.[1];
    const bassAlter = Number(/<bass-alter>(-?\d+)<\/bass-alter>/.exec(seg)?.[1] ?? 0);
    const acc = (a) => (a > 0 ? "#" : a < 0 ? "♭" : "");
    let s = acc(alter) + step + kindText;
    if (bass) s += "/" + acc(bassAlter) + bass;
    out.push(s);
  }
  return out;
}

/** fifths → 调名（简谱写作 `1=X`）。升号调用 #、降号调用 ♭，与谱面写法一致。 */
const FIFTHS_KEY = {
  "-7": "♭C", "-6": "♭G", "-5": "♭D", "-4": "♭A", "-3": "♭E", "-2": "♭B", "-1": "F",
  0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "#F", 7: "#C",
};

/** MusicXML → 调号与拍号。取第一个 `<attributes>` 里的，转调另算（谱面上少见）。 */
export function gtKeyTime(musicxml) {
  const fifths = Number(/<fifths>(-?\d+)<\/fifths>/.exec(musicxml)?.[1] ?? 0);
  const beats = Number(/<beats>(\d+)<\/beats>/.exec(musicxml)?.[1] ?? 0);
  const beatType = Number(/<beat-type>(\d+)<\/beat-type>/.exec(musicxml)?.[1] ?? 0);
  return { fifths, key: FIFTHS_KEY[String(fifths)] ?? "?", beats, beatType };
}

/**
 * MusicXML → 圆滑线与连音线，按**音符序号**表示成 [起, 止] 区间。
 *
 * 音符序号只数**发声的音符**（跳过 `<rest/>` 与和弦附音 `<chord/>`），与识别侧
 * 「谱面上数得出来的音符格」对得上。
 */
export function gtSlurTie(musicxml) {
  const slurs = [];
  const ties = [];
  const openSlur = new Map(); // number → 起始音符序号
  let openTie = null;
  let n = -1;
  for (const m of musicxml.matchAll(/<note[ >][\s\S]*?<\/note>/g)) {
    const seg = m[0];
    if (/<chord\s*\/>/.test(seg)) continue; // 和弦附音不单独占一格
    n++;
    if (/<rest\s*\/>/.test(seg)) continue; // 休止不挂弧
    for (const s of seg.matchAll(/<slur\b[^>]*\/>/g)) {
      const tag = s[0];
      const num = /number="(\d+)"/.exec(tag)?.[1] ?? "1";
      if (/type="start"/.test(tag)) openSlur.set(num, n);
      else if (/type="stop"/.test(tag) && openSlur.has(num)) {
        slurs.push([openSlur.get(num), n]);
        openSlur.delete(num);
      }
    }
    for (const t of seg.matchAll(/<tied\b[^>]*\/>/g)) {
      if (/type="start"/.test(t[0])) openTie ??= n;
      else if (/type="stop"/.test(t[0]) && openTie != null) {
        ties.push([openTie, n]);
        openTie = null;
      }
    }
  }
  slurs.sort((a, b) => a[0] - b[0]);
  ties.sort((a, b) => a[0] - b[0]);
  return { slurs, ties };
}

/** MusicXML → 反复与房号。 */
export function gtRepeats(musicxml) {
  const repeats = [...musicxml.matchAll(/<repeat\b[^>]*direction="(\w+)"/g)].map((m) => m[1]);
  const endings = [...musicxml.matchAll(/<ending\b[^>]*number="([^"]*)"[^>]*type="(\w+)"/g)].map((m) => ({
    number: m[1],
    type: m[2],
  }));
  // 只数结构性的小节线（终止线、复纵线），普通细线不算
  const barStyles = [...musicxml.matchAll(/<bar-style>([\w-]+)<\/bar-style>/g)]
    .map((m) => m[1])
    .filter((b) => b !== "regular");
  return { repeats, endings, barStyles };
}


/** `.Title` 里的 `WordsByAndMusicBy`。**取最后一条非空的**：有的文件写了两条，
 *  第一条是空的；`=` 后面只吃横向空白，吃到换行就会把下一行整条卷进来。 */
export function creditField(titleSec) {
  let out = "";
  for (const m of (titleSec ?? "").matchAll(/WordsByAndMusicBy[^\S\r\n]*=[^\S\r\n]*\{?([^}\r\n]*)\}?/g)) {
    if (m[1].trim()) out = m[1];
  }
  return out;
}

/**
 * 逐曲采集「页面字形序列 + 对应的 GT 串」。
 *
 * 字形自举（gen-glyphdict）与补字表（gen-backfill）**必须共用这一份取法**：
 * 两边若对不同的序列做对齐，学到的字与补上的字就会打架。
 *
 * @param keyOf 形状键回调。gen-glyphdict 传的是「注册进形状表并返回代表键」，
 *              gen-backfill 传的是纯 shapeKey。
 */
export async function collectSongItems({ cli, doc, OPS, profile, byId, songs, keyOf, invCache = new Map() }) {
  const items = [];
  const bot = (o) => o.obj.bbox.y + o.obj.bbox.h;
for (const [id, entries] of byId) {
  const song = songs.get(id);
  if (!song?.jpwabc) continue;
  const notes = [];
  const verseRows = [];
  const title = [];
  const chords = [];
  const credits = [];
  const category = [];
  const footers = [];
  for (const e of entries) {
    let inv = invCache.get(e.page);
    if (!inv) {
      const g = await doc.getPage(e.page);
      const vp = await cli.extractVectorPage(g, OPS);
      g.cleanup();
      inv = cli.classifyPage(vp, profile);
      invCache.set(e.page, inv);
    }
    const got = collectSongGlyphs(inv, e, profile, cli.shapeKey);
    for (const o of got.notes) notes.push(keyOf(o));
    for (const o of got.title) title.push(keyOf(o));
    for (const o of got.chords) chords.push(keyOf(o));
    // 词曲署名：**按基线分行再按 x 排**（作词一行、作曲一行交错排，照 x 直读会串行）
    {
      const lines = [];
      for (const o of inv.objs
        .filter((x) => x.cls === "credit" && !x.dup && x.obj.bbox.y >= (e.yFrom ?? 0) && x.obj.bbox.y < (e.yTo ?? 1e9))
        .sort((a, b) => bot(a) - bot(b))) {
        const last = lines[lines.length - 1];
        // 容差 5 而不是 3：生卒年印得略高，卡在 3 上会被切成另一行、排到人名前面（同 pdf-diff）
        if (last && bot(o) - last.bot <= 5) last.items.push(o);
        else lines.push({ bot: bot(o), items: [o] });
      }
      // 标点（`：` `.` `(` `)`）不进这条序列：GT 那边只留字与数，留着两边永远对不齐
      for (const ln of lines)
        for (const o of ln.items.sort((a, b) => a.obj.bbox.x - b.obj.bbox.x)) if (isCreditWordGlyph(o.obj.bbox)) credits.push(keyOf(o));
    }
    if (e.startsHere) {
      for (const o of inv.objs.filter((x) => x.cls === "category" && !x.dup).sort((a, b) => a.obj.bbox.x - b.obj.bbox.x))
        category.push(keyOf(o));
      // 页脚是「·书页码·」。首曲 001 在 PDF 第 33 页、书页 1，故书页码 = PDF 页 − 32。
      footers.push({ keys: inv.objs.filter((x) => x.cls === "footer" && !x.dup).sort((a, b) => a.obj.bbox.x - b.obj.bbox.x).map(keyOf), text: `\u00b7${e.page - 32}\u00b7` });
    }
    got.verses.forEach((ln, vi) => {
      (verseRows[vi] ??= []).push(...ln);
    });
  }
  if (invCache.size > 40) invCache.clear();

  const gt = await readSongGt(song);
  const sec = jpwSections(gt.jpwabc);
  items.push({
    id,
    gtNotes: gtNoteDigits(sec.Voice || ""),
    gtVerses: gtLyricVerses(sec.Words || "").map((v) => v.chars),
    gtTitle: song.title,
    gtChords: gt.musicxml ? gtHarmonies(gt.musicxml).join("") : "",
    gtCategory: (song.category ?? "").replace(/\s+/g, ""),
    // GT 的署名字段：`词曲：(加)宣信(1843-1919)`。谱面上的标点/空格随排版走，只留字与数
    gtCredit: (creditField(sec.Title))
      .replace(/\\n/g, "")
      .match(/[\u4e00-\u9fff0-9A-Za-z]/g)
      ?.join("") ?? "",
    notes,
    verses: verseRows.map((r) => r.map(keyOf)),
    title,
    chords,
    credits,
    category,
    footers,
  });
}
  return items;
}
