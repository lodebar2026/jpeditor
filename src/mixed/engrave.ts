// 导出 MusicXML 的版面坐标：由五线谱引擎排一遍（与屏幕上的五线谱同一套——同纸、同断行、同自动铺排），
// 把排出来的结果写回 `ScoreDoc`，再由唯一写出端 `model/toxml.ts` 序列化。
//
// 以前导出另有一套 DOM 上的版面注入（A4 常量表、每行 4 小节、音符按小节宽均分），与这里的自动铺排判据两份，
// 屏幕上与 MuseScore 里的分行对不上；导出的文件再读回来，那些粗坐标还会压过自动铺排（行首音压在谱号下）。
// 现在导出的坐标就是引擎自己的坐标，读回来走「带版面」那条路，排出来与导出前一致。
//
// 谱里已经带版面（有 `<defaults>`，或小节宽/音符 default-x）的一字不改：作者给的版面比我们排的更贴切。

import type { HAlign, Position, ScoreDoc, Song } from "../model/doc";
import { LCR, type MixedOptions, type StaffLayout, type Sys } from "./model";
import { ScorePainter } from "../layout/painter";

const r1 = (v: number): number => Math.round(v * 10) / 10;
const at = (pos: Position | undefined, set: Position): Position => ({ ...(pos ?? {}), ...set });

/** 给 `doc` 第一首补上版面坐标（就地改）。谱里已带版面、或排不出来时返回 false、不动它。 */
export async function engraveScoreDoc(doc: ScoreDoc, page: MixedOptions["page"]): Promise<boolean> {
  const song = doc.songs[0];
  if (!song || song.defaults) return false;
  const mp = new ScorePainter();
  await mp.load({ view: "staff", doc, page, hideBarNumber: false });
  const placed = mp.staffPlacement;
  mp.dispose();
  if (!placed?.score.autoLayout || placed.score.song !== song) return false;
  writeLayout(song, placed.score, placed.systems);
  return true;
}

function writeLayout(
  song: Song,
  score: StaffLayout,
  systems: readonly { sys: Sys; page: number; top: number }[],
): void {
  const d = score.defaults;
  song.defaults = {
    scaling: { millimeters: 7, tenths: 40 }, // = DEFAULT_SCALING：自动铺排的谱都按它排
    pageLayout: {
      pageWidth: r1(d.pageWidth),
      pageHeight: r1(d.pageHeight),
      margins: [{ left: d.leftMargin, right: d.rightMargin, top: d.topMargin, bottom: d.bottomMargin, oddEven: "both" }],
    },
    systemLayout: { leftMargin: 0, rightMargin: 0 },
  };
  // 标题块：`autoLayoutHeader` 排的，已含标题那条（MuseScore 只要有 <credit> 就不再看 <work-title>）
  const justify = (j: LCR): HAlign => (j === LCR.Center ? "center" : j === LCR.Right ? "right" : "left");
  song.credits = score.credits.map((c) => ({
    ...(c.type ? { type: c.type } : {}),
    text: c.text,
    x: r1(c.x),
    y: r1(c.y),
    ...(c.fontSize > 0 ? { fontSize: c.fontSize } : {}),
    justify: justify(c.justify),
    page: c.page + 1,
  }));

  // 分行分页与系统间距：换行一律按排出来的，源文带来的换行（简谱视图的行）先清掉
  for (const part of song.parts) {
    for (const m of part.measures) {
      if (!m.print) continue;
      delete m.print.newSystem;
      delete m.print.newPage;
      delete m.print.systemLayout;
      delete m.print.staffLayouts;
      if (Object.keys(m.print).length === 0) delete m.print;
    }
  }
  systems.forEach(({ sys, page, top }, i) => {
    const prev = systems[i - 1];
    const newPage = i > 0 && prev!.page !== page;
    let staff = 0;
    song.parts.forEach((part, pi) => {
      const m = part.measures[sys.firstMeasure];
      if (!m) return;
      const layout = score.parts[pi]!;
      const staffLayouts = layout.staves.flatMap((_, k) => {
        const st = sys.staves[staff + k];
        return st && staff + k > 0 && st.distance > 0 ? [{ staff: k + 1, staffDistance: r1(st.distance) }] : [];
      });
      staff += layout.staves.length;
      m.print = {
        ...(m.print ?? {}),
        ...(i > 0 ? (newPage ? { newPage: true } : { newSystem: true }) : {}),
        ...(pi === 0
          ? {
            systemLayout: !prev || newPage
              ? { topSystemDistance: r1(top - d.topMargin) }
              : { systemDistance: r1(top - (prev.top + prev.sys.height())) },
          }
          : {}),
        ...(staffLayouts.length ? { staffLayouts } : {}),
      };
    });
  });

  // 没写朝向的圆滑线按排出来的方向写明（`PartLayout.arcsAbove`：有歌词在上方，否则按符干），第三方软件不另猜；
  // 没对上排版的（只留旋律时删掉的等）仍写上方
  const slurAbove = new Map<string, boolean>();
  for (const pl of score.parts) {
    for (const sl of pl.slurs) if (sl.mark) slurAbove.set(`${sl.mark.start}:${sl.mark.end}:${sl.mark.startNote ?? 0}:${sl.mark.endNote ?? 0}`, sl.above);
  }
  for (const m of song.marks) {
    if (m.type !== "slur" || m.placement || m.orientation) continue;
    const above = slurAbove.get(`${m.start}:${m.end}:${m.startNote ?? 0}:${m.endNote ?? 0}`) ?? true;
    m.placement = above ? "above" : "below";
  }

  // 小节宽、音符横向位置与符干方向、歌词与和弦与文字的高度
  const four = 4;
  for (const [pi, part] of song.parts.entries()) {
    const layout = score.parts[pi]!;
    part.measures.forEach((m, mi) => {
      const mif = score.measures[mi];
      if (mif) m.width = r1(mif.width);
      const md = layout.measures[mi];
      if (!md) return;
      for (const ch of md.chords) {
        for (const nt of ch.notes) {
          if (nt.x < 0) continue;
          if (nt.src) nt.src.pos = at(nt.src.pos, { defaultX: r1(nt.x) });
          else ch.src.pos = at(ch.src.pos, { defaultX: r1(nt.x) });
          // 统一过的符杠组方向写明，第三方软件不另猜
          if (nt.src && !ch.rest && ch.noteType.toFloat() < four && nt.src.stem === undefined) {
            nt.src.stem = ch.stemUp ? "up" : "down";
          }
        }
      }
      for (const l of md.lyrics) l.src.pos = at(l.src.pos, { defaultY: r1(l.y) });
      for (const h of md.harmonies) h.src.pos = at(h.src.pos, { defaultY: r1(h.y) });
      // 自动放置的速度/文字记号：高度，连同自动铺排统一过的字号（歌词字号，pt）
      const textPt = r1(score.defaults.lyricFont.size * score.scaling);
      for (const t of md.textBlocks) {
        if (!t.autoY || !t.src) continue;
        for (const item of [t.src, ...(t.src.more ?? [])]) {
          if (item.type !== "words" && item.type !== "metronome") continue;
          item.pos = at(item.pos, { defaultY: r1(t.y) });
          item.font = { ...(item.font ?? {}), size: textPt };
        }
      }
    });
  }
}
