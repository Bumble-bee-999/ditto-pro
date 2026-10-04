/* Speed ramps: the pieces must add up to one smooth, continuous picture in a real render. */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const DS = require('../src/shared');
const { buildExport } = require('../src/exporter');
const FFMPEG = require('ffmpeg-static');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-ramp-'));
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
const run = (args) => spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 1 << 28 });

// a clip whose brightness is its time: 0..255 over 8 s, with a tone
const src = path.join(tmp, 'ramp-src.mp4');
let r = run(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=64x64:r=30:d=8,geq=lum=\'255*T/8\':cb=128:cr=128', '-f', 'lavfi', '-i', 'sine=f=440:d=8', '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-shortest', src]);
if (r.status) throw new Error(r.stderr);

console.log('Segment maths:');
for (const curve of Object.keys(DS.RAMP_CURVES)) {
  const segs = DS.rampSegments({ srcIn: 0, srcLen: 8, fps: 30, from: 1, to: 4, curve });
  let cont = true, srcSum = 0, t = 0;
  segs.forEach((s, i) => { if (i && Math.abs(s.in - (segs[i - 1].in + segs[i - 1].span)) > 1e-6) cont = false; if (Math.abs(s.start - t) > 1e-6) cont = false; srcSum += s.span; t += s.dur; });
  ok(cont && Math.abs(srcSum - 8) < 1e-6, curve + ': ' + segs.length + ' pieces, continuous, covers the whole source (' + srcSum.toFixed(3) + ' s)');
  ok(segs.every((s) => s.speed >= 0.1 && s.speed <= 8) && Math.abs(segs[0].dur * 30 - Math.round(segs[0].dur * 30)) < 1e-6, curve + ': speeds in range, frame-aligned');
}
const lin = DS.rampSegments({ srcIn: 0, srcLen: 8, fps: 30, from: 1, to: 4, curve: 'linear' });
ok(lin[0].speed < lin[lin.length - 1].speed && lin[0].speed > 0.9 && lin[lin.length - 1].speed < 4.1, 'linear ramp accelerates from 1x to 4x');

console.log('Real render:');
const P = DS.newProject({ width: 128, height: 128, fps: 30, name: 'ramp' });
P.media = [{ id: 'm', path: src, name: 'ramp-src.mp4', kind: 'video', duration: 8, hasAudio: true, w: 64, h: 64 }];
const segs = DS.rampSegments({ srcIn: 0, srcLen: 8, fps: 30, from: 1, to: 3, curve: 'ease' });
const total = segs.reduce((a, s) => a + s.dur, 0);
const g = 'rg1';
P.clips = segs.map((s, i) => { const c = DS.newClip({ track: 'V1', media: 'm', start: s.start, in: s.in, dur: s.dur, speed: s.speed }); c.ramp = { g, i, n: segs.length, orig: { speed: 1 } }; return c; })
  .concat(segs.map((s, i) => { const c = DS.newClip({ track: 'A1', media: 'm', start: s.start, in: s.in, dur: s.dur, speed: s.speed }); c.ramp = { g, i, n: segs.length, orig: { speed: 1 } }; return c; }));
const out = path.join(tmp, 'out.mp4'), script = path.join(tmp, 'f.txt');
const b = buildExport(P, { outPath: out, scriptPath: script, newFilterFlag: false, format: 'mp4-h264', quality: 90 }, {});
fs.writeFileSync(script, b.script);
const res = spawnSync(FFMPEG, b.args, { encoding: 'utf8', maxBuffer: 1 << 28, cwd: tmp });
if (res.status) console.log(res.stderr.slice(-2000));
ok(res.status === 0 && fs.existsSync(out), 'ffmpeg renders the ramp (' + segs.length + ' pieces)');
// brightness of every output frame -> source time
const raw = spawnSync(FFMPEG, ['-v', 'error', '-i', out, '-vf', 'scale=4:4,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 }).stdout;
const nF = Math.floor(raw.length / 16);
const times = []; for (let f = 0; f < nF; f++) times.push(raw[f * 16 + 5] / 255 * 8);
ok(Math.abs(nF / 30 - total) < 0.1, 'output length ' + (nF / 30).toFixed(2) + ' s ≈ planned ' + total.toFixed(2) + ' s');
let maxJump = 0, back = 0; for (let i = 24; i < times.length; i++) { const d = times[i] - times[i - 1]; if (d < -0.05 && times[i] > 0.5) back++; maxJump = Math.max(maxJump, d); }
ok(back === 0, 'the picture never jumps backwards');
const refRaw = spawnSync(FFMPEG, ['-v', 'error', '-i', src, '-vf', 'scale=4:4,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 }).stdout;
const ref = (sec) => refRaw[Math.min(Math.floor(refRaw.length / 16) - 1, Math.max(0, Math.round(sec * 30))) * 16 + 5] / 255 * 8;   // how the source looks through the same measuring chain
const expect0 = (f) => { const t = f / 30; let sg = segs[0]; for (const x of segs) if (t >= x.start - 1e-6) sg = x; return Math.min(8, sg.in + (t - sg.start) * sg.speed); };
const expect = (f) => ref(expect0(f));
if (process.env.RAMP_DEBUG) console.log(times.map((t, f) => [f, Math.abs(t - expect(f))]).filter((x) => x[1] > 0.1).map((x) => x[0] + ':' + x[1].toFixed(2)).join(' '));
let worst = 0, worstF = 0, sum = 0; for (let f = 24; f < nF - 3; f++) { const e = Math.abs(times[f] - expect(f)); sum += e; if (e > worst) { worst = e; worstF = f; } }
ok(worst < 0.25, 'every frame shows the right moment of the source (worst error ' + worst.toFixed(2) + ' s at frame ' + worstF + ')');
ok(sum / (nF - 27) < 0.06, 'and on average within ' + (sum / (nF - 27)).toFixed(3) + ' s');
ok(times[times.length - 1] > 7.5 && times[0] < 0.3, 'covers the whole source (' + times[0].toFixed(2) + ' → ' + times[times.length - 1].toFixed(2) + ' s)');
const early = times[10] - times[0], late = times[times.length - 1] - times[times.length - 11];
ok(late > early * 1.8, 'later frames advance faster than early ones (' + early.toFixed(2) + ' vs ' + late.toFixed(2) + ' s per 10 frames)');
const pr = spawnSync(require('ffprobe-static').path, ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', out], { encoding: 'utf8' });
const st = JSON.parse(pr.stdout).streams, au = st.find((s) => s.codec_type === 'audio');
ok(au && Math.abs(parseFloat(au.duration) - total) < 0.15, 'audio present and as long as the picture (' + (au && au.duration) + ' s)');
process.exit(failed ? 1 : 0);
