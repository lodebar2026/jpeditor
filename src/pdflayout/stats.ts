// 从原书的版面规格（page-report.mjs 出的 pdf-layout.json）统计出 BookStyle。
//
// **为什么统计的是中位数**：原件是排好版付印的，同一角色的字号/间距本该整齐，
// 实测值的抖动来自轮廓量测（亚像素、笔画粗细、标点只占字格下部）。取中位数
// 就把「原书的意图」还原出来，而不是把量测噪声一起继承下去。
//
// **角色判定用 PageSpec 的字段位置**，不是 BookProfile.families[].role
// （那个字段全书恒为 "unknown"，没有任何回填方），也不重跑 classifyPage——
// spec 的具名字段本身就是 inventory 那一整套判据的产物。
//
// 无 DOM 依赖。
import type { Rect } from "../omr/types";
import type { PageSpec, TextRun, MarkSpec, SongPlacement } from "./spec";
import type { BookProfile } from "../omr/bookprofile";
import {
  defaultBookStyle,
  roleFontDefaults,
  type BookStyle,
  type FontRef,
  type RoleStyle,
  type StyleRole,
  STYLE_ROLES,
} from "./bookstyle";

/** 段落词（副歌/间奏…）印在和弦带里，字号是那一带的（实测 7pt 上下），
 *  不是歌词那一档。词表与 bookmeta.ts 的 SECTION_WORDS 同源——两边要一致。 */
const SECTION_WORD = /(副歌|间奏|前奏|尾奏|结束句|齐唱|独唱|轮唱|合唱|重唱|末节|尾声)/;

const bottom = (r: Rect) => r.y + r.h;
const right = (r: Rect) => r.x + r.w;
const cx = (r: Rect) => r.x + r.w / 2;
const cy = (r: Rect) => r.y + r.h / 2;

export interface Summary {
  n: number;
  p25: number;
  p50: number;
  p75: number;
  /** 中位绝对偏差 ÷ 中位数。> 0.12（字号）/ 0.15（间距）说明这一项其实是两族混在一起。 */
  madRatio: number;
}

export function summarize(v: number[]): Summary {
  const s = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return { n: 0, p25: 0, p50: 0, p75: 0, madRatio: 0 };
  const q = (f: number) => s[Math.min(s.length - 1, Math.max(0, Math.floor(f * s.length)))];
  const p50 = q(0.5);
  const mad = [...s.map((x) => Math.abs(x - p50))].sort((a, b) => a - b)[Math.floor(s.length / 2)];
  return { n: s.length, p25: q(0.25), p50, p75: q(0.75), madRatio: p50 ? mad / Math.abs(p50) : 0 };
}

const med = (v: number[]) => summarize(v).p50;

export interface RoleSample {
  role: StyleRole;
  h: number;
  w: number;
  page: number;
  ch: string;
}

/** 只采正文页（跳过封面/前言/目录/索引），与 docs 里那张分族表同口径。 */
export interface SampleOptions {
  fromPage?: number;
  toPage?: number;
}

/** 一行里的**主字高**：剔掉标点与上标后的中位数。
 *  标点只占字格下部（逗号 h≈1.5，正文 h≈10.5），上标数字也小一半——
 *  这些字形的高度不是字号，混进去会把中位数拉偏（lyric2 那一档尤其明显）。 */
function runBodyHeight(run: TextRun): number {
  const hs = run.chars.filter((c) => c.h > 0).map((c) => c.h);
  if (!hs.length) return 0;
  const top = med(hs.filter((h) => h >= med(hs)));
  return top || med(hs);
}

function runChars(run: TextRun | null | undefined): { h: number; w: number; ch: string }[] {
  if (!run) return [];
  const body = runBodyHeight(run);
  // 读不出的字形（"�"）仍然是一个真实字形，尺寸照采；标点/上标不采（见 runBodyHeight）。
  return run.chars
    .filter((c) => c.h > 0 && c.w > 0 && (body <= 0 || c.h >= body * 0.72))
    .map((c) => ({ h: c.h, w: c.w, ch: c.ch }));
}

function pushRun(out: RoleSample[], role: StyleRole, run: TextRun | null | undefined, page: number): void {
  for (const c of runChars(run)) out.push({ role, h: c.h, w: c.w, page, ch: c.ch });
}

/** 谱行上方那一带既有和弦也有署名/段落词（spec 把它们一起放进 chordLines）。
 *  和弦是拉丁字母+数字，署名含汉字——按非 ASCII 占比分开，否则两族字号会混成一锅。 */
function chordLineRole(run: TextRun): StyleRole {
  const t = run.text.replace(/\s/g, "");
  if (!t) return "chord";
  const cjk = [...t].filter((c) => c.charCodeAt(0) > 0x2e7f).length;
  return cjk / t.length > 0.4 ? "credit" : "chord";
}

export function collectRoleSamples(pages: PageSpec[], opt: SampleOptions = {}): RoleSample[] {
  const from = opt.fromPage ?? 40;
  const to = opt.toPage ?? 560;
  const out: RoleSample[] = [];
  // 歌词分主/次两号：先收全部歌词行的字号，再按全局中位数劈开（文档实测 11 / 10 两档）。
  const lyricSizes: number[] = [];
  for (const p of pages) {
    if (p.kind !== "score") continue;
    for (const s of p.songs) for (const y of s.systems) for (const l of y.lyricLines) {
      const h = runBodyHeight(l);
      if (h >= 3) lyricSizes.push(h); // 太矮的整行是标点/记号，不是歌词字号
    }
  }
  const lyricMid = med(lyricSizes);
  const lyric2Cut = lyricMid - 0.6;

  for (const p of pages) {
    const inRange = p.page >= from && p.page <= to;
    if (p.kind === "toc" || p.kind === "index" || p.kind === "front-matter") {
      // 目录/索引/扉页那几页混着四档字：页题（「目录」「诗题笔划索引」）、
      // 一级分类、二级小标题、条目正文。按「有没有尾页码 + 字号」分开收，
      // 混成一桶的话条目那一档会被大字拉高（实测拉到 8.9pt，真值 7.8）。
      // **扉页/前言的正文不能进目录那几档**：它们也是「以数字结尾」的普通行，
      // 一并收进来会把条目字号的中位数从 8.7 拉到 7.8（n=20350，其中七成是前言正文），
      // 目录与歌词的字号比也就跟原书对不上了（原书 8.68 : 10.56 ≈ 0.82）。
      const tocPage = p.kind === "toc" || p.kind === "index";
      for (const t of p.textLines) {
        const txt = t.text.trim();
        const entry = /[（(]\d+[)）]\s*$/.test(txt) || /\d\s*$/.test(txt);
        if (t.size >= 16) pushRun(out, "frontTitle", t, p.page);
        else if (!tocPage) continue;
        else if (entry) pushRun(out, "toc", t, p.page);
        // 一级分类标题（目录页的「敬拜赞美」「教会」）实测 13.8~14.7pt；
        // 12.5 的门槛会把索引页那一档 12.x 的小标题也收进来，把中位数压到 12.99，
        // 与条目的比例就跟原书对不上了（原书 14.4 : 7.8 ≈ 1.84）。
        else if (t.size >= 13.5) pushRun(out, "tocHeading", t, p.page);
        else if (t.size >= 9.8) pushRun(out, "tocSub", t, p.page);
      }
    }
    if (p.header) pushRun(out, "header", p.header, p.page);
    if (p.footer) pushRun(out, "footer", p.footer, p.page);
    if (!inRange || p.kind !== "score") continue;
    for (const b of p.storyBoxes) for (const l of b.lines) pushRun(out, "story", l, p.page);
    for (const s of p.songs) {
      pushRun(out, "title", s.titleRun, p.page);
      pushRun(out, "songNumber", s.numberRun, p.page);
      pushRun(out, "keyMeter", s.keyMeterRun, p.page);
      pushRun(out, "category", s.categoryRun, p.page);
      for (const c of s.creditRuns) pushRun(out, "credit", c, p.page);
      for (const y of s.systems) {
        // 音符带里混着一档明显更小的字（三连音数字、上标、括号），单列成 tuplet——
        // 它们在 inventory 里没有独立类（tupletNum 只声明未使用），只能按字高分档。
        const noteMed = med(y.notes.filter((c) => c.h > 0).map((c) => c.h));
        for (const c of y.notes) {
          if (!(c.h > 0)) continue;
          const role: StyleRole = noteMed > 0 && c.h < noteMed * 0.72 ? "tuplet" : "note";
          out.push({ role, h: c.h, w: c.w, page: p.page, ch: c.ch });
        }
        for (const c of y.chordLines) pushRun(out, SECTION_WORD.test(c.text) ? "sectionWord" : chordLineRole(c), c, p.page);
        for (const l of y.lyricLines) {
          const h = runBodyHeight(l);
          if (h < lyricMid * 0.5) continue; // 整行标点/记号：不是歌词，别拿去算字号
          pushRun(out, h < lyric2Cut ? "lyric2" : "lyric", l, p.page);
        }
      }
    }
  }
  return out;
}

/** 间距原料。每一项的量法见字段注释——**改量法前先读 docs/实现/矢量PDF识别.md 的「重排」一节**。 */
export interface MetricSamples {
  noteH: number[];
  /** 谱行净距：上一行最后一条歌词 baseline → 下一行 noteTop。
   *  不用 noteBottom 逐差（那随歌词段数变，1 段与 4 段能差一倍，天然多峰、不可移植）。 */
  systemGap: number[];
  noteStep: number[];
  barGap: number[];
  octaveDotUpGap: number[];
  octaveDotDownGap: number[];
  octaveDotStep: number[];
  divLineGap: number[];
  divLineStep: number[];
  divLineLen: number[];
  divLineWidth: number[];
  /** 房号/三连音括线：线宽、脚（下垂那一小段）的长度；以及三连音数字的墨迹高。 */
  bracketWidth: number[];
  bracketFootLen: number[];
  tupletNumH: number[];
  augmentLineLen: number[];
  augmentLineWidth: number[];
  augmentDotGap: number[];
  barlineHeight: number[];
  barlineWidth: number[];
  repeatDotDiam: number[];
  slurThickness: number[];
  slurHeight: number[];
  chordToNote: number[];
  musicToLyric: number[];
  lyricToLyric: number[];
  titleToSystem: number[];
  creditToSystem: number[];
  keyMeterToSystem: number[];
  /** 版心左右缘：每页取 min(x0)/max(x1)，按页奇偶分开（对开页镜像）。 */
  oddX0: number[];
  oddX1: number[];
  evenX0: number[];
  evenX1: number[];
  topY: number[];
  bottomY: number[];
  // 首页标题块（页内绝对 y；原书整本统一版式）
  numberBaseline: number[];
  titleBaseline: number[];
  keyMeterBaseline: number[];
  creditFirstBaseline: number[];
  creditLineGap: number[];
  firstSystemTop: number[];
  contSystemTop: number[];
}

function emptySamples(): MetricSamples {
  return {
    noteH: [], systemGap: [], noteStep: [], barGap: [],
    octaveDotUpGap: [], octaveDotDownGap: [], octaveDotStep: [],
    divLineGap: [], divLineStep: [], divLineLen: [], divLineWidth: [],
    augmentLineLen: [], augmentLineWidth: [], augmentDotGap: [],
    barlineHeight: [], barlineWidth: [], repeatDotDiam: [],
    bracketWidth: [], bracketFootLen: [], tupletNumH: [],
    slurThickness: [], slurHeight: [],
    chordToNote: [], musicToLyric: [], lyricToLyric: [],
    titleToSystem: [], creditToSystem: [], keyMeterToSystem: [],
    oddX0: [], oddX1: [], evenX0: [], evenX1: [], topY: [], bottomY: [],
    numberBaseline: [], titleBaseline: [], keyMeterBaseline: [], creditFirstBaseline: [],
    creditLineGap: [], firstSystemTop: [], contSystemTop: [],
  };
}

type Note = SongPlacement["systems"][number]["notes"][number];

/** 把一个记号归到 x 最近的音符上（超过一个音符宽就不算，避免跨音符串味）。 */
function nearestNote(notes: Note[], x: number, tol: number): Note | null {
  let best: Note | null = null;
  let bd = Infinity;
  for (const n of notes) {
    const d = Math.abs(cx(n) - x);
    if (d < bd) {
      bd = d;
      best = n;
    }
  }
  return best && bd <= tol ? best : null;
}

export function collectMetricSamples(pages: PageSpec[], opt: SampleOptions = {}): MetricSamples {
  const from = opt.fromPage ?? 40;
  const to = opt.toPage ?? 560;
  const out = emptySamples();

  for (const p of pages) {
    if (p.kind !== "score" || p.page < from || p.page > to) continue;
    // 房号/三连音的括线归在 frames 里（spec.ts 的「线框」那一档）：
    // 横的那条给线宽，竖的那条（脚）给下垂长度。音符字高在下面的谱行循环里才有，
    // 所以这里先按 pt 收，最后统一按字高归一。
    for (const f of p.frames) {
      if (f.type !== "bracket") continue;
      // 线宽取**几何短边**（转曲后的线是细长矩形），`lineWidth` 字段是笔宽默认值 1，不作数：
      // 实测房号括线只有 0.43pt，比小节线（1.01pt）细一半多。
      out.bracketWidth.push(Math.min(f.box.w, f.box.h));
      if (f.box.h > f.box.w && f.box.h > 1) out.bracketFootLen.push(f.box.h);
    }
    let pageX0 = Infinity;
    let pageX1 = -Infinity;
    for (const s of p.songs) {
      const sys = s.systems;
      for (let i = 0; i < sys.length; i++) {
        const y = sys[i];
        const notes = y.notes.filter((n) => n.h > 0 && n.w > 0);
        if (notes.length < 3) continue;
        const noteH = med(notes.map((n) => n.h));
        const noteW = med(notes.map((n) => n.w));
        if (!(noteH > 0)) continue;
        out.noteH.push(noteH);
        pageX0 = Math.min(pageX0, y.x0);
        pageX1 = Math.max(pageX1, y.x1);
        for (const l of [...y.lyricLines, ...y.chordLines]) {
          pageX0 = Math.min(pageX0, l.box.x);
          pageX1 = Math.max(pageX1, right(l.box));
        }

        // 谱行净距：本行最后一条歌词 baseline → 下一行的**行顶**。
        // 行顶要算上和弦那一带（下一行若印了和弦，它比 noteTop 还高十来个点）——
        // 不算的话，把这个值当行距灌进排版器，行与行之间会平白多出一个和弦带的高度。
        if (i + 1 < sys.length) {
          const nx = sys[i + 1];
          const lastLyric = y.lyricLines.length ? Math.max(...y.lyricLines.map((l) => l.baselineY)) : y.noteBottom;
          const chordTop = nx.chordLines.length ? Math.min(...nx.chordLines.map((c) => c.box.y)) : nx.noteTop;
          out.systemGap.push(Math.min(nx.noteTop, chordTop) - lastLyric);
        }

        // 音符步距：相邻 x 逐差，去掉跨小节线那一档（> 1.6 × 中位数）
        const xs = [...notes].sort((a, b) => a.x - b.x);
        const steps: number[] = [];
        for (let k = 1; k < xs.length; k++) steps.push(cx(xs[k]) - cx(xs[k - 1]));
        const stepMed = med(steps);
        for (const d of steps) if (stepMed > 0 && d <= stepMed * 1.6) out.noteStep.push(d);

        // 记号：只看落在本谱行上下各 4 个字高之内的
        const band = p.marks.filter(
          (m) => bottom(m.box) > y.noteTop - noteH * 4 && m.box.y < y.noteBottom + noteH * 4 && right(m.box) > y.x0 - noteW && m.box.x < y.x1 + noteW,
        );
        const upDots = new Map<Note, MarkSpec[]>();
        const downDots = new Map<Note, MarkSpec[]>();
        const divsOf = new Map<Note, MarkSpec[]>();
        for (const m of band) {
          switch (m.cls) {
            case "octaveDot": {
              const n = nearestNote(notes, cx(m.box), noteW * 0.8);
              if (!n) break;
              const map = cy(m.box) < cy(n) ? upDots : downDots;
              const a = map.get(n) ?? [];
              a.push(m);
              map.set(n, a);
              break;
            }
            case "divLine": {
              const n = nearestNote(notes, cx(m.box), noteW * 1.2);
              if (!n) break;
              const a = divsOf.get(n) ?? [];
              a.push(m);
              divsOf.set(n, a);
              out.divLineLen.push(m.box.w);
              out.divLineWidth.push(m.box.h);
              break;
            }
            case "augmentLine":
              out.augmentLineLen.push(m.box.w);
              out.augmentLineWidth.push(m.box.h);
              break;
            case "augmentDot": {
              const n = nearestNote(notes, cx(m.box) - noteW, noteW * 1.5);
              if (n) out.augmentDotGap.push(m.box.x - right(n));
              break;
            }
            case "barline":
              if (m.box.h > noteH * 0.8 && m.box.h < noteH * 3) {
                out.barlineHeight.push(m.box.h / noteH);
                out.barlineWidth.push(m.box.w);
              }
              break;
            case "tupletNum":
              if (m.box.h > 2) out.tupletNumH.push(m.box.h);
              break;
            case "repeatDot": {
              const d = Math.max(m.box.w, m.box.h);
              if (d > 0.8) out.repeatDotDiam.push(d);
              break;
            }
            case "slur":
              out.slurThickness.push(m.lineWidth || 0);
              out.slurHeight.push(m.box.h / noteH);
              break;
          }
        }
        for (const [, ds] of upDots) {
          const sorted = [...ds].sort((a, b) => b.box.y - a.box.y); // 由近及远
          // 以**谱行的** noteTop 为基准，不用单个音符的墨迹上缘：
          // 「1」和「4」的墨迹高度本就不同，逐音符量会把字形差异算成层距离散。
          out.octaveDotUpGap.push(y.noteTop - bottom(sorted[0].box));
          for (let k = 1; k < sorted.length; k++) out.octaveDotStep.push(sorted[k - 1].box.y - bottom(sorted[k].box));
        }
        for (const [n, ds] of downDots) {
          const sorted = [...ds].sort((a, b) => a.box.y - b.box.y);
          // 低音点排在减时线**之下**：有减时线时要量到最下面那条的下缘，
          // 否则量出来的是「音符 → 点」的总距，会把减时线的层数一起算进去（离散度飙到 0.29）。
          const divs = divsOf.get(n);
          const above = divs && divs.length ? Math.max(...divs.map((d) => bottom(d.box))) : y.noteBottom;
          out.octaveDotDownGap.push(sorted[0].box.y - above);
          for (let k = 1; k < sorted.length; k++) out.octaveDotStep.push(sorted[k].box.y - bottom(sorted[k - 1].box));
        }
        for (const [n, ds] of divsOf) {
          const sorted = [...ds].sort((a, b) => a.box.y - b.box.y);
          out.divLineGap.push(sorted[0].box.y - bottom(n));
          for (let k = 1; k < sorted.length; k++) out.divLineStep.push(sorted[k].box.y - bottom(sorted[k - 1].box));
        }

        // 小节线两侧留白
        for (const bx of y.barlineXs) {
          let leftD = Infinity;
          let rightD = Infinity;
          for (const n of notes) {
            if (right(n) <= bx) leftD = Math.min(leftD, bx - right(n));
            else if (n.x >= bx) rightD = Math.min(rightD, n.x - bx);
          }
          if (Number.isFinite(leftD) && leftD < noteW * 4) out.barGap.push(leftD);
          if (Number.isFinite(rightD) && rightD < noteW * 4) out.barGap.push(rightD);
        }

        // 上下带
        for (const c of y.chordLines) if (chordLineRole(c) === "chord") out.chordToNote.push(y.noteTop - c.baselineY);
        const lyr = [...y.lyricLines].sort((a, b) => a.baselineY - b.baselineY);
        if (lyr.length) out.musicToLyric.push(lyr[0].baselineY - y.noteBottom);
        for (let k = 1; k < lyr.length; k++) out.lyricToLyric.push(lyr[k].baselineY - lyr[k - 1].baselineY);
      }

      for (const r of [s.titleRun, s.numberRun, s.keyMeterRun, ...s.creditRuns]) {
        if (!r) continue;
        pageX0 = Math.min(pageX0, r.box.x);
        pageX1 = Math.max(pageX1, right(r.box));
      }

      // 标题块：只在这首歌起始的那一页量
      if (s.startsHere && sys.length) {
        const top = sys[0].noteTop;
        out.firstSystemTop.push(top);
        if (s.titleRun) {
          out.titleToSystem.push(top - s.titleRun.baselineY);
          out.titleBaseline.push(s.titleRun.baselineY);
        }
        if (s.numberRun) out.numberBaseline.push(s.numberRun.baselineY);
        if (s.keyMeterRun) {
          out.keyMeterToSystem.push(top - s.keyMeterRun.baselineY);
          out.keyMeterBaseline.push(s.keyMeterRun.baselineY);
        }
        // 署名只取标题块里那几行：creditRuns 会捎上歌词区里被判成 credit 的标点
        const cr = s.creditRuns.filter((c) => c.baselineY < top).map((c) => c.baselineY).sort((a, b) => a - b);
        if (cr.length) out.creditFirstBaseline.push(cr[0]);
        for (let k = 1; k < cr.length; k++) out.creditLineGap.push(cr[k] - cr[k - 1]);
      } else if (sys.length) {
        out.contSystemTop.push(sys[0].noteTop);
      }
    }
    if (Number.isFinite(pageX0)) (p.page % 2 === 1 ? out.oddX0 : out.evenX0).push(pageX0);
    if (Number.isFinite(pageX1)) (p.page % 2 === 1 ? out.oddX1 : out.evenX1).push(pageX1);
    if (p.header) out.topY.push(p.header.baselineY);
    if (p.footer) out.bottomY.push(p.footer.baselineY);
  }
  return out;
}

export interface StyleReport {
  roles: Partial<Record<StyleRole, Summary>>;
  metrics: Record<string, Summary & { em?: number }>;
  warnings: string[];
}

/**
 * 目录/索引的版面几何：行距、首行基线、左右缘、页题基线。
 *
 * 判据：**目录条目认「尾部带圆括号页码」，索引条目认「以数字收尾」**——两者行距不同
 *（实测 19.4 与 15.8），混在一起量会得到一个两不像的中位数。
 * 页题基线取整页最大那行（「目录」18.3pt、「诗题笔划索引」16.1pt）。
 */
export function inferTocRule(pages: PageSpec[]): Partial<BookStyle["toc"]> {
  const tocGaps: number[] = [];
  const tocFirst: number[] = [];
  const idxGaps: number[] = [];
  const idxFirst: number[] = [];
  const lefts: number[] = [];
  const rights: number[] = [];
  const titles: number[] = [];
  // 分类标题（行楷那一档）上下的净距：上一条目基线 → 标题基线、标题基线 → 下一条目基线。
  const headAbove: number[] = [];
  const headBelow: number[] = [];
  for (const p of pages) {
    if (p.kind !== "toc" && p.kind !== "index") continue;
    const isTocEntry = (t: string) => /[（(]\d+[)）]\s*$/.test(t.trim());
    const isIdxEntry = (t: string) => !isTocEntry(t) && /\d\s*$/.test(t.trim());
    for (const kind of ["toc", "index"] as const) {
      const lines = p.textLines.filter((l) => (kind === "toc" ? isTocEntry(l.text) : isIdxEntry(l.text)));
      if (lines.length < 5) continue;
      const bl = lines.map((l) => l.baselineY).sort((a, b) => a - b);
      for (let i = 1; i < bl.length; i++) {
        const d = bl[i] - bl[i - 1];
        if (d > 4) (kind === "toc" ? tocGaps : idxGaps).push(d);
      }
      (kind === "toc" ? tocFirst : idxFirst).push(bl[0]);
      for (const l of lines) {
        lefts.push(l.box.x);
        rights.push(right(l.box));
      }
    }
    // 目录页里的分类标题：既不是「…(123)」的条目、也不是页题，字号比条目大
    if (p.kind === "toc") {
      const entries = p.textLines.filter((l) => isTocEntry(l.text));
      const entrySize = entries.length ? med(entries.map((l) => l.size)) : 0;
      if (entrySize > 0) {
        // 门槛拉到 1.4 倍：目录页里掉出条目的碎片（「2一」「12的一天1」）字号只比条目大一点点，
        // 混进来会把「标题上下的净距」摊平（原书真正的分类标题是 13.8~14.7pt，条目 8.7pt）。
        const heads = p.textLines.filter((l) => !isTocEntry(l.text) && l.size > entrySize * 1.4 && l.size < 16);
        for (const h of heads) {
          const above = entries.filter((e) => e.baselineY < h.baselineY).sort((a, b) => b.baselineY - a.baselineY)[0];
          const below = entries.filter((e) => e.baselineY > h.baselineY).sort((a, b) => a.baselineY - b.baselineY)[0];
          if (above) headAbove.push(h.baselineY - above.baselineY);
          if (below) headBelow.push(below.baselineY - h.baselineY);
        }
      }
    }
    const big = [...p.textLines].sort((a, b) => b.size - a.size)[0];
    if (big && big.size >= 15) titles.push(big.baselineY);
  }
  const round = (v: number) => Number(v.toFixed(2));
  const out: Partial<BookStyle["toc"]> = {};
  if (tocGaps.length) out.lineGap = round(med(tocGaps));
  if (tocFirst.length) out.firstBaseline = round(med(tocFirst));
  if (idxGaps.length) out.indexLineGap = round(med(idxGaps));
  if (idxFirst.length) out.indexFirstBaseline = round(med(idxFirst));
  if (lefts.length) out.left = round(med(lefts));
  if (rights.length) out.right = round(med(rights));
  if (titles.length) out.titleBaseline = round(med(titles));
  if (headAbove.length) out.headingGapAbove = round(med(headAbove));
  if (headBelow.length) out.headingGapBelow = round(med(headBelow));
  return out;
}

/** 统计 → BookStyle。`fonts` 不由统计产生（转曲 PDF 里没有字体资源），由调用方给。 */
export function inferBookStyle(
  profile: BookProfile,
  pages: PageSpec[],
  fonts: Record<string, FontRef>,
  opt: SampleOptions & {
    id?: string;
    /** page-report.mjs 顺带落下的逐类字高（tuplet/verseNum/sectionWord 这几个角色
     *  在 PageSpec 里没有独立字段，只能从归类结果拿）。 */
    classHeights?: Record<string, number[]>;
  } = {},
): { style: BookStyle; report: StyleReport } {
  const base = defaultBookStyle();
  const roleFont = roleFontDefaults();
  const samples = collectRoleSamples(pages, opt);
  const ms = collectMetricSamples(pages, opt);
  const warnings: string[] = [];

  // 汉字档的字号**只按汉字量**：一档里混着数字、标点和「一」这种扁字，中位数会被压下去
  //（目录条目 8.7 → 7.8，与歌词的比例就跟原书对不上了；fontSizeFor 反算时用的样本字也是「国」，
  //  两边口径必须一致）。过滤后没样本的角色（纯西文的那几档）退回全部样本。
  const CJK_ROLES = new Set<StyleRole>([
    "lyric", "lyric2", "title", "credit", "story", "toc", "tocHeading", "tocSub",
    "frontTitle", "category", "header", "sectionWord",
  ]);
  const isCjk = (ch: string | undefined): boolean => !!ch && /[\u4e00-\u9fff]/.test(ch);
  const byRole = new Map<StyleRole, number[]>();
  const byRoleAll = new Map<StyleRole, number[]>();
  for (const s of samples) {
    const all = byRoleAll.get(s.role) ?? [];
    all.push(s.h);
    byRoleAll.set(s.role, all);
    if (CJK_ROLES.has(s.role) && !isCjk(s.ch)) continue;
    const a = byRole.get(s.role) ?? [];
    a.push(s.h);
    byRole.set(s.role, a);
  }
  for (const [role, all] of byRoleAll) if (!byRole.get(role)?.length) byRole.set(role, all);
  // 没有 PageSpec 字段的那几个角色，从归类字高直方图补
  const CLASS_ROLE: Record<string, StyleRole> = {
    tupletNum: "tuplet",
    verseNum: "verseNum",
    sectionWord: "sectionWord",
    category: "category",
  };
  for (const [cls, role] of Object.entries(CLASS_ROLE)) {
    const hs = opt.classHeights?.[cls];
    if (hs?.length && !byRole.get(role)?.length) byRole.set(role, hs);
  }
  const roles = {} as Record<StyleRole, RoleStyle>;
  const roleReport: Partial<Record<StyleRole, Summary>> = {};
  const derived: StyleRole[] = [];
  for (const r of STYLE_ROLES) {
    const sum = summarize(byRole.get(r) ?? []);
    roleReport[r] = sum;
    roles[r] = {
      font: roleFont[r].font,
      align: roleFont[r].align,
      size: sum.n ? Number(sum.p50.toFixed(2)) : base.roles[r].size,
      baselineAdjust: 0,
    };
    if (!sum.n) derived.push(r);
    else if (sum.n < 50) warnings.push(`角色 ${r} 样本偏少（n=${sum.n}）`);
    if (sum.madRatio > 0.12) warnings.push(`⚠ 角色 ${r} 离散偏大（MAD/p50=${sum.madRatio.toFixed(3)}，n=${sum.n}），多半是两族混在一桶`);
  }

  // 没有任何实测样本的角色，从同版式的邻近角色派生（**不是猜**：段号与歌词同号、
  // 段落词随歌词、三连音数字若连小字档都没采到就按印刷惯例取音符的 0.62）。
  for (const r of derived) {
    const from: Partial<Record<StyleRole, StyleRole>> = { verseNum: "lyric", sectionWord: "lyric", category: "header", smufl: "note" };
    const src = from[r];
    if (src && roleReport[src]?.n) {
      roles[r].size = roles[src].size;
      warnings.push(`角色 ${r} 无实测样本，派生自 ${src}（${roles[r].size}pt）`);
    } else if (r === "tuplet") {
      roles[r].size = Number((roles.note.size * 0.62).toFixed(2));
      warnings.push(`角色 tuplet 无实测样本，按音符字号 × 0.62 派生（${roles[r].size}pt）`);
    } else {
      warnings.push(`角色 ${r} 无实测样本，沿用默认字号 ${roles[r].size}`);
    }
  }

  const noteH = roles.note.size || med(ms.noteH) || 5;
  const em = (v: number[]) => Number(((med(v) || 0) / noteH).toFixed(4));
  const pt = (v: number[]) => Number((med(v) || 0).toFixed(3));

  const metricReport: Record<string, Summary & { em?: number }> = {};
  const rec = (name: string, v: number[], asEm: boolean) => {
    const sum = summarize(v);
    metricReport[name] = asEm ? { ...sum, em: sum.p50 / noteH } : sum;
    if (!sum.n) warnings.push(`间距 ${name} 没有样本`);
    else if (sum.n < 200) warnings.push(`间距 ${name} 样本偏少（n=${sum.n}）`);
    else if (sum.madRatio > 0.15) warnings.push(`⚠ 间距 ${name} 离散偏大（MAD/p50=${sum.madRatio.toFixed(3)}，n=${sum.n}）`);
    return sum;
  };

  rec("systemGap", ms.systemGap, true);
  rec("noteStep", ms.noteStep, true);
  rec("barGap", ms.barGap, true);
  rec("octaveDotUpGap", ms.octaveDotUpGap, true);
  rec("octaveDotDownGap", ms.octaveDotDownGap, true);
  rec("octaveDotStep", ms.octaveDotStep, true);
  rec("divLineGap", ms.divLineGap, true);
  rec("divLineStep", ms.divLineStep, true);
  rec("divLineLen", ms.divLineLen, true);
  rec("divLineWidth", ms.divLineWidth, false);
  rec("augmentLineLen", ms.augmentLineLen, true);
  rec("augmentLineWidth", ms.augmentLineWidth, false);
  rec("augmentDotGap", ms.augmentDotGap, true);
  rec("barlineHeight", ms.barlineHeight, false);
  rec("barlineWidth", ms.barlineWidth, false);
  rec("repeatDotDiam", ms.repeatDotDiam, false);
  rec("bracketWidth", ms.bracketWidth, false);
  rec("bracketFootLen", ms.bracketFootLen, false);
  rec("tupletNumH", ms.tupletNumH, false);
  rec("slurThickness", ms.slurThickness, false);
  rec("slurHeight", ms.slurHeight, false);
  rec("chordToNote", ms.chordToNote, true);
  rec("musicToLyric", ms.musicToLyric, true);
  rec("lyricToLyric", ms.lyricToLyric, true);
  rec("titleToSystem", ms.titleToSystem, true);
  rec("creditToSystem", ms.creditToSystem, true);
  rec("keyMeterToSystem", ms.keyMeterToSystem, true);
  rec("titleBaseline", ms.titleBaseline, false);
  rec("numberBaseline", ms.numberBaseline, false);
  rec("keyMeterBaseline", ms.keyMeterBaseline, false);
  rec("creditFirstBaseline", ms.creditFirstBaseline, false);
  rec("creditLineGap", ms.creditLineGap, false);
  rec("firstSystemTop", ms.firstSystemTop, false);
  rec("contSystemTop", ms.contSystemTop, false);

  // 三个层距（高音点上距 / 低音点下距 / 减时线首层距）够近才共用一把尺子，
  // 否则 applyBookStyle 那边要分开覆写（见计划 §5.3 与 docs/实现/简谱纵向栅格.md）。
  const gUp = med(ms.octaveDotUpGap);
  const gDown = med(ms.octaveDotDownGap);
  const gDiv = med(ms.divLineGap);
  const spread = Math.max(gUp, gDown, gDiv) - Math.min(gUp, gDown, gDiv);
  if (spread > noteH * 0.1) {
    warnings.push(
      `⚠ 层距不等：高音点上 ${gUp.toFixed(2)} / 低音点下 ${gDown.toFixed(2)} / 减时线 ${gDiv.toFixed(2)}（差 ${spread.toFixed(2)}pt > 0.1 字高），` +
        `jpStackGap 需要拆成三个字段分别覆写`,
    );
  }

  const metrics: BookStyle["metrics"] = {
    ...base.metrics,
    systemGapEm: em(ms.systemGap),
    noteStepEm: em(ms.noteStep),
    barGapEm: em(ms.barGap),
    octaveDotUpGapEm: em(ms.octaveDotUpGap),
    octaveDotDownGapEm: em(ms.octaveDotDownGap),
    octaveDotStepEm: em(ms.octaveDotStep),
    divLineGapEm: em(ms.divLineGap),
    divLineStepEm: em(ms.divLineStep),
    divLineLenEm: em(ms.divLineLen),
    inkDivLineWidth: pt(ms.divLineWidth),
    augmentLineLenEm: em(ms.augmentLineLen),
    inkAugmentLineWidth: pt(ms.augmentLineWidth),
    augmentDotGapEm: em(ms.augmentDotGap),
    barlineHeightEm: pt(ms.barlineHeight),
    inkBarlineWidth: pt(ms.barlineWidth),
    repeatDotDiam: pt(ms.repeatDotDiam),
    // 房号（1./2.）与三连音的括线：原书量到的线宽与「脚」长（脚长按音符字高归一）
    inkBracketWidth: pt(ms.bracketWidth),
    bracketFootEm: em(ms.bracketFootLen),
    tupletNumEm: em(ms.tupletNumH),
    inkSlurWidth: pt(ms.slurThickness),
    slurHeightEm: pt(ms.slurHeight),
    // slurArcEm 不从原书量：那边量到的是 slur 对象的包围盒高（含描边外扩、且短弧居多），
    // 拿来当弧的凸起高度会扁得几乎没有弧度。用默认值，需要再调就改 bookstyle.json。
    slurArcEm: base.metrics.slurArcEm,
    chordToNoteEm: em(ms.chordToNote),
    musicToLyricEm: em(ms.musicToLyric),
    lyricToLyricEm: em(ms.lyricToLyric),
    titleToSystemEm: em(ms.titleToSystem),
    creditToSystemEm: em(ms.creditToSystem),
    keyMeterToSystemEm: em(ms.keyMeterToSystem),
    dotDiam: Number(profile.dotDiam.toFixed(3)),
    stackGapEm: Number(((gUp + gDown + gDiv) / 3 / noteH).toFixed(4)),
  };

  // 版心与页边距：奇偶页分开量。奇数页在右手边、装订边在左，故 inner = 奇数页左缘、
  // outer = 奇数页右缘到纸边；偶数页镜像，用来交叉验证（差得多就说明这本书其实不镜像）。
  const oddLeft = med(ms.oddX0);
  const oddRight = profile.pageW - med(ms.oddX1);
  const evenLeft = med(ms.evenX0);
  const evenRight = profile.pageW - med(ms.evenX1);
  const mirror = Math.abs(oddLeft - evenRight) + Math.abs(oddRight - evenLeft) < Math.abs(oddLeft - evenLeft) + Math.abs(oddRight - evenRight);
  const inner = mirror ? (oddLeft + evenRight) / 2 : (oddLeft + evenLeft) / 2;
  const outer = mirror ? (oddRight + evenLeft) / 2 : (oddRight + evenRight) / 2;
  if (!mirror) warnings.push(`版心不是对开镜像（奇 ${oddLeft.toFixed(1)}/${oddRight.toFixed(1)} 偶 ${evenLeft.toFixed(1)}/${evenRight.toFixed(1)}），mirror 置 false`);
  const cb = profile.contentBox;
  const style: BookStyle = {
    ...base,
    id: opt.id ?? profile.id ?? "book",
    page: {
      w: Number(profile.pageW.toFixed(3)),
      h: Number(profile.pageH.toFixed(3)),
      mirror,
      margin: {
        inner: Number(inner.toFixed(2)),
        outer: Number(outer.toFixed(2)),
        top: Number(cb.y.toFixed(2)),
        bottom: Number((profile.pageH - bottom(cb)).toFixed(2)),
      },
      contentBox: { x: Number(cb.x.toFixed(2)), y: Number(cb.y.toFixed(2)), w: Number(cb.w.toFixed(2)), h: Number(cb.h.toFixed(2)) },
    },
    fonts,
    roles,
    metrics,
    toc: { ...base.toc, ...inferTocRule(pages) },
    titleBlock: {
      numberBaseline: pt(ms.numberBaseline) || base.titleBlock.numberBaseline,
      titleBaseline: pt(ms.titleBaseline) || base.titleBlock.titleBaseline,
      keyMeterBaseline: pt(ms.keyMeterBaseline) || base.titleBlock.keyMeterBaseline,
      creditFirstBaseline: pt(ms.creditFirstBaseline) || base.titleBlock.creditFirstBaseline,
      creditLineGap: pt(ms.creditLineGap) || base.titleBlock.creditLineGap,
      firstSystemTop: pt(ms.firstSystemTop) || base.titleBlock.firstSystemTop,
      contSystemTop: pt(ms.contSystemTop) || base.titleBlock.contSystemTop,
      headerBaseline: pt(ms.topY) || base.titleBlock.headerBaseline,
      footerBaseline: pt(ms.bottomY) || base.titleBlock.footerBaseline,
    },
    header: { ...base.header, band: profile.headerBand ?? base.header.band },
    footer: { ...base.footer, band: profile.footerBand ?? base.footer.band },
  };

  return { style, report: { roles: roleReport, metrics: metricReport, warnings } };
}
