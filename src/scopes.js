/*
 * Ditto Pro — video scopes (pure analysis; drawing is in renderer/color.js).
 *
 *  hist   : 256-bin histograms of red, green, blue and luma
 *  wave   : waveform — for each screen column, how many pixels sit at each level (luma and R, G, B for the RGB parade)
 *  vec    : vectorscope — pixel density on a Cb / Cr plane (Rec. 709), Cb to the right, Cr up
 *
 * Input is RGBA bytes as returned by canvas getImageData. Large frames are sampled on a grid so a scope costs the same
 * at 4K as at 720p.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DSC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KR = 0.2126, KG = 0.7152, KB = 0.0722;
  const VEC = 256;

  function analyze(rgba, w, h, o) {
    o = o || {};
    const cols = Math.max(8, Math.min(1024, o.cols || 256));
    const hist = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256) };
    const wave = { cols, l: new Uint32Array(cols * 256), r: new Uint32Array(cols * 256), g: new Uint32Array(cols * 256), b: new Uint32Array(cols * 256), rows: 0 };
    const vec = { size: VEC, d: new Uint32Array(VEC * VEC) };
    // sample at most ~120k pixels, but always visit every column slot so the waveform has no gaps
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 120000)));
    let n = 0, rowsSeen = 0;
    for (let y = 0; y < h; y += step) {
      rowsSeen++;
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        const l = Math.round(KR * r + KG * g + KB * b);
        hist.r[r]++; hist.g[g]++; hist.b[b]++; hist.l[l]++;
        const c = Math.min(cols - 1, Math.floor(x * cols / w)) * 256;
        wave.l[c + l]++; wave.r[c + r]++; wave.g[c + g]++; wave.b[c + b]++;
        const Y = KR * r + KG * g + KB * b;
        const cb = (b - Y) / 1.8556 / 255, cr = (r - Y) / 1.5748 / 255;       // -0.5 .. 0.5
        const vx = Math.max(0, Math.min(VEC - 1, Math.round((cb + 0.5) * (VEC - 1))));
        const vy = Math.max(0, Math.min(VEC - 1, Math.round((0.5 - cr) * (VEC - 1))));
        vec.d[vy * VEC + vx]++;
        n++;
      }
    }
    wave.rows = rowsSeen;
    return { hist, wave, vec, count: n, step };
  }

  /** where a colour lands on the vectorscope (pixels, origin top-left) */
  function vecPoint(r, g, b, size) {
    size = size || VEC;
    const Y = KR * r + KG * g + KB * b, cb = (b - Y) / 1.8556 / 255, cr = (r - Y) / 1.5748 / 255;
    return { x: (cb + 0.5) * (size - 1), y: (0.5 - cr) * (size - 1) };
  }
  /** luma percentile (0..255) from a histogram: 0.01 -> the level 1 % of pixels are below */
  function percentile(h, p) {
    let total = 0; for (let i = 0; i < 256; i++) total += h[i];
    if (!total) return 0;
    let acc = 0; const t = total * p;
    for (let i = 0; i < 256; i++) { acc += h[i]; if (acc >= t) return i; }
    return 255;
  }
  /** a gentle "auto tone" suggestion from the luma histogram: how far to lift the blacks / pull the whites / move exposure */
  function autoTone(lumaHist) {
    const lo = percentile(lumaHist, 0.01) / 255, hi = percentile(lumaHist, 0.99) / 255, mid = percentile(lumaHist, 0.5) / 255;
    // blacks: move the 1 % point to 0.02 (− crushes); whites: move the 99 % point up to 0.98 (+ brightens); then nudge the middle toward 0.45
    const blacks = Math.max(-100, Math.min(100, Math.round((0.02 - lo) / 0.12 * 100)));
    const whites = Math.max(-100, Math.min(100, Math.round((1 - hi / 0.98) / 0.25 * 100)));
    const span = Math.max(0.05, hi - lo);
    const midN = (mid - lo) / span;
    const exposure = Math.max(-60, Math.min(60, Math.round((0.45 - midN) * 80)));
    return { blacks, whites, exposure, lo, hi, mid };
  }
  return { analyze, vecPoint, percentile, autoTone, VEC };
});
