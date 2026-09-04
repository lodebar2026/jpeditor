// 五线谱识别 ↔ GT musicxml 的**对拍度量**。两条路共用：
//   staff-diff.mjs   —— 赞美之泉那本（矢量路）
//   chorus-diff.mjs  —— 合唱谱（位图路）
//
// **判据只写在这一处。** 抄第二份必然走样——这些函数里每一条都是拿具体曲子换来的
// （允许整首平移八度、允许开头多出一段引子、调号差蕴含的整首移调）。
//
// 与它配套的是 `node-harness.mjs` 里那几个 `xmlXxx` 读 GT 的函数，
// 那边的教训见 docs/实现/五线谱识别.md 的「几处量错了的指标」。
import { lev } from "./staff-align.mjs";

/**
 * 准确率：以 GT 为分母的编辑距离相似度。
 *
 * **允许谱面开头多出一段**（引子／前奏 GT 里没有，实测 p205 头一行是柱状和弦的前奏）：
 * 在谱面序列的前若干音里找起点最好的那个再比。不这么做的话，有引子的曲子
 * 整条序列错位，准确率会掉到五成以下——那不是读错，是两边起点不同。
 *
 * **也允许 GT 开头多出一段休止**（`skipLeadRests`）。合唱谱的 GT 是**全谱**：
 * 每个声部从第一小节就在，不出声的地方写休止；而谱面是**分谱**，声部没进来时
 * 那一行谱根本不印。实测破碎的男低声部 GT 开头有五十个休止，谱面上一个都没有
 * ——不放宽的话整条序列错位五十格，准确率只剩两成。
 * 只跳**开头连续的休止**，中间的休止照旧计入（那是真的信息）；
 * 跳掉之后**分母只算剩下那一段**——那几十个休止在谱面上根本没印，
 * 记成「漏掉」是罚了格式差异，不是罚识别。
 * 一道闸防止空识别蹭分：识别侧的长度至少要有剩下那一段的一半。
 */
export const acc = (a, b, maxSkip = 24, skipLeadRests = false) => {
  if (!b.length) return 0;
  let best = 0;
  for (let s = 0; s <= Math.min(maxSkip, Math.max(0, a.length - 1)); s++) {
    best = Math.max(best, 1 - lev(a.slice(s), b) / b.length);
  }
  if (skipLeadRests) {
    let k = 0;
    while (k < b.length && b[k] === "R") k++;
    if (k > 0) {
      const cut = b.slice(k);
      if (cut.length && a.length >= cut.length * 0.5) {
        for (let s = 0; s <= Math.min(maxSkip, Math.max(0, a.length - 1)); s++) {
          best = Math.max(best, 1 - lev(a.slice(s), cut) / cut.length);
        }
      }
    }
  }
  return best;
};

export const shiftOct = (a, n) =>
  a.map((t) => {
    if (t === "R") return "R";
    const m = /^(.*?)(-?\d+)$/.exec(t);
    return m ? m[1] + (Number(m[2]) + n) : t;
  });

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
/** 五度圈上升降号落在哪个音名（音名序号 C=0…B=6）：升 F C G D A E B、降 B E A D G C F。 */
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6];
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];
/** 这个调号给这个音名的升降（+1/0/−1）。 */
export function keyAlterOf(fifths, letterIdx) {
  if (!fifths) return 0;
  return fifths > 0
    ? (SHARP_ORDER.slice(0, fifths).includes(letterIdx) ? 1 : 0)
    : (FLAT_ORDER.slice(0, -fifths).includes(letterIdx) ? -1 : 0);
}
/** 整首平移 n 个**音级**（全音阶级数，7 = 一个八度）。升降号原样带着——
 *  移调版的谱面升降号本来就跟着调号走，逐音的临时记号在这一档不参与判断。 */
export const shiftStep = (a, n) => {
  if (!n) return a;
  return a.map((t) => {
    if (t === "R") return "R";
    const m = /^([A-G])(.*?)(-?\d+)$/.exec(t);
    if (!m) return t;
    const idx = (Number(m[3]) + 1) * 7 + LETTERS.indexOf(m[1]) - n;
    return LETTERS[((idx % 7) + 7) % 7] + m[2] + (Math.floor(idx / 7) - 1);
  });
};
/**
 * 含升降的音高整首移调。**不能像 `shiftStep` 那样把升降号原样带着**：
 * 移调之后调号变了，同一个音级在新调里该带的升降也跟着变——
 * G 大调的 `F♯` 移到 E 大调是 `A♮`，原样带过去就成了 `A♯`。
 * 保持不变的是「**相对调号的偏离**」（临时记号），所以
 * 新升降 = 原升降 − 原调给原音名的升降 + 新调给新音名的升降。
 *
 * 不这么算的话，272《耶和华尼西》（谱面 1 个升号、GT 4 个）的音高档只有 46.2%，
 * 而音符档是 96.5%——那不是读错，是口径没跟着移调。
 */
export const shiftPitch = (a, n, gotFifths, gtFifths) => {
  if (!n) return a;
  return a.map((t) => {
    if (t === "R") return "R";
    const m = /^([A-G])([+-]*)(-?\d+)$/.exec(t);
    if (!m) return t;
    const oldIdx = LETTERS.indexOf(m[1]);
    const alter = (m[2].match(/\+/g) || []).length - (m[2].match(/-/g) || []).length;
    const idx = (Number(m[3]) + 1) * 7 + oldIdx - n;
    const newIdx = ((idx % 7) + 7) % 7;
    const na = alter - keyAlterOf(gotFifths, oldIdx) + keyAlterOf(gtFifths, newIdx);
    const mark = na > 0 ? "+".repeat(na) : na < 0 ? "-".repeat(-na) : "";
    return LETTERS[newIdx] + mark + (Math.floor(idx / 7) - 1);
  });
};

/**
 * **书上印的调与 GT 不同**时，整首的音名会齐刷刷差一个音程。
 *
 * 实测 272 首《耶和华尼西》谱面印 G 大调（1 个升号）、GT 是 E 大调（4 个升号），
 * 143 个音全都高两个音级——那是**移调版**，不是读错，与已有的「整首差一个八度」
 * 是同一类事（记法不同），得允许平移之后再比。
 *
 * **但不许自由拟合**：一个读错谱号的页面同样是整首差一个常数，放开搜索就把它一并
 * 洗白了。所以平移量**只认调号差算出来的那一个**——识别侧的调号（谱行首的升降号个数）
 * 与 GT 的 `<fifths>` 指到不同的主音时，才按两个主音的音名距离平移。
 */
// fifths → 主音的音名序号（C=0 … B=6）。大调，与 `node-harness.mjs::FIFTHS_KEY` 同一张表。
const TONIC_IDX = { "-7": 0, "-6": 4, "-5": 1, "-4": 5, "-3": 2, "-2": 6, "-1": 3, 0: 0, 1: 4, 2: 1, 3: 5, 4: 2, 5: 6, 6: 3, 7: 0 };
/** 调号差蕴含的音级平移量（−3…+3，取绝对值最小的那一个等价类）。两侧调号相同或读不到时为 0。 */
export function keyShift(gotFifths, gtFifths) {
  if (gotFifths == null || gtFifths == null) return 0;
  const a = TONIC_IDX[String(gotFifths)], b = TONIC_IDX[String(gtFifths)];
  if (a === undefined || b === undefined) return 0;
  let d = (((a - b) % 7) + 7) % 7;
  if (d > 3) d -= 7;
  return d;
}

/** 只留音名（丢掉八度），单独看「音级」这一档——八度整体差一档是**记谱档次不同**，
 *  与读错音是两回事，得分开记（简谱那本书也是这么分的）。 */
export const letters = (a) => a.map((t) => (t === "R" ? "R" : t[0]));

/** 歌词归一：繁→简、去掉标点与空白。**谱面是繁体、GT 是简体**，不归一逐字比全是差异。 */
export const lyricNorm = (t2s, s) => t2s(s).replace(/[\s\u3000，。、；：！？“”‘’（）《》〈〉—…·.,;:!?"'()\-]/g, "");
