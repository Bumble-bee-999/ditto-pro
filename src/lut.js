'use strict';
/* Adobe/IRIDAS .cube 3D LUT parser (pure, shared by main and tests). */
function parseCube(text) {
  let size = 0, title = '';
  let dmin = [0, 0, 0], dmax = [1, 1, 1];
  const vals = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    const k = parts[0].toUpperCase();
    if (k === 'TITLE') { title = line.replace(/^TITLE\s*/i, '').replace(/^"|"$/g, ''); continue; }
    if (k === 'LUT_3D_SIZE') { size = parseInt(parts[1], 10); continue; }
    if (k === 'LUT_1D_SIZE') throw new Error('1D LUTs are not supported — use a 3D .cube file.');
    if (k === 'DOMAIN_MIN') { dmin = parts.slice(1, 4).map(Number); continue; }
    if (k === 'DOMAIN_MAX') { dmax = parts.slice(1, 4).map(Number); continue; }
    if (/^[A-Z_]+$/.test(k)) continue; // other keywords
    if (parts.length >= 3) vals.push(+parts[0], +parts[1], +parts[2]);
  }
  if (!(size >= 2 && size <= 256)) throw new Error('Not a valid .cube file (missing LUT_3D_SIZE).');
  const n3 = size * size * size;
  if (vals.length !== n3 * 3 || vals.some((v) => !isFinite(v))) throw new Error('The .cube file has ' + vals.length / 3 + ' entries but ' + n3 + ' were expected.');
  return { size, title, dmin, dmax, data: Float32Array.from(vals) };
}
module.exports = { parseCube };
