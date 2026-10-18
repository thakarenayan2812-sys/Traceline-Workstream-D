// Image pixels (top-left origin, y down) <-> screen pixels. Display only: nothing here is saved.
/** @typedef {{scale:number, tx:number, ty:number}} Viewport */

export function fitViewport(imgW, imgH, canvasW, canvasH, margin = 8) {
  const scale = Math.min((canvasW - 2 * margin) / imgW, (canvasH - 2 * margin) / imgH);
  return { scale, tx: (canvasW - imgW * scale) / 2, ty: (canvasH - imgH * scale) / 2 };
}
export const imageToScreen = (p, vp) => ({ x: p.x * vp.scale + vp.tx, y: p.y * vp.scale + vp.ty });
export const screenToImage = (p, vp) => ({ x: (p.x - vp.tx) / vp.scale, y: (p.y - vp.ty) / vp.scale });

/** Zoom by `factor` keeping the image point under `screenPt` fixed. */
export function zoomAt(vp, screenPt, factor, { min = 0.02, max = 40 } = {}) {
  const scale = Math.min(max, Math.max(min, vp.scale * factor));
  const k = scale / vp.scale;
  return { scale, tx: screenPt.x - (screenPt.x - vp.tx) * k, ty: screenPt.y - (screenPt.y - vp.ty) * k };
}
export const panBy = (vp, dx, dy) => ({ ...vp, tx: vp.tx + dx, ty: vp.ty + dy });
