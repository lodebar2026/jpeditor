// 从原书的版面规格统计出「书籍样式」——两条重排路（relayout 原位替换 / rebuild 数据重排）
// 共用的字体·字号·间距参数集。
//
//   node gen-bookstyle.mjs            # 写 testdata/500/bookstyle.json + bookstyle-report.md
//   node gen-bookstyle.mjs --check    # 只打统计表，不写文件
//   node gen-bookstyle.mjs --fonts=my-fonts.json
//
// 输入只有 page-report.mjs 出的 pdf-layout.json（不重开 PDF、不重跑归类），秒级、可反复跑。
// 字号与间距一律取**同类型中位数**：原件是排好版付印的，抖动来自轮廓量测，取中位数才是原书的意图。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadCli } from "./node-harness.mjs";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")));
const CHECK = "check" in flags;
const LAYOUT = flags.layout ?? "pdf-layout.json";
const OUTDIR = flags.out ?? "testdata/500";

const cli = await loadCli();
const layout = JSON.parse(await readFile(LAYOUT, "utf8"));
const fonts = flags.fonts ? JSON.parse(await readFile(flags.fonts, "utf8")) : cli.defaultFonts();

const { style, report } = cli.inferBookStyle(layout.profile, layout.pages, fonts, {
  id: flags.id ?? layout.profile?.id ?? "book",
  classHeights: layout.classHeights,
  fromPage: Number(flags.from ?? 40),
  toPage: Number(flags.to ?? 560),
});

const { errors } = cli.validateBookStyle(style);
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : "—");
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : "—");

const lines = [];
lines.push(`# 书籍样式统计（${style.id}）`, "");
lines.push(`来源：${LAYOUT}（${layout.pages.length} 页，采样 ${flags.from ?? 40}–${flags.to ?? 560}）`, "");
lines.push(`页面 ${f3(style.page.w)} × ${f3(style.page.h)} pt；版心 x=${f2(style.page.contentBox.x)} y=${f2(style.page.contentBox.y)} w=${f2(style.page.contentBox.w)} h=${f2(style.page.contentBox.h)}`);
lines.push(`页边距 inner=${f2(style.page.margin.inner)} outer=${f2(style.page.margin.outer)} top=${f2(style.page.margin.top)} bottom=${f2(style.page.margin.bottom)}`, "");

lines.push("## 各角色字号（pt，取同类型字形高度中位数）", "");
lines.push("| 角色 | 字体 | 字号 | n | p25 | p75 | MAD/p50 |", "|---|---|---|---|---|---|---|");
for (const [role, sum] of Object.entries(report.roles)) {
  lines.push(`| ${role} | ${style.roles[role].font} | ${f2(style.roles[role].size)} | ${sum.n} | ${f2(sum.p25)} | ${f2(sum.p75)} | ${sum.madRatio.toFixed(3)}${sum.madRatio > 0.12 ? " ⚠" : ""} |`);
}
lines.push("");

lines.push("## 间距（pt 与 em；em 基准 = 音符字高 " + f2(style.roles.note.size) + "pt）", "");
lines.push("| 项 | n | p50(pt) | em | p25 | p75 | MAD/p50 |", "|---|---|---|---|---|---|---|");
for (const [k, sum] of Object.entries(report.metrics)) {
  lines.push(`| ${k} | ${sum.n} | ${f3(sum.p50)} | ${sum.em === undefined ? "—" : sum.em.toFixed(4)} | ${f3(sum.p25)} | ${f3(sum.p75)} | ${sum.madRatio.toFixed(3)}${sum.madRatio > 0.15 ? " ⚠" : ""} |`);
}
lines.push("");

if (report.warnings.length) {
  lines.push("## 提示", "");
  for (const w of report.warnings) lines.push(`- ${w}`);
  lines.push("");
}
if (errors.length) {
  lines.push("## 校验错误", "");
  for (const e of errors) lines.push(`- ${e}`);
  lines.push("");
}

const md = lines.join("\n");
console.log(md);

if (!CHECK) {
  await mkdir(OUTDIR, { recursive: true });
  await writeFile(`${OUTDIR}/bookstyle.json`, JSON.stringify(style, null, 2));
  await writeFile(`${OUTDIR}/bookstyle-report.md`, md);
  console.log(`\n写入 ${OUTDIR}/bookstyle.json 与 bookstyle-report.md`);
}
if (errors.length) process.exitCode = 1;
