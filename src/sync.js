'use strict';
/* Ditto Pro — audio synchronisation for multi-camera editing (GCC-PHAT cross-correlation). Pure Node + FFmpeg. */
const { spawn } = require('child_process');

const RATE = 8000;

function readMono(ffmpeg, file, from, maxSec) {
  return new Promise((resolve, reject) => {
    const a = ['-v', 'error', '-nostdin'];
    if (from > 0) a.push('-ss', String(from));
    a.push('-i', file, '-vn', '-t', String(maxSec), '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1');
    const p = spawn(ffmpeg, a, { windowsHide: true });
    const chunks = []; let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.slice(-300) || 'ffmpeg failed'));
      const b = Buffer.concat(chunks);
      const out = new Float32Array(b.length >> 2);
      for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
      resolve(out);
    });
  });
}

// in-place iterative radix-2 FFT with a precomputed twiddle table
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  const cosT = new Float64Array(n >> 1), sinT = new Float64Array(n >> 1);
  for (let k = 0; k < n >> 1; k++) { const a = 2 * Math.PI * k / n * (inverse ? 1 : -1); cosT[k] = Math.cos(a); sinT[k] = Math.sin(a); }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cosT[k * step], wi = sinT[k * step];
        const a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/**
 * How much later (seconds) the same sound occurs in `b` than in `a`.
 * Positive = b's recording started earlier / its content is delayed relative to a's.
 */
function lagBetween(a, b, maxLagSec) {
  let n = 1; while (n < a.length + b.length) n <<= 1;
  const xr = new Float64Array(n), xi = new Float64Array(n), yr = new Float64Array(n), yi = new Float64Array(n);
  const norm = (src, dst) => { let m = 0; for (let i = 0; i < src.length; i++) m += src[i]; m /= src.length || 1; for (let i = 0; i < src.length; i++) dst[i] = src[i] - m; };
  norm(a, xr); norm(b, yr);
  fft(xr, xi, false); fft(yr, yi, false);
  for (let i = 0; i < n; i++) { // PHAT-weighted cross spectrum  X * conj(Y)
    const re = xr[i] * yr[i] + xi[i] * yi[i], im = xi[i] * yr[i] - xr[i] * yi[i];
    const mag = Math.hypot(re, im) + 1e-9;
    xr[i] = re / mag; xi[i] = im / mag;
  }
  fft(xr, xi, true);
  const maxLag = Math.min(Math.floor((maxLagSec || 60) * RATE), (n >> 1) - 1);
  let best = -Infinity, bi = 0, sum = 0, cnt = 0;
  for (let k = -maxLag; k <= maxLag; k++) {
    const v = xr[(k + n) % n];
    sum += Math.abs(v); cnt++;
    if (v > best) { best = v; bi = k; }
  }
  return { lag: -bi / RATE, confidence: best / ((sum / cnt) + 1e-12) };
}

/**
 * items: [{ file, from }] — returns offsets[i] = lag of item i relative to item 0 (seconds, in source time) with a confidence ratio.
 */
async function syncFiles(ffmpeg, items, o) {
  o = o || {};
  const maxSec = o.maxSec || 90;
  const ref = await readMono(ffmpeg, items[0].file, items[0].from || 0, maxSec);
  const out = [{ lag: 0, confidence: Infinity }];
  for (let i = 1; i < items.length; i++) {
    const sig = await readMono(ffmpeg, items[i].file, items[i].from || 0, maxSec);
    out.push(lagBetween(ref, sig, o.maxLag || 60));
  }
  return out;
}

module.exports = { syncFiles, lagBetween, fft, readMono, RATE };
