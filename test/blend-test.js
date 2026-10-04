'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const F = require('ffmpeg-static');
const DS = require('../src/shared');
const { buildExport } = require('../src/exporter');
let fail = 0; const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
console.log('Blend modes (export vs the reference formulas):');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blend-'));
const W = 320, H = 180;
const mk = (name, hex) => { const f = path.join(tmp, name + '.mp4'); spawnSync(F, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x' + hex + ':s=' + W + 'x' + H + ':r=30:d=2', '-c:v', 'libx264', '-crf', '4', '-pix_fmt', 'yuv444p', f]); return f; };
const BASE = [0x90, 0x48, 0xc0], TOP = [0x40, 0xb0, 0x70];
const hex = (c) => c.map((v) => v.toString(16).padStart(2, '0')).join('');
const A = mk('base', hex(BASE)), B = mk('top', hex(TOP));
const frame = (out, n) => spawnSync(F, ['-v', 'error', '-i', out, '-vf', 'select=eq(n\\,' + n + ')', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 }).stdout;
const px = (buf, x, y) => [buf[(y * W + x) * 3], buf[(y * W + x) * 3 + 1], buf[(y * W + x) * 3 + 2]];
function render(mode, opacity, scale, extra) {
  const P = DS.newProject({ width: W, height: H, fps: 30, name: 'b' });
  P.media = [{ id: 'a', path: A, name: 'a', kind: 'video', duration: 2, hasAudio: false, w: W, h: H }, { id: 'b', path: B, name: 'b', kind: 'video', duration: 2, hasAudio: false, w: W, h: H }];
  const c1 = DS.newClip({ track: 'V1', media: 'a', start: 0, in: 0, dur: 2 });
  const c2 = DS.newClip({ track: 'V2', media: 'b', start: 0.5, in: 0, dur: 1 });
  c2.blend = mode; c2.tf.opacity = opacity; c2.tf.scale = scale;
  if (extra) extra(c2);
  P.clips = [c1, c2];
  const out = path.join(tmp, 'o_' + mode + opacity + scale + '.mp4');
  const b = buildExport(P, { outPath: out, scriptPath: path.join(tmp, 's.txt'), newFilterFlag: false, format: 'mp4-h264', quality: 100 }, {});
  fs.writeFileSync(path.join(tmp, 's.txt'), b.script);
  const r = spawnSync(F, b.args, { cwd: tmp });
  return { code: r.status, err: String(r.stderr).slice(-400), out };
}
const want = (mode, a) => BASE.map((bv, i) => { const b = bv / 255, s = TOP[i] / 255; return Math.round(255 * (b * (1 - a) + DS.blendPx(mode, b, s) * a)); });
const diff = (x, y) => Math.max.apply(null, x.map((v, i) => Math.abs(v - y[i])));
let worst = 0;
for (const mode of DS.BLEND_IDS.slice(1)) {
  for (const op of [100, 60]) {
    const r = render(mode, op, 100);
    if (r.code !== 0) { ok(false, mode + ' @' + op + '% renders: ' + r.err); continue; }
    const mid = px(frame(r.out, 30), 160, 90), w = want(mode, op / 100), d = diff(mid, w);
    worst = Math.max(worst, d);
    ok(d <= 4, mode + ' @' + op + '%: got ' + mid.join(',') + ' want ' + w.join(',') + ' (diff ' + d + ')');
    if (op === 100) {
      const before = px(frame(r.out, 5), 160, 90), after = px(frame(r.out, 50), 160, 90);
      ok(diff(before, BASE) <= 3 && diff(after, BASE) <= 3, mode + ': the picture beneath is untouched before and after the clip');
    }
  }
}
console.log('  worst colour difference ' + worst + ' / 255');
{
  const r = render('multiply', 100, 50);
  const f = frame(r.out, 30);
  ok(r.code === 0 && diff(px(f, 160, 90), want('multiply', 1)) <= 4 && diff(px(f, 20, 20), BASE) <= 3, 'a half-size clip blends only where it is (centre ' + px(f, 160, 90).join(',') + ', corner ' + px(f, 20, 20).join(',') + ')');
}
{
  const r = render('screen', 100, 100, (c) => { c.kf.opacity = [{ t: 0, v: 0, e: 'lin' }, { t: 1, v: 100, e: 'lin' }]; });
  const f = frame(r.out, 30);   // 0.5 s into the clip → opacity 50 %
  const w = want('screen', 0.5), d = diff(px(f, 160, 90), w);
  ok(r.code === 0 && d <= 6, 'keyframed opacity works with a blend mode (got ' + px(f, 160, 90).join(',') + ' want ' + w.join(',') + ')');
}
ok(DS.cleanBlend('multiply') === 'multiply' && DS.cleanBlend('x:enable=1') === 'normal' && DS.cleanBlend(null) === 'normal', 'unknown blend names fall back to normal');
{
  const r = render('nope;[x]', 100, 100);
  const mid = px(frame(r.out, 30), 160, 90);
  ok(r.code === 0 && diff(mid, TOP) <= 4, 'a hostile blend value is exported as a normal clip');
}
process.exit(fail ? 1 : 0);
