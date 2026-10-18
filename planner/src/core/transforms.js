// Coordinate conventions (guide section 7):
//   metres, origin bottom-left of venue bounding box, x right, y up.
//   pixel_y = (height_m - y) * px_per_m. Pixels exist only in drawing code.
// Every function is pure. No hidden state.

/**
 * @typedef {{height_m:number, px_per_m:number, offset_px?:{x:number,y:number}}} View
 */

/** Convert a metric point to canvas pixels. */
export function metresToPixels(pt, view) {
  const ox = view.offset_px?.x ?? 0;
  const oy = view.offset_px?.y ?? 0;
  return {
    x: pt.x * view.px_per_m + ox,
    y: (view.height_m - pt.y) * view.px_per_m + oy,
  };
}

/** Convert canvas pixels back to metres. Always do this before saving anything. */
export function pixelsToMetres(px, view) {
  const ox = view.offset_px?.x ?? 0;
  const oy = view.offset_px?.y ?? 0;
  return {
    x: (px.x - ox) / view.px_per_m,
    y: view.height_m - (px.y - oy) / view.px_per_m,
  };
}

/** Pixels-per-metre that fits a venue into a canvas, with a margin in pixels. */
export function fitScale(venue, canvasW, canvasH, margin_px = 16) {
  const sx = (canvasW - 2 * margin_px) / venue.width_m;
  const sy = (canvasH - 2 * margin_px) / venue.height_m;
  return Math.min(sx, sy);
}

/**
 * Build a View that fits and centres a venue in a canvas.
 * @returns {View}
 */
export function fitView(venue, canvasW, canvasH, margin_px = 16) {
  const px_per_m = fitScale(venue, canvasW, canvasH, margin_px);
  return {
    height_m: venue.height_m,
    px_per_m,
    offset_px: {
      x: (canvasW - venue.width_m * px_per_m) / 2,
      y: (canvasH - venue.height_m * px_per_m) / 2,
    },
  };
}

/**
 * Blueprint-image scale (guide 9.4): the user marks two image pixels that are a
 * known distance apart. Returns metres per image pixel, or throws.
 * Never invents a scale: bad input is an error the UI must show.
 */
export function scaleFromKnownDistance(pxA, pxB, known_m) {
  if (!Number.isFinite(known_m) || known_m <= 0) {
    throw new RangeError("Known distance must be a positive number of metres.");
  }
  const d = Math.hypot(pxB.x - pxA.x, pxB.y - pxA.y);
  if (!(d > 0)) {
    throw new RangeError("The two calibration points are identical. Mark two different points.");
  }
  return known_m / d;
}

/**
 * Image pixel (top-left origin, y down) to metres (bottom-left origin, y up).
 * origin_px is the image pixel chosen as the metric origin (bottom-left of the
 * marked floor boundary).
 */
export function imagePxToMetres(px, origin_px, metres_per_px) {
  return {
    x: (px.x - origin_px.x) * metres_per_px,
    y: (origin_px.y - px.y) * metres_per_px,
  };
}

/** Inverse of imagePxToMetres. */
export function metresToImagePx(pt, origin_px, metres_per_px) {
  return {
    x: origin_px.x + pt.x / metres_per_px,
    y: origin_px.y - pt.y / metres_per_px,
  };
}

/** True when a point lies inside the venue bounding box (inclusive). */
export function inBounds(pt, venue) {
  return pt.x >= 0 && pt.y >= 0 && pt.x <= venue.width_m && pt.y <= venue.height_m;
}
