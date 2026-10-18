// Upload validation (guide 9.4: PNG or JPEG). Checks the file's own bytes, not just its name or MIME type.
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MIN_SIDE_PX = 200;
export const MAX_SIDE_PX = 12000;

/** @param {Uint8Array} bytes @returns {"png"|"jpeg"|null} */
export function sniffImageType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

/** @returns {string[]} problems; empty means the file can be used. */
export function validateImageFile({ size_bytes, bytes }) {
  const errs = [];
  if (!size_bytes) errs.push("The file is empty.");
  if (size_bytes > MAX_IMAGE_BYTES) errs.push(`The file is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB. Export a smaller PNG or JPEG.`);
  if (bytes && !sniffImageType(bytes)) errs.push("This is not a PNG or JPEG image. Export the floor plan as PNG or JPEG and try again.");
  return errs;
}

/** Checks decoded dimensions. @returns {string[]} */
export function validateImageSize(width_px, height_px) {
  const errs = [];
  if (!(width_px >= MIN_SIDE_PX && height_px >= MIN_SIDE_PX))
    errs.push(`The image is too small (${width_px} x ${height_px} px). Use at least ${MIN_SIDE_PX} px on each side.`);
  if (width_px > MAX_SIDE_PX || height_px > MAX_SIDE_PX)
    errs.push(`The image is too large (${width_px} x ${height_px} px). Keep each side under ${MAX_SIDE_PX} px.`);
  return errs;
}
