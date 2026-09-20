// 桌面版的版本更新检测。
//
// **只查不装**：查 GitHub Releases API 比对版本号，发现新版就问一句，点确定用 opener 插件
// 打开 release 页让用户自己装。没上 `tauri-plugin-updater`——那条路要生成并保管签名密钥、
// 改 build.yml 注入 TAURI_SIGNING_PRIVATE_KEY 并产出 latest.json（动 workflow），
// 而且存量用户仍得手动装一次新版才享受得到。接口留在这儿，日后想换只换本文件。
//
// Web 版不需要（刷新即最新），调用方一律先判 `isTauriRuntime()`；本文件的
// `maybeAutoCheck` 自己也判一道，防漏。
import { showConfirmDialog } from "./dialogs";
import { isTauriRuntime } from "./fileio";

const REPO = "lodebar2026/jpeditor";
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
export const HOMEPAGE = "https://lodebar2026.github.io/jpeditor/";

/** 构建期由 vite define 注入（取 package.json 的 version）。 */
export const APP_VERSION = __APP_VERSION__;

export interface LatestRelease {
  /** 去掉前导 v 的版本号 */
  version: string;
  /** release 页地址 */
  url: string;
}

/** 按 `.` 拆数字段比较；非数字段（`0.8.0-rc1` 的后缀）当 0。a>b 返回正数。 */
export function cmpVersion(a: string, b: string): number {
  const parts = (v: string) => v.split(".").map((x) => parseInt(x, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 查最新 release。任何异常 / 非 200 / 解析不出版本号都返回 null——
 *  静默检查绝不能因为断网弹错误框。 */
export async function fetchLatestRelease(): Promise<LatestRelease | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const resp = await fetch(LATEST_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: ac.signal,
    });
    if (!resp.ok) return null;
    const j: unknown = await resp.json();
    const tag = (j as { tag_name?: unknown })?.tag_name;
    if (typeof tag !== "string") return null;
    const version = tag.replace(/^v/i, "").trim();
    if (!/^\d/.test(version)) return null;
    const url = (j as { html_url?: unknown }).html_url;
    return { version, url: typeof url === "string" ? url : RELEASES_PAGE };
  } catch {
    return null; // 断网 / 超时 / 限流
  } finally {
    clearTimeout(timer);
  }
}

/** 用系统默认浏览器打开链接（桌面 webview 里 <a target=_blank> 不靠谱）。 */
export async function openExternal(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/** 发现新版本时的询问框。确定 → 打开 release 页。 */
export async function promptUpdate(rel: LatestRelease): Promise<void> {
  const ok = await showConfirmDialog(
    "发现新版本",
    `当前版本 ${APP_VERSION}，最新版本 ${rel.version}。是否打开下载页面？`,
  );
  if (ok) await openExternal(rel.url);
}

// ---- 检查状态的持久化 -------------------------------------------------------
// 不进 PersistedSettings：那份是 App.saveSettings 整对象覆盖写的，从这里补字段会被抹掉。
// 照 settings.ts 的约定，存取一律吞异常。

const STATE_KEY = "jpeditor-update-state";
const CHECK_INTERVAL_MS = 24 * 3600 * 1000;

interface UpdateState {
  /** 启动时自动检查，默认开 */
  auto?: boolean;
  /** 上次检查的时间戳，用于节流 */
  lastCheck?: number;
  /** 已经提示过的版本号，同一版本不再打扰 */
  notified?: string;
}

function loadState(): UpdateState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return {};
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" ? (v as UpdateState) : {};
  } catch {
    return {};
  }
}

function saveState(patch: UpdateState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ ...loadState(), ...patch }));
  } catch {
    // 存储不可用——最多是下次启动又检查一遍
  }
}

export function isAutoCheckEnabled(): boolean {
  return loadState().auto !== false;
}

export function setAutoCheckEnabled(on: boolean): void {
  saveState({ auto: on });
}

/** 关于页的「检查更新」按钮用：null = 查询失败（网络问题），"latest" = 已是最新。 */
export async function checkForUpdate(): Promise<LatestRelease | "latest" | null> {
  const rel = await fetchLatestRelease();
  if (!rel) return null;
  saveState({ lastCheck: Date.now() });
  return cmpVersion(rel.version, APP_VERSION) > 0 ? rel : "latest";
}

/** 启动后的静默检查：只在桌面版、开关未关、距上次检查超过 24h 才查；
 *  有新版且该版本没提示过才弹一次。全程不报错。 */
export async function maybeAutoCheck(): Promise<void> {
  if (!isTauriRuntime()) return;
  const st = loadState();
  if (st.auto === false) return;
  if (st.lastCheck && Date.now() - st.lastCheck < CHECK_INTERVAL_MS) return;
  const rel = await fetchLatestRelease();
  saveState({ lastCheck: Date.now() });
  if (!rel) return;
  if (cmpVersion(rel.version, APP_VERSION) <= 0) return;
  if (st.notified === rel.version) return;
  saveState({ notified: rel.version });
  await promptUpdate(rel);
}
