import { readFile } from "node:fs/promises";
import { serveDist, launchPage, loadApp, decodeJpwabc } from "./harness.mjs";
const IMG="testdata/日光之下/日光之下简谱.jpg";const GT="testdata/日光之下/日光之下.jpwabc";
const { port, close: closeServer } = await serveDist();
const { browser, page } = await launchPage();
await loadApp(page, port);
const b64=Buffer.from(await readFile(IMG)).toString("base64");
const r=await page.evaluate(async({b64})=>{const omr=await window.__omr;const by=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const bin=await omr.decodeToBinary(by,"image/jpeg");const sc=await omr.recognizeJianpu(bin,omr.paddleOcrBackend());const xml=omr.toMusicXml(sc);window.__app.importBytes(new TextEncoder().encode(xml),"o.musicxml");return {jpw:window.__app.getText(), xml};},{b64});
const gt=decodeJpwabc(await readFile(GT));
function head(t){return t.split(/\.Voice/i)[0];}
console.log("===== GT 头部(.Title) =====\n"+head(gt));
console.log("===== 生成 头部 =====\n"+head(r.jpw));
const slur=t=>{const v=t.split(/\.Voice/i)[1]?.split(/\.Words/i)[0]||"";return (v.match(/\(/g)||[]).length;};
console.log("===== slur(括号组) 数: GT="+slur(gt)+" 生成="+slur(r.jpw));
console.log("===== MusicXML 含 slur/tie/work-title/creator? "+JSON.stringify({slur:/<slur/.test(r.xml),tied:/<tied/.test(r.xml),tie:/<tie[ >]/.test(r.xml),workTitle:/<work-title/.test(r.xml),creator:/<creator/.test(r.xml),movementTitle:/<movement-title/.test(r.xml)}));
await browser.close();closeServer();
