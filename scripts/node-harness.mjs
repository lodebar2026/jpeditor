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
  const verses = [];
  let cur = null;
  for (const line of wordsText.split(/\r?\n/)) {
    const m = /^W(\d+)(?:-\d+)?(?:\([^)]*\))?@/.exec(line.trim());
    if (m) {
      cur = { verse: Number(m[1]), text: "" };
      verses.push(cur);
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
 * 从一页的归类结果里，按曲目分区取出该首的字形序列。
 * gen-glyphdict.mjs 与 pdf-diff.mjs 共用——两边的取法必须一模一样，
 * 否则建字典时的位置和查字典时的位置对不上。
 *
 * @param entry pagemap 里的一条（含 page / yFrom / yTo / startsHere）
 * @returns { notes, chords, title, verses }，元素都是归类后的对象
 */
export function collectSongGlyphs(inv, entry, profile) {
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
  const stripVerseNo = (items) => {
    // **剔掉行首段号**「1.」：谱面上每个谱行都重印一次，GT 里只有一处。
    // 按几何认：第一个是窄字（数字），紧跟一个小点。
    if (items.length < 2) return items;
    const a = items[0].obj.bbox;
    const b = items[1].obj.bbox;
    const narrow = a.w / Math.max(a.h, 0.1) < 0.72;
    const isDot = b.w <= dot * 2 && b.h <= dot * 2;
    return narrow && isDot && b.x >= a.x ? items.slice(2) : items;
  };

  // 先把每个谱行下方的歌词聚成行
  const perRow = [];
  for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
    const objs = byRow.get(row).sort((a, b) => bot(a) - bot(b));
    const lines = [];
    for (const o of objs) {
      const last = lines[lines.length - 1];
      if (last && bot(o) - last.y <= 4) last.items.push(o);
      else lines.push({ y: bot(o), items: [o] });
    }
    perRow.push(lines.map((ln) => stripVerseNo(ln.items.sort((a, b) => a.obj.bbox.x - b.obj.bbox.x))));
  }

  for (const lines of perRow) lines.forEach((ln, vi) => (verses[vi] ??= []).push(...ln));

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
        if (verses[k].length >= avgMain * 0.25) continue; // 够长，是真的一段，别动
        verses[(k - mainIdx) % mainIdx].push(...verses[k]);
        folds += verses[k].length;
        verses[k] = [];
      }
    }
  }
  const kept = verses.filter((v) => v && v.length);
  return { notes, chords, title, verses: kept, folds };
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
  for (const m of musicxml.matchAll(/<note\b[\s\S]*?<\/note>/g)) {
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
