/* Colour grade: the maths, hostile input, and — against a real FFmpeg — that the baked LUT does what the function says. */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const DG = require('../src/grade');
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
const near = (a, b, e) => Math.abs(a - b) <= (e == null ? 1e-6 : e);
const G = (o) => Object.assign(DG.fresh(), o);

console.log('Neutral and monotonic behaviour:');
ok(!DG.active(null) && !DG.active(DG.fresh()) && DG.makeFn(DG.fresh()) === null, 'a neutral grade is inactive (nothing is baked or filtered)');
{
  const c = G({ curves: { m: [[0, 0], [1, 1]], r: null, g: null, b: null } });
  ok(!DG.active(c), 'a straight-line curve counts as neutral');
}
{
  const grey = [0.5, 0.5, 0.5];
  const up = DG.apply(G({ exposure: 50 }), grey), dn = DG.apply(G({ exposure: -50 }), grey);
  ok(up[0] > 0.5 && dn[0] < 0.5 && near(up[0], up[1]) && near(up[1], up[2]), 'exposure brightens / darkens and keeps grey grey');
  const stop = DG.apply(G({ exposure: 50 }), [0.2, 0.2, 0.2])[0];   // +1 stop in linear light
  const lin = (c) => Math.pow((c + 0.055) / 1.055, 2.4);
  ok(near(lin(stop) / lin(0.2), 2, 0.01), '+50 on the slider is exactly one stop in linear light (' + (lin(stop) / lin(0.2)).toFixed(3) + '×)');
  const w = DG.apply(G({ temp: 60 }), grey), c = DG.apply(G({ temp: -60 }), grey);
  ok(w[0] > w[2] && c[2] > c[0], 'temperature: positive is warm (red up, blue down), negative is cool');
  const m = DG.apply(G({ tint: 60 }), grey);
  ok(m[1] < m[0] && m[1] < m[2], 'tint: positive is magenta (green down)');
  const hl = DG.apply(G({ highlights: -80 }), [0.9, 0.9, 0.9])[0], hd = DG.apply(G({ highlights: -80 }), [0.1, 0.1, 0.1])[0];
  ok(hl < 0.9 - 0.1 && near(hd, 0.1, 0.03), 'highlights −80 pulls bright areas down and leaves dark areas alone (' + hl.toFixed(2) + ', ' + hd.toFixed(2) + ')');
  const sl = DG.apply(G({ shadows: 80 }), [0.1, 0.1, 0.1])[0], sh = DG.apply(G({ shadows: 80 }), [0.9, 0.9, 0.9])[0];
  ok(sl > 0.15 && near(sh, 0.9, 0.02), 'shadows +80 lifts dark areas and leaves bright areas alone');
  ok(DG.apply(G({ whites: 100 }), [0.75, 0.75, 0.75])[0] >= 0.99, 'whites +100 moves the white point down to 75%');
  ok(DG.apply(G({ blacks: 100 }), [0, 0, 0])[0] > 0.09 && DG.apply(G({ blacks: -100 }), [0.1, 0.1, 0.1])[0] < 0.01, 'blacks lift (+) or crush (−) the dark end');
  const sat = (v) => Math.max(...v) - Math.min(...v);
  const lowS = [0.55, 0.5, 0.45], hiS = [0.9, 0.5, 0.1];
  const gLow = sat(DG.apply(G({ vibrance: 80 }), lowS)) / sat(lowS), gHi = sat(DG.apply(G({ vibrance: 80 }), hiS)) / sat(hiS);
  ok(gLow > gHi && gLow > 1.4 && gHi >= 0.99, 'vibrance boosts muted colours more than saturated ones (×' + gLow.toFixed(2) + ' vs ×' + gHi.toFixed(2) + ')');
  const wh = G({ wheels: { sh: { h: 0, s: 100, l: 0 }, mid: { h: 0, s: 0, l: 0 }, hi: { h: 0, s: 0, l: 0 } } });
  const s0 = DG.apply(wh, [0.1, 0.1, 0.1]), s1 = DG.apply(wh, [0.9, 0.9, 0.9]);
  ok(s0[0] - s0[1] > 0.1 && near(s1[0], 0.9, 0.01), 'a red shadow wheel tints dark areas and leaves highlights alone');
}

console.log('Curves:');
{
  const f = DG.curveFn([[0, 0], [0.5, 0.7], [1, 1]]);
  ok(near(f(0.5), 0.7, 1e-9) && near(f(0), 0) && near(f(1), 1), 'a curve passes exactly through its points');
  let mono = true, prev = -1;
  for (let i = 0; i <= 200; i++) { const v = f(i / 200); if (v < prev - 1e-12) mono = false; prev = v; }
  ok(mono, 'the curve never goes backwards (monotone spline: no overshoot or inversion)');
  const g = DG.curveFn([[0.2, 0.1], [0.8, 0.9]]);
  ok(near(g(0), 0.1) && near(g(1), 0.9) && g(0.5) > 0.4 && g(0.5) < 0.6, 'a curve with no end points holds its first / last value flat');
  const m = DG.apply(G({ curves: { m: [[0, 0], [0.5, 0.7], [1, 1]], r: null, g: null, b: null } }), [0.5, 0.5, 0.5]);
  const r = DG.apply(G({ curves: { m: null, r: [[0, 0], [0.5, 0.7], [1, 1]], g: null, b: null } }), [0.5, 0.5, 0.5]);
  ok(near(m[0], 0.7, 1e-9) && near(m[2], 0.7, 1e-9), 'master curve moves all channels');
  ok(near(r[0], 0.7, 1e-9) && near(r[1], 0.5, 1e-9), 'the red curve moves only red');
}

console.log('Hostile and broken input:');
{
  const n = DG.normalize({ exposure: 'x', temp: Infinity, tint: NaN, highlights: 1e9, shadows: -1e9, curves: { m: [[NaN, 1], [0.5, 'a'], 'x', [2, -3], [0.5, 0.5], [0.5001, 0.9]], r: 'junk', g: { length: 5 } }, wheels: { sh: { h: -30, s: 500, l: 'q' } }, __proto__: { evil: 1 } });
  ok(n.exposure === 0 && n.temp === 0 && n.tint === 0 && n.highlights === 100 && n.shadows === -100, 'bad numbers fall back to 0 and out-of-range values are clamped');
  ok(Array.isArray(n.curves.m) && n.curves.m.every((p) => p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1) && n.curves.r === null && n.curves.g === null, 'curve points are cleaned (NaN / strings dropped, clamped to 0..1); non-lists are ignored');
  ok(n.wheels.sh.h === 330 && n.wheels.sh.s === 100 && n.wheels.sh.l === 0 && !('evil' in n), 'wheels are wrapped and clamped; unknown keys never get through');
  const many = DG.normalize({ curves: { m: Array.from({ length: 5000 }, (_, i) => [i / 5000, 0.5]) } });
  ok(many.curves.m.length <= 32, 'a curve with thousands of points is capped');
  const f = DG.makeFn(DG.normalize({ exposure: 100, highlights: 100, vibrance: 100, curves: { m: [[0.5, 0.5]] } }));
  const v = f([1, 0, 0.5]);
  ok(v.every((x) => x >= 0 && x <= 1 && Number.isFinite(x)), 'extreme settings still produce colours inside 0..1');
}

console.log('Baked LUT:');
{
  const c = G({ exposure: 20, temp: 15, shadows: 30, vibrance: 25, curves: { m: [[0, 0], [0.3, 0.25], [1, 1]], r: null, g: null, b: null } });
  const N = 17, d = DG.sampleCube(c, N), px = DG.texturePixels(c, N), f = DG.makeFn(c);
  const at = (r, g, b) => ((b * N + g) * N + r) * 3;
  const want = f([5 / 16, 9 / 16, 13 / 16]);
  ok(near(d[at(5, 9, 13)], want[0], 1e-6) && near(d[at(5, 9, 13)+1], want[1], 1e-6) && near(d[at(5, 9, 13)+2], want[2], 1e-6), 'a LUT sample equals the function at that point');
  const t = (9 * N * N + 13 * N + 5) * 4;
  ok(px[t] === Math.round(want[0] * 255) && px[t + 1] === Math.round(want[1] * 255) && px[t + 3] === 255, 'the preview texture uses the layout the compositor expects (x = r + b·N, y = g)');
  const txt = DG.cubeText(c, 5).split('\n');
  ok(txt[1] === 'LUT_3D_SIZE 5' && txt.filter((l) => /^[\d.]+ [\d.]+ [\d.]+$/.test(l)).length === 125, 'the .cube text has 5³ = 125 entries');
  const { parseCube } = require('../src/lut');
  ok(parseCube(DG.cubeText(c, 9)).size === 9, 'our own .cube parser accepts it');
}

console.log('Against a real FFmpeg (lut3d reading the baked file):');
{
  const F = require('ffmpeg-static');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-grade-'));
  const grades = {
    'exposure + warm + shadows': G({ exposure: 25, temp: 30, shadows: 40 }),
    'curve + vibrance': G({ vibrance: 60, curves: { m: [[0, 0.05], [0.4, 0.3], [1, 0.95]], r: null, g: null, b: null } }),
    'wheels + blacks/whites': G({ blacks: -30, whites: 40, wheels: { sh: { h: 220, s: 60, l: -10 }, mid: { h: 40, s: 30, l: 0 }, hi: { h: 30, s: 50, l: 10 } } })
  };
  // a test card: 16 x 16 grid of colours covering the cube
  const W = 16, H = 16, raw = Buffer.alloc(W * H * 3);
  const cols = [];
  for (let i = 0; i < W * H; i++) { const r = ((i * 37) % 256), g = ((i * 91 + 17) % 256), b = ((i * 53 + 101) % 256); raw[i * 3] = r; raw[i * 3 + 1] = g; raw[i * 3 + 2] = b; cols.push([r, g, b]); }
  fs.writeFileSync(path.join(tmp, 'in.raw'), raw);
  for (const [name, c] of Object.entries(grades)) {
    fs.writeFileSync(path.join(tmp, 'g.cube'), DG.cubeText(c, 33));
    const r = spawnSync(F, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', W + 'x' + H, '-i', 'in.raw', '-vf', 'lut3d=file=g.cube:interp=trilinear', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'out.raw'], { cwd: tmp });
    if (r.status) { ok(false, name + ': ffmpeg failed ' + String(r.stderr)); continue; }
    const out = fs.readFileSync(path.join(tmp, 'out.raw'));
    const f = DG.makeFn(c);
    let worst = 0, sum = 0;
    cols.forEach((p, i) => { const e = f(p.map((v) => v / 255)); for (let k = 0; k < 3; k++) { const d = Math.abs(out[i * 3 + k] - e[k] * 255); worst = Math.max(worst, d); sum += d; } });
    ok(worst <= 4 && sum / (cols.length * 3) < 1.2, name + ': FFmpeg output matches the function (worst ' + worst.toFixed(1) + ' / 255, mean ' + (sum / (cols.length * 3)).toFixed(2) + ')');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
