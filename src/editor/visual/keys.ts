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

export type ActionGroup = "模式" | "移动与选择" | "记号" | "编辑";

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
