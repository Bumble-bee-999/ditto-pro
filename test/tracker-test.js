/* Motion tracker and subject finder on synthetic footage whose true motion we know. */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const F = require('ffmpeg-static');
const { trackPoint, analyzeSubject, simplify } = require('../src/tracker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-trk-'));
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
const W = 640, H = 360, FPS = 30;
// a textured 90x90 patch travels over a noisy still background: x = 120 + 90 t, y = 140 + 40 sin(1.5 t)
const bg = path.join(tmp, 'bg.png');
spawnSync(F, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}`, '-vf', 'noise=alls=25:allf=u,eq=brightness=-0.15', '-frames:v', '1', bg]);
const vid = path.join(tmp, 'move.mp4');
const patch = path.join(tmp, 'patch.png');
spawnSync(F, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=90x90', '-vf', 'noise=alls=18:allf=u', '-frames:v', '1', patch]);
let r = spawnSync(F, ['-y', '-v', 'error', '-loop', '1', '-framerate', '30', '-i', bg, '-loop', '1', '-framerate', '30', '-i', patch, '-filter_complex',
  "[1:v]format=rgb24[p];[0:v][p]overlay=x='120+90*t':y='140+40*sin(1.5*t)':shortest=1", '-t', '4', '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', vid], { encoding: 'utf8' });
if (r.status) throw new Error(r.stderr);
const truth = (t) => ({ x: (120 + 90 * t + 45) / W, y: (140 + 40 * Math.sin(1.5 * t) + 45) / H });

(async () => {
  console.log('Point tracker:');
  const t0 = truth(0);
  const res = await trackPoint(F, { file: vid, from: 0, span: 4, fps: FPS, w: W, h: H, pointT: 0, x: t0.x, y: t0.y, size: 0.07, direction: 'forward' }, null);
  let worst = 0, sum = 0, n = 0, lost = 0;
  res.samples.forEach((s) => { const tr = truth(s.t); const e = Math.hypot((s.x - tr.x) * W, (s.y - tr.y) * H); worst = Math.max(worst, e); sum += e; n++; if (!s.ok) lost++; });
  ok(res.samples.length >= 115, 'one position per frame (' + res.samples.length + ')');
  ok(worst < 4, 'stays on the object for the whole shot (worst error ' + worst.toFixed(2) + ' px of ' + W + ', mean ' + (sum / n).toFixed(2) + ')');
  ok(lost === 0, 'never reports the object lost');
  // start in the middle, track both ways
  const mid = truth(2);
  const both = await trackPoint(F, { file: vid, from: 0, span: 4, fps: FPS, w: W, h: H, pointT: 2, x: mid.x, y: mid.y, size: 0.07, direction: 'both' }, null);
  let w2 = 0; both.samples.forEach((s) => { const tr = truth(s.t); w2 = Math.max(w2, Math.hypot((s.x - tr.x) * W, (s.y - tr.y) * H)); });
  ok(both.samples.length >= 115 && w2 < 4, 'tracks forward and backward from the middle (' + both.samples.length + ' frames, worst ' + w2.toFixed(2) + ' px)');
  const slim = simplify(res.samples, 0.004);
  let dev = 0; res.samples.forEach((s) => { let a = slim[0], b = slim[slim.length - 1]; for (let i = 0; i < slim.length - 1; i++) if (s.t >= slim[i].t && s.t <= slim[i + 1].t) { a = slim[i]; b = slim[i + 1]; } const u = (s.t - a.t) / ((b.t - a.t) || 1); dev = Math.max(dev, Math.abs(a.x + (b.x - a.x) * u - s.x) * W, Math.abs(a.y + (b.y - a.y) * u - s.y) * H); });
  ok(slim.length < res.samples.length / 3 && dev < 3, 'path thins to ' + slim.length + ' keyframes within ' + dev.toFixed(1) + ' px');
  // a point on plain background that never moves must stay put
  const still = await trackPoint(F, { file: vid, from: 0, span: 2, fps: FPS, w: W, h: H, pointT: 0, x: 0.8, y: 0.8, size: 0.07, direction: 'forward' }, null);
  const drift = Math.max.apply(null, still.samples.map((s) => Math.hypot((s.x - 0.8) * W, (s.y - 0.8) * H)));
  ok(drift < 2, 'a fixed point stays fixed (drift ' + drift.toFixed(2) + ' px)');

  console.log('Subject finder:');
  const sub = await analyzeSubject(F, { file: vid, from: 0, span: 4, fps: 8, w: W, h: H, smooth: 0.5 }, null);
  const first = sub.path[2], last = sub.path[sub.path.length - 2];
  ok(sub.path.length >= 30 && last.x > first.x + 0.35, 'the centre of interest follows the mover left to right (' + first.x.toFixed(2) + ' → ' + last.x.toFixed(2) + ')');
  const mm = sub.path[Math.floor(sub.path.length / 2)], tm = truth(mm.t);
  ok(Math.abs(mm.x - tm.x) < 0.12, 'and sits near it (' + mm.x.toFixed(2) + ' vs ' + tm.x.toFixed(2) + ')');
  // a locked-off shot with nothing moving: stays near where it started, no wild swings
  const calm = path.join(tmp, 'calm.mp4');
  spawnSync(F, ['-y', '-v', 'error', '-loop', '1', '-framerate', '30', '-i', bg, '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', calm]);
  const cs = await analyzeSubject(F, { file: calm, from: 0, span: 3, fps: 8, w: W, h: H }, null);
  const span = Math.max.apply(null, cs.path.map((p) => p.x)) - Math.min.apply(null, cs.path.map((p) => p.x));
  ok(span < 0.05 && cs.confidence < 0.3, 'nothing moving: no wandering (range ' + span.toFixed(3) + ', confidence ' + cs.confidence.toFixed(2) + ')');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
