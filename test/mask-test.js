/* Shape masks: real FFmpeg renders, static and tracked, checked against the reference maths (DS.maskCover). */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const DS = require('../src/shared');
const { buildExport } = require('../src/exporter');
const FFMPEG = require('ffmpeg-static');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-mask-'));
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
const src = path.join(tmp, 'white.mp4');
spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xff8000:s=640x360:r=30:d=3', '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', src]);
const W = 640, H = 360;
function render(name, mask, dur) {
  const P = DS.newProject({ width: W, height: H, fps: 30, name: 'm' });
  P.media = [{ id: 'm', path: src, name: 'w.mp4', kind: 'video', duration: 3, hasAudio: false, w: 640, h: 360 }];
  const c = DS.newClip({ track: 'V1', media: 'm', start: 0, in: 0, dur: dur || 2 });
  c.fx.mask = mask; P.clips = [c];
  const out = path.join(tmp, name + '.mp4'), sc = path.join(tmp, name + '.txt');
  const b = buildExport(P, { outPath: out, scriptPath: sc, newFilterFlag: false, format: 'mp4-h264', quality: 95 }, {});
  fs.writeFileSync(sc, b.script);
  const r = spawnSync(FFMPEG, b.args, { encoding: 'utf8', cwd: tmp, maxBuffer: 1 << 28 });
  if (r.status) { console.log(r.stderr.slice(-1500)); return null; }
  return out;
}
// frame f of the render as RGB
function frame(file, f) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', 'select=eq(n\\,' + f + ')', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
  return r.stdout;
}
const px = (buf, x, y) => Array.from(buf.slice((y * W + x) * 3, (y * W + x) * 3 + 3));
const bright = (p) => (p[0] + p[1] + p[2]) / (255 + 128 + 0);          // 1 = the orange, 0 = black

console.log('Static ellipse, feathered:');
const m1 = { on: true, shape: 'ellipse', cx: 50, cy: 50, w: 50, h: 50, feather: 20, invert: false, path: null };
let f1 = render('ell', m1);
ok(!!f1, 'ffmpeg renders an ellipse mask');
if (f1) {
  const fr = frame(f1, 10);
  const pts = [[320, 180], [320, 100], [320, 40], [140, 180], [620, 340], [450, 180], [380, 180], [200, 180]];
  let worst = 0;
  pts.forEach(([x, y]) => { const want = DS.maskCover(m1, (x + .5) / W, (y + .5) / H, 0), got = bright(px(fr, x, y)); worst = Math.max(worst, Math.abs(want - got)); });
  ok(worst < 0.1, 'every sampled pixel matches the reference maths (worst difference ' + worst.toFixed(3) + ')');
  ok(bright(px(fr, 320, 180)) > 0.95 && bright(px(fr, 5, 5)) < 0.03, 'centre fully visible, corner fully hidden');
}
console.log('Rectangle and invert:');
const m2 = { on: true, shape: 'rect', cx: 30, cy: 50, w: 20, h: 40, feather: 0, invert: true, path: null };
const f2 = render('rect', m2);
if (f2) {
  const fr = frame(f2, 5);
  ok(bright(px(fr, 192, 180)) < 0.05 && bright(px(fr, 500, 180)) > 0.95, 'inverted rectangle: inside hidden, outside visible');
}
console.log('Tracked (moving) mask:');
const m3 = { on: true, shape: 'ellipse', cx: 20, cy: 50, w: 20, h: 30, feather: 5, invert: false, path: [{ t: 0, x: 20, y: 50 }, { t: 1, x: 80, y: 50 }, { t: 2, x: 80, y: 20 }] };
const f3 = render('trk', m3, 2);
ok(!!f3, 'ffmpeg renders a moving mask');
if (f3) {
  const early = frame(f3, 2), mid = frame(f3, 30), late = frame(f3, 58);
  const at = (t) => DS.maskCentre(m3, t);
  const chk = (fr, t, f) => { const c = at(t); const x = Math.round(c.cx / 100 * W), y = Math.round(c.cy / 100 * H); return bright(px(fr, x, y)) > 0.85 && bright(px(fr, W - x, H - y > 0 ? Math.min(H - 1, H - y) : 0)) < 0.2; };
  ok(chk(early, 2 / 30, 2), 'at 0.07 s the visible spot is at the left');
  ok(chk(mid, 1, 30), 'at 1 s it is at the right');
  ok(chk(late, 58 / 30, 58), 'at 1.9 s it has moved up');
}
process.exit(failed ? 1 : 0);
