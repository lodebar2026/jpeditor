// 谱行的**声部标签**（`Soprano 1` / `Alto` / `Women` …）：切条、算指纹。
//
// 为什么要它：跨系统连接改成全局指派之后（`staffomr/score.ts::assignSlots`），
// 定谱行身份靠「谱号 + 有没有词 + 音域中位数」三样。前两样在合唱谱上分不开人声行
// （SATB 同是常规大小的 G 谱号、都印歌词），全靠音域；而音域**跨段落会整体挪**
// ——破碎那份 3 行/4 行系统里女高唱 31~32、7 行系统里同一个声部唱到 36，
// 于是被判成另一条声部。谱面印的标签是唯一分得开的证据（人工映射也正是照它手改的）。
//
// **只按固定几何裁一条带，不猜哪块墨是标签。** 认字走歌词那条路的老规矩：
// 离线跑一遍 PP-OCR、按**条的内容指纹**落盘（`gen-rasterlabels.mjs` →
// `rasterlabels.json`），识别时查缓存，不起浏览器；定位交给生成器里的 **DBNet 文本检测**。
//
// 两条弯路，都撤了：
//   - **「不认字、只比标签图」**（32×32 签名聚类）：`Soprano` / `Soprano 1` /
//     `Soprano 2` 尾部只差一两个字符，归一化之后聚成同一类（汉明距离闸放到 55
//     仍全归一类），宽度 6.4~7.6 格也重叠。得真读出字来。
//   - **在带里做连通块、按「像字」的高宽筛、缝隙不到 0.7 格的连成一串**：
//     带放宽就灌进上一行谱的歌词与弧线、收紧就漏掉标签，六种调法（取最靠下的文字行、
//     加白边、笔画加粗、放宽块高、放宽串宽、放宽带高）**全都劣于原配置**，
//     全语料认得出的声部名始终卡在 8 个。几何闸没有中间地带——定位这件事交给 DBNet。
import type { Binary, Rect } from "../omr/types";
import type { RasterUnit } from "./staffline";

/** 一条标签条：裸像素 + 它在页面上的盒。 */
export interface LabelStrip {
  w: number;
  h: number;
  /** 逐像素 0/1，长 `w*h`，1 = 墨。 */
  data: Uint8Array;
  box: Rect;
  /** 这条属于第几行谱（`SPage.staves` 的下标）。 */
  staff: number;
}

/** 带的窗口（线距的倍数）：顶线上方这一段、谱行左缘往右这一段。
 *
 *  上界给 DBNet 留出高度（太薄它框不出行），带里混进上一行谱的歌词不要紧
 *  ——检测会把它们分成各自的行框，取**最靠近谱行**的那一框即可。
 *  左界要躲开**小节号**：它就印在谱行左缘正上方。 */
const BAND_TOP = 3.0;
const BAND_BOTTOM = 0.15;
const LEFT_SKIP = 1.2;
const RIGHT_FRAC = 0.45;

/**
 * 裁出各谱行的标签带。`staves` 给每行谱的盒（页面坐标），次序即 `SPage.staves`。
 *
 * **几何是死的**——同一页跑几次裁出来的带一模一样，指纹才稳得住。
 * 带里有什么、哪一块是标签，是生成器那边 DBNet + rec 的事。
 */
export function findStaffLabels(
  bin: Binary,
  staves: { box: { left: number; right: number; top: number }; index: number }[],
  unit: RasterUnit,
): LabelStrip[] {
  const sp = unit.space;
  const out: LabelStrip[] = [];
  for (const st of staves) {
    const y0 = Math.max(0, Math.round(st.box.top - sp * BAND_TOP));
    const y1 = Math.max(0, Math.round(st.box.top - sp * BAND_BOTTOM));
    const x0 = Math.max(0, Math.round(st.box.left + sp * LEFT_SKIP));
    const x1 = Math.min(bin.w, Math.round(st.box.left + (st.box.right - st.box.left) * RIGHT_FRAC));
    if (y1 - y0 < 8 || x1 - x0 < 8) continue;
    const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const data = new Uint8Array(box.w * box.h);
    let ink = 0;
    for (let y = 0; y < box.h; y++)
      for (let x = 0; x < box.w; x++) {
        const v = bin.data[(box.y + y) * bin.w + box.x + x];
        data[y * box.w + x] = v;
        ink += v;
      }
    if (!ink) continue; // 整条空白：这一行没印任何东西，不必送 OCR
    out.push({ w: box.w, h: box.h, data, box, staff: st.index });
  }
  return out;
}

/** 条的**内容指纹**（与 `lyric.ts::stripKey` 同一套：尺寸 + FNV-1a）。
 *  几何一动指纹就变，旧缓存自然失效——这正是要的。 */
export function labelKey(s: LabelStrip): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.data.length; i++) {
    h1 ^= s.data[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return `L${s.w}x${s.h}-${h1.toString(36)}`;
}

/**
 * OCR 读出来的字串 → **规范化的声部名**。
 *
 * 只收得下这本书用得上的那几个（合唱谱的声部就这么几种），别的一律判否
 * ——标签条里混进力度、表情文字是常事，收进来会把两条不同的声部判成同一条。
 * 分部号（`1` / `2` / `Ⅰ` / `Ⅱ`）跟在名字后面，是区分 `Soprano 1` 与 `Soprano 2` 的要害。
 */
export function normalizeLabel(text: string): string | null {
  const t = text.toLowerCase().replace(/[^a-z0-9一-鿿]/g, "");
  if (!t) return null;
  // 分部号常被 rec 读成形近的字母：`Soprano 1` → `Sopranol`（实测破碎扫描版）。
  // 名字里没有以这些字母收尾的（`soprano`/`alto`/`men`/`bass`…），拿来当数字很安全。
  const DIGITISH: Record<string, string> = { "1": "1", "2": "2", "3": "3", "4": "4", l: "1", i: "1", z: "2" };
  const last = t.slice(-1);
  const num = DIGITISH[last] ?? "";
  const body = num ? t.slice(0, -1) : t;
  // 中文名直接判（PP-OCR 读中文准，不必模糊）
  const CJK: [RegExp, string][] = [
    [/女高/, "S"], [/女低|中音/, "A"], [/男高/, "T"], [/男低/, "B"],
    [/女声/, "W"], [/男声/, "M"], [/齐唱|全体/, "U"], [/独唱|领唱/, "O"], [/钢琴|伴奏/, "P"],
  ];
  for (const [re, name] of CJK) if (re.test(body)) return name + num;
  // 拉丁名**模糊比**：这几个字小、又印在符号堆里，OCR 常读成
  // `Sopiamo` / `bopranO` / `oopruno`（实测破碎那份 5 个 Soprano 只有 2 个读对）。
  // 编辑距离不超过词长的三成就算认出来。
  const LATIN: [string, string][] = [
    ["soprano", "S"], ["alto", "A"], ["tenor", "T"], ["bass", "B"], ["baritone", "B"],
    ["women", "W"], ["men", "M"], ["unison", "U"], ["solo", "O"], ["piano", "P"], ["tutti", "U"],
  ];
  let best: string | null = null;
  let bd = Infinity;
  for (const [word, name] of LATIN) {
    const d = editDistance(body, word);
    if (d <= Math.floor(word.length * FUZZ) && d < bd) {
      bd = d;
      best = name;
    }
  }
  return best === null ? null : best + num;
}

/** 拉丁名模糊比的容错：编辑距离不超过词长的这个比例。
 *  三成：`soprano`(7) 容 2 个错、`men`(3) 容 0 个——短词本来就容易误收。 */
const FUZZ = 0.3;

function editDistance(a: string, b: string): number {
  const prev = new Int32Array(b.length + 1);
  const cur = new Int32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev.set(cur);
  }
  return prev[b.length];
}
