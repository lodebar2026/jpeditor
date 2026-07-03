// Regression for the abc2xml TS port: convert ABC fixtures in-browser (window.__abc2musicxml,
// same engine as the app) and, when python3 + the original abc2xml.py are available, assert the
// output is byte-identical (modulo whitespace / encoding-date) to the reference implementation.
// Usage: node abc-check.mjs
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

const ORIG = join(process.env.HOME, "proj/zanmeigepu/abc2xml.py");
const ZANMEI = join(process.env.HOME, "proj/zanmeigepu/zanmeigepu_score.abc");
const ZANMEI_GOLD = join(process.env.HOME, "proj/zanmeigepu/zanmeigepu_score.xml");

// fixtures: [name, abcTextOrPath]. `gold` = compare full output (with page credits) to that xml
// (the published zanmeigepu file = abc2xml + download_score.py post-processing).
const FIXTURES = [
  ["zanmeigepu (real hymn + page credits)", { path: ZANMEI, gold: ZANMEI_GOLD }],
  ["multi-voice / tuplet / repeat / volta / chord / grace / broken", { text:
`X:1
T:Feature Test
M:6/8
L:1/8
Q:3/8=60
K:D
|: A>Bc (3def g2a | "G"B3 [CEG]2 z2 :|1 {/g}f2e d3 |2 f2e d6 |]
w: la la la la~la mid-dle-word end
V:2
K:D bass
|: D,2E, F,3 | G,3 A,3 :|1 B,3 C3 |2 D,6 |]
` }],
  ["decorations / chord symbols / key change / accidentals", { text:
`X:1
T:Decorations & Chords
M:4/4
L:1/4
Q:"Allegro"
K:Eb
"C7b9" !trill!C !fermata!E "Gm7b5" G2 |[K:F] .A !>!B "F#dim7" c/d/ | !p!E>F G2- G4 |]
` }],
];

const MIME = { ".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".woff2":"font/woff2",".svg":"image/svg+xml",".wasm":"application/wasm",".mjs":"text/javascript" };
const ROOT = join(process.cwd(), "dist");
const server = createServer(async (req, res) => {
  try { let p = decodeURIComponent((req.url ?? "/").split("?")[0]); if (p === "/") p = "/index.html";
    const data = await readFile(join(ROOT, normalize(p)));
    res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" }); res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

function canon(s){ return s.replace(/<\?xml[^>]*\?>/g,"").replace(/<!DOCTYPE[^>]*>/g,"")
  .replace(/<encoding-date>[^<]*<\/encoding-date>/g,"<encoding-date/>")
  .replace(/<([a-zA-Z-]+)([^>]*)\/>/g,"<$1$2></$1>").replace(/>\s+</g,"><").trim(); }
function toks(s){ return canon(s).match(/<[^>]+>|[^<]+/g) || []; }
function diffClusters(a0, b0){
  const a = toks(a0), b = toks(b0); let i=0,j=0,clusters=0; const samples=[];
  while(i<a.length&&j<b.length){ if(a[i]===b[j]){i++;j++;continue;} clusters++; let f=false;
    for(let w=1;w<60&&!f;w++){ if(a[i+w]===b[j]){if(samples.length<8)samples.push(`MINE+${w} ${JSON.stringify(a.slice(i,i+w))}`);i+=w;f=true;}
      else if(a[i]===b[j+w]){if(samples.length<8)samples.push(`REF+${w} ${JSON.stringify(b.slice(j,j+w))}`);j+=w;f=true;}
      else if(a[i+w]===b[j+w]){if(samples.length<8)samples.push(`SUBST ${JSON.stringify(a.slice(i,i+w))} vs ${JSON.stringify(b.slice(j,j+w))}`);i+=w;j+=w;f=true;} }
    if(!f){if(samples.length<8)samples.push(`DESYNC ${JSON.stringify(a[i])} ${JSON.stringify(b[j])}`);i++;j++;} }
  return { clusters, tail: (a.length-i)+(b.length-j), samples, na:a.length, nb:b.length };
}

const havePy = spawnSync("python3", ["-c", "import pyparsing"], { stdio: "ignore" }).status === 0
  && (await readFile(ORIG).then(() => true).catch(() => false));

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);

let fail = 0;
const tmp = await mkdtemp(join(tmpdir(), "abc-check-"));
for (const [name, src] of FIXTURES) {
  const abc = src.path ? await readFile(src.path, "utf-8") : src.text;
  const mine = await page.evaluate(async (a) => (await window.__abc2musicxml).abcToMusicXml(a), abc);
  if (!mine || !mine.includes("<score-partwise>")) { console.log(`FAIL  ${name}: no score-partwise output`); fail++; continue; }
  const nMeasure = (mine.match(/<measure /g) || []).length;
  // ref = the published golden xml (abc2xml + post-process) when given, else raw python abc2xml.py
  let ref, refWhat;
  if (src.gold) { ref = await readFile(src.gold, "utf-8"); refWhat = "golden xml (abc2xml + credits)"; }
  else if (havePy) {
    const abcFile = join(tmp, "in.abc"); await writeFile(abcFile, abc);
    ref = spawnSync("python3", [ORIG, abcFile], { encoding: "utf-8" }).stdout; refWhat = "abc2xml.py";
  } else { console.log(`ok?   ${name}: ${nMeasure} measures (no ref to diff)`); continue; }
  const d = diffClusters(mine, ref);
  if (d.clusters === 0 && d.tail === 0) console.log(`PASS  ${name}: byte-identical to ${refWhat} (${d.na} tokens, ${nMeasure} measures)`);
  else { console.log(`FAIL  ${name}: ${d.clusters} diff clusters, tail ${d.tail} (mine ${d.na} / ref ${d.nb})`); d.samples.forEach((s) => console.log("      " + s)); fail++; }
}
if (errors.length) { console.log("PAGE ERRORS:\n" + errors.join("\n")); fail++; }
await browser.close(); server.close();
console.log(fail ? `\n${fail} failure(s)` : "\nall passed");
process.exit(fail ? 1 : 0);
