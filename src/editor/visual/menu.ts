// 可视化编辑的**右键菜单**与**记号面板**：给不熟悉快捷键的人用。
//
// 两者都从动作表（`keys.ts::VISUAL_ACTIONS`）生成——动作名、快捷键提示、在哪种模式下可用都取自那一份，
// 点了调的是控制器同一个 `run`，不另写一套逻辑。

import { VISUAL_ACTIONS, type VisualAction, type VisualMode } from "./keys";

/** 面板与菜单里不列的：移动、轮换这类纯键盘操作，和面板自己的开关 */
const KEYBOARD_ONLY = new Set(["nav.prev", "nav.next", "nav.extendPrev", "nav.extendNext", "nav.home", "nav.end", "mark.next", "mark.prev"]);

/** 唱名那个动作展开成一排：1–7、0 */
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "0"];

export interface MenuRunner {
  readonly mode: VisualMode;
  run(a: VisualAction, key?: string): boolean;
  /** 跑完把焦点还给谱面（键盘接着能用） */
  refocus(): void;
}

/** 右键点中的是什么：决定菜单里摆哪些动作 */
export type MenuTarget = "note" | "mark" | "break" | "caret" | "other";

const listed = (): VisualAction[] => VISUAL_ACTIONS.filter((a) => !KEYBOARD_ONLY.has(a.id));
const usable = (a: VisualAction, mode: VisualMode): boolean => !a.modes || a.modes.includes(mode);

function button(label: string, title: string, onPick: () => void, cls = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.title = title;
  // 按下时不抢谱面的焦点
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", onPick);
  return b;
}

// ───────────────────────── 记号面板 ─────────────────────────

/** 面板上每个按钮显示什么（缺省用动作名） */
const SHORT: Record<string, string> = {
  "oct.up": "高音点", "oct.down": "低音点", "acc.sharp": "♯", "acc.flat": "♭", "acc.natural": "♮",
  "dur.halve": "减时线", "dur.double": "加倍", "dur.dot": "附点", "sus.add": "增时线 -",
  "slur.toggle": "圆滑线", "tie.toggle": "延音线", "deco.fermata": "延长号", "deco.accent": "重音",
  "bar.insert": "小节线 |", "brk.line": "换行 ↵", "brk.page": "换页 ⤓", "del.forward": "删除", "del.back": "退格",
  "mode.insert": "插入模式", "mode.edit": "编辑模式", "view.formatMarks": "¶", "edit.undo": "撤销", "edit.redo": "重做",
};

/** 把面板建进 `root`；返回刷新函数（模式一变，按钮可用与否跟着变）。 */
export function buildPalette(root: HTMLElement, r: MenuRunner): () => void {
  root.replaceChildren();
  const entries: { a: VisualAction; el: HTMLButtonElement }[] = [];
  const groups = new Map<string, HTMLElement>();
  for (const a of listed()) {
    let g = groups.get(a.group);
    if (!g) {
      g = document.createElement("div");
      g.className = "visual-palette-group";
      g.dataset.group = a.group;
      groups.set(a.group, g);
      root.appendChild(g);
    }
    if (a.id === "note.digit") {
      for (const d of DIGITS) {
        const el = button(d === "0" ? "0" : d, `${d === "0" ? "休止" : `唱名 ${d}`}（${a.help}）`, () => {
          r.run(a, d);
          r.refocus();
        }, "visual-palette-digit");
        g.appendChild(el);
        entries.push({ a, el });
      }
      continue;
    }
    const el = button(SHORT[a.id] ?? a.label, `${a.label}（${a.keyText}）：${a.help}`, () => {
      r.run(a);
      r.refocus();
    });
    g.appendChild(el);
    entries.push({ a, el });
  }
  return () => {
    for (const { a, el } of entries) el.disabled = !usable(a, r.mode);
  };
}

// ───────────────────────── 右键菜单 ─────────────────────────

/** 各种目标上摆哪些动作（按动作 id 前缀 / 全名挑） */
function actionsFor(target: MenuTarget, mode: VisualMode): VisualAction[] {
  const all = listed().filter((a) => usable(a, mode));
  switch (target) {
    case "mark":
    case "break":
      return all.filter((a) => a.id === "del.forward" || a.id.startsWith("edit."));
    case "caret":
      return all.filter((a) => ["note.digit", "sus.add", "bar.insert", "brk.line", "brk.page", "del.forward", "del.back", "mode.edit", "dur.halve", "dur.double"].includes(a.id));
    case "note":
      return all.filter((a) => !["mode.edit", "del.back", "view.formatMarks"].includes(a.id));
    default:
      return all.filter((a) => a.id.startsWith("edit.") || a.id === "view.formatMarks");
  }
}

let openMenu: HTMLElement | null = null;

export function closeMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

/** 在屏幕坐标 `(x, y)` 弹出菜单。 */
export function showMenu(x: number, y: number, target: MenuTarget, r: MenuRunner): void {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "visual-menu";
  menu.setAttribute("role", "menu");
  const pick = (a: VisualAction, key?: string) => () => {
    closeMenu();
    r.run(a, key);
    r.refocus();
  };
  for (const a of actionsFor(target, r.mode)) {
    if (a.id === "note.digit") {
      const row = document.createElement("div");
      row.className = "visual-menu-digits";
      for (const d of DIGITS) row.appendChild(button(d, d === "0" ? "休止" : `唱名 ${d}`, pick(a, d)));
      menu.appendChild(row);
      continue;
    }
    const item = button("", a.help, pick(a), "visual-menu-item");
    const label = document.createElement("span");
    label.textContent = a.label;
    const key = document.createElement("kbd");
    key.textContent = a.keyText;
    item.append(label, key);
    item.setAttribute("role", "menuitem");
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  // 贴着指针弹出，出不了视口
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  openMenu = menu;
  const away = (e: Event): void => {
    if (e instanceof KeyboardEvent && e.key !== "Escape") return;
    if (e.target instanceof Node && menu.contains(e.target)) return;
    closeMenu();
    document.removeEventListener("mousedown", away, true);
    document.removeEventListener("keydown", away, true);
  };
  document.addEventListener("mousedown", away, true);
  document.addEventListener("keydown", away, true);
}
