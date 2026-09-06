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

// 剩余弯曲不能把谱线当成符号留下；跨线符干仍须完整。
for (const curved of [false, true]) {
  const bin = { w: 320, h: 120, data: new Uint8Array(320 * 120) };
  for (let x = 10; x < 310; x++) {
    const y = 50 + (curved ? Math.round(4 * Math.sin(x / 320 * 2 * Math.PI)) : 0);
    rect(bin, x, y, x, y + 1);
  }
  rect(bin, 60, 20, 62, 89);
  const before = new Uint8Array(bin.data);
  const rest = cli.removeStaffLines(bin, [50.5], { space: 18, lineThick: 2, height: 72 });
  assert.equal(ink(rest), 210, "平直或弯曲谱线应擦净，只留下三像素宽的 70px 符干");
  for (let y = 20; y < 90; y++)
    for (let x = 60; x < 63; x++) assert.equal(rest.data[y * rest.w + x], 1, "跨线符干不能断");
  assert.deepEqual(bin.data, before);
}

// 每隔一段被 40px 宽的符号遮挡，仍应跟踪到两行弯谱，且不能把上下行并在一起。
const curvedStaves = (period) => {
  const bin = { w: 900, h: 500, data: new Uint8Array(900 * 500) };
  for (const top of [100, 300]) {
    for (let x = 40; x < 860; x++) {
      const dy = Math.round(7 * Math.sin(x / 900 * Math.PI * 2));
      for (let k = 0; k < 5; k++) rect(bin, x, top + k * 18 + dy, x, top + k * 18 + dy + 1);
      if (x % period >= period - 40) rect(bin, x, top + dy, x, top + 72 + dy);
    }
  }
  return bin;
};
const curved = curvedStaves(160);
assert.equal(cli.trackCurves(curved)?.length, 2);
assert.equal(cli.groupStaves(cli.findStaffLines(curved)).length, 0);
assert.equal(cli.dewarpPage(curved), true);
assert.equal(cli.groupStaves(cli.findStaffLines(curved)).length, 2, "推平后两行谱都应恢复");

// 遮挡密到行投影始终不可用时，0 → 0 不算增益，必须原样还原。
const obscured = curvedStaves(100);
const original = new Uint8Array(obscured.data);
assert.equal(cli.dewarpPage(obscured), false);
assert.deepEqual(obscured.data, original);
console.log("✓ 弯曲谱线擦除、交叉符干保护、遮挡后轨迹续接与无增益还原检查通过");
