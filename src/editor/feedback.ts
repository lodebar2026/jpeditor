// 意见反馈入口（桌面版）：用 mailto: 唤起系统邮件客户端，预填收件人、带版本号的主题
// 和一段环境信息（用户想删就删）。不自建上报服务——这个应用全程本地运行，不该为了
// 一条反馈开一条网络通道。
import { APP_VERSION, openExternal } from "./update";

export const FEEDBACK_EMAIL = "lo.debar.2026@gmail.com";

function envLines(): string {
  const ua = navigator.userAgent;
  const os = /Mac OS X ([\d_]+)/.exec(ua)?.[1].replace(/_/g, ".");
  const win = /Windows NT ([\d.]+)/.exec(ua)?.[1];
  const plat = os ? `macOS ${os}` : win ? `Windows NT ${win}` : ua.slice(0, 120);
  return [
    "",
    "",
    "--- 以下为环境信息，便于定位问题，可自行删除 ---",
    `版本：${APP_VERSION}`,
    `系统：${plat}`,
    `日期：${new Date().toISOString().slice(0, 10)}`,
  ].join("\n");
}

/** 打开邮件客户端。失败（没有默认邮件客户端）时把地址交还给调用方显示，
 *  别静默什么都不发生。抛出的错误由调用方兜。 */
export async function openFeedbackMail(): Promise<void> {
  const subject = encodeURIComponent(`简谱编辑器反馈 v${APP_VERSION}`);
  const body = encodeURIComponent(`请描述问题或建议：${envLines()}`);
  await openExternal(`mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`);
}
