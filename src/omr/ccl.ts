// 连通域标注（8-邻接，迭代式 flood fill，避免递归爆栈）。
// 对应 musicpp 用 cv::findContours 得到的 contour 包围盒；这里直接给连通块包围盒。
import type { Binary, Component, Rect } from "./types";

export function connectedComponents(bin: Binary, minArea = 4): Component[] {
  const { w, h, data } = bin;
  const labels = new Int32Array(w * h).fill(0);
  const comps: Component[] = [];
  let next = 1;
  const stack: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (data[idx] !== 1 || labels[idx] !== 0) continue;
      // 新连通块
      const id = next++;
      let minX = x, maxX = x, minY = y, maxY = y, area = 0, sx = 0, sy = 0;
      stack.length = 0;
      stack.push(idx);
      labels[idx] = id;
      while (stack.length) {
        const cur = stack.pop()!;
        const cy = (cur / w) | 0;
        const cx = cur - cy * w;
        area++; sx += cx; sy += cy;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            if (nx < 0 || nx >= w) continue;
            const nIdx = ny * w + nx;
            if (data[nIdx] === 1 && labels[nIdx] === 0) {
              labels[nIdx] = id;
              stack.push(nIdx);
            }
          }
        }
      }
      if (area < minArea) continue;
      const bbox: Rect = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
      comps.push({ id, bbox, area, cx: sx / area, cy: sy / area });
    }
  }
  return comps;
}
