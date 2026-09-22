// 可视化编辑的**动作表**：快捷键、名字、说明只写这一份。
//
// 键盘分派（`controller.ts`）、帮助页的快捷键表（`help.ts`）、右键菜单与记号面板都从这里取，
// 加一个动作只改这张表加一个处理函数，几处不会脱节。
//
// **`/` 不绑定**：留给歌词对位（歌词录入模式要用它，见 `docs/待办.md`「可视化编辑的后续」）。

/** 编辑模式 = 方块光标罩住元素；插入模式 = 竖线光标落在两个元素之间。
 *  **不单独存**：由代码区选区推出（非空 = 编辑，空 = 插入），两侧因此不会不同步。 */
export type VisualMode = "edit" | "insert";

export interface KeyBinding {
  /** `KeyboardEvent.key`（字符键按产生的字符认，`#` 就是 `#`） */
  key: string;
  shift?: boolean;
  /** Ctrl（Windows/Linux）或 ⌘（macOS） */
  mod?: boolean;
}

export type ActionGroup = "模式" | "移动与选择" | "音符" | "时值" | "记号" | "换行" | "编辑";

export interface VisualAction {
  id: string;
  label: string;
  group: ActionGroup;
  keys: KeyBinding[];
  /** 帮助与菜单里怎么写这组键 */
  keyText: string;
  /** 哪种模式下可用；缺省两种都行 */
  modes?: VisualMode[];
  /** 一句话说明（帮助页用） */
  help: string;
}

export const VISUAL_ACTIONS: readonly VisualAction[] = [
  { id: "mode.insert", label: "插入模式", group: "模式", keys: [{ key: "Insert" }, { key: "i" }], keyText: "Insert / i",
    modes: ["edit"], help: "方块光标变成竖线，落在选中元素的后面" },
  { id: "mode.edit", label: "编辑模式", group: "模式", keys: [{ key: "Escape" }], keyText: "Esc",
    modes: ["insert"], help: "竖线光标变成方块，罩住光标前面那个元素" },
  { id: "nav.prev", label: "前一个", group: "移动与选择", keys: [{ key: "ArrowLeft" }], keyText: "←",
    help: "编辑模式选中前一个元素；插入模式把光标往前挪一格" },
  { id: "nav.next", label: "后一个", group: "移动与选择", keys: [{ key: "ArrowRight" }], keyText: "→",
    help: "编辑模式选中后一个元素；插入模式把光标往后挪一格" },
  { id: "nav.extendPrev", label: "向前扩选", group: "移动与选择", keys: [{ key: "ArrowLeft", shift: true }], keyText: "Shift+←",
    help: "选区往前多罩一个元素" },
  { id: "nav.extendNext", label: "向后扩选", group: "移动与选择", keys: [{ key: "ArrowRight", shift: true }], keyText: "Shift+→",
    help: "选区往后多罩一个元素" },
  { id: "nav.home", label: "行首", group: "移动与选择", keys: [{ key: "Home" }], keyText: "Home",
    help: "跳到本行（到上一个换行符为止）的第一个元素" },
  { id: "nav.end", label: "行尾", group: "移动与选择", keys: [{ key: "End" }], keyText: "End",
    help: "跳到本行的最后一个元素" },
  { id: "note.digit", label: "唱名 / 休止", group: "音符",
    keys: ["0", "1", "2", "3", "4", "5", "6", "7"].map((key) => ({ key })), keyText: "1–7 · 0",
    help: "编辑模式改选中音符的唱名（八度、时值不变）；插入模式按当前时值插入一个音符" },
  { id: "oct.up", label: "升高八度", group: "音符", keys: [{ key: "ArrowUp" }, { key: "'" }], keyText: "↑ / '",
    modes: ["edit"], help: "加一个高音点（或去掉一个低音点），选了一段就整段一起移" },
  { id: "oct.down", label: "降低八度", group: "音符", keys: [{ key: "ArrowDown" }, { key: "," }], keyText: "↓ / ,",
    modes: ["edit"], help: "加一个低音点（或去掉一个高音点）" },
  { id: "acc.sharp", label: "升号", group: "音符", keys: [{ key: "#" }], keyText: "#",
    modes: ["edit"], help: "加升号，再按一次取消" },
  { id: "acc.flat", label: "降号", group: "音符", keys: [{ key: "b" }], keyText: "b",
    modes: ["edit"], help: "加降号，再按一次取消" },
  { id: "acc.natural", label: "还原号", group: "音符", keys: [{ key: "n" }], keyText: "n",
    modes: ["edit"], help: "加还原号，再按一次取消" },
  { id: "dur.halve", label: "时值减半", group: "时值", keys: [{ key: "_" }], keyText: "_",
    help: "编辑模式：有增时线先去掉一半，否则加一条减时线；插入模式：改「当前时值」" },
  { id: "dur.double", label: "时值加倍", group: "时值", keys: [{ key: "=" }], keyText: "=",
    help: "编辑模式：有减时线先去一条，否则拍数翻倍（加增时线）；插入模式：改「当前时值」" },
  { id: "dur.dot", label: "附点", group: "时值", keys: [{ key: "." }], keyText: ".",
    modes: ["edit"], help: "加上或去掉附点" },
  { id: "sus.add", label: "增时线", group: "时值", keys: [{ key: "-" }], keyText: "-",
    help: "编辑模式在选中音符后面加一条增时线；插入模式在光标处插入一条" },
  { id: "bar.insert", label: "小节线", group: "编辑", keys: [{ key: "|" }], keyText: "|",
    help: "在选中元素后面（插入模式：光标处）插入一根小节线" },
  { id: "brk.line", label: "换行", group: "换行", keys: [{ key: "Enter" }], keyText: "Enter",
    help: "在选中元素后面（插入模式：光标处）换行；这一行曲下的歌词跟着按对位格拆成两半" },
  { id: "brk.page", label: "换页", group: "换行", keys: [{ key: "Enter", shift: true }], keyText: "Shift+Enter",
    help: "同上，换页" },
  { id: "del.forward", label: "删除", group: "编辑", keys: [{ key: "Delete" }], keyText: "Delete",
    help: "编辑模式删掉选中的元素（音符连同它的增时线、和弦名、装饰；换行符删掉后两行并一行，歌词接起来）；插入模式删光标后面那个" },
  { id: "del.back", label: "退格", group: "编辑", keys: [{ key: "Backspace" }], keyText: "Backspace",
    help: "编辑模式同 Delete；插入模式删光标前面那个" },
  { id: "slur.toggle", label: "圆滑线", group: "记号", keys: [{ key: "s" }, { key: "(" }], keyText: "s / (",
    modes: ["edit"], help: "选区首尾两个音之间加上圆滑线；已有同样起止的就去掉" },
  { id: "tie.toggle", label: "延音线", group: "记号", keys: [{ key: "t" }], keyText: "t",
    modes: ["edit"], help: "选中的音与后面同音高的音之间加上或去掉延音线" },
  { id: "deco.fermata", label: "延长号", group: "记号", keys: [{ key: "f" }], keyText: "f",
    modes: ["edit"], help: "选中的音加上或去掉延长号" },
  { id: "deco.accent", label: "重音", group: "记号", keys: [{ key: ">" }], keyText: ">",
    modes: ["edit"], help: "选中的音加上或去掉重音记号" },
  { id: "mark.next", label: "下一个记号", group: "记号", keys: [{ key: "Tab" }], keyText: "Tab",
    modes: ["edit"], help: "在选中音符挂的记号（和弦名、延长号等装饰、注记、圆滑线）之间轮换选中" },
  { id: "mark.prev", label: "上一个记号", group: "记号", keys: [{ key: "Tab", shift: true }], keyText: "Shift+Tab",
    modes: ["edit"], help: "反方向轮换" },
  { id: "view.formatMarks", label: "显示格式标记", group: "编辑", keys: [{ key: "m", mod: true, shift: true }], keyText: "Ctrl/⌘+Shift+M",
    help: "谱面上显示或隐藏换行符 ↵ 与换页符 ⤓（点一下即选中）" },
  { id: "edit.undo", label: "撤销", group: "编辑", keys: [{ key: "z", mod: true }], keyText: "Ctrl/⌘+Z",
    help: "与代码区共用同一份撤销记录" },
  { id: "edit.redo", label: "重做", group: "编辑", keys: [{ key: "z", mod: true, shift: true }, { key: "y", mod: true }], keyText: "Ctrl/⌘+Shift+Z",
    help: "同上" },
];

/** 按下的键对应哪个动作（没有返回 null）。 */
export function actionOfKey(ev: KeyboardEvent): VisualAction | null {
  const mod = ev.ctrlKey || ev.metaKey;
  // 字母键带 Shift 时 `key` 是大写，统一按小写比
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  for (const a of VISUAL_ACTIONS) {
    for (const k of a.keys) {
      if (k.key.toLowerCase() !== key.toLowerCase()) continue;
      if (!!k.mod !== mod) continue;
      // 符号键（`#`、`(`、`|`）本身就要按 Shift 才打得出，不看 Shift
      const shiftMatters = k.key.length > 1 || /[a-z]/i.test(k.key);
      if (shiftMatters && !!k.shift !== ev.shiftKey) continue;
      return a;
    }
  }
  return null;
}
