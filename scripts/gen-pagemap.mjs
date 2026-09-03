// 页 → 曲 映射：读每页的曲号数字，与 GT 曲目清单按页序对齐，产出 testdata/500/pagemap.json。
//
// 曲号字形只种了十个数字（testdata/500/glyph-seed.tsv，按字形肉眼判定），
// J01/D12 那些字母**不需要认**——曲目在书里按 songRank 顺序排，顺序消费即可对上。
//
// 两条实测出来的判据：
//  - **起始页必须印着曲号**。只看「有没有标题」会把扉页/前言里的大字当成一首（实测 p4
//    吃掉了 001，导致其后整本错位一格）。
//  - **一页可能不止一首**：J/D 短歌两首挤一页（实测 p612 有三个标题带）。故标题与曲号
//    各按 y 聚成组再配对，一组算一首。
//
//   npm run build:cli && node gen-pagemap.mjs
import { readFile, writeFile } from "node:fs/promises";
import { loadCli, openPdf, loadCorpus, songRank } from "./node-harness.mjs";

const SEED = "testdata/500/glyph-seed.tsv";
const OUT = "testdata/500/pagemap.json";

const cli = await loadCli();
const { doc, OPS } = await openPdf();
const { songs } = await loadCorpus();

const seed = new Map();
for (const line of (await readFile(SEED, "utf8")).split("\n")) {
  if (!line.trim() || line.startsWith("#")) continue;
  const [k, c] = line.split("\t");
  seed.set(k, c);
}

const sample = [];
for (let p = 40; p <= 200; p += 4) {
  const g = await doc.getPage(p);
  sample.push(await cli.extractVectorPage(g, OPS));
  g.cleanup();
}
const profile = cli.detectProfile(sample, "hymn500");

/** 按 y 把对象聚成带。 */
function bandsOfY(arr, tol) {
  const gs = [];
  for (const o of arr.slice().sort((a, b) => a.obj.bbox.y - b.obj.bbox.y)) {
    const last = gs[gs.length - 1];
    if (last && o.obj.bbox.y - last.y <= tol) last.items.push(o);
    else gs.push({ y: o.obj.bbox.y, items: [o] });
  }
  return gs;
}

const pageInfo = [];
for (let pn = 1; pn <= doc.numPages; pn++) {
  const g = await doc.getPage(pn);
  const vp = await cli.extractVectorPage(g, OPS);
  g.cleanup();
  const inv = cli.classifyPage(vp, profile);

  const titleGs = bandsOfY(inv.objs.filter((o) => o.cls === "title" && !o.dup), 12);
  const numGs = bandsOfY(inv.objs.filter((o) => o.cls === "songNumber" && !o.dup), 12);
  const reads = numGs.map((gp) => {
    const s = gp.items
      .sort((a, b) => a.obj.bbox.x - b.obj.bbox.x)
      .map((o) => seed.get(cli.shapeKey(o.obj.data)) ?? "?")
      .join("");
    const cleaned = s.replace(/\?/g, "");
    return { y: gp.y, raw: s, num: cleaned && /^\d+$/.test(cleaned) ? Number(cleaned) : null };
  });

  const starts = [];
  for (const tg of titleGs) {
    let near = null;
    let bestD = Infinity;
    for (const r of reads) {
      const d = Math.abs(r.y - tg.y);
      if (d < bestD) {
        bestD = d;
        near = r;
      }
    }
    if (near && bestD <= 20) starts.push({ y: tg.y, num: near.num, raw: near.raw });
  }
  const noteCount = inv.objs.filter((o) => o.cls === "note" && !o.dup).length;
  pageInfo.push({ page: pn, starts, bands: inv.bands.length, notes: noteCount, objs: vp.objs.length, height: vp.height });
}

const list = [...songs.values()].sort((a, b) => songRank(a.id) - songRank(b.id));
const numOf = (id) => Number(/(\d+)/.exec(id)[1]);

const map = [];
const warn = [];
let si = 0;
for (const p of pageInfo) {
  if (!p.bands || p.notes < 4) continue; // 无谱行 / 几乎没有音符 = 非乐谱页
  if (!p.starts.length) {
    // 续页必须**紧接着**上一页。不加这条，书末的索引页（偶尔也判出谱行）会被一路挂到
    // 最后一首身上——实测 D28 曾吞进 6006 个「音符」。
    const prev = map[map.length - 1];
    if (prev && p.page === prev.page + 1) {
      map.push({ page: p.page, id: prev.id, title: prev.title, num: null, startsHere: false, yFrom: 0, yTo: p.height });
    }
    continue;
  }
  // **页顶可能是前一首的续尾**：上一首在这页收尾（无标题），新一首从页面中部起
  // （实测 p65 顶部是 32 首的末三行，33 首从 y≈320 开始）。第一个标题带明显不在页顶时，
  // 顶部那一段要归给前一首，否则会被算进新一首。
  if (p.starts[0].y - 12 > p.height * 0.2) {
    const prev = map[map.length - 1];
    if (prev && p.page === prev.page + 1) {
      map.push({ page: p.page, id: prev.id, title: prev.title, num: null, startsHere: false, yFrom: 0, yTo: p.starts[0].y - 12 });
    }
  }
  for (let k = 0; k < p.starts.length; k++) {
    const st = p.starts[k];
    // 一页多首（J/D 短歌）：按标题带把页面纵向切给各首，否则整页对象都算进第一首。
    const yFrom = st.y - 12;
    const yTo = k + 1 < p.starts.length ? p.starts[k + 1].y - 12 : p.height;
    let hit = si;
    if (st.num != null && (si >= list.length || numOf(list[si].id) !== st.num)) {
      const from = Math.max(0, si - 2);
      const end = Math.min(list.length, si + 12);
      let k = from;
      for (; k < end; k++) if (numOf(list[k].id) === st.num) break;
      if (k < end) hit = k;
      else warn.push(`p${p.page} 读到曲号 ${st.raw}，清单此处是 ${list[si]?.id ?? "(用尽)"}`);
    }
    if (hit >= list.length) {
      warn.push(`p${p.page} 曲目清单已用尽（读数 ${st.raw}）`);
      continue;
    }
    map.push({ page: p.page, id: list[hit].id, title: list[hit].title, num: st.num, startsHere: true, yFrom, yTo });
    si = hit + 1;
  }
}

const started = map.filter((m) => m.startsHere);
const covered = new Set(started.map((m) => m.id));
const missing = list.filter((s) => !covered.has(s.id));

await writeFile(
  OUT,
  JSON.stringify(
    { pdf: "诗歌500首内页校再校对编定稿2019年2月.pdf", pages: doc.numPages, songs: list.length, map, missing: missing.map((s) => s.id), warnings: warn },
    null,
    1,
  ),
);

console.log(`乐谱页 ${map.length}，起始 ${started.length}，覆盖曲目 ${covered.size}/${list.length}`);
if (missing.length) console.log(`未映射 ${missing.length}：`, missing.map((s) => s.id).join(" "));
if (warn.length) console.log(`告警 ${warn.length}：\n  ` + warn.slice(0, 10).join("\n  "));
const cont = map.filter((m) => !m.startsHere);
console.log(`续页 ${cont.length}：`, cont.slice(0, 12).map((m) => `p${m.page}→${m.id}`).join(" "));
console.log(`→ ${OUT}`);
