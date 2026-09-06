// 评测歌词不能漏掉 Sibelius 段号，也不能把 lyric-font 或第二段吞进第一段。
import assert from "node:assert/strict";
import { xmlLyricVerses } from "./node-harness.mjs";

const xml = `<score-partwise><lyric-font font-family="serif"/>
  <note><lyric-font/><lyric number="part2verse1"><text>望</text></lyric>
    <lyric number="part2verse2"><text>Face</text></lyric></note>
  <note><lyric number='1'><text font-style="italic">十</text><elision> </elision><text>架</text></lyric></note>
  <note><lyric><text>&amp;光</text></lyric></note>
  <note><lyric number="part2verse6"><text>另段</text></lyric></note>
  <note><lyric number="chorus"><text>副歌</text></lyric></note>
</score-partwise>`;
assert.deepEqual(xmlLyricVerses(xml), [
  { verse: 1, chars: "望十架&光" },
  { verse: 2, chars: "Face" },
  { verse: 6, chars: "另段" },
  { verse: "chorus", chars: "副歌" },
]);
assert.deepEqual(xmlLyricVerses('<note><lyric-language/><lyric-font/></note>'), []);
console.log("✓ 歌词数字段号、Sibelius 段号、缺省段号、文本属性及非歌词标签检查通过");
