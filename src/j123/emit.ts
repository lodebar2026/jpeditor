// `ScoreDoc` → `.123` 文本。往返校验与语料迁移都靠它。
//
// 输出风格固定（**幂等的前提**）：
//   - 字段用 ASCII 规范形（中文别名只在读入端认，不往外写）
//   - 小节之间一个空格、小节线两侧各一个空格
//   - 符杠分组内的音符**连写**（ABC §4.7 的空白规则），组间留一个空格
//   - 歌词一行一段，CJK 连写不加空格
//
// 幂等判据：`parse → emit → parse` 两次得到的 `ScoreDoc` 结构相等（id 除外，那是解析期分配的）。

import type {
  Barline,
  Chord,
  Element,
  Measure,
  Part,
  ScoreDoc,
  Song,
} from "../model/doc";

/** 小节线归一名 → 123 写法。与 `lex.ts::BARLINES` 互逆。 */
function barlineText(b: Barline): string {
  if (b.repeat === "forward") return b.repeatTimes === 3 ? "|::" : "|:";
  if (b.repeat === "backward") return b.repeatTimes === 3 ? "::|" : ":|";
  switch (b.style) {
    case "none": return "[|]";
    case "light-light": return "||";
    case "light-heavy": return "|]";
    case "heavy-light": return "[|";
    case "dotted": return ".|";
    case "regular": return "|";
    default: return "|";
  }
}

const ACC_TEXT: Readonly<Record<string, string>> = {
  sharp: "#",
  flat: "b",
  natural: "n",
  "double-sharp": "##",
  "double-flat": "bb",
};

/** 一个和弦/占位符 → 音乐体文本（不含前置的和弦符号与装饰）。 */
function elementText(el: Element): string {
  if (el.kind === "space") {
    let s = el.spacer;
    if (el.spacer === "x" && el.duration) s += durationText(el.duration.dots, el.beams?.length ?? 0);
    return s;
  }
  const ch = el;
  let s = "";
  if (ch.rest) {
    s = "0";
  } else {
    const n = ch.notes[0];
    const d = n?.degree;
    if (d) {
      if (d.accidental) s += ACC_TEXT[d.accidental] ?? "";
      s += String(d.number);
      s += d.octaveShift > 0 ? "'".repeat(d.octaveShift) : ",".repeat(-d.octaveShift);
    } else if (n?.pitch) {
      // 只有绝对音高、没有度数（从 MusicXML 来且还没换算）——写成 0 并留给调用方报降级
      s += "0";
    }
  }
  s += durationText(ch.duration.dots, ch.beams?.length ?? 0);
  // 增时线
  for (const su of ch.sustains ?? []) {
    s += su.harmony?.text ? ` "${su.harmony.text}"-` : "-";
  }
  return s;
}

function durationText(dots: number, beams: number): string {
  return "_".repeat(beams) + ".".repeat(dots);
}

/** 倚音 `{6,}` */
function graceText(ch: Chord): string {
  const inner = ch.notes
    .map((n) => {
      const d = n.degree;
      if (!d) return "";
      return (
        (d.accidental ? ACC_TEXT[d.accidental] ?? "" : "") +
        String(d.number) +
        (d.octaveShift > 0 ? "'".repeat(d.octaveShift) : ",".repeat(-d.octaveShift))
      );
    })
    .join("");
  return `{${inner}}`;
}

/** 一个声部的音乐体。按小节拼，符杠分组内连写。 */
function partBody(part: Part, song: Song): string {
  const out: string[] = [];
  // **只收两端都在本声部里的 Mark**：`song.marks` 是全曲共用的，而一条弧的两端
  // 必须落在同一个声部才画得出来。不校验就会输出**不配对的 `(`**——那不只是往返不幂等，
  // 是写出了非法的 123（解析回来会报「圆滑线里没有音符」）。
  const own = new Set<number>();
  for (const mea of part.measures) {
    for (const el of mea.elements) {
      own.add(el.id);
      if (el.kind === "chord") for (const su of el.sustains ?? []) own.add(su.id);
    }
  }
  // Mark 按起止 id 建索引，便于在元素前后插 `(` `)` 与 `(N:`
  const slurStart = new Map<number, number>();
  const slurEnd = new Map<number, number>();
  const tupletStart = new Map<number, { actual: number; normal: number }>();
  for (const m of song.marks) {
    if (!own.has(m.start) || !own.has(m.end)) continue;
    if (m.type === "slur") {
      slurStart.set(m.start, (slurStart.get(m.start) ?? 0) + 1);
      slurEnd.set(m.end, (slurEnd.get(m.end) ?? 0) + 1);
    } else if (m.type === "tuplet") {
      tupletStart.set(m.start, { actual: m.tupletActual ?? 3, normal: m.tupletNormal ?? 2 });
    }
  }

  for (const mea of part.measures) {
    // 左线可能有**多条**（`.jpwabc` 允许 `|:|` 连写），按顺序全部输出
    for (const left of (mea.barlines ?? []).filter((b) => b.location === "left")) {
      // 只有房号、没有实际线时不写线（`[1` 自己就是起点标记）
      if (left.style !== undefined) out.push(barlineText(left));
      if (left.ending?.type === "start") out.push(`[${left.ending.numbers.join(",")}`);
    }
    out.push(measureBody(mea, { slurStart, slurEnd, tupletStart }));
    const right = (mea.barlines ?? []).find((b) => b.location === "right");
    out.push(right ? barlineText(right) : "|");
    if (mea.print?.newPage) out.push("$$");
    else if (mea.print?.newSystem) out.push("$");
  }
  return out.filter((s) => s !== "").join(" ");
}

interface MarkIndex {
  slurStart: Map<number, number>;
  slurEnd: Map<number, number>;
  tupletStart: Map<number, { actual: number; normal: number }>;
}

function measureBody(mea: Measure, mi: MarkIndex): string {
  const pieces: string[] = [];
  let prevGroup: number | undefined;
  // 小节**中间**的小节线（`[|]` 不可见线多是这种）：按它在元素流里的位置插回去。
  // `Score` 把它存成独立的 `BarlineEntry`，丢了就会把两个小节并成一个。
  const mid = (mea.barlines ?? []).filter((b) => b.location === "middle");
  let midIdx = 0;
  for (const el of mea.elements) {
    const ch = el.kind === "chord" ? el : null;
    // 倚音单独成块、紧贴后一个音符
    if (ch?.grace) {
      pieces.push(graceText(ch));
      prevGroup = undefined;
      continue;
    }
    let s = "";
    // 和弦符号前置（规范 §8.1）
    if (el.harmony?.text) s += `"${el.harmony.text}"`;
    // 段落词/注记走 ABC §4.19 的注记写法（`^` = 标在上方）
    if (ch?.sectionWord) s += `"^${ch.sectionWord}"`;
    if (el.notations?.fermata) s += "!fermata!";
    for (const a of el.notations?.articulations ?? []) s += `!${a}!`;
    const tp = mi.tupletStart.get(el.id);
    // 简写 `(N:`；normal≠2 时必须写完整形 `(N:p:q`（**两个冒号**，见 lex.ts 的正则注释）
    if (tp) s += tp.normal === 2 ? `(${tp.actual}:` : `(${tp.actual}:${tp.normal}:${tp.actual}`;
    s += "(".repeat(mi.slurStart.get(el.id) ?? 0);
    s += elementText(el);
    s += ")".repeat(mi.slurEnd.get(el.id) ?? 0);

    // 中间小节线按 `afterElements` 计数插入
    while (midIdx < mid.length && mid[midIdx]!.afterElements !== undefined
           && mid[midIdx]!.afterElements! <= pieces.length) {
      pieces.push(barlineText(mid[midIdx]!));
      midIdx++;
      prevGroup = undefined;
    }
    // 符杠分组：同组连写、不同组之间留空格
    const group = ch?.beamGroup;
    const sameGroup = group !== undefined && group === prevGroup;
    if (pieces.length && sameGroup) pieces[pieces.length - 1] += s;
    else pieces.push(s);
    prevGroup = group;
  }
  while (midIdx < mid.length) { pieces.push(barlineText(mid[midIdx]!)); midIdx++; }
  return pieces.join(" ");
}

/** 歌词行。CJK 连写不加空格；收尾标点贴回前一字。
 *
 *  **必须逐个音符走、空位补 `*`**：歌词是按音符位置对位的（规范 §5），
 *  若只把有词的音节顺序拼起来，中间空一个音符就会让后面所有字前移一格、末尾溢出丢字。
 *  `*` 是 ABC §5.1 的「跳过一个音符」。 */
function lyricLines(part: Part): string[] {
  // 可挂歌词的位置：按元素顺序（倚音不算，它不占对位格）
  const slots: Element[] = [];
  for (const mea of part.measures) {
    for (const el of mea.elements) {
      if (el.kind === "chord" && el.grace) continue;
      slots.push(el);
    }
  }
  // 有哪些段
  const verses = new Map<string, { from: number; to?: number }>();
  for (const el of slots) {
    for (const l of el.lyrics ?? []) {
      const key = `${l.number}-${l.numberTo ?? l.number}`;
      if (!verses.has(key)) {
        const v: { from: number; to?: number } = { from: l.number };
        if (l.numberTo !== undefined) v.to = l.numberTo;
        verses.set(key, v);
      }
    }
  }
  const out: string[] = [];
  for (const slot of [...verses.values()].sort((a, b) => a.from - b.from)) {
    const name = slot.to !== undefined && slot.to !== slot.from
      ? `w${slot.from}-${slot.to}`
      : `w${slot.from}`;
    let body = "";
    let label: string | undefined;
    /** 末尾连续的空位不必写出来（ABC：音节少于音符是合法的） */
    let pendingSkips = "";
    /** 上一个字带了 `_`（延长到下一音符）——那个空位已由 `_` 表达，**不要再补 `*`**，
     *  否则每往返一轮就多出一个占位符、把后面的字顶错一格。 */
    let extendConsumes = false;
    for (const el of slots) {
      const hit = (el.lyrics ?? []).find(
        (l) => l.number === slot.from && (l.numberTo ?? l.number) === (slot.to ?? slot.from),
      );
      if (hit?.verseLabel !== undefined && label === undefined) label = hit.verseLabel;
      if (hit === undefined || hit.text === "") {
        if (extendConsumes) {
          // 这一格是上一个字的延长位，`_` 已经写过了
          extendConsumes = false;
          continue;
        }
        // 空位：先攒着，后面真有字了再落下去
        pendingSkips += hit?.extend ? "_" : "*";
        continue;
      }
      body += pendingSkips;
      pendingSkips = "";
      // **多字并一格要包 `{}`**：CJK 是逐字成音节的（规范 §5.2），
      // `1.圣` 这种并字（`.jpwabc` 的 `{1.[圣]}`）不包起来，读回时会被拆成多个音节、
      // 把后面所有字顶错一格，末尾还会溢出丢字。
      const needBrace = [...hit.text].length > 1 && /[\u3400-\u9fff]/u.test(hit.text);
      body += (needBrace ? `{${hit.text}}` : hit.text) + (hit.trailingPunctuation ?? "");
      if (hit.extend) {
        body += "_";
        extendConsumes = true;
      }
    }
    if (body === "") continue;
    out.push(`${name}:${label !== undefined ? `<${label}>` : ""}${body}`);
  }
  return out;
}

function keyText(song: Song): string | null {
  const k = song.key;
  if (!k) return null;
  if (k.spelling === "none") return "none";
  const sp = k.spelling ?? "C";
  // 主音唱名非 1 时写简谱首调形（`6=E`），否则写 `1=X`
  const degree = k.tonicDegree ?? "1";
  return `${degree}=${sp}`;
}

/** 字段值里的换行会把后续内容变成裸行（第二轮解析就当成音乐体了）。
 *  MusicXML 的 `<creator>` 常把多行塞进一个字段（Finale 的习惯），所以一律按行拆成多条同名字段。 */
function pushLines(L: string[], name: string, value: string): void {
  for (const line of value.split(/\r?\n/)) {
    const t = line.trim();
    if (t) L.push(`${name}:${t}`);
  }
}

/** 一首歌 → `.123` 文本。
 *  @param fallbackNumber 没有曲号时用它补一个——**多曲文件必须给**，
 *    因为 123 的多曲就是靠 `X:` 分隔（规范 §1，同 ABC tunebook）。
 *    文本谱用 `-----` 分曲、大多没有曲号，不补的话几首会连成一片、读回只剩一首。 */
export function emitSong(song: Song, fallbackNumber?: number): string {
  const L: string[] = [];
  if (song.work.number) L.push(`X:${song.work.number}`);
  else if (fallbackNumber !== undefined) L.push(`X:${fallbackNumber}`);
  if (song.work.title !== undefined) pushLines(L, "T", song.work.title);
  for (const st of song.work.subtitles) pushLines(L, "T", st);
  for (const c of song.identification?.creators ?? []) pushLines(L, "C", c.text);
  const k = keyText(song);
  if (k) L.push(`K:${k}`);
  if (song.time) L.push(`M:${song.time.beats}/${song.time.beatType}`);
  for (const t of song.tempos ?? []) {
    L.push(typeof t === "number" ? `Q:1/4=${t}` : `Q:"${t}"`);
  }
  // 页眉页脚（文本谱的 `XL/XR/TL/TR/BL/BC/BR`）。ABC 没有对应字段，走它的 `I:` 扩展点——
  // 规范 §3 写明未识别的 `I:` 会被忽略，所以这样扩展是安全的。语料里 绝大多数用到，不能丢。
  const pt = song.pageText;
  if (pt) {
    if (pt.indexLeft !== undefined) L.push(`I:indexleft ${pt.indexLeft}`);
    if (pt.indexRight !== undefined) L.push(`I:indexright ${pt.indexRight}`);
    for (const [key, arr] of [
      ["topleft", pt.topLeft], ["topright", pt.topRight],
      ["bottomleft", pt.bottomLeft], ["bottomcenter", pt.bottomCenter], ["bottomright", pt.bottomRight],
    ] as const) {
      for (const t of arr) for (const line of t.split(/\r?\n/)) if (line.trim()) L.push(`I:${key} ${line.trim()}`);
    }
  }
  if (song.style?.sheetRef) L.push(`I:style ${song.style.sheetRef}`);
  if (song.linesPerPage) L.push(`I:linesperpage ${song.linesPerPage}`);
  // 指令名**一律小写输出**：`parseInstruction` 读入时会归一成小写（ABC 的 `I:` 不区分大小写），
  // 这里若保留原样大小写，往返一轮就会从 `I:FontSize` 变成 `I:fontsize`
  for (const r of song.style?.raw ?? []) L.push(`I:${r.key.toLowerCase()} ${r.value}`);
  if (song.playOrder?.length) L.push(`I:playorder ${playOrderText(song)}`);
  for (const r of song.remarks ?? []) {
    // `P:` 原文在解析期被塞进 remarks，原样还回去
    if (r.startsWith("P:")) L.push(r);
    else pushLines(L, "N", r);
  }

  for (let i = 0; i < song.parts.length; i++) {
    const part = song.parts[i]!;
    if (song.parts.length > 1) L.push(`V:${i + 1}`);
    L.push(partBody(part, song));
    for (const line of lyricLines(part)) L.push(line);
  }
  return L.join("\n");
}

function playOrderText(song: Song): string {
  // skip/limit 的元素 id → 该小节第几个音符
  const noteIndex = new Map<number, { measure: number; index: number }>();
  const part = song.parts[0];
  if (part) {
    for (let mi = 0; mi < part.measures.length; mi++) {
      let k = 0;
      for (const el of part.measures[mi]!.elements) {
        if (el.kind === "chord" && !el.grace) {
          k++;
          noteIndex.set(el.id, { measure: mi + 1, index: k });
        }
      }
    }
  }
  return (song.playOrder ?? [])
    .map((p) => {
      const from = p.fromElement !== undefined ? noteIndex.get(p.fromElement) : undefined;
      const to = p.toElement !== undefined ? noteIndex.get(p.toElement) : undefined;
      let s = `${p.fromMeasure}${from && from.index > 1 ? `.${from.index}` : ""}`;
      s += `-${p.toMeasure}${to ? `.${to.index}` : ""}`;
      if (p.verse !== undefined) s += ` v${p.verse}`;
      if (p.pageBreakAfter) s += " page";
      return s;
    })
    .join(" | ");
}

/** 整份文档 → `.123` 文本。多曲之间空一行，且**每首都带 `X:`**（分隔靠它）。 */
export function emit123(doc: ScoreDoc): string {
  const head = "%123-1.0";
  const multi = doc.songs.length > 1;
  const bodies = doc.songs.map((s, i) => emitSong(s, multi ? i + 1 : undefined));
  return [head, ...bodies].join("\n\n") + "\n";
}
