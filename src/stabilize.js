'use strict';
/*
 * Ditto Pro — video stabilisation.
 *
 * Pass 1 measures the camera's motion frame to frame (translation, rotation and zoom, see motion.js). The path is then
 * smoothed, and pass 2 re-renders every frame so the picture follows the smooth path instead of the shaky one. A slight
 * zoom hides the edges that the correction would otherwise reveal. The result is written to a new high-quality file that
 * replaces the clip's source (the original stays in the project), so preview and export show exactly the same picture.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('./motion');
const { decodeFrames, startEncoder } = require('./framepipe');

const even = (v) => Math.max(2, Math.floor(v / 2) * 2);

function cacheKey(o) {
  let st = {};
  try { const s = fs.statSync(o.file); st = { size: s.size, mtime: s.mtimeMs }; } catch (e) { /* ignore */ }
  return crypto.createHash('sha1').update(JSON.stringify([o.file, st, o.from, o.span, o.fps, o.w, o.h, o.smoothness, o.method, o.fill, o.rotation, 'v2'])).digest('hex').slice(0, 20);
}

// Gaussian width of the path smoothing in frames
function sigmaFrames(o, nFrames) {
  if (o.method === 'locked') return Math.max(10, nFrames * 2);          // hold the camera still (tripod look)
  const s = Math.max(0, Math.min(100, o.smoothness == null ? 40 : o.smoothness));
  return (0.05 + 0.012 * s) * (o.fps || 30);
}

/**
 * Computes the correction for each frame without touching the video (used by the tests and by stabilize()).
 * Returns { M: per-frame [a,b,tx,ty] in full-resolution centred pixels, zoom, G, shakeBefore, shakeAfter }
 */
function planCorrection(G, o, w, h, k) {
  const Gs = M.smoothPath(G, sigmaFrames(o, G.length));
  if (o.rotation === false) { // keep rotation/scale as measured, smooth only the translation
    for (let t = 0; t < G.length; t++) { const d = M.decompose(G[t]), s = M.decompose(Gs[t]); Gs[t] = M.fromParts(s.tx, s.ty, d.rot, d.scale); }
  }
  const mats = M.corrections(G, Gs).map((m) => [m[0], m[1], m[2] * k, m[3] * k]);
  const zoom = o.fill === 'edges' ? 1 : M.zoomFor(mats, w, h, 1.6);
  return { M: mats, zoom, Gs };
}

/**
 * @param o { file, from, span, fps, w, h, smoothness 0-100, method 'smooth'|'locked', fill 'zoom'|'edges', rotation, outDir }
 * @returns { path, cached, zoom }
 */
async function stabilize(ffmpeg, o, onProgress, isCancelled) {
  if (!(o.span > 0.2)) throw new Error('The clip is too short to stabilise.');
  fs.mkdirSync(o.outDir, { recursive: true });
  const out = path.join(o.outDir, 'stab-' + cacheKey(o) + '.mp4');
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) return { path: out, cached: true };
  const fps = o.fps || 30, W = even(o.w), H = even(o.h);
  const total = Math.max(1, Math.round(o.span * fps));
  const rep = (f) => { if (onProgress) onProgress(Math.max(0, Math.min(1, f))); };

  // ---- pass 1: camera motion from small grayscale frames
  const aw = 320, ah = even(Math.round(H * aw / W));
  const est = M.createGlobalEstimator(aw, ah, { rotation: o.rotation !== false });
  await decodeFrames(ffmpeg, { file: o.file, from: o.from, span: o.span, fps, w: aw, h: ah, pix: 'gray' }, (buf, i) => { est.add(new Uint8Array(buf)); if (i % 8 === 0) rep(0.4 * i / total); }, isCancelled);
  if (est.G.length < 3) throw new Error('Not enough frames to stabilise.');
  const k = W / aw;
  const plan = planCorrection(est.G, o, W, H, k);

  // ---- pass 2: re-render the frames along the smooth path
  const tmp = out + '.part.mp4';
  const enc = startEncoder(ffmpeg, { w: W, h: H, fps, pix: 'rgb24', out: tmp, audio: { file: o.file, from: o.from, span: o.span } });
  const dst = Buffer.alloc(W * H * 3);
  let n = 0;
  try {
    await decodeFrames(ffmpeg, { file: o.file, from: o.from, span: o.span, fps, w: W, h: H, pix: 'rgb24' }, async (buf, i) => {
      const m = plan.M[Math.min(i, plan.M.length - 1)];
      M.warpRGB(buf, dst, W, H, m, plan.zoom, o.fill === 'edges');
      await enc.write(dst);
      n++; if (i % 4 === 0) rep(0.4 + 0.6 * i / total);
    }, isCancelled);
    await enc.end();
  } catch (e) { enc.kill(); try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ } throw e; }
  if (!n) { try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ } throw new Error('No frames were produced.'); }
  fs.renameSync(tmp, out);
  rep(1);
  return { path: out, cached: false, zoom: plan.zoom };
}
module.exports = { stabilize, planCorrection, cacheKey };
