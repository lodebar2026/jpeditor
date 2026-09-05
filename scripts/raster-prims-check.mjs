// 粗加线不能冒充符杠，把骑在上面的符头抹断。
// npm run build:cli && node scripts/raster-prims-check.mjs
import assert from "node:assert/strict";
import { loadCli } from "./node-harness.mjs";

const cli = await loadCli();
const unit = { space: 18, lineThick: 4, height: 72 };
const staffYs = [0, 18, 36, 54, 72];
const onGrid = cli.ledgerGrid(staffYs, unit);
const blank = () => ({ w: 240, h: 200, data: new Uint8Array(240 * 200) });
const rect = (bin, x0, y0, x1, y1) => {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) bin.data[y * bin.w + x] = 1;
};
const ink = (bin) => bin.data.reduce((sum, v) => sum + v, 0);

// 扫描件实测：谱线中位宽 4px，局部加线 5px（已超过线距的四分之一）。
// 分别检查孤立加线与骑线符头，防止只排掉其中一种误检。
for (const withHead of [false, true]) {
  const bin = blank();
  rect(bin, 30, 106, 64, 110);
  if (withHead) {
    for (let y = 98; y <= 118; y++)
      for (let x = 30; x <= 64; x++)
        if (((x - 47) / 12) ** 2 + ((y - 108) / 7) ** 2 <= 1) bin.data[y * bin.w + x] = 1;
  }
  const before = new Uint8Array(bin.data);
  const prims = cli.findPrimitives(bin, unit, staffYs);
  assert.equal(prims.beams.length, 0, `粗加线${withHead ? "连着符头" : ""}不能被认作符杠`);
  assert.ok(prims.hSegs.length > 0, "加线仍应作为横段交给音高归属流程");
  const rest = cli.blobImage(bin, prims, unit, onGrid);
  if (withHead) assert.equal(ink(rest), ink(bin), "保符头的加线分支应留下完整墨迹");
  assert.deepEqual(bin.data, before, "抽取与擦除不能修改原图");
}

// 干净页的细符杠、扫描页的粗符杠，以及斜符杠都应照常抽出并擦除。
for (const [lineThick, beamThick, slope] of [[2, 5, 0], [4, 9, 0], [4, 9, 0.08]]) {
  const bin = blank();
  for (let x = 30; x <= 110; x++) {
    const top = 40 + Math.round((x - 30) * slope);
    rect(bin, x, top, x, top + beamThick - 1);
  }
  const localUnit = { ...unit, lineThick };
  const prims = cli.findPrimitives(bin, localUnit, staffYs);
  assert.equal(prims.beams.length, 1, `正常符杠不能漏检：${lineThick}/${beamThick}/${slope}`);
  assert.equal(ink(cli.blobImage(bin, prims, localUnit, onGrid)), 0, "正常符杠应从符号图擦除");
}
console.log("✓ 粗加线、骑线符头、干净页细符杠、扫描页粗符杠与斜符杠检查通过");
