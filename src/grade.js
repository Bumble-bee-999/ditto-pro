/*
 * Ditto Pro — colour grade (a Lumetri-style "basic correction + curves + colour wheels").
 *
 * The whole grade is a pure function  rgb(0..1) -> rgb(0..1).  It is baked into a 3D LUT (33 points per axis), and
 * THAT LUT is what both the GPU preview (a second LUT sampler in the compositor) and the FFmpeg export (lut3d) apply,
 * so the preview and the export run the very same numbers instead of two separate implementations of "highlights".
 *
 * Pure: no DOM, no Node APIs. Loaded by the renderer (window.DG) and required by the main process and tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DG = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT = {
    exposure: 0, temp: 0, tint: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, vibrance: 0,
    // curves: lists of [x, y] points in 0..1 (null = straight line). m = all channels, then r, g, b
    curves: { m: null, r: null, g: null, b: null },
    // colour wheels: hue (degrees), strength (0..100) and a brightness shift (-100..100)
    wheels: { sh: { h: 0, s: 0, l: 0 }, mid: { h: 0, s: 0, l: 0 }, hi: { h: 0, s: 0, l: 0 } }
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const fresh = () => clone(DEFAULT);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fin = (v, d) => (Number.isFinite(+v) ? +v : d);
  const SLIDERS = ['exposure', 'temp', 'tint', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance'];

  function normCurve(pts) {
    if (!Array.isArray(pts)) return null;
    const out = pts.filter((p) => Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1])).slice(0, 32)
      .map((p) => [clamp(+p[0], 0, 1), clamp(+p[1], 0, 1)]).sort((a, b) => a[0] - b[0]);
    // x values must be strictly increasing for the spline; drop near-duplicates
    const keep = [];
    for (const p of out) if (!keep.length || p[0] - keep[keep.length - 1][0] > 0.004) keep.push(p);
    return keep.length >= 2 || (keep.length === 1) ? keep : null;
  }
  /** Cleans anything (a loaded project, a review file, the UI) into a grade object with sane numbers. */
  function normalize(c) {
    const o = fresh();
    if (!c || typeof c !== 'object') return o;
    SLIDERS.forEach((k) => { o[k] = clamp(fin(c[k], 0), -100, 100); });
    ['m', 'r', 'g', 'b'].forEach((k) => { o.curves[k] = normCurve(c.curves && c.curves[k]); });
    ['sh', 'mid', 'hi'].forEach((k) => {
      const w = (c.wheels && c.wheels[k]) || {};
      o.wheels[k] = { h: ((fin(w.h, 0) % 360) + 360) % 360, s: clamp(fin(w.s, 0), 0, 100), l: clamp(fin(w.l, 0), -100, 100) };
    });
    return o;
  }
  const curveIdentity = (p) => !p || p.length === 0 || (p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1);
  /** true when the grade changes anything (a neutral grade is skipped entirely: no LUT, no filter) */
  function active(c) {
    if (!c) return false;
    const n = normalize(c);
    if (SLIDERS.some((k) => n[k] !== 0)) return true;
    if (['m', 'r', 'g', 'b'].some((k) => !curveIdentity(n.curves[k]))) return true;
    return ['sh', 'mid', 'hi'].some((k) => n.wheels[k].s > 0 || n.wheels[k].l !== 0);
  }

  // ---- monotone cubic (Fritsch–Carlson) through the points, with the ends held flat
  function curveFn(pts) {
    if (curveIdentity(pts)) return (x) => x;
    const P = pts.slice();
    if (P[0][0] > 0) P.unshift([0, P[0][1]]);
    if (P[P.length - 1][0] < 1) P.push([1, P[P.length - 1][1]]);
    const n = P.length, dx = [], dy = [], m = [], t = new Array(n);
    for (let i = 0; i < n - 1; i++) { dx.push(P[i + 1][0] - P[i][0]); dy.push(P[i + 1][1] - P[i][1]); m.push(dy[i] / dx[i]); }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
      if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    return (x) => {
      x = clamp(x, 0, 1);
      let i = 0;
      while (i < n - 2 && x > P[i + 1][0]) i++;
      const h = dx[i], u = (x - P[i][0]) / h, u2 = u * u, u3 = u2 * u;
      const v = (2 * u3 - 3 * u2 + 1) * P[i][1] + (u3 - 2 * u2 + u) * h * t[i] + (-2 * u3 + 3 * u2) * P[i + 1][1] + (u3 - u2) * h * t[i + 1];
      return clamp(v, 0, 1);
    };
  }

  const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const fromLin = (c) => { c = Math.max(0, c); return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  function hueVec(h) {   // hue (degrees) -> an rgb offset that sums to zero (a pure tint, no brightness change)
    const a = h * Math.PI / 180;
    return [Math.cos(a), Math.cos(a - 2.0943951), Math.cos(a + 2.0943951)].map((v) => v * 2 / 3);
  }

  /** the grade as a function; returns null for a neutral grade */
  function makeFn(color) {
    if (!active(color)) return null;
    const c = normalize(color);
    const stops = Math.pow(2, c.exposure / 100 * 2);
    const gR = stops * (1 + 0.30 * c.temp / 100) * (1 + 0.10 * c.tint / 100);
    const gG = stops * (1 - 0.20 * c.tint / 100);
    const gB = stops * (1 - 0.30 * c.temp / 100) * (1 + 0.10 * c.tint / 100);
    const lightOn = c.exposure !== 0 || c.temp !== 0 || c.tint !== 0;
    const bp = -0.12 * c.blacks / 100, wp = 1 - 0.25 * c.whites / 100;
    const cm = curveFn(c.curves.m), cr = curveFn(c.curves.r), cg = curveFn(c.curves.g), cb = curveFn(c.curves.b);
    const curvesOn = ['m', 'r', 'g', 'b'].some((k) => !curveIdentity(c.curves[k]));
    const wheels = ['sh', 'mid', 'hi'].map((k) => { const w = c.wheels[k]; const v = hueVec(w.h), s = w.s / 100 * 0.25, l = w.l / 100 * 0.25; return { on: w.s > 0 || w.l !== 0, add: [v[0] * s + l, v[1] * s + l, v[2] * s + l] }; });
    const wheelsOn = wheels.some((w) => w.on);
    return (rgb) => {
      let r = rgb[0], g = rgb[1], b = rgb[2];
      if (lightOn) { r = fromLin(toLin(r) * gR); g = fromLin(toLin(g) * gG); b = fromLin(toLin(b) * gB); }
      if (c.highlights || c.shadows) {
        const L = lum(clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1));
        const k = 1 + 0.6 * c.highlights / 100 * smooth(0.35, 1, L) + 1.0 * c.shadows / 100 * (1 - smooth(0, 0.65, L));
        r *= k; g *= k; b *= k;
      }
      if (c.blacks || c.whites) { const d = wp - bp; r = (r - bp) / d; g = (g - bp) / d; b = (b - bp) / d; }
      if (wheelsOn) {
        const L = lum(clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1));
        const ws = 1 - smooth(0, 0.5, L), wh = smooth(0.5, 1, L), wm = 1 - ws - wh;
        const w = [ws, wm, wh];
        for (let i = 0; i < 3; i++) if (wheels[i].on) { r += w[i] * wheels[i].add[0]; g += w[i] * wheels[i].add[1]; b += w[i] * wheels[i].add[2]; }
      }
      r = clamp(r, 0, 1); g = clamp(g, 0, 1); b = clamp(b, 0, 1);
      if (curvesOn) { r = cr(cm(r)); g = cg(cm(g)); b = cb(cm(b)); }
      if (c.vibrance) {
        const sat = Math.max(r, g, b) - Math.min(r, g, b), L = lum(r, g, b), f = 1 + c.vibrance / 100 * (1 - sat);
        r = clamp(L + (r - L) * f, 0, 1); g = clamp(L + (g - L) * f, 0, 1); b = clamp(L + (b - L) * f, 0, 1);
      }
      return [r, g, b];
    };
  }
  const apply = (color, rgb) => { const f = makeFn(color); return f ? f(rgb) : rgb.slice(); };

  /** N^3 samples, red fastest then green then blue: the order of a .cube file */
  function sampleCube(color, N) {
    N = N || 33;
    const f = makeFn(color), out = new Float32Array(N * N * N * 3);
    let i = 0;
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
      const v = f ? f([r / (N - 1), g / (N - 1), b / (N - 1)]) : [r / (N - 1), g / (N - 1), b / (N - 1)];
      out[i++] = v[0]; out[i++] = v[1]; out[i++] = v[2];
    }
    return out;
  }
  /** the .cube text FFmpeg's lut3d reads */
  function cubeText(color, N) {
    N = N || 33;
    const d = sampleCube(color, N), lines = ['TITLE "Ditto Pro grade"', 'LUT_3D_SIZE ' + N, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
    for (let i = 0; i < d.length; i += 3) lines.push(d[i].toFixed(6) + ' ' + d[i + 1].toFixed(6) + ' ' + d[i + 2].toFixed(6));
    return lines.join('\n') + '\n';
  }
  /** preview texture: N*N x N RGBA8, x = r + b*N, y = g (the layout the compositor's LUT samplers use) */
  function texturePixels(color, N) {
    N = N || 33;
    const d = sampleCube(color, N), px = new Uint8Array(N * N * N * 4);
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
      const s = ((b * N + g) * N + r) * 3, t = (g * N * N + b * N + r) * 4;
      px[t] = Math.round(d[s] * 255); px[t + 1] = Math.round(d[s + 1] * 255); px[t + 2] = Math.round(d[s + 2] * 255); px[t + 3] = 255;
    }
    return px;
  }
  const key = (color) => JSON.stringify(normalize(color));

  return { DEFAULT, SLIDERS, fresh, clone, normalize, active, curveFn, curveIdentity, makeFn, apply, sampleCube, cubeText, texturePixels, key };
});
