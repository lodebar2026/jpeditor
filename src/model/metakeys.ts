// 扩展 meta 的键注册表与读写。`Song.meta` 是 map（`doc.ts::SongMeta`），**扩一个数据项只在这里加一行**：
// 解析器、写出端、书清单、模板都按键走，不改模型类型。不在表里的键照样保存和往返，只是没有默认角色。
// 设计见 docs/样式机制.md §9。
//
// 无 DOM 依赖。
import type { Creator, Song, SongMeta } from "./doc";

export interface MetaKeyDef {
  key: string;
  /** 编辑器表单、报表用的名字 */
  label: string;
  /** 默认排版角色（`style/sheet.ts::StyleRole`；这里写字符串，模型层不依赖样式层） */
  role?: string;
  /** 录入一整串时按它切成多项（标签 `a；b;c`） */
  split?: RegExp;
  /** 值是布尔开关（"true"/"false"） */
  flag?: boolean;
}

export const META_KEYS: readonly MetaKeyDef[] = [
  { key: "title-alt", label: "英文标题", role: "titleAlt" },
  { key: "epigraph", label: "题下经文", role: "epigraph" },
  { key: "epigraph-ref", label: "题下经文出处", role: "epigraphRef" },
  { key: "scripture-refs", label: "经文参考", role: "scriptureRefs" },
  { key: "tags", label: "标签", role: "tags", split: /[;；]/ },
  { key: "category", label: "分类", role: "header" },
  { key: "tune", label: "曲调名", role: "note" },
  { key: "ccli", label: "CCLI 编号", role: "note" },
  { key: "rights-extra", label: "译配权", role: "rights" },
  { key: "note-bl", label: "页脚注释（左）", role: "note" },
  { key: "note-bc", label: "页脚注释（中）", role: "note" },
  { key: "note-br", label: "页脚注释（右）", role: "note" },
  { key: "layout.new-page", label: "另起一页", flag: true },
  { key: "layout.melody-only", label: "只留旋律声部", flag: true },
  { key: "layout.chinese-hyphen", label: "歌词连字符用「—」", flag: true },
];

const BY_KEY = new Map(META_KEYS.map((d) => [d.key, d]));

export function metaKeyDef(key: string): MetaKeyDef | undefined {
  return BY_KEY.get(key);
}

/** 键名是否合法：小写字母/数字开头，其后字母、数字、`-`、`.`（123 `I:meta 键 值` 与 MusicXML name 都放得下）。 */
export function isMetaKey(key: string): boolean {
  return /^[a-z0-9][a-z0-9.-]*$/.test(key);
}

export function getMeta(song: Song, key: string): readonly string[] {
  return song.meta?.[key] ?? [];
}

/** 多项合成一段文字。 */
export function metaText(song: Song, key: string, joiner = "\n"): string {
  return getMeta(song, key).join(joiner);
}

export function metaFlag(song: Song, key: string): boolean | undefined {
  const v = getMeta(song, key)[0]?.trim().toLowerCase();
  if (v === undefined || v === "") return undefined;
  return v === "true" || v === "1" || v === "yes";
}

/** 写一项（整键替换）。空列表 = 删键；删到空时 `meta` 本身也删掉。 */
export function setMeta(song: Song, key: string, values: readonly string[]): void {
  if (values.length === 0) {
    if (!song.meta) return;
    delete song.meta[key];
    if (Object.keys(song.meta).length === 0) delete song.meta;
    return;
  }
  (song.meta ??= {})[key] = [...values];
}

/** 追加一项（123 的多行 `I:meta tags …`、MusicXML 同名多个 `<miscellaneous-field>`）。 */
export function addMeta(song: Song, key: string, value: string): void {
  ((song.meta ??= {})[key] ??= []).push(value);
}

/** 按键浅覆盖（书清单优先于谱文件）。不改入参。 */
export function overlayMeta(base: SongMeta | undefined, over: SongMeta | undefined): SongMeta | undefined {
  if (!over || Object.keys(over).length === 0) return base;
  return { ...(base ?? {}), ...over };
}

/** 一整串按注册表的 `split` 切成多项（没登记 split 的键原样一项）。 */
export function splitMetaValue(key: string, text: string): string[] {
  const re = metaKeyDef(key)?.split;
  if (!re) return [text];
  return text.split(re).map((s) => s.trim()).filter((s) => s.length > 0);
}

// ───────────────────────── 词曲署名的类型 ─────────────────────────

const LABEL_TYPE: readonly [RegExp, string][] = [
  [/^词\s*[、/&和]?\s*曲$/, "words-and-music"],
  [/^(作\s*词|填\s*词|词)$/, "lyricist"],
  [/^(作\s*曲|曲)$/, "composer"],
  [/^(编\s*曲|改\s*编|编)$/, "arranger"],
  [/^(译\s*词|译\s*配|配\s*译|中\s*译|翻\s*译|译)$/, "translator"],
  [/^(制\s*谱|打\s*谱)$/, "transcriber"],
];

function typeOfLabel(label: string): string | null {
  const t = label.trim();
  for (const [re, type] of LABEL_TYPE) if (re.test(t)) return type;
  return null;
}

/**
 * 按原文里的标签定署名类型：前缀式「作词：X」「词曲: X」或后缀式「X 词」「X 词曲」。
 * **只认明写的标签**，认不出返回 null（调用方按老规矩记 composer）——文本一字不改。
 */
export function creatorTypeOf(text: string): string | null {
  const t = text.trim();
  const pre = /^([^：:]{1,8}?)\s*[：:]/.exec(t);
  if (pre) return typeOfLabel(pre[1]!);
  // 后缀式：名字至少两个字，避免把单字「曲」当成整条署名
  const suf = /^(.{2,}?)\s*(词\s*曲|作词|作曲|编曲|词|曲)$/.exec(t);
  if (suf && !/[（(]$/.test(suf[1]!)) return typeOfLabel(suf[2]!);
  return null;
}

/** 无 type 源格式的一条署名。 */
export function creatorOf(text: string): Creator {
  return { type: creatorTypeOf(text) ?? "composer", text };
}
