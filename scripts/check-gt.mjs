// 校验 testdata 下各 .jpwabc GT 能被编辑器正常解析/排版：报页数与控制台错误。
// 用法: node check-gt.mjs [歌谱名子串...]
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { serveDist, launchPage, loadApp, readJpwabc } from "./harness.mjs";
const TESTDATA = join(process.cwd(), "testdata");
const { port, close: closeServer } = await serveDist();
const filters = process.argv.slice(2);
const { browser, page, errors: errs } = await launchPage({ viewport: { width: 1200, height: 800 }, quiet: true });
await loadApp(page, port);
for (const d of (await readdir(TESTDATA,{withFileTypes:true})).filter(x=>x.isDirectory())) {
  if (filters.length && !filters.some(f=>d.name.includes(f))) continue;
  const files = await readdir(join(TESTDATA,d.name));
  const gt = files.find(f=>f.endsWith(".jpwabc"));
  if (!gt) { console.log("—  ", d.name, "(无 GT)"); continue; }
  const text = await readJpwabc(join(TESTDATA,d.name,gt));
  errs.length = 0;
  const r = await page.evaluate(async (t)=>{
    window.__app.setText(t);
    await new Promise(r=>setTimeout(r,300));
    return { pages: document.querySelectorAll("#score-pane svg.score-page").length,
             lines: (window.__app.getText().match(/\$\(/g)||[]).length };
  }, text);
  const bad = errs.filter(e=>!/favicon/.test(e));
  console.log(bad.length?"✗":"✓", d.name, `页=${r.pages} 排版行=${r.lines}`, bad.join(" | "));
}
await browser.close(); closeServer();
