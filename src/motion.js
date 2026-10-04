'use strict';
/*
 * Ditto Pro — motion analysis (pure JavaScript, deterministic, no native code).
 *
 * Everything here works on small grayscale frames and a "similarity" warp: scale + rotation + translation, written as
 * complex numbers  z' = c·z + t  (c = a + ib, t = tx + i·ty) in coordinates centred on the frame.
 *
 *  • trackSimilarity()  – direct (Lucas–Kanade) alignment of a template region against a frame, coarse to fine, with
 *                         robust weights so moving objects and noise don't pull the estimate. Used for object tracking.
 *  • estimateGlobal()   – the same on the whole frame, frame to frame: the camera motion.
 *  • smoothPath(), zoomFor(), warpRGB() – everything needed to stabilise and to reframe.
 */

// ---------------------------------------------------------------- similarity transforms as [a, b, tx, ty]
const ID = () => [1, 0, 0, 0];
function compose(A, B) { // A ∘ B  (apply B first)
  return [A[0] * B[0] - A[1] * B[1], A[0] * B[1] + A[1] * B[0], A[0] * B[2] - A[1] * B[3] + A[2], A[0] * B[3] + A[1] * B[2] + A[3]];
}
function invert(A) {
  const d = A[0] * A[0] + A[1] * A[1] || 1e-12;
  const ia = A[0] / d, ib = -A[1] / d;
  return [ia, ib, -(ia * A[2] - ib * A[3]), -(ia * A[3] + ib * A[2])];
}
function apply(A, x, y) { return [A[0] * x - A[1] * y + A[2], A[1] * x + A[0] * y + A[3]]; }
const decompose = (A) => ({ tx: A[2], ty: A[3], rot: Math.atan2(A[1], A[0]), scale: Math.hypot(A[0], A[1]) });
const fromParts = (tx, ty, rot, scale) => [scale * Math.cos(rot), scale * Math.sin(rot), tx, ty];

// ---------------------------------------------------------------- gray image pyramid
function makeGray(data, w, h) {
  const f = new Float32Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = data[i] / 255;
  return { w, h, d: f };
}
function down(g) {
  const w = Math.max(1, g.w >> 1), h = Math.max(1, g.h >> 1), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.min(g.w - 1, 2 * x), y0 = Math.min(g.h - 1, 2 * y), x1 = Math.min(g.w - 1, x0 + 1), y1 = Math.min(g.h - 1, y0 + 1);
    o[y * w + x] = (g.d[y0 * g.w + x0] + g.d[y0 * g.w + x1] + g.d[y1 * g.w + x0] + g.d[y1 * g.w + x1]) * 0.25;
  }
  return { w, h, d: o };
}
function blur3(g) {
  const { w, h, d } = g, o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, k = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const xx = x + i, yy = y + j; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const wt = (i === 0 ? 2 : 1) * (j === 0 ? 2 : 1); s += d[yy * w + xx] * wt; k += wt;
    }
    o[y * w + x] = s / k;
  }
  return { w, h, d: o };
}
function pyramid(g, levels) {
  const out = [g];
  for (let l = 1; l < levels; l++) { const p = out[l - 1]; if (Math.min(p.w, p.h) < 24) break; out.push(down(blur3(p))); }
  return out;
}
function gradients(g) {
  const { w, h, d } = g, gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1), ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1);
    gx[y * w + x] = (d[y * w + xp] - d[y * w + xm]) / (xp - xm || 1);
    gy[y * w + x] = (d[yp * w + x] - d[ym * w + x]) / (yp - ym || 1);
  }
  return { gx, gy };
}
function bil(d, w, h, x, y) { // x,y in pixel indices, caller guarantees 0<=x<=w-1
  const x0 = x | 0, y0 = y | 0, x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0, fx = x - x0, fy = y - y0;
  return (d[y0 * w + x0] * (1 - fx) + d[y0 * w + x1] * fx) * (1 - fy) + (d[y1 * w + x0] * (1 - fx) + d[y1 * w + x1] * fx) * fy;
}

/**
 * Aligns `img` to `tpl`: finds p so that img(W_p(x)) ≈ tpl(x) for x inside `roi`.
 * @param tpl,img  gray images {w,h,d} of the same size
 * @param roi      {x0,y0,x1,y1} in full-resolution pixel coordinates (template side); null = whole frame (with a margin)
 * @param init     starting warp [a,b,tx,ty] in centred full-resolution coordinates
 * @param o        { levels, iters, rotation: true|false, scale: true|false }
 * @returns { p, err, ok, support }
 */
function trackSimilarity(tplPyr, imgPyr, roi, init, o) {
  o = o || {};
  const levels = Math.min(tplPyr.length, imgPyr.length, o.levels || 4);
  let p = (init || ID()).slice();
  const W0 = tplPyr[0].w, H0 = tplPyr[0].h;
  let err = 1, support = 0;
  for (let L = levels - 1; L >= 0; L--) {
    const T = tplPyr[L], I = imgPyr[L], f = Math.pow(2, L);
    const w = T.w, h = T.h;
    const grad = imgPyr[L].grad || (imgPyr[L].grad = gradients(I));
    // region at this level
    const rx0 = Math.max(1, Math.floor((roi ? roi.x0 : W0 * 0.04) / f)), ry0 = Math.max(1, Math.floor((roi ? roi.y0 : H0 * 0.04) / f));
    const rx1 = Math.min(w - 2, Math.ceil((roi ? roi.x1 : W0 * 0.96) / f)), ry1 = Math.min(h - 2, Math.ceil((roi ? roi.y1 : H0 * 0.96) / f));
    if (rx1 - rx0 < 6 || ry1 - ry0 < 6) continue;
    // pixel lists for the template region (centred coordinates at this level)
    const n = (rx1 - rx0) * (ry1 - ry0);
    const px = new Float32Array(n), py = new Float32Array(n), tv = new Float32Array(n), wt = new Float32Array(n);
    let k = 0;
    for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) { px[k] = x - w / 2; py[k] = y - h / 2; tv[k] = T.d[y * w + x]; wt[k] = 1; k++; }
    // parameters at this level: translation scales with the level, a and b do not
    let q = [p[0], p[1], p[2] / f, p[3] / f];
    const iters = (o.iters || 14) + (L === 0 ? 0 : 6);
    const res = new Float32Array(n);
    for (let it = 0; it < iters; it++) {
      // Gauss–Newton step on [a, b, tx, ty]
      const A = new Float64Array(16), bvec = new Float64Array(4);
      let used = 0, sum = 0;
      const absr = [];
      for (let i = 0; i < n; i++) {
        const X = q[0] * px[i] - q[1] * py[i] + q[2] + w / 2, Y = q[1] * px[i] + q[0] * py[i] + q[3] + h / 2;
        if (X < 1 || Y < 1 || X > w - 2 || Y > h - 2) { res[i] = NaN; continue; }
        res[i] = bil(I.d, w, h, X, Y) - tv[i];
        sum += res[i]; used++;
      }
      if (used < n * 0.25) { support = used / n; err = 1; break; }
      const mean = sum / used; // offset invariance (exposure drift)
      let samp = [];
      for (let i = 0; i < n; i += Math.max(1, (n / 1500) | 0)) if (!isNaN(res[i])) samp.push(Math.abs(res[i] - mean));
      samp.sort((u, v) => u - v);
      const sc = Math.max(0.004, 1.4826 * samp[samp.length >> 1]);
      const cut = 4.685 * sc;
      let se = 0, sw = 0;
      for (let i = 0; i < n; i++) {
        if (isNaN(res[i])) continue;
        const r = res[i] - mean, ar = Math.abs(r);
        if (ar >= cut) continue;
        const u = 1 - (ar / cut) * (ar / cut), wgt = u * u;
        const X = q[0] * px[i] - q[1] * py[i] + q[2] + w / 2, Y = q[1] * px[i] + q[0] * py[i] + q[3] + h / 2;
        const gx = bil(grad.gx, w, h, X, Y), gy = bil(grad.gy, w, h, X, Y);
        const J0 = gx * px[i] + gy * py[i], J1 = -gx * py[i] + gy * px[i], J2 = gx, J3 = gy;
        const J = [J0, J1, J2, J3];
        for (let a = 0; a < 4; a++) { bvec[a] += wgt * J[a] * r; for (let b = 0; b < 4; b++) A[a * 4 + b] += wgt * J[a] * J[b]; }
        se += wgt * r * r; sw += wgt;
      }
      err = sw > 0 ? Math.sqrt(se / sw) : 1; support = sw / n;
      if (o.rotation === false) { for (let j = 0; j < 4; j++) { A[1 * 4 + j] = A[j * 4 + 1] = 0; } A[5] = 1; bvec[1] = 0; }
      if (o.scale === false && o.rotation === false) { for (let j = 0; j < 4; j++) { A[0 * 4 + j] = A[j * 4 + 0] = 0; } A[0] = 1; bvec[0] = 0; }
      for (let j = 0; j < 4; j++) A[j * 4 + j] += 1e-6 * (A[j * 4 + j] + 1) + 1e-9;
      const d = solve4(A, bvec);
      if (!d) break;
      // damp rotation/scale at coarse levels (they are poorly conditioned on tiny images)
      q = [q[0] - d[0], q[1] - d[1], q[2] - d[2], q[3] - d[3]];
      if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) + Math.abs(d[3]) < 1e-4) break;
    }
    p = [q[0], q[1], q[2] * f, q[3] * f];
  }
  return { p, err, support, ok: support > 0.3 && err < 0.12 };
}
function solve4(A, b) {
  const M = [];
  for (let i = 0; i < 4; i++) M.push([A[i * 4], A[i * 4 + 1], A[i * 4 + 2], A[i * 4 + 3], b[i]]);
  for (let c = 0; c < 4; c++) {
    let piv = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < 4; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let j = c; j < 5; j++) M[r][j] -= f * M[c][j]; }
  }
  return [M[0][4] / M[0][0], M[1][4] / M[1][1], M[2][4] / M[2][2], M[3][4] / M[3][3]];
}

// ---------------------------------------------------------------- camera motion over a whole clip
/**
 * frames: array of Uint8Array gray frames (w×h). Returns G[t] = mapping from frame-0 coordinates to frame-t coordinates
 * (centred, full-frame pixels) and a per-step quality list.
 */
function estimateGlobal(frames, w, h, o) {
  const est = createGlobalEstimator(w, h, o);
  frames.forEach((f) => est.add(f));
  return { G: est.G, quality: est.quality };
}
// incremental version: feed frames one at a time (keeps memory flat for long clips)
function createGlobalEstimator(w, h, o) {
  o = o || {};
  const G = [ID()], quality = [1];
  let prevPyr = null, Gt = ID();
  return {
    G, quality,
    add(frame) {
      const pyr = pyramid(makeGray(frame, w, h), 4);
      if (prevPyr) {
        // W maps frame t-1 coords -> frame t coords (img = frame t, template = frame t-1)
        const r = trackSimilarity(prevPyr, pyr, null, ID(), { levels: 4, iters: 12, rotation: o.rotation !== false });
        const W = r.ok || r.err < 0.2 ? r.p : ID();
        Gt = compose(W, Gt);
        G.push(Gt.slice()); quality.push(r.ok ? 1 : 0);
      }
      prevPyr = pyr;
    }
  };
}

// Gaussian smoothing of a path of transforms (each parameter separately; rotation unwrapped)
function smoothPath(G, sigma) {
  const n = G.length;
  if (sigma <= 0.01 || n < 3) return G.map((g) => g.slice());
  const parts = G.map(decompose);
  let prev = 0; const rot = parts.map((p) => { let r = p.rot; while (r - prev > Math.PI) r -= 2 * Math.PI; while (r - prev < -Math.PI) r += 2 * Math.PI; prev = r; return r; });
  const series = { tx: parts.map((p) => p.tx), ty: parts.map((p) => p.ty), rot, ls: parts.map((p) => Math.log(p.scale || 1)) };
  const rad = Math.ceil(sigma * 3), ker = []; let ks = 0;
  for (let i = -rad; i <= rad; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); ker.push(v); ks += v; }
  const sm = (arr) => arr.map((_, t) => {
    let s = 0, wsum = 0;
    for (let i = -rad; i <= rad; i++) { // reflect at the ends so the clip's first/last frames aren't dragged
      let j = t + i; if (j < 0) j = -j; if (j > n - 1) j = 2 * (n - 1) - j; j = Math.max(0, Math.min(n - 1, j));
      s += arr[j] * ker[i + rad]; wsum += ker[i + rad];
    }
    return s / wsum;
  });
  const a = sm(series.tx), b = sm(series.ty), c = sm(series.rot), d = sm(series.ls);
  return G.map((_, t) => fromParts(a[t], b[t], c[t], Math.exp(d[t])));
}

// The correction for each frame: output pixel u shows frame-t pixel M_t(u / z)
function corrections(G, Gs) { return G.map((g, t) => compose(g, invert(Gs[t]))); }

// Smallest uniform zoom (≥ 1) that keeps every output pixel inside the source frame for all frames
function zoomFor(M, w, h, cap) {
  let z = 1;
  const hw = w / 2, hh = h / 2;
  const corners = [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]];
  for (const m of M) {
    for (const [ux, uy] of corners) {
      const rx = m[0] * ux - m[1] * uy, ry = m[1] * ux + m[0] * uy;
      const need = (r, t, half) => (r > 0 ? (half - t > 1e-6 ? r / (half - t) : Infinity) : r < 0 ? (half + t > 1e-6 ? -r / (half + t) : Infinity) : 1);
      z = Math.max(z, need(rx, m[2], hw), need(ry, m[3], hh));
    }
  }
  return Math.min(cap || 1.6, z);
}

// Renders dst(u) = src(M(u / z)) for RGB24 frames (bilinear). Outside the source -> black (or edge colour when `clamp`).
function warpRGB(src, dst, w, h, M, z, clamp) {
  const hw = w / 2, hh = h / 2, iz = 1 / z;
  const a = M[0] * iz, b = M[1] * iz, tx = M[2] + hw, ty = M[3] + hh;
  for (let y = 0; y < h; y++) {
    const uy = y + 0.5 - hh;
    let X = a * (0.5 - hw) - b * uy + tx - 0.5, Y = b * (0.5 - hw) + a * uy + ty - 0.5;
    let o = y * w * 3;
    for (let x = 0; x < w; x++, X += a, Y += b, o += 3) {
      let xx = X, yy = Y;
      if (xx < 0 || yy < 0 || xx > w - 1 || yy > h - 1) {
        if (!clamp) { dst[o] = 0; dst[o + 1] = 0; dst[o + 2] = 0; continue; }
        xx = xx < 0 ? 0 : xx > w - 1 ? w - 1 : xx; yy = yy < 0 ? 0 : yy > h - 1 ? h - 1 : yy;
      }
      const x0 = xx | 0, y0 = yy | 0, x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0, fx = xx - x0, fy = yy - y0;
      const i00 = (y0 * w + x0) * 3, i10 = (y0 * w + x1) * 3, i01 = (y1 * w + x0) * 3, i11 = (y1 * w + x1) * 3;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      dst[o] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11 + 0.5;
      dst[o + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11 + 0.5;
      dst[o + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11 + 0.5;
    }
  }
}

module.exports = { ID, compose, invert, apply, decompose, fromParts, makeGray, pyramid, trackSimilarity, estimateGlobal, createGlobalEstimator, smoothPath, corrections, zoomFor, warpRGB };
