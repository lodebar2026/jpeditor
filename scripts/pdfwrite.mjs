// DrawList → PDF。**全仓库唯一写 PDF 的地方**，A 路（原位替换）与 B 路（数据重排）共用。
//
// 从 relayout.mjs 的 text 模式抽出来并升级：按角色多字体嵌入、逐字笔位换算、
// 缺字按字体链回退、字距用 Tc 撑开（保住 PDF 文本层的连续词）。
//
// 为什么不用 Chromium printToPDF：CDP 传整份 666 页会 Printing failed / Page crashed，
// 只能分批，而每批各嵌一份字体子集（实测 666 页 43MB）。pdf-lib 一次嵌一份，12MB 出头。
import { writeFile } from "node:fs/promises";
import { resolveBookFonts } from "./fontres.mjs";

/** 半角 CJK 标点 → 全角等价。排版器为对位把标点压成半角（LayoutOptions.halfWidthPunct），
 *  但宋体一类的字体没有 U+FF61 这些半角形，画出来是空白。找不到字形时退到等价的全角字符：
 *  宽度会宽一点，但字在，内容不丢。 */
const PUNCT_EQUIV = {
  "\uff61": "。", "\uff62": "「", "\uff63": "」", "\uff64": "、", "\uff65": "・",
  "\uff0e": "．", "\uff0c": "，",
};

/** 需要隐藏搜索层的角色：这些是「词」，要能搜。音符/和弦不需要。 */
const SEARCH_ROLES = new Set(["lyric", "lyric2", "title", "credit", "story", "toc", "header", "sectionWord", "category"]);

/** pdf-lib 的 drawSvgPath **不支持二次贝塞尔 Q**（它把 Q 派给三次曲线的处理函数，
 *  参数少两个，直接崩在 numberToString 里、错误信息完全看不出出处）。
 *  矢量抽取器与 opentype 都会产出 Q，所以在这里统一升成 C：
 *  C1 = P0 + 2/3(Q−P0)，C2 = P2 + 2/3(Q−P2)。 */
export function quadToCubic(d) {
  if (!d || d.indexOf("Q") < 0) return d;
  const tok = d.match(/[MLCQZmlcqz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  let out = "";
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < tok.length) {
    const c = tok[i++];
    const num = (k) => Number(tok[i + k]);
    if (c === "M" || c === "L") {
      x = num(0);
      y = num(1);
      out += `${c}${tok[i]} ${tok[i + 1]}`;
      i += 2;
    } else if (c === "C") {
      x = num(4);
      y = num(5);
      out += `C${tok.slice(i, i + 6).join(" ")}`;
      i += 6;
    } else if (c === "Q") {
      const qx = num(0);
      const qy = num(1);
      const px = num(2);
      const py = num(3);
      const c1x = x + (2 / 3) * (qx - x);
      const c1y = y + (2 / 3) * (qy - y);
      const c2x = px + (2 / 3) * (qx - px);
      const c2y = py + (2 / 3) * (qy - py);
      out += `C${c1x.toFixed(3)} ${c1y.toFixed(3)} ${c2x.toFixed(3)} ${c2y.toFixed(3)} ${px} ${py}`;
      x = px;
      y = py;
      i += 4;
    } else if (c === "Z" || c === "z") {
      out += "Z";
    } else {
      // 相对命令等这里用不到；遇到就原样透传，交给 badPath 兜
      out += c;
    }
  }
  return out;
}

/** 画路径前先验一遍：路径里混进 NaN/undefined 会让 pdf-lib 在 numberToString 里崩，
 *  错误信息完全看不出是哪一页哪个对象。宁可丢掉这一条并记账。 */
function badPath(d) {
  return !d || /NaN|undefined|Infinity/.test(d);
}

const rgbOf = (v) => {
  const n = v ?? 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** 一个字的墨迹范围（相对笔位，pt）。fontkit 的 bbox 是字体单位，按 unitsPerEm 折算。 */
function inkOf(metric, ch, size) {
  const upem = metric.unitsPerEm || 1000;
  let g = null;
  try {
    g = metric.layout(ch).glyphs[0] ?? null;
  } catch {
    return null;
  }
  const b = g?.bbox;
  if (!b || !Number.isFinite(b.minX)) return null;
  return { left: (b.minX / upem) * size, width: ((b.maxX - b.minX) / upem) * size };
}

function advOf(metric, text, size) {
  const upem = metric.unitsPerEm || 1000;
  try {
    return (metric.layout(text).advanceWidth / upem) * size;
  } catch {
    return 0;
  }
}

function hasGlyph(metric, ch) {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  try {
    return metric.hasGlyphForCodePoint ? metric.hasGlyphForCodePoint(cp) : true;
  } catch {
    return false;
  }
}

/**
 * DrawBook → PDF 文件。
 * @param {{style: object, source: string, pages: object[]}} book
 * @param {{out: string, title?: string, strict?: boolean}} opt
 * @returns {Promise<{pages:number, bytes:number, missing:object[], missingFonts:object[], notSubset:object[], fallbacks:object[]}>}
 */
export async function writePdf(book, opt) {
  const { PDFDocument, rgb, setCharacterSpacing, setTextRenderingMode, TextRenderingMode } = await import("pdf-lib");
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  const style = book.style;

  const { fonts, missing: missingFonts } = await resolveBookFonts(style);
  const metrics = new Map(); // fontId → fontkit Font
  for (const [id, f] of Object.entries(fonts)) metrics.set(id, fontkit.create(Buffer.from(f.bytes)));

  // 回退链：角色的主字体 → 同书其它字体。♭ 只有 Bravura 有、汉字只有中文字体有，
  // 缺字若不回退，pdf-lib 会静默画成 .notdef（回读出来是 U+0000，不是报错）。
  const chainOf = (role) => {
    const main = style.roles[role]?.font;
    const rest = Object.keys(fonts).filter((id) => id !== main);
    return [main, ...rest].filter((id) => id && fonts[id]);
  };

  // mode:"path" 的字体不嵌入，改用轮廓画（见 FontRef.mode 的注释）。
  // 轮廓取自 **fontkit**（就是上面算度量那一份），不用 opentype.js：
  // 后者对这套魏碑的少数字形会吐出带 NaN / 参数不全的路径（实测「作」「渣」「你」三个字）。
  const outlines = new Set(Object.keys(fonts).filter((id) => style.fonts[id]?.mode === "path"));
  const notSubsetEarly = [];
  /** 一个字的轮廓（SVG 系、已放到笔位上）。 */
  const glyphPath = (id, ch, size, penX, baselineY) => {
    const font = metrics.get(id);
    const g = font?.layout(ch)?.glyphs?.[0];
    if (!g?.path) return null;
    const s = size / (font.unitsPerEm || 1000);
    return g.path.transform(s, 0, 0, -s, penX, baselineY).toSVG();
  };
  // 轮廓模式的行没有可见文字，隐藏搜索层得借一个能嵌、有汉字的字体来写。
  const searchFallbackId = Object.keys(fonts).find((id) => !outlines.has(id) && hasGlyph(metrics.get(id), "一")) ?? null;

  // ── 预扫描：定下每个字用哪个字体，同时算出到底要嵌哪几份
  //    （嵌了却一个字都没画的 CFF 字体，子集是空的，保存时会崩在 CFF 编码上）
  const pick = new Map(); // `${role}|${ch}` → fontId | null
  const usedFonts = new Set();
  const missing = [];
  const fallbacks = [];
  /** (角色, 字) → { 用哪个字体, 实际画哪个字 }；都找不到时 null。 */
  const pickGlyph = (role, ch) => {
    const k = `${role}|${ch}`;
    if (pick.has(k)) return pick.get(k);
    const chain = chainOf(role);
    let got = null;
    for (const cand of [ch, PUNCT_EQUIV[ch]].filter(Boolean)) {
      for (const id of chain) {
        if (hasGlyph(metrics.get(id), cand)) {
          got = { id, ch: cand };
          break;
        }
      }
      if (got) break;
    }
    if (got && got.id !== chain[0]) fallbacks.push({ role, ch, from: chain[0], to: got.id });
    if (got && got.ch !== ch) fallbacks.push({ role, ch, from: ch, to: got.ch });
    pick.set(k, got);
    if (got) usedFonts.add(got.id);
    return got;
  };
  const fontFor = (role, ch) => pickGlyph(role, ch)?.id ?? null;
  const charFor = (role, ch) => pickGlyph(role, ch)?.ch ?? ch;
  for (const p of book.pages)
    for (const it of p.items)
      if (it.t === "text") for (const ch of it.text) if (ch.trim()) fontFor(it.role, ch);
  if (searchFallbackId && [...usedFonts].some((id) => outlines.has(id))) usedFonts.add(searchFallbackId);

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  if (opt.title) doc.setTitle(opt.title);
  doc.setCreator("jpeditor-web / pdfwrite.mjs");

  const searchLayer = opt.searchLayer !== false;
  const notSubset = [...notSubsetEarly];
  const embedded = new Map(); // fontId → PDFFont（同一份字节只嵌一次）
  const byKey = new Map();
  for (const id of usedFonts) {
    if (outlines.has(id)) continue; // 走轮廓，不嵌
    const f = fonts[id];
    if (byKey.has(f.key)) {
      embedded.set(id, byKey.get(f.key));
      continue;
    }
    let font;
    try {
      font = await doc.embedFont(f.bytes, { subset: true });
    } catch (e) {
      // CFF2 可变字体（PingFang 那类）子集化会失败。整份嵌仍能出正确的 PDF，
      // 只是体积暴涨——报出来，好换一个能子集的同族字体。
      font = await doc.embedFont(f.bytes, { subset: false });
      notSubset.push({ id, family: f.family, reason: String(e?.message ?? e) });
    }
    byKey.set(f.key, font);
    embedded.set(id, font);
  }

  for (const p of book.pages) {
    const pg = doc.addPage([p.w, p.h]);
    const flip = (y) => p.h - y; // 规格是 SVG 系（左上原点、y 向下），PDF 是左下原点
    for (const it of p.items) {
      switch (it.t) {
        case "rect": {
          const [r, g, b] = rgbOf(it.fill ?? 0);
          pg.drawRectangle({ x: it.x, y: flip(it.y + it.h), width: it.w, height: it.h, color: rgb(r, g, b) });
          break;
        }
        case "line": {
          const [r, g, b] = rgbOf(it.color ?? 0);
          pg.drawLine({ start: { x: it.x1, y: flip(it.y1) }, end: { x: it.x2, y: flip(it.y2) }, thickness: it.sw, color: rgb(r, g, b) });
          break;
        }
        case "path": {
          const [r, g, b] = rgbOf(it.fill ?? it.stroke ?? 0);
          // d 的坐标已经是设备坐标（SVG 系），把 SVG 原点对到页左上角即可
          // 一条路径画不出不该炸整本：记账、跳过、继续。
          const dd = quadToCubic(it.d);
          if (badPath(dd)) {
            missing.push({ page: p.pageNo, role: "path", ch: "", note: "路径含 NaN" });
            break;
          }
          try {
            pg.drawSvgPath(dd, {
              x: 0,
              y: p.h,
              color: it.fill == null ? undefined : rgb(r, g, b),
              borderColor: it.stroke == null ? undefined : rgb(r, g, b),
              borderWidth: it.sw ?? 0,
            });
          } catch (e) {
            missing.push({ page: p.pageNo, role: "path", ch: "", note: `画不出：${e?.message ?? e}`, d: dd.slice(0, 120) });
          }
          break;
        }
        case "text":
          drawText(pg, it, p, flip(it.y));
          break;
      }
    }
  }

  function drawText(pg, it, page, y) {
    const [r, g, b] = rgbOf(it.color ?? 0);
    const color = rgb(r, g, b);
    const chars = [...it.text];
    const mainId = chainOf(it.role)[0];
    const mainMetric = metrics.get(mainId);
    if (!mainMetric) return;

    // 逐字笔位。align 决定怎么从「原件量到的墨迹左缘」换算成「PDF 的笔位」。
    let pens;
    if (it.align === "pen") {
      pens = chars.map((_, i) => it.xs[i] ?? it.xs[0] ?? 0);
    } else if (it.align === "inkCenter") {
      // 原件是逐字方格定位的（歌词/音符/和弦）：把新字体的**墨迹**摆到原墨迹的中心。
      // 直接拿 ch.x 当笔位会整体偏一个 sidebearing。
      pens = chars.map((c, i) => {
        const id = fontFor(it.role, c) ?? mainId;
        const x0 = it.xs[i] ?? 0;
        const w = it.ws?.[i] ?? 0;
        const ink = inkOf(metrics.get(id), c, it.size);
        return ink ? x0 + w / 2 - (ink.left + ink.width / 2) : x0;
      });
    } else {
      // 连排文字：整段自然排。自然宽与原件差得多（>8%）时按逐字摆，绝不横向缩放。
      const natural = advOf(mainMetric, it.text, it.size);
      const boxW = it.box?.w ?? natural;
      const lead = inkOf(mainMetric, chars[0] ?? " ", it.size)?.left ?? 0;
      let x = (it.xs[0] ?? 0) - lead;
      if (it.align === "right" || it.align === "outer") x = (it.box ? it.box.x + boxW : x) - natural;
      else if (it.align === "center") x = (it.box ? it.box.x + boxW / 2 : x) - natural / 2;
      if (boxW > 0 && Math.abs(natural - boxW) / boxW > 0.08) {
        pens = chars.map((c, i) => (it.xs[i] ?? 0) - (inkOf(metrics.get(fontFor(it.role, c) ?? mainId), c, it.size)?.left ?? 0));
      } else {
        pens = [];
        let cx = x;
        for (const c of chars) {
          pens.push(cx);
          cx += advOf(metrics.get(fontFor(it.role, c) ?? mainId), c, it.size);
        }
      }
    }

    // 切段：同字体、等字距的连排成一段，一次 showText。
    //
    // 为什么不能一个字一次 drawText：pdfjs 提取文本时按字距插空格，
    // 「神配受崇拜」会变成「神 配 受 崇 拜」。简谱歌词的字距是为对位撑开的，
    // 也不能靠紧排回避——所以用**字符间距 Tc**：它算进 advance，一次 showText
    // 就能摆出宽字距。
    let i = 0;
    while (i < chars.length) {
      const c0 = chars[i];
      if (!c0.trim()) {
        i++;
        continue;
      }
      const id = fontFor(it.role, c0);
      if (!id) {
        missing.push({ page: page.pageNo, role: it.role, ch: c0 });
        i++;
        continue;
      }
      const metric = metrics.get(id);
      if (outlines.has(id)) {
        // 轮廓模式：逐字画路径（位置就是算好的笔位，opentype 的坐标系与 SVG 一致）
        for (let k = i; k < chars.length; k++) {
          const c = chars[k];
          if (!c.trim()) continue;
          if (fontFor(it.role, c) !== id) break;
          const d = quadToCubic(glyphPath(id, charFor(it.role, c), it.size, pens[k], it.y));
          let ok = false;
          if (d && !badPath(d)) {
            try {
              pg.drawSvgPath(d, { x: 0, y: page.h, color });
              ok = true;
            } catch (e) {
              missing.push({ page: page.pageNo, role: it.role, ch: c, note: `轮廓画不出：${e?.message ?? e}`, d: d.slice(0, 120) });
            }
          } else if (d) missing.push({ page: page.pageNo, role: it.role, ch: c, note: "轮廓含 NaN" });
          // 轮廓出不来也不能丢字：用能嵌的替代字体可见地补上（面貌不同，但内容在）
          if (!ok && searchFallbackId && embedded.get(searchFallbackId) && hasGlyph(metrics.get(searchFallbackId), c)) {
            pg.drawText(c, { x: pens[k], y, size: it.size, font: embedded.get(searchFallbackId), color });
          }
          i = k;
        }
        i++;
        continue;
      }
      const font = embedded.get(id);
      let j = i;
      let tc = 0;
      const next = (k) => (k + 1 < chars.length ? pens[k + 1] - pens[k] - advOf(metric, chars[k], it.size) : 0);
      if (i + 1 < chars.length && chars[i + 1].trim() && fontFor(it.role, chars[i + 1]) === id) tc = next(i);
      while (j + 1 < chars.length) {
        const c = chars[j + 1];
        if (!c.trim() || fontFor(it.role, c) !== id) break;
        if (Math.abs(next(j) - tc) > 0.05) break;
        j++;
      }
      const text = chars.slice(i, j + 1).map((c) => charFor(it.role, c)).join("");
      if (tc && j > i) pg.pushOperators(setCharacterSpacing(tc));
      pg.drawText(text, { x: pens[i], y, size: it.size, font, color });
      if (tc && j > i) pg.pushOperators(setCharacterSpacing(0));
      i = j + 1;
    }

    // 隐藏搜索层：把这一行再紧排画一遍，但用不可见渲染模式（Tr 3）。
    //
    // 为什么必须有它：简谱歌词的字距是为对位撑开的（比字宽宽 40%），
    // pdfjs 一类的提取器看到这么宽的间距就会插空格——「神配受崇拜」变成
    // 「神 配 受 崇 拜」，搜索直接落空。Tc 也救不了（提取器把 Tc 一并算进间距）。
    // 扫描件 OCR 的文本层就是这么做的：可见层管样子，隐藏层管搜索。
    if (searchLayer && SEARCH_ROLES.has(it.role) && chars.filter((c) => c.trim()).length > 1) {
      const body = chars.filter((c) => c.trim()).join("");
      const spread = pens.length > 1 ? pens[pens.length - 1] - pens[0] : 0;
      const natural = advOf(mainMetric, body, it.size);
      // 只给含汉字的行加：拉丁连排本来就是一次输出，不会被拆，重复画只会让提取出的文本变脏。
      const hasCjk = [...body].some((c) => c.charCodeAt(0) > 0x2e7f);
      // 轮廓模式的行没有可见文字层，无论字距宽窄都要补一层，否则整行搜不到、选不中。
      const needed = outlines.has(mainId) || spread > natural * 1.05;
      const hidden = embedded.get(outlines.has(mainId) ? searchFallbackId : mainId);
      if (body.length > 1 && hasCjk && needed && hidden) {
        pg.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
        pg.drawText(
          [...body].filter((c) => hasGlyph(metrics.get(outlines.has(mainId) ? searchFallbackId : mainId), c)).join(""),
          { x: pens[0], y, size: it.size, font: hidden, color },
        );
        pg.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
      }
    }
  }

  const bytes = await doc.save();
  await writeFile(opt.out, bytes);
  if (opt.strict && (missing.length || missingFonts.length)) process.exitCode = 1;
  return { pages: book.pages.length, bytes: bytes.length, missing, missingFonts, notSubset, fallbacks };
}
