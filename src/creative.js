/*
 * Ditto Pro — creative effects, as plain pixel code (invert, posterize, threshold, mosaic, emboss, find edges, film grain, glow).
 *
 * This is the reference: the export runs the same effects as FFmpeg filters, the GPU preview runs a GLSL copy, and this file is
 * the version the 2D-canvas fallback uses and the tests compare both against. Everything works in place on RGBA bytes
 * (straight alpha), the order is the export's: invert, posterize, threshold, mosaic, emboss / edges, grain, then glow.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Creative = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const LW = [0.2126, 0.7152, 0.0722];
  /** FFmpeg's noise strength per unit of the 0..100 grain slider, and the resulting std-dev per RGB channel (measured, per unit of strength) */
  const GRAIN_K = 0.6;
  const GRAIN_STD = [0.52, 0.39, 0.63];
  /** half-width of the uniform noise added to one channel, in 0..1 units */
  const grainAmp = (grain, ch) => Math.sqrt(3) * GRAIN_STD[ch] * grain * GRAIN_K / 255;

  function invert(d) { for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } }
  function posterize(d, n) {
    const L = n - 1;
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = Math.round(d[i + k] / 255 * L) / L * 255;
  }
  function threshold(d, t) {
    t = t / 100;
    for (let i = 0; i < d.length; i += 4) {
      const y = (LW[0] * d[i] + LW[1] * d[i + 1] + LW[2] * d[i + 2]) / 255;
      const v = clamp((y - t) / 0.002, 0, 1) * 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  /** red moves left and blue right by n pixels (FFmpeg rgbashift rh=-n:bh=n), edges repeat */
  function rgbsplit(d, w, h, n) {
    n = Math.round(n); if (!n) return;
    const src = Uint8ClampedArray.from(d);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = src[(y * w + clamp(x + n, 0, w - 1)) * 4];
      d[i + 2] = src[(y * w + clamp(x - n, 0, w - 1)) * 4 + 2];
    }
  }
  /** luma key: alpha = clamp((|Y - threshold| - tolerance) / softness), Y = limited-range luma 0..1 with the BT.601 weights FFmpeg's converter uses */
  function lumakeyAlpha(r, g, b, k) {
    const y = (16 + 219 * (0.299 * r + 0.587 * g + 0.114 * b) / 255) / 255;
    const e = Math.abs(y - k.threshold / 100) - k.tolerance / 100, s = k.softness / 100;
    return s > 0 ? clamp(e / s, 0, 1) : (e > 0 ? 1 : 0);
  }
  function lumakey(d, k) { for (let i = 0; i < d.length; i += 4) d[i + 3] *= lumakeyAlpha(d[i], d[i + 1], d[i + 2], k); }
  function mosaic(d, w, h, n) {
    n = Math.max(2, Math.round(n));
    for (let by = 0; by < h; by += n) for (let bx = 0; bx < w; bx += n) {
      const x1 = Math.min(w, bx + n), y1 = Math.min(h, by + n);
      let r = 0, g = 0, b = 0, a = 0, c = 0;
      for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) { const i = (y * w + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; c++; }
      r /= c; g /= c; b /= c; a /= c;
      for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) { const i = (y * w + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; }
    }
  }
  /** kind: 'emboss' | 'edges' — a 3x3 kernel on the brightness; the result is grey (what the export's convolution on the Y plane gives) */
  function relief(d, w, h, kind) {
    const lum = new Float32Array(w * h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) lum[j] = (LW[0] * d[i] + LW[1] * d[i + 1] + LW[2] * d[i + 2]) / 255;
    const K = kind === 'emboss' ? [-2, -1, 0, -1, 0, 1, 0, 1, 2] : [-1, -1, -1, -1, 8, -1, -1, -1, -1];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, k = 0;
      for (let j = -1; j <= 1; j++) { const yy = clamp(y + j, 0, h - 1) * w; for (let i = -1; i <= 1; i++) s += K[k++] * lum[yy + clamp(x + i, 0, w - 1)]; }
      const v = clamp(kind === 'emboss' ? 0.5114 + s : 2 * s - 0.0731, 0, 1) * 255;
      const o = (y * w + x) * 4; d[o] = d[o + 1] = d[o + 2] = v;
    }
  }
  function grain(d, amount, rnd) {
    rnd = rnd || Math.random;
    const A = [grainAmp(amount, 0) * 255, grainAmp(amount, 1) * 255, grainAmp(amount, 2) * 255];
    for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] += (rnd() * 2 - 1) * A[k];
  }
  // three box blurs approximate a Gaussian well enough for a glow
  function boxBlur(src, dst, w, h, r, ch) {
    const n = 2 * r + 1;
    for (let y = 0; y < h; y++) for (let c = 0; c < ch; c++) {
      let s = 0; const row = y * w * ch + c;
      for (let x = -r; x <= r; x++) s += src[row + clamp(x, 0, w - 1) * ch];
      for (let x = 0; x < w; x++) { dst[row + x * ch] = s / n; s += src[row + clamp(x + r + 1, 0, w - 1) * ch] - src[row + clamp(x - r, 0, w - 1) * ch]; }
    }
  }
  function boxBlurV(src, dst, w, h, r, ch) {
    const n = 2 * r + 1, stride = w * ch;
    for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) {
      let s = 0; const col = x * ch + c;
      for (let y = -r; y <= r; y++) s += src[clamp(y, 0, h - 1) * stride + col];
      for (let y = 0; y < h; y++) { dst[y * stride + col] = s / n; s += src[clamp(y + r + 1, 0, h - 1) * stride + col] - src[clamp(y - r, 0, h - 1) * stride + col]; }
    }
  }
  function gauss(buf, w, h, sigma, ch) {
    if (sigma < 0.4) return buf;
    const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));   // three boxes of width 2r+1: variance 3 * ((2r+1)^2 - 1) / 12
    let a = Float32Array.from(buf), b = new Float32Array(buf.length);
    for (let pass = 0; pass < 3; pass++) { boxBlur(a, b, w, h, r, ch); boxBlurV(b, a, w, h, r, ch); }
    return a;
  }
  /** glow: the bright parts, blurred, screened back. g = { amount, size, threshold } (percent), sigma in pixels of THIS image */
  function glow(d, w, h, g, sigma) {
    const T = g.threshold / 100, amt = g.amount / 100;
    const buf = new Float32Array(w * h * 3);
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) for (let k = 0; k < 3; k++) buf[j + k] = clamp((d[i + k] / 255 - T) / (1 - T), 0, 1);
    const b = gauss(buf, w, h, sigma, 3);
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) for (let k = 0; k < 3; k++) { const a = d[i + k] / 255, s = b[j + k] * amt; d[i + k] = (1 - (1 - a) * (1 - s)) * 255; }
  }
  const active = (fx) => !!fx && (fx.rgbsplit > 0 || (fx.lumakey && fx.lumakey.on) || fx.invert || fx.posterize >= 2 || fx.threshold > 0 || fx.mosaic >= 2 || fx.emboss || fx.edges || fx.grain > 0 || (fx.glow && fx.glow.amount > 0));
  /**
   * Runs every creative effect of fx over RGBA bytes. scale = output pixels per source pixel (mosaic blocks and the glow radius
   * are defined in source pixels); srcW = the width of the picture in source pixels (glow radius is a fraction of it).
   */
  function process(d, w, h, fx, scale, srcW, rnd, opts) {
    scale = scale || 1; opts = opts || {};
    if (fx.invert) invert(d);
    if (fx.posterize >= 2) posterize(d, fx.posterize);
    if (fx.threshold > 0) threshold(d, fx.threshold);
    if (fx.mosaic >= 2) mosaic(d, w, h, fx.mosaic * scale);
    if (fx.rgbsplit > 0) rgbsplit(d, w, h, fx.rgbsplit * scale);
    if (fx.emboss) relief(d, w, h, 'emboss');
    else if (fx.edges) relief(d, w, h, 'edges');
    if (fx.grain > 0) grain(d, fx.grain, rnd);
    if (fx.glow && fx.glow.amount > 0) glow(d, w, h, fx.glow, Math.max(0.5, fx.glow.size / 100 * (srcW || w / scale) * 0.25 * scale));
    if (fx.lumakey && fx.lumakey.on && !opts.noKey) lumakey(d, fx.lumakey);
    return d;
  }
  return { GRAIN_K, GRAIN_STD, grainAmp, rgbsplit, lumakey, lumakeyAlpha, invert, posterize, threshold, mosaic, relief, grain, glow, process, active };
});
