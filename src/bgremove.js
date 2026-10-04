'use strict';
/*
 * Ditto Pro — offline background removal.
 *
 * A salient-object network (U²-Net / IS-Net, Apache-2.0, run with onnxruntime on this computer, on the GPU through
 * DirectML when Windows offers it) estimates a soft matte for every frame. Three own steps then turn that rough
 * matte into broadcast-usable edges:
 *   1. temporal smoothing and cut detection, so the matte does not flicker and never bleeds across a cut;
 *   2. a guided filter (He et al.) that snaps the matte onto the real edges of the full-resolution picture, which keeps hair
 *      and fine detail the network could only see at 320 or 1024 pixels;
 *   3. an adjustable contrast curve (edge softness, grow / shrink).
 * The result is written as ProRes 4444 with alpha (video) or a PNG with alpha (stills), which the timeline treats like any
 * other clip. Nothing leaves the computer.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { decodeFrames, startEncoder } = require('./framepipe');

const MODELS = {
  u2netp: { id: 'u2netp', file: 'u2netp.onnx', size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], label: 'Fast (U²-Netp)', note: 'Small and quick. Good for people, products and animals.' },
  isnet: { id: 'isnet', file: 'isnet-general-use.onnx', size: 1024, mean: [0.5, 0.5, 0.5], std: [1, 1, 1], label: 'Best quality (IS-Net)', note: 'Larger model, sharper edges, much slower without a GPU.' }
};

/** Which models are present in the given folders. */
function findModels(dirs) {
  const out = [];
  for (const id of Object.keys(MODELS)) {
    for (const d of dirs || []) {
      const p = path.join(d, MODELS[id].file);
      try { const st = fs.statSync(p); if (st.isFile() && st.size > 1e6) { out.push({ id, label: MODELS[id].label, note: MODELS[id].note, path: p, bytes: st.size }); break; } } catch (e) { /* not here */ }
    }
  }
  return out;
}

// ------------------------------------------------------------------ resampling
function taps(sn, dn) {
  const s = sn / dn, T = new Array(dn);
  for (let i = 0; i < dn; i++) {
    if (s > 1) { // shrinking: average over the covered source pixels
      const a = i * s, b = (i + 1) * s;
      const i0 = Math.floor(a), i1 = Math.min(sn - 1, Math.ceil(b) - 1);
      const w = []; let sum = 0;
      for (let k = i0; k <= i1; k++) { const wk = Math.min(k + 1, b) - Math.max(k, a); w.push(wk); sum += wk; }
      T[i] = { s: i0, w: w.map((x) => x / sum) };
    } else { // enlarging (or equal): bilinear
      const c = (i + 0.5) * s - 0.5, i0 = Math.floor(c), f = c - i0;
      const a = Math.max(0, Math.min(sn - 1, i0)), b = Math.max(0, Math.min(sn - 1, i0 + 1));
      T[i] = a === b ? { s: a, w: [1] } : { s: a, w: [1 - f, f] };
    }
  }
  return T;
}

/** Resizes interleaved samples (`ch` per pixel) of any typed array into a Float32Array. */
function resize(src, sw, sh, ch, dw, dh) {
  const out = new Float32Array(dw * dh * ch);
  if (sw === dw && sh === dh) { for (let i = 0; i < out.length; i++) out[i] = src[i]; return out; }
  const tx = taps(sw, dw), ty = taps(sh, dh);
  const mid = new Float32Array(dw * sh * ch);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * ch;
    for (let x = 0; x < dw; x++) {
      const t = tx[x], w = t.w, n = w.length;
      for (let c = 0; c < ch; c++) {
        let v = 0, p = row + t.s * ch + c;
        for (let k = 0; k < n; k++, p += ch) v += src[p] * w[k];
        mid[(y * dw + x) * ch + c] = v;
      }
    }
  }
  for (let y = 0; y < dh; y++) {
    const t = ty[y], w = t.w, n = w.length;
    for (let x = 0; x < dw * ch; x++) {
      let v = 0, p = t.s * dw * ch + x;
      for (let k = 0; k < n; k++, p += dw * ch) v += mid[p] * w[k];
      out[y * dw * ch + x] = v;
    }
  }
  return out;
}

// ------------------------------------------------------------------ guided filter
/** Mean over a (2r+1)² window (clamped at the borders). In-place safe for src !== dst. */
function boxMean(src, w, h, r, dst, tmp) {
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0, lo = 0, hi = Math.min(w - 1, r);
    for (let x = 0; x <= hi; x++) s += src[o + x];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s / (hi - lo + 1);
      const nh = x + 1 + r, nl = x - r;
      if (nh < w) { s += src[o + nh]; hi = nh; }
      if (nl >= 0) { s -= src[o + nl]; lo = nl + 1; }
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0, lo = 0, hi = Math.min(h - 1, r);
    for (let y = 0; y <= hi; y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = s / (hi - lo + 1);
      const nh = y + 1 + r, nl = y - r;
      if (nh < h) { s += tmp[nh * w + x]; hi = nh; }
      if (nl >= 0) { s -= tmp[nl * w + x]; lo = nl + 1; }
    }
  }
  return dst;
}

/**
 * Guided filter: smooths `p` while following the edges of the guide image `I` (both 0..1, w×h).
 * Returns a new Float32Array.
 */
function guidedFilter(I, p, w, h, r, eps) {
  const n = w * h, tmp = new Float32Array(n);
  const mI = boxMean(I, w, h, r, new Float32Array(n), tmp), mp = boxMean(p, w, h, r, new Float32Array(n), tmp);
  const t1 = new Float32Array(n), t2 = new Float32Array(n);
  for (let i = 0; i < n; i++) { t1[i] = I[i] * I[i]; t2[i] = I[i] * p[i]; }
  const cI = boxMean(t1, w, h, r, new Float32Array(n), tmp), cIp = boxMean(t2, w, h, r, new Float32Array(n), tmp);
  const a = t1, b = t2; // reuse
  for (let i = 0; i < n; i++) {
    const v = cI[i] - mI[i] * mI[i], cov = cIp[i] - mI[i] * mp[i];
    const ai = cov / (v + eps);
    a[i] = ai; b[i] = mp[i] - ai * mI[i];
  }
  const ma = boxMean(a, w, h, r, mI, tmp), mb = boxMean(b, w, h, r, mp, tmp);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = ma[i] * I[i] + mb[i]; q[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  return q;
}

/** Contrast curve on a 0..1 matte: `edge` 0-100 (soft…hard is 0…100 inverted), `shift` -100..100 (shrink … grow). */
function curve(q, edge, shift) {
  const e = Math.max(0, Math.min(100, edge == null ? 35 : edge)), s = Math.max(-100, Math.min(100, shift || 0));
  const t = 0.5 - s / 100 * 0.35, hw = 0.03 + 0.42 * Math.pow(e / 100, 1.4);
  const lo = t - hw, span = 2 * hw;
  for (let i = 0; i < q.length; i++) {
    let x = (q[i] - lo) / span;
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    q[i] = x * x * (3 - 2 * x);
  }
  return q;
}

// ------------------------------------------------------------------ the model
/** Loads the network. device: 'auto' (GPU through DirectML on Windows, else CPU) or 'cpu'. */
async function createSession(modelPath, spec, device) {
  const ort = require('onnxruntime-node');
  const make = (eps) => ort.InferenceSession.create(modelPath, { executionProviders: eps, graphOptimizationLevel: 'all', intraOpNumThreads: Math.max(1, os.cpus().length - 1) });
  const warm = async (s) => { await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * spec.size * spec.size), [1, 3, spec.size, spec.size]) }); };
  let session = null, provider = 'cpu';
  if (device !== 'cpu' && process.platform === 'win32') {
    try { session = await make(['dml', 'cpu']); await warm(session); provider = 'dml'; } catch (e) { session = null; }
  }
  if (!session) session = await make(['cpu']);
  return { ort, session, input: session.inputNames[0], output: session.outputNames[0], provider, spec };
}

/** Runs the network on one full-resolution RGBA frame. Returns probabilities (0..1) at the model's resolution. */
async function infer(M, rgba, W, H) {
  const N = M.spec.size, small = resize(rgba, W, H, 4, N, N);
  let mx = 1e-6;
  for (let i = 0; i < N * N; i++) { const o = i * 4; if (small[o] > mx) mx = small[o]; if (small[o + 1] > mx) mx = small[o + 1]; if (small[o + 2] > mx) mx = small[o + 2]; }
  const data = new Float32Array(3 * N * N), mean = M.spec.mean, std = M.spec.std;
  for (let i = 0; i < N * N; i++) for (let c = 0; c < 3; c++) data[c * N * N + i] = (small[i * 4 + c] / mx - mean[c]) / std[c];
  const out = await M.session.run({ [M.input]: new M.ort.Tensor('float32', data, [1, 3, N, N]) });
  const o = out[M.output].data;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < o.length; i++) { const v = o[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const prob = new Float32Array(N * N);
  if (lo >= -0.01 && hi <= 1.01) for (let i = 0; i < prob.length; i++) prob[i] = Math.max(0, Math.min(1, o[i]));       // already probabilities
  else for (let i = 0; i < prob.length; i++) prob[i] = (o[i] - lo) / ((hi - lo) || 1);                                // raw scores: stretch
  return prob;
}

// ------------------------------------------------------------------ one frame
const CUT = 0.16;           // mean difference (0..1) between neighbouring frames that counts as a cut
function thumbOf(rgba, W, H) {
  const t = resize(rgba, W, H, 4, 32, 32), g = new Float32Array(32 * 32);
  for (let i = 0; i < g.length; i++) g[i] = (0.299 * t[i * 4] + 0.587 * t[i * 4 + 1] + 0.114 * t[i * 4 + 2]) / 255;
  return g;
}
function thumbDiff(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }

/** Refines a model-resolution matte against the real frame and writes it into the frame's alpha channel (in place). */
function applyMatte(rgba, W, H, prob, N, o) {
  const k = Math.min(1, 1280 / Math.max(W, H)), ww = Math.max(8, Math.round(W * k)), wh = Math.max(8, Math.round(H * k));
  const px = resize(rgba, W, H, 4, ww, wh), guide = new Float32Array(ww * wh);
  for (let i = 0; i < guide.length; i++) guide[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
  const p = resize(prob, N, N, 1, ww, wh);
  const r = Math.max(4, Math.round(Math.max(ww, wh) * (o.detail == null ? 0.007 : o.detail))), eps = 2e-4;
  let q = guidedFilter(guide, p, ww, wh, r, eps);
  curve(q, o.edge, o.shift);
  if (ww !== W || wh !== H) q = resize(q, ww, wh, 1, W, H);
  for (let i = 0, j = 3; i < q.length; i++, j += 4) { const v = q[i] * 255 + 0.5; rgba[j] = v < 0 ? 0 : v > 255 ? 255 : v; }
  return rgba;
}

const blend = (a, b, t) => { const o = new Float32Array(a.length); for (let i = 0; i < o.length; i++) o[i] = a[i] + (b[i] - a[i]) * t; return o; };

function cacheKey(o) {
  let st = {};
  try { const s = fs.statSync(o.file); st = { size: s.size, mtime: s.mtimeMs }; } catch (e) { /* ignore */ }
  return crypto.createHash('sha1').update(JSON.stringify([o.file, st, o.from, o.span, o.fps, o.w, o.h, o.model, o.edge, o.shift, o.temporal, o.step, o.detail, o.kind, 'v1'])).digest('hex').slice(0, 20);
}
const even = (v) => Math.max(2, Math.floor(v / 2) * 2);

/**
 * o: { file, kind:'video'|'image', from, span, fps, w, h, model: { id, path }, edge 0-100, shift -100..100, temporal 0-90 (%),
 *      step 1-8 (run the network on every n-th frame, the frames in between follow by blending), device, outDir }
 * returns { path, cached, provider, frames }
 */
async function removeBackground(ffmpeg, o, onProgress, isCancelled) {
  const spec = MODELS[o.model && o.model.id];
  if (!spec || !o.model.path) throw new Error('No background-removal model is installed.');
  const image = o.kind === 'image';
  if (!image && !(o.span > 0.1)) throw new Error('The clip is too short.');
  fs.mkdirSync(o.outDir, { recursive: true });
  const out = path.join(o.outDir, 'bg-' + cacheKey(Object.assign({}, o, { model: o.model.id })) + (image ? '.png' : '.mov'));
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) return { path: out, cached: true };
  const fps = o.fps || 30, W = even(o.w), H = even(o.h);
  const total = image ? 1 : Math.max(1, Math.round(o.span * fps));
  const step = image ? 1 : Math.max(1, Math.min(8, Math.round(o.step || 1)));
  const tmpA = (o.temporal == null ? 30 : Math.max(0, Math.min(90, o.temporal))) / 100;
  const rep = (f) => { if (onProgress) onProgress(Math.max(0, Math.min(1, f))); };
  const M = await createSession(o.model.path, spec, o.device);

  const tmp = out + '.part' + path.extname(out);
  const enc = startEncoder(ffmpeg, image
    ? { w: W, h: H, fps: 1, pix: 'rgba', out: tmp, vcodecArgs: ['-frames:v', '1', '-c:v', 'png', '-pix_fmt', 'rgba'] }
    : { w: W, h: H, fps, pix: 'rgba', out: tmp, audio: { file: o.file, from: o.from, span: o.span }, vcodecArgs: ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0'] });
  let n = 0, A = null, pending = [];
  const emit = async (buf, prob) => { applyMatte(buf, W, H, prob, spec.size, o); await enc.write(buf); n++; rep(n / total); };
  const settle = async (B) => { // frames between key A and key B (B null at the end of the clip)
    if (!pending.length) return;
    let cutAt = -1;
    if (B) { const seq = [A.thumb].concat(pending.map((f) => f.thumb), [B.thumb]); for (let j = 1; j < seq.length; j++) if (thumbDiff(seq[j - 1], seq[j]) > CUT) { cutAt = j; break; } }
    const span = pending.length + 1;
    for (let j = 0; j < pending.length; j++) {
      const f = pending[j];
      let prob;
      if (!B || (cutAt >= 0 && j + 1 < cutAt)) prob = A.prob;
      else if (cutAt >= 0) prob = B.prob;
      else prob = blend(A.prob, B.prob, (j + 1) / span);
      await emit(f.buf, prob);
    }
    pending = [];
  };
  try {
    await decodeFrames(ffmpeg, { file: o.file, from: image ? 0 : o.from, span: image ? 0 : o.span, fps, w: W, h: H, pix: 'rgba', scaleFlags: 'bicubic' }, async (buf, i) => {
      const thumb = thumbOf(buf, W, H);
      if (i % step !== 0) { pending.push({ buf, thumb }); return; }
      let prob = await infer(M, buf, W, H);
      const cut = !A || thumbDiff(A.thumb, thumb) > CUT;
      if (!cut && tmpA > 0) prob = blend(prob, A.prob, tmpA);
      const B = { prob, thumb };
      if (A) await settle(B);
      A = B;
      await emit(buf, prob);
    }, isCancelled);
    if (A) await settle(null);
    await enc.end();
  } catch (e) { enc.kill(); try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ } throw e; }
  if (!n) { try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ } throw new Error('No frames were produced.'); }
  fs.renameSync(tmp, out);
  rep(1);
  return { path: out, cached: false, provider: M.provider, frames: n };
}

module.exports = { MODELS, findModels, resize, guidedFilter, boxMean, curve, createSession, infer, applyMatte, thumbOf, thumbDiff, removeBackground, cacheKey };
