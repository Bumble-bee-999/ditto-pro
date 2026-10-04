'use strict';
/*
 * Ditto Pro — motion tracking and subject finding.
 *
 *  trackPoint:     follows a small patch of the picture from frame to frame (translation, sub-pixel, robust to noise).
 *                  The patch is re-learned whenever it has moved far or changed look, so long shots do not lose it.
 *  analyzeSubject: finds where the action is in each moment of a clip (motion, with a pull toward the centre), smooths it
 *                  like a camera operator would, and returns a path the auto-reframe turns into pan keyframes.
 *
 * Everything runs on small grayscale copies of the frames, on this computer.
 */
const M = require('./motion');
const { decodeFrames } = require('./framepipe');

const even = (v) => Math.max(2, Math.floor(v / 2) * 2);
const MAX_FRAMES = 2400;

/**
 * o: { file, from, span, fps, w, h (source size), pointT (seconds into the span), x, y (0..1), size (patch half-width as a
 *      fraction of the picture width), direction 'both'|'forward'|'backward' }
 * returns { samples: [{t, x, y, ok}] (t = seconds into the span, x/y 0..1), fps, truncated }
 */
async function trackPoint(ffmpeg, o, onProgress, isCancelled) {
  const fps = Math.max(1, Math.min(60, o.fps || 30));
  const aw = 384, ah = even(Math.round(aw * (o.h || 9) / (o.w || 16)));
  const maxSpan = MAX_FRAMES / fps;
  const span = Math.min(o.span, maxSpan);
  const frames = [];
  const rep = (f) => { if (onProgress) onProgress(Math.max(0, Math.min(1, f))); };
  await decodeFrames(ffmpeg, { file: o.file, from: o.from, span, fps, w: aw, h: ah, pix: 'gray' }, (buf, i) => { frames.push(buf); if (i % 10 === 0) rep(0.25 * i / (span * fps)); }, isCancelled);
  if (frames.length < 2) throw new Error('Not enough frames to track.');
  const r0 = Math.max(0, Math.min(frames.length - 1, Math.round((o.pointT || 0) * fps)));
  const hs = Math.max(8, Math.round((o.size || 0.06) * aw));
  const pyr = (i) => M.pyramid(M.makeGray(frames[i], aw, ah), 4);

  const out = new Array(frames.length);
  out[r0] = { t: r0 / fps, x: o.x, y: o.y, ok: true };
  const dirs = o.direction === 'forward' ? [1] : o.direction === 'backward' ? [-1] : [1, -1];
  let done = 0;
  const total = dirs.reduce((a, d) => a + (d > 0 ? frames.length - 1 - r0 : r0), 0) || 1;
  for (const dir of dirs) {
    let tpl = pyr(r0), cx = o.x * aw, cy = o.y * ah, pos = [cx, cy], lastGood = pos.slice();
    for (let i = r0 + dir; i >= 0 && i < frames.length; i += dir) {
      if (isCancelled && isCancelled()) throw new Error('Cancelled.');
      const img = pyr(i);
      const lo = (v, m) => Math.max(3, Math.min(m - 4, v));
      const roi = { x0: lo(cx - hs, aw), y0: lo(cy - hs, ah), x1: lo(cx + hs, aw), y1: lo(cy + hs, ah) };
      const res = M.trackSimilarity(tpl, img, roi, [1, 0, pos[0] - cx, pos[1] - cy], { levels: 4, iters: 16, rotation: false, scale: false });
      if (res.ok) {
        pos = [cx + res.p[2], cy + res.p[3]]; lastGood = pos.slice();
        // learn the patch afresh when it has travelled or changed look
        if (Math.hypot(pos[0] - cx, pos[1] - cy) > hs * 0.5 || res.err > 0.05) { tpl = img; cx = pos[0]; cy = pos[1]; }
      } else {
        pos = lastGood.slice();                       // lost: hold the last good position and say so
        tpl = img; cx = pos[0]; cy = pos[1];
      }
      out[i] = { t: i / fps, x: Math.max(0, Math.min(1, pos[0] / aw)), y: Math.max(0, Math.min(1, pos[1] / ah)), ok: res.ok };
      if (++done % 10 === 0) rep(0.25 + 0.75 * done / total);
    }
  }
  rep(1);
  return { samples: out.filter(Boolean), fps, truncated: span < o.span - 1e-6 };
}

// ---- thinning: fewest keyframes that stay within `tol` (in 0..1 units) of the full path
function simplify(samples, tol) {
  if (samples.length < 3) return samples.slice();
  const keep = new Uint8Array(samples.length); keep[0] = 1; keep[samples.length - 1] = 1;
  const stack = [[0, samples.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = 0, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const u = (samples[i].t - samples[a].t) / (samples[b].t - samples[a].t || 1);
      const ex = samples[a].x + (samples[b].x - samples[a].x) * u, ey = samples[a].y + (samples[b].y - samples[a].y) * u;
      const e = Math.max(Math.abs(ex - samples[i].x), Math.abs(ey - samples[i].y));
      if (e > worst) { worst = e; wi = i; }
    }
    if (worst > tol && wi > 0) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  return samples.filter((s, i) => keep[i]);
}

// ---- subject finding for auto-reframe
function gauss(arr, sigma) {
  if (sigma < 0.3) return arr.slice();
  const r = Math.ceil(sigma * 3), k = [];
  let sum = 0; for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); sum += v; }
  const n = arr.length;
  return arr.map((_, i) => { let a = 0; for (let j = -r; j <= r; j++) { let m = i + j; if (m < 0) m = -m; if (m >= n) m = 2 * (n - 1) - m; a += arr[Math.max(0, Math.min(n - 1, m))] * k[j + r] / sum; } return a; });
}

/**
 * o: { file, from, span, fps (analysis rate), w, h, smooth (seconds, default 0.9) }
 * returns { path: [{t, x, y}] (t seconds into the span; x/y 0..1 centre of interest), confidence }
 */
async function analyzeSubject(ffmpeg, o, onProgress, isCancelled) {
  const fps = Math.max(2, Math.min(15, o.fps || 8));
  const aw = 128, ah = even(Math.round(aw * (o.h || 9) / (o.w || 16)));
  const rawX = [], rawY = [], energy = [];
  let prev = null;
  const total = Math.max(1, o.span * fps);
  await decodeFrames(ffmpeg, { file: o.file, from: o.from, span: o.span, fps, w: aw, h: ah, pix: 'gray' }, (buf, i) => {
    const cur = new Float32Array(aw * ah); for (let k = 0; k < cur.length; k++) cur[k] = buf[k];
    // blur a little so noise is not mistaken for movement
    if (prev) {
      let sw = 0, sx = 0, sy = 0;
      for (let y = 1; y < ah - 1; y++) for (let x = 1; x < aw - 1; x++) {
        const k = y * aw + x;
        const d = Math.abs(cur[k] - prev[k]) + 0.5 * (Math.abs(cur[k - 1] - prev[k - 1]) + Math.abs(cur[k + 1] - prev[k + 1]));
        const wgt = d > 14 ? d * d : 0;                         // ignore sensor noise, emphasise real movement
        sw += wgt; sx += wgt * x; sy += wgt * y;
      }
      energy.push(sw / (aw * ah));
      if (sw > 0) { rawX.push(sx / sw / aw); rawY.push(sy / sw / ah); } else { rawX.push(NaN); rawY.push(NaN); }
    } else { energy.push(0); rawX.push(NaN); rawY.push(NaN); }
    prev = cur;
    if (i % 8 === 0 && onProgress) onProgress(Math.min(1, i / total));
  }, isCancelled);
  const n = rawX.length;
  if (n < 2) throw new Error('Not enough frames to analyse.');
  // fill gaps (no movement): hold the last known place, starting from the first known one
  let lastX = null, lastY = null;
  for (let i = 0; i < n; i++) if (!isNaN(rawX[i])) { lastX = rawX[i]; lastY = rawY[i]; break; }
  if (lastX == null) { lastX = 0.5; lastY = 0.5; }
  const px = [], py = [];
  for (let i = 0; i < n; i++) { if (!isNaN(rawX[i])) { lastX = rawX[i]; lastY = rawY[i]; } px.push(lastX); py.push(lastY); }
  const sigma = Math.max(0.5, (o.smooth || 0.9) * fps);
  const sx = gauss(px, sigma), sy = gauss(py, sigma);
  const mean = energy.reduce((a, b) => a + b, 0) / n;
  const path = sx.map((x, i) => ({ t: i / fps, x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, sy[i])) }));
  if (onProgress) onProgress(1);
  return { path, confidence: Math.min(1, mean / 20), fps };
}

module.exports = { trackPoint, analyzeSubject, simplify, gauss };
