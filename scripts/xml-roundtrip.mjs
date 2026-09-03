// MusicXML 导出回归：在浏览器里（window.__xmlout，与 app 同一份代码）跑三组断言。
//   P 组 — 增量 patch：底本 XML + 模拟编辑，验「改动进去了」且「底本其余节点一个没动」。
//   R 组 — 全量序列化往返：.jpwabc → MusicXML → Score → MusicXML 的定点性与逐字段一致。
//   L 组 — 版面注入：分行严格沿用底本 <print>，宽度/坐标合法，且不改动任何音乐内容。
// 用法：npm run build && node xml-roundtrip.mjs [曲名子串]
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { serveDist, launchPage, loadApp, readJpwabc } from "./harness.mjs";

const { port, close: closeServer } = await serveDist();

// 夹具：testdata/<曲名>/<曲名>.jpwabc
const filter = process.argv[2];
const dirs = (await readdir("testdata", { withFileTypes: true })).filter((d) => d.isDirectory());
const fixtures = [];
for (const d of dirs) {
  if (filter && !d.name.includes(filter)) continue;
  const files = await readdir(join("testdata", d.name));
  const jp = files.find((f) => f.endsWith(".jpwabc"));
  if (!jp) continue;
  fixtures.push([d.name, await readJpwabc(join("testdata", d.name, jp))]);
}
if (!fixtures.length) { console.log("没有夹具"); process.exit(1); }

const { browser, page, pageErrors: errors } = await launchPage({ quiet: true });
await loadApp(page, port);

// ABC 底本：abc2xml 转出的 MusicXML 也是「比 .jpwabc 信息多」的底本，patch 同样要保全它。
const ABC_FIXTURE = `X:1
T:Roundtrip Test
M:4/4
L:1/4
K:G
|: G A B c | d2 c2 | B A G2 :| e f g2 | d4 |]
w: one two three four five six sev-en eight nine
`;

const results = await page.evaluate(async ({ fixtures, abc }) => {
  const X = await window.__xmlout;
  const out = [];

  const scoreOf = (text) => {
    const f = X.JpwFile.fromString(text);
    const s = X.fromJpw(f);
    if (!s) throw new Error("fromJpw 返回 null");
    return s;
  };
  // 谱面的可比对快照：音符流 + 小节结构 + 元数据。
  // withLayout=false 时排除 newSystem/newPage（那是版面不是音乐内容，annotateLayout 会动它）。
  const snap = (score, withLayout = true) => {
    const notes = [];
    const measures = [];
    for (const m of score.parts[0].measures) {
      measures.push([m.time.beats, m.time.beatType,
        withLayout ? `${m.newSystem}/${m.newPage}` : "",
        m.leftBarline, m.barline, m.repeatForward, m.repeatBackward, m.endingLeft,
        m.endingNum ? [...m.endingNum].sort().join(",") : null, m.endingRight, m.sectionMark].join("|"));
      for (const e of m.entries) {
        if (!e.notes) continue;
        for (const nt of e.notes) {
          notes.push([m.index, e.position?.toString(), nt.number, nt.jpOctave, nt.jpAlter,
            e.duration?.toString(), e.beats, e.beams, e.dot, !!e.rest, !!nt.tieStart, !!nt.tieEnd,
            !!nt.tupletBegin, !!nt.tupletEnd, !!e.slurStart, !!e.slurEnd, !!e.fermata,
            nt.lyrics.map((l) => `${l.refrain ? "R" : l.number}:${l.text}`).join(",")].join("|"));
        }
      }
    }
    // 标题类 credit 不参与比较：annotateLayout 会在缺失时补一条（MuseScore 没有 title credit
    // 就不显示标题），那是版面补充而非音乐内容，标题本身仍由 score.title 比。
    const meta = [score.title, [...score.creator].map((x) => x.join("=")).join(";"),
      score.credit.filter((c) => c.type !== "title" && c.text !== score.title)
        .map((c) => `${c.type}/${c.page}/${c.text}`).join(";"),
      score.playData.tempo].join("|");
    return { notes, measures, meta };
  };
  const cmp = (a, b, label) => {

    if (a.meta !== b.meta) return `${label} 元数据不同:\n  A ${a.meta}\n  B ${b.meta}`;
    for (let i = 0; i < Math.max(a.measures.length, b.measures.length); i++) {
      if (a.measures[i] !== b.measures[i]) return `${label} 第 ${i + 1} 小节结构不同:\n  A ${a.measures[i]}\n  B ${b.measures[i]}`;
    }
    for (let i = 0; i < Math.max(a.notes.length, b.notes.length); i++) {
      if (a.notes[i] !== b.notes[i]) return `${label} 第 ${i + 1} 个音符不同:\n  A ${a.notes[i]}\n  B ${b.notes[i]}`;
    }
    return null;
  };
  const countTags = (xml, tag) => (xml.match(new RegExp(`<${tag}[ />]`, "g")) || []).length;

  for (const [name, text] of fixtures) {
    const r = { name, checks: [] };
    const add = (id, err) => r.checks.push({ id, ok: !err, err });
    try {
      // ---- R 组：全量序列化往返 ----
      // 基准取「导入过一次的 Score」：导入端会做几处幂等归一（首小节 <attributes> 让
      // keyChange 变 true、dot+beats>1 折算、findRefrain 重新推断副歌），第二轮起才稳定。
      const S0 = scoreOf(text);
      // 第一轮（jpw → XML）会被导入端归一（findRefrain 把尾段歌词折成 chorus 等），
      // 故定点性从第二轮起算：X0(jpw) → S1 → X1 → S1b → X2，断言 X2 === X1。
      const X0 = X.scoreToMusicXml(S0);
      const S1 = X.loadMusicXml(X0);
      const X1 = X.scoreToMusicXml(S1);
      const S1b = X.loadMusicXml(X1);
      const X2 = X.scoreToMusicXml(S1b);
      add("R-A 定点", X2 === X1 ? null : `第三轮与第二轮序列化不同（长度 ${X1.length} vs ${X2.length}）`);
      add("R-BCD 往返", cmp(snap(S1), snap(S1b), "往返"));

      // ---- P 组：以 X0 为底本做增量 patch ----
      const p0 = X.patchMusicXml(X0, S1);
      add("P1 空改动", p0.fallback ? "fallback" : p0.changed === 0 ? null : `changed=${p0.changed}（应为 0）`);
      if (!p0.fallback) {
        add("P1 语义不变", cmp(snap(X.loadMusicXml(p0.xml)), snap(S1), "空 patch"));
      }

      // 模拟编辑：改第一个音符的数字并加一个高八度点、改第一个歌词字、改标题
      let edited = text;
      const voiceMatch = edited.match(/\n\.Voice\n/);
      if (voiceMatch) {
        const at = voiceMatch.index + voiceMatch[0].length;
        const rest = edited.slice(at);
        const m = rest.match(/[1-7]/);
        if (m) {
          const d = m[0] === "5" ? "6" : "5";
          edited = edited.slice(0, at) + rest.slice(0, m.index) + d + "'" + rest.slice(m.index + 1);
        }
      }
      // 第一段歌词的首个汉字 → 「测」
      edited = edited.replace(/(\nW1@[^\n]*\n)([^\n]*)/, (s, head, line) => {
        const i = [...line].findIndex((c) => /[一-龥]/.test(c));
        return i < 0 ? s : head + line.slice(0, i) + "测" + line.slice(i + 1);
      });
      edited = edited.replace(/Title = \{([^}]*)\}/, (s, t) => `Title = {${t}测}`);
      const S2 = X.loadMusicXml(X.scoreToMusicXml(scoreOf(edited)));
      const p1 = X.patchMusicXml(X0, S2);
      // 先确认模拟编辑真的改到了谱面，否则下面的断言等于没测
      add("P2 编辑有效", cmp(snap(S1), snap(S2), "编辑前后") ? null : "模拟编辑没有改变谱面");
      if (p1.fallback) add("P2 patch", "fallback（对齐失败）");
      else {
        add("P2 有改动", p1.changed > 0 ? null : "changed=0（patch 什么都没改）");
        add("P2 改动生效", cmp(snap(X.loadMusicXml(p1.xml)), snap(S2), "patch 后"));
        // 精确性：底本里 patch 不该碰的节点，数量必须一个不少
        const keep = ["print", "credit", "direction", "time-modification", "attributes", "barline"];
        const lost = keep.filter((t) => countTags(p1.xml, t) !== countTags(X0, t));
        add("P2 底本节点保全", lost.length ? `这些节点数量变了: ${lost.join(", ")}` : null);
      }

      // ---- 反复记号：.jpwabc 的 |: / :| 必须以 <repeat> 出现，不能展开成重复小节 ----
      const nFwd = (X0.match(/<repeat direction="forward"\/>/g) || []).length;
      const nBwd = (X0.match(/<repeat direction="backward"\/>/g) || []).length;
      const src = { fwd: 0, bwd: 0 };
      for (const m of S0.parts[0].measures) {
        for (const e of m.entries) {
          if (e.repeat === "forward") src.fwd++;
          else if (e.repeat === "backward") src.bwd++;
        }
      }
      // 房末（最后一房除外）会补一个回头记号，源里没有 `:|` 的那些要算进期望值
      const voltas0 = X.deriveVoltas(S0);
      let extraBwd = 0;
      for (const [mid, v] of voltas0) {
        if (!v.repeatBack) continue;
        const m = S0.parts[0].measures[mid];
        if (!m.entries.some((e) => e.repeat === "backward")) extraBwd++;
      }
      add("反复记号导出", nFwd === src.fwd && nBwd === src.bwd + extraBwd
        ? null : `源 |:${src.fwd} :|${src.bwd}(+房末 ${extraBwd}) → 导出 forward ${nFwd} / backward ${nBwd}`);
      add("反复不展开", S1.parts[0].measures.length === S0.parts[0].measures.length
        ? null : `小节数 ${S0.parts[0].measures.length} → ${S1.parts[0].measures.length}（反复被展开了）`);
      // 往返后仍是记号（导入端置 Measure.repeat*，第二轮序列化必须原样吐回）
      const nBwd2 = (X1.match(/<repeat direction="backward"\/>/g) || []).length;
      add("反复往返", nBwd2 === nBwd ? null : `第一轮 ${nBwd} → 第二轮 ${nBwd2}`);

      // 房号：.Repeat 反推出的每一房都要有 start/stop 一对 <ending>，且往返后仍在
      const wantStarts = [...voltas0.entries()].filter(([, v]) => v.start)
        .map(([mid, v]) => `${mid}:${v.start}`).sort().join(" ");
      const gotStarts = S1.parts[0].measures
        .map((m, i) => m.endingLeft ? `${i}:${[...m.endingNum].sort((a, b) => a - b).join(",")}` : null)
        .filter(Boolean).sort().join(" ");
      add("房号导出", wantStarts === gotStarts ? null : `推断 [${wantStarts}] → 往返 [${gotStarts}]`);
      const nEnd1 = (X1.match(/<ending /g) || []).length;
      const nEnd0 = (X0.match(/<ending /g) || []).length;
      add("房号往返", nEnd0 === nEnd1 ? null : `第一轮 ${nEnd0} 个 <ending> → 第二轮 ${nEnd1}`);

      // ---- jpwabc 落地：作者行不能丢（jpwimport 的 credit.page 与 jpscore 的判据要对上）----
      // 字段值可带可不带花括号（JP-Word 两种写法都有）
      const authorOf = (jp) => {
        const m = jp.match(/WordsByAndMusicBy = (\{[^}]*\}|[^\n]*)/);
        return m ? m[1].replace(/^\{|\}$/g, "").trim() : "";
      };
      const srcAuthor = authorOf(text);
      if (srcAuthor) {
        const back = authorOf(X.scoreToJpwabc(S1));
        add("作者行往返", back ? null : `源有作者行「${srcAuthor}」，往返后丢了`);
      }

      // ---- 符杠：休止符不能带 <beam>（没有符干），各层必须成对 ----
      {
        const d = new DOMParser().parseFromString(X0, "application/xml");
        const ns = [...d.querySelectorAll("part > measure > note")];
        let restBeam = 0, restTie = 0, bad = 0;
        const st = {};
        for (const n of ns) {
          if (n.querySelector("rest")) {
            restBeam += n.querySelectorAll(":scope > beam").length;
            restTie += n.querySelectorAll("notations > tied").length;
          }
          for (const bm of n.querySelectorAll(":scope > beam")) {
            const lv = bm.getAttribute("number"), v = bm.textContent;
            if (v === "begin") { if (st[lv]) bad++; st[lv] = 1; }
            else if (v === "continue") { if (!st[lv]) bad++; }
            else if (v === "end") { if (!st[lv]) bad++; st[lv] = 0; }
          }
        }
        for (const k in st) if (st[k]) bad++;
        const msg = [];
        if (restBeam) msg.push(`休止符带 beam ${restBeam}`);
        if (restTie) msg.push(`休止符带 tie ${restTie}`);
        if (bad) msg.push(`beam 不成对 ${bad}`);
        add("符杠合法性", msg.length ? msg.join("、") : null);
      }

      // ---- L 组：版面注入 ----
      const doc = new DOMParser().parseFromString(X0, "application/xml");
      const printsBefore = [...doc.querySelectorAll("measure > print")]
        .map((p) => p.parentElement.getAttribute("number")).join(",");
      X.annotateLayout(doc);
      const printsAfter = [...doc.querySelectorAll("measure > print")]
        .filter((p) => p.getAttribute("new-system") === "yes" || p.getAttribute("new-page") === "yes")
        .map((p) => p.parentElement.getAttribute("number")).join(",");
      add("L 分行保持", printsBefore === "" || printsBefore === printsAfter
        ? null : `注入前 [${printsBefore}] → 注入后 [${printsAfter}]`);
      add("L defaults", doc.querySelector("defaults > scaling") ? null : "缺 <defaults><scaling>");
      let badX = null;
      for (const mel of doc.querySelectorAll("part > measure")) {
        const w = parseFloat(mel.getAttribute("width") ?? "0");
        let prev = -1;
        for (const n of mel.querySelectorAll(":scope > note")) {
          const dx = n.getAttribute("default-x");
          if (dx === null) continue;
          const v = parseFloat(dx);
          if (v < 0 || v > w) { badX = `第 ${mel.getAttribute("number")} 小节 default-x=${v} 超出 width=${w}`; break; }
          if (v < prev) { badX = `第 ${mel.getAttribute("number")} 小节 default-x 非单调`; break; }
          prev = v;
        }
        if (badX) break;
      }
      add("L default-x", badX);
      const after = new XMLSerializer().serializeToString(doc);
      add("L 不改音乐内容", cmp(snap(X.loadMusicXml(after), false), snap(S1, false), "注入后"));
    } catch (e) {
      r.checks.push({ id: "异常", ok: false, err: String(e && e.stack || e) });
    }
    out.push(r);
  }

  // ---- ABC 底本组：abc2xml 的产物同样是「信息比 .jpwabc 多」的底本 ----
  {
    const r = { name: "[ABC 底本] abc2xml → patch", checks: [] };
    const add = (id, err) => r.checks.push({ id, ok: !err, err });
    try {
      const XB = (await window.__abc2musicxml).abcToMusicXml(abc);
      const SB = X.loadMusicXml(XB);
      const p0 = X.patchMusicXml(XB, SB);
      add("空改动", p0.fallback ? "fallback" : p0.changed === 0 ? null : `changed=${p0.changed}`);
      add("空 patch 语义不变", p0.fallback ? null : cmp(snap(X.loadMusicXml(p0.xml)), snap(SB), "空 patch"));
      // 模拟用户改过：动标题与第一个音符的歌词，再 patch 回底本
      const S2 = X.loadMusicXml(XB);
      S2.title += " 改";
      for (const m of S2.parts[0].measures) {
        const ch = m.entries.find((e) => e.notes && e.notes.length);
        if (!ch) continue;
        const lrc = ch.notes[0].lyrics[0];
        if (!lrc) continue;
        lrc.text = "改";
        break;
      }
      const p1 = X.patchMusicXml(XB, S2);
      add("改动后 patch", p1.fallback ? "fallback" : null);
      if (!p1.fallback) {
        const doc2 = new DOMParser().parseFromString(XB, "application/xml");
        const before = doc2.querySelectorAll("defaults, credit, print").length;
        const docAfter = new DOMParser().parseFromString(p1.xml, "application/xml");
        const after2 = docAfter.querySelectorAll("defaults, credit, print").length;
        add("底本版面节点保全", before === after2 ? null : `${before} → ${after2}`);
      }
      // ABC 底本自带 <defaults>：annotateLayout 必须原样不动
      const doc3 = new DOMParser().parseFromString(XB, "application/xml");
      const hadDefaults = !!doc3.querySelector("defaults");
      const beforeStr = new XMLSerializer().serializeToString(doc3);
      X.annotateLayout(doc3);
      const afterStr = new XMLSerializer().serializeToString(doc3);
      add("自带 defaults 时不覆盖", !hadDefaults || beforeStr === afterStr
        ? null : "底本已有 <defaults>，注入却改动了文档");
    } catch (e) {
      r.checks.push({ id: "异常", ok: false, err: String(e && e.stack || e) });
    }
    out.push(r);
  }
  return out;
}, { fixtures, abc: ABC_FIXTURE });

let fail = 0;
for (const r of results) {
  const bad = r.checks.filter((c) => !c.ok);
  if (!bad.length) { console.log(`PASS  ${r.name}  (${r.checks.length} 项)`); continue; }
  fail++;
  console.log(`FAIL  ${r.name}`);
  for (const c of bad) console.log(`      ${c.id}: ${c.err}`);
}
if (errors.length) { console.log("PAGE ERRORS:\n" + errors.join("\n")); fail++; }
await browser.close();
closeServer();
console.log(fail ? `\n${fail} 首失败 / 共 ${results.length}` : `\n全部通过（${results.length} 首）`);
process.exit(fail ? 1 : 0);
