'use strict';
/* Builds deliberately shaky clips (with FFmpeg, independently of our own warp code), stabilises them with the real
   engine, and measures that the picture really holds still: mean frame-to-frame difference vs. a locked-off reference. */
const fs = require('fs'), os = require('os'), path = require('path');
const F = require('ffmpeg-static');
const { spawnSync } = require('child_process');
const { stabilize } = require('../src/stabilize');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-stab-'));
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
const run = (args) => { const r = spawnSync(F, args, { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr.slice(-400)); return r; };

function jitter(file, w, h) {
  const r = spawnSync(F, ['-v', 'error', '-i', file, '-vf', 'scale=' + w + ':' + h + ',format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 29 });
  const fsz = w * h, buf = r.stdout, n = Math.floor(buf.length / fsz);
  let tot = 0, cnt = 0;
  for (let i = 4; i < n - 4; i++) { let s = 0; for (let k = 0; k < fsz; k += 3) s += Math.abs(buf[i * fsz + k] - buf[(i - 1) * fsz + k]); tot += s / (fsz / 3); cnt++; }
  return tot / Math.max(1, cnt);
}
(async () => {
  console.log('Stabilisation:');
  const still = path.join(tmp, 'still.png');
  run(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=800x500:d=1', '-vf', 'noise=alls=30:allf=u,format=rgb24', '-frames:v', '1', still]);
  const mk = (name, vf, extra) => { const o = path.join(tmp, name); run(['-y', '-v', 'error', '-loop', '1', '-framerate', '30', '-i', still].concat(extra || [], ['-t', '4', '-vf', vf, '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', '-g', '30', o])); return o; };
  const locked = mk('locked.mp4', 'crop=720:420:40:40');
  const shaky = mk('shaky.mp4', "crop=720:420:x='40+14*sin(2*PI*n/9)+9*sin(2*PI*n/4.3+1)':y='40+12*cos(2*PI*n/7)+7*sin(2*PI*n/3.1)'");
  // with a sound track so we can check it survives
  const withAudio = path.join(tmp, 'shaky-audio.mp4');
  run(['-y', '-v', 'error', '-i', shaky, '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-c:v', 'copy', '-c:a', 'aac', '-shortest', withAudio]);
  const floor = jitter(locked, 320, 186), before = jitter(shaky, 320, 186);

  const prog = [];
  const t0 = Date.now();
  const r = await stabilize(F, { file: withAudio, from: 0, span: 4, fps: 30, w: 720, h: 420, smoothness: 40, method: 'smooth', fill: 'zoom', outDir: path.join(tmp, 'cache') }, (p) => prog.push(p));
  const after = jitter(r.path, 320, 186);
  console.log('   frame-to-frame difference: locked-off ' + floor.toFixed(2) + ', shaky ' + before.toFixed(2) + ', stabilised ' + after.toFixed(2) + '  (' + (Date.now() - t0) + ' ms, zoom ' + r.zoom.toFixed(3) + ')');
  ok(before - floor > 2, 'the test clip really is shaky');
  ok((after - floor) < 0.2 * (before - floor), 'removes at least 80% of the camera shake');
  ok(prog.length > 5 && prog[prog.length - 1] === 1 && prog.every((v, i) => !i || v >= prog[i - 1] - 1e-9), 'progress rises monotonically to 100%');
  const info = spawnSync(F, ['-i', r.path], { encoding: 'utf8' }).stderr;
  ok(/720x420/.test(info) && /Duration: 00:00:0[34]/.test(info), 'keeps the frame size and the clip length');
  ok(/Audio: aac/.test(info), 'keeps the sound');
  ok(r.zoom > 1 && r.zoom < 1.3, 'zooms in just enough to hide the edges (' + r.zoom.toFixed(3) + ')');

  const again = await stabilize(F, { file: withAudio, from: 0, span: 4, fps: 30, w: 720, h: 420, smoothness: 40, method: 'smooth', fill: 'zoom', outDir: path.join(tmp, 'cache') });
  ok(again.cached && again.path === r.path, 'a repeat run reuses the cached file');
  const again2 = await stabilize(F, { file: withAudio, from: 0, span: 4, fps: 30, w: 720, h: 420, smoothness: 40, method: 'smooth', fill: 'zoom', outDir: path.join(tmp, 'cache2') });
  ok(Math.abs(jitter(again2.path, 320, 186) - after) < 0.05, 'deterministic: a fresh run gives the same result');

  const lockedOut = await stabilize(F, { file: shaky, from: 0, span: 4, fps: 30, w: 720, h: 420, method: 'locked', fill: 'zoom', outDir: path.join(tmp, 'cache') });
  const lj = jitter(lockedOut.path, 320, 186);
  ok((lj - floor) < 0.12 * (before - floor), 'locked-off mode holds the picture still (' + lj.toFixed(2) + ')');

  // rotation shake: the camera also rolls a few degrees
  const roll = mk('roll.mp4', "rotate=a='(5*sin(2*PI*n/11)+3*sin(2*PI*n/5.3))*PI/180':ow=iw:oh=ih:c=black,crop=640:380:80:60,format=yuv420p");
  const rb = jitter(roll, 320, 190);
  const rlock = mk('roll-locked.mp4', 'crop=640:380:80:60');
  const rfloor = jitter(rlock, 320, 190);
  const rr = await stabilize(F, { file: roll, from: 0, span: 4, fps: 30, w: 640, h: 380, smoothness: 40, method: 'smooth', fill: 'zoom', outDir: path.join(tmp, 'cache') });
  const ra = jitter(rr.path, 320, 190);
  console.log('   rolling camera: locked-off ' + rfloor.toFixed(2) + ', shaky ' + rb.toFixed(2) + ', stabilised ' + ra.toFixed(2));
  ok((ra - rfloor) < 0.35 * (rb - rfloor), 'also removes most of a rolling (rotation) shake');

  const part = await stabilize(F, { file: shaky, from: 1, span: 2, fps: 30, w: 720, h: 420, smoothness: 40, method: 'smooth', fill: 'edges', outDir: path.join(tmp, 'cache') });
  const info2 = spawnSync(F, ['-i', part.path], { encoding: 'utf8' }).stderr;
  ok(/Duration: 00:00:0[12]/.test(info2), 'stabilises just the used part of a clip (edge-fill mode)');
  let msg = ''; try { await stabilize(F, { file: path.join(tmp, 'nope.mp4'), from: 0, span: 2, fps: 30, w: 720, h: 420, outDir: path.join(tmp, 'cache') }); } catch (e) { msg = e.message; }
  ok(/Could not read|Not enough/.test(msg), 'clear error for an unreadable file');
  console.log(failed ? '\n' + failed + ' check(s) FAILED' : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
