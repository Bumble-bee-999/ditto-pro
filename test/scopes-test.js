'use strict';
const SC = require('../src/scopes');
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
const frame = (w, h, f) => { const a = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = f(x, y), i = (y * w + x) * 4; a[i] = c[0]; a[i + 1] = c[1]; a[i + 2] = c[2]; a[i + 3] = 255; } return a; };
const sum = (a) => a.reduce((s, v) => s + v, 0);

console.log('Histogram:');
{
  const A = SC.analyze(frame(64, 32, () => [10, 128, 250]), 64, 32);
  ok(A.hist.r[10] === 64 * 32 && A.hist.g[128] === 64 * 32 && A.hist.b[250] === 64 * 32, 'a flat colour puts every pixel in one bin per channel');
  const l = Math.round(0.2126 * 10 + 0.7152 * 128 + 0.0722 * 250);
  ok(A.hist.l[l] === 64 * 32, 'luma uses Rec. 709 weights (bin ' + l + ')');
  const B = SC.analyze(frame(100, 100, (x) => (x < 50 ? [0, 0, 0] : [255, 255, 255])), 100, 100);
  ok(B.hist.l[0] === 5000 && B.hist.l[255] === 5000 && sum(B.hist.l) === 10000, 'half black, half white: two spikes of equal size');
}
console.log('Waveform and RGB parade:');
{
  const W = 200, H = 80;
  const A = SC.analyze(frame(W, H, (x) => (x < 100 ? [0, 0, 0] : [255, 255, 255])), W, H, { cols: 100 });
  const col = (arr, c) => arr.slice(c * 256, c * 256 + 256);
  const per = A.wave.rows * (W / 100);
  ok(col(A.wave.l, 10)[0] === per && sum(col(A.wave.l, 10)) === per, 'a black column has all its samples at level 0');
  ok(col(A.wave.l, 90)[255] === per, 'a white column has all its samples at level 255');
  const P = SC.analyze(frame(W, H, (x, y) => [255, Math.round(y / H * 255), 0]), W, H, { cols: 50 });
  const per2 = P.wave.rows * (W / 50);
  ok(col(P.wave.r, 3)[255] === per2 && col(P.wave.b, 3)[0] === per2, 'parade: pure red shows at 255 in R and 0 in B');
  const g = col(P.wave.g, 3); let spread = 0; for (let i = 0; i < 256; i++) if (g[i]) spread++;
  ok(spread > 60, 'parade: a green ramp is spread over many levels (' + spread + ')');
}
console.log('Vectorscope:');
{
  const pt = (c) => SC.vecPoint(c[0], c[1], c[2], 256);
  const red = pt([255, 0, 0]), blue = pt([0, 0, 255]), yel = pt([255, 255, 0]), grey = pt([128, 128, 128]);
  ok(Math.abs(grey.x - 127.5) < 0.6 && Math.abs(grey.y - 127.5) < 0.6, 'grey sits in the centre of the scope');
  ok(red.y < 5 && red.x < 127, 'red is at the top, a little left of centre (Cr = +0.5, Cb < 0)');
  ok(blue.x > 250 && blue.y > 127, 'blue is at the far right, below the centre line');
  ok(yel.x < 5 && yel.y < 127 && yel.y > 100, 'yellow is at the far left, just above the centre line');
  const A = SC.analyze(frame(40, 40, () => [255, 0, 0]), 40, 40);
  const rp = SC.vecPoint(255, 0, 0, 256);
  ok(A.vec.d[Math.round(rp.y) * 256 + Math.round(rp.x)] === 1600 && sum(A.vec.d) === 1600, 'every pixel of a red frame lands on the red point');
  const G = SC.analyze(frame(40, 40, () => [90, 90, 90]), 40, 40);
  ok(G.vec.d[128 * 256 + 128] + G.vec.d[127 * 256 + 127] + G.vec.d[127 * 256 + 128] + G.vec.d[128 * 256 + 127] === 1600, 'a grey frame stays at the centre');
}
console.log('Sampling and auto tone:');
{
  const big = frame(2000, 1200, (x) => [x % 256, 100, 100]);
  const t0 = Date.now(); const A = SC.analyze(big, 2000, 1200); const ms = Date.now() - t0;
  ok(A.count < 160000 && A.step >= 4, 'a 2000x1200 frame is sampled on a grid (' + A.count + ' pixels, step ' + A.step + ')');
  ok(ms < 400, 'and analysed quickly (' + ms + ' ms)');
  const flat = frame(100, 100, (x, y) => { const v = 90 + Math.round(60 * (x / 100)); return [v, v, v]; });
  const T = SC.autoTone(SC.analyze(flat, 100, 100).hist.l);
  ok(T.blacks < -30 && T.whites > 30, 'a flat, low-contrast image: auto tone crushes the raised blacks (−) and lifts the whites (+): blacks ' + T.blacks + ', whites ' + T.whites);
}
process.exit(failed ? 1 : 0);
