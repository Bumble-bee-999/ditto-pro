/* Renders real files with the bundled FFmpeg to prove the exporter's filter graphs work. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const DS = require('../src/shared');
const { buildExport } = require('../src/exporter');

const FFMPEG = require('ffmpeg-static');
const FFPROBE = require('ffprobe-static').path;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-test-'));
let failed = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS ' : '  FAIL ') + msg); if (!cond) failed++; };
const run = (bin, args) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 28 });

// ---- sample media --------------------------------------------------------------
const vidA = path.join(tmp, 'a.mp4'), vidB = path.join(tmp, 'b.mp4'), aud = path.join(tmp, 'tone.wav'), img = path.join(tmp, 'pic.png'), ttl = path.join(tmp, 'title.png');
let r = run(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', vidA]);
if (r.status) throw new Error(r.stderr);
r = run(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'smptebars=s=480x270:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=880:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', vidB]);
if (r.status) throw new Error(r.stderr);
run(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=6', aud]);
run(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xff8800:s=300x300:d=1', '-frames:v', '1', img]);
// a title PNG: red box with transparent surroundings, 1920x1080
run(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xff0000:s=400x200,format=rgba', '-vf', 'pad=1920:1080:760:440:color=black@0', '-frames:v', '1', ttl]);

// ---- project -----------------------------------------------------------------------
const P = DS.newProject({ width: 1280, height: 720, fps: 30, name: 'test' });
P.media = [
  { id: 'mA', path: vidA, name: 'a.mp4', kind: 'video', duration: 4, hasAudio: true, w: 640, h: 360 },
  { id: 'mB', path: vidB, name: 'b.mp4', kind: 'video', duration: 4, hasAudio: true, w: 480, h: 270 },
  { id: 'mT', path: aud, name: 'tone.wav', kind: 'audio', duration: 6, hasAudio: true },
  { id: 'mI', path: img, name: 'pic.png', kind: 'image', duration: 5, hasAudio: false, w: 300, h: 300 }
];
const A = DS.newClip({ track: 'V1', media: 'mA', start: 0, in: 0, dur: 3 });
const B = DS.newClip({ track: 'V1', media: 'mB', start: 3, in: 0, dur: 3, tr: { type: 'dissolve', dur: 1 } });
B.fx.saturation = 150; B.fx.contrast = 10; B.fx.sepia = true;
const T = DS.newClip({ track: 'V2', type: 'title', start: 1, dur: 4 });
T.title = DS.newTitle('hello');
DS.addKeyframe(T, 'scale', 0, 50, 'ease'); DS.addKeyframe(T, 'scale', 2, 150, 'lin');
DS.addKeyframe(T, 'x', 0, -300, 'ease'); DS.addKeyframe(T, 'x', 3, 300, 'lin');
DS.addKeyframe(T, 'rot', 0, 0, 'lin'); DS.addKeyframe(T, 'rot', 4, 45, 'lin');
DS.addKeyframe(T, 'opacity', 0, 0, 'lin'); DS.addKeyframe(T, 'opacity', 1, 100, 'lin');
const I = DS.newClip({ track: 'V3', media: 'mI', start: 2, in: 0, dur: 2, fadeIn: 0.3, fadeOut: 0.3, tr: { type: 'slide-left', dur: 0.5 } });
I.tf.scale = 40; I.tf.opacity = 80;
const ADJ = DS.newClip({ track: 'V3', type: 'adjust', start: 4.5, dur: 1 }); ADJ.fx.blur = 4; ADJ.fx.brightness = 20;
const AU = DS.newClip({ track: 'A1', media: 'mT', start: 0.5, in: 1, dur: 4, speed: 1.5, vol: -6, fadeIn: 0.5, fadeOut: 0.5 });
P.clips = [A, B, T, I, ADJ, AU];

function render(name, o, envExtra) {
  const out = path.join(tmp, name);
  const script = path.join(tmp, name + '.filter.txt');
  const b = buildExport(P, Object.assign({ outPath: out, scriptPath: script, newFilterFlag: false }, o), Object.assign({ titleFiles: { [T.id]: ttl } }, envExtra));
  fs.writeFileSync(script, b.script);
  const t0 = Date.now();
  const res = spawnSync(FFMPEG, b.args, { encoding: 'utf8', maxBuffer: 1 << 28, cwd: tmp });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (res.status !== 0) {
    console.log('--- ffmpeg stderr ---\n' + res.stderr.slice(-2500) + '\n--- graph ---\n' + b.script);
  }
  return { out, status: res.status, dt, b };
}
const probe = (f) => JSON.parse(run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f]).stdout || '{}');
const frameStats = (f, t) => {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 });
  const raw = r.stdout || Buffer.alloc(0);
  const px = raw.length / 3;
  const s = [0, 0, 0];
  for (let i = 0; i < raw.length; i++) s[i % 3] += raw[i];
  return { r: s[0] / px, g: s[1] / px, b: s[2] / px, n: px };
};

console.log('H.264 MP4, full timeline (video+audio, keyframes, transitions, adjustment layer):');
const mp4 = render('out.mp4', { format: 'mp4-h264', quality: 60 });
ok(mp4.status === 0, 'ffmpeg exited 0 in ' + mp4.dt + 's');
if (mp4.status === 0) {
  const pr = probe(mp4.out);
  const v = pr.streams.find((s) => s.codec_type === 'video'), a = pr.streams.find((s) => s.codec_type === 'audio');
  ok(v && v.codec_name === 'h264' && v.width === 1280 && v.height === 720, 'video is h264 1280x720');
  ok(a && a.codec_name === 'aac', 'audio is AAC');
  ok(Math.abs(parseFloat(pr.format.duration) - 6) < 0.15, 'duration ≈ 6s (got ' + pr.format.duration + ')');
  const t1 = frameStats(mp4.out, 0.5), t2 = frameStats(mp4.out, 3.5), t3 = frameStats(mp4.out, 5.3);
  ok(t1.n > 0 && (t1.r + t1.g + t1.b) > 30, 'frame at 0.5s is not black');
  ok(t2.n > 0 && (t2.r + t2.g + t2.b) > 30, 'frame at 3.5s (mid-dissolve) is not black');
  ok(t3.n > 0, 'frame at 5.3s (adjustment layer region) decodes');
}

// the title must really be composited: same range rendered with and without it must differ
{
  console.log('Title / keyframe compositing:');
  const saved = P.clips;
  const withT = render('cmp_with.mp4', { format: 'mp4-h264', rangeStart: 2.8, rangeEnd: 3.2 });
  P.clips = saved.filter((c) => c.id !== T.id);
  const noT = render('cmp_without.mp4', { format: 'mp4-h264', rangeStart: 2.8, rangeEnd: 3.2 });
  P.clips = saved;
  const a = frameStats(withT.out, 0.2), b = frameStats(noT.out, 0.2);
  const diff = Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
  ok(withT.status === 0 && noT.status === 0 && diff > 6, 'title box visibly changes the frame at 3.0s (mean RGB diff ' + diff.toFixed(1) + ')');
  T.disabled = true;
  const offT = render('cmp_disabled.mp4', { format: 'mp4-h264', rangeStart: 2.8, rangeEnd: 3.2 });
  T.disabled = false;
  const dis = frameStats(offT.out, 0.2);
  const d2 = Math.abs(dis.r - b.r) + Math.abs(dis.g - b.g) + Math.abs(dis.b - b.b);
  ok(offT.status === 0 && d2 < 1.5, 'a disabled clip renders exactly like a deleted one (diff ' + d2.toFixed(2) + ')');
}

const others = [
  ['out.webm', { format: 'webm-vp9', quality: 30, rangeStart: 1, rangeEnd: 2.5 }],
  ['out.mov', { format: 'mov-prores', rangeStart: 1, rangeEnd: 2 }],
  ['out.mp4', { format: 'mp4-h265', quality: 50, rangeStart: 0, rangeEnd: 1.5 }, 'h265.mp4'],
  ['out.gif', { format: 'gif', rangeStart: 0, rangeEnd: 1.5, width: 320, height: 180 }],
  ['out.wav', { format: 'wav' }],
  ['out.mp3', { format: 'mp3', normalize: true, rangeStart: 0, rangeEnd: 3 }],
  ['out.m4a', { format: 'm4a', rangeStart: 0, rangeEnd: 2 }]
];
for (const [name, o, alias] of others) {
  console.log(o.format + ':');
  const r2 = render(alias || name, o);
  ok(r2.status === 0 && fs.existsSync(r2.out) && fs.statSync(r2.out).size > 500, 'rendered ' + (alias || name) + ' (' + (fs.existsSync(r2.out) ? fs.statSync(r2.out).size : 0) + ' bytes, ' + r2.dt + 's)');
}

console.log('PNG sequence:');
const seqDir = path.join(tmp, 'seq'); fs.mkdirSync(seqDir);
const rs = render('seq/f_%05d.png', { format: 'png-seq', rangeStart: 0, rangeEnd: 0.5 });
ok(rs.status === 0 && fs.readdirSync(seqDir).length >= 14, 'wrote ' + fs.readdirSync(seqDir).length + ' PNG frames');

console.log('Audio effects export:');
{
  const saved = AU.ae; AU.ae = Object.assign({}, DS.DEFAULT_AE, { hp: 100, low: 4, mid: -3, high: 3, pan: 30, comp: { on: true, thresh: -24, ratio: 3, attack: 10, release: 200, makeup: 2 } });
  const r3 = render('ae.wav', { format: 'wav' });
  AU.ae = saved;
  ok(r3.status === 0 && fs.existsSync(r3.out) && fs.statSync(r3.out).size > 1000, 'wav with EQ + compressor + pan renders');
  ok(/highpass/.test(r3.b.script) && /acompressor/.test(r3.b.script) && /pan=stereo/.test(r3.b.script), 'filter graph contains the audio effect chain');
}

console.log('LUT, crop, reverse, denoise:');
{
  const { parseCube } = require('../src/lut');
  // an inverting 3D LUT
  const N = 9; let cube = 'TITLE "invert"\nLUT_3D_SIZE ' + N + '\n';
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) cube += (1 - r / (N - 1)) + ' ' + (1 - g / (N - 1)) + ' ' + (1 - b / (N - 1)) + '\n';
  fs.writeFileSync(path.join(tmp, 'lut0.cube'), cube);
  const parsed = parseCube(cube);
  ok(parsed.size === N && parsed.data.length === N * N * N * 3 && parsed.title === 'invert', '.cube parser reads size, title and entries');
  let bad = false; try { parseCube('LUT_3D_SIZE 2\n0 0 0\n'); } catch (e) { bad = /expected/.test(e.message); }
  ok(bad, '.cube parser rejects truncated files');

  const saved = P.clips;
  const mk = (mut) => { const c = DS.newClip({ track: 'V1', media: 'mA', start: 0, in: 0, dur: 2 }); if (mut) mut(c); return c; };
  const R = (name, c, env) => { P.clips = [c]; const r5 = render(name, { format: 'mp4-h264', quality: 90, rangeStart: 0, rangeEnd: 2 }, env); return r5; };
  const base = R('n_base.mp4', mk());
  const lutC = mk((c) => { c.fx.lut = { path: '/x/invert.cube', name: 'invert.cube' }; });
  const withLut = R('n_lut.mp4', lutC, { lutFiles: { '/x/invert.cube': 'lut0.cube' } });
  const bs = frameStats(base.out, 0.5);
  const rgbF = (f, t) => spawnSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', 'scale=96:54', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 }).stdout;
  const A0 = rgbF(base.out, 0.5), A1 = rgbF(withLut.out, 0.5);
  let sum = 0; for (let i = 0; i < A0.length; i++) sum += Math.abs(A0[i] + A1[i] - 255);
  const err = sum / A0.length;
  ok(withLut.status === 0 && err < 14, 'inverting LUT really inverts every pixel (mean |orig + graded - 255| = ' + err.toFixed(1) + ')');

  const crop = R('n_crop.mp4', mk((c) => { c.fx.crop = { l: 50, t: 0, r: 0, b: 0 }; }));
  const cs = frameStats(crop.out, 0.5);
  ok(crop.status === 0 && Math.abs((cs.r + cs.g + cs.b) - (bs.r + bs.g + bs.b)) > 3, 'crop changes the picture and renders');

  const rev = R('n_rev.mp4', mk((c) => { c.reverse = true; }));
  ok(rev.status === 0, 'reverse renders (video + audio)');
  const rawF = (f, t) => spawnSync(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', 'scale=96:54', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 }).stdout;
  const dist = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };
  const dSame = dist(rawF(rev.out, 0.02), rawF(base.out, 1.9)), dDiff = dist(rawF(rev.out, 0.02), rawF(base.out, 0.02));
  ok(dSame < dDiff * 0.6, 'reversed clip starts on the original last frame (diff ' + dSame.toFixed(2) + ' vs ' + dDiff.toFixed(2) + ')');
  const pr = probe(rev.out); const aS = pr.streams.find((x) => x.codec_type === 'audio');
  ok(!!aS, 'reversed clip keeps an audio stream');

  P.clips = saved;
  const AU2 = DS.newClip({ track: 'A1', media: 'mT', start: 0, in: 0, dur: 2 }); AU2.ae = Object.assign({}, DS.DEFAULT_AE, { denoise: 12 });
  P.clips = [AU2];
  const dn = render('n_denoise.wav', { format: 'wav' });
  ok(dn.status === 0 && /afftdn/.test(dn.b.script), 'noise reduction (afftdn) renders');
  P.clips = saved;
}

console.log('Nested-sequence render (alpha) and re-use as media:');
{
  const saved = P.clips;
  const T2 = DS.newClip({ track: 'V1', type: 'title', start: 0, dur: 2 }); T2.title = DS.newTitle('x');
  P.clips = [T2];
  const nr = render('nest.mov', { format: 'nest-prores', rangeStart: 0, rangeEnd: 2 }, { titleFiles: { [T2.id]: ttl } });
  ok(nr.status === 0, 'nest render (ProRes 4444 + alpha) succeeded');
  const pr = probe(nr.out); const vs = pr.streams.find((x) => x.codec_type === 'video');
  ok(vs && vs.codec_name === 'prores' && /yuva/.test(vs.pix_fmt), 'nest file keeps an alpha channel (' + (vs && vs.pix_fmt) + ')');
  const rawA = (f, x, y) => { const r = spawnSync(FFMPEG, ['-v', 'error', '-ss', '0.5', '-i', f, '-frames:v', '1', '-vf', 'format=rgba', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 26 }).stdout; const o = (y * 1280 + x) * 4; return [r[o], r[o + 1], r[o + 2], r[o + 3]]; };
  const outside = rawA(nr.out, 40, 40), inside = rawA(nr.out, 640, 360);
  ok(outside[3] < 10 && inside[3] > 245 && inside[0] > 200, 'alpha is 0 outside the title and opaque inside (' + outside[3] + ' / ' + inside[3] + ')');
  // use the rendered nest as an ordinary media file on top of a coloured background
  P.media.push({ id: 'mN', path: nr.out, name: 'nest.mov', kind: 'video', duration: 2, hasAudio: true, w: 1280, h: 720 });
  const bg = DS.newClip({ track: 'V1', media: 'mI', start: 0, in: 0, dur: 2 }); bg.tf.scale = 500;
  const nc = DS.newClip({ track: 'V2', media: 'mN', start: 0, in: 0, dur: 2 });
  P.clips = [bg, nc];
  const par = render('nest_parent.mp4', { format: 'mp4-h264', quality: 90, rangeStart: 0, rangeEnd: 1.5 });
  ok(par.status === 0, 'parent project using the nest renders');
  const rgb = (f, x, y) => { const r = spawnSync(FFMPEG, ['-v', 'error', '-ss', '0.5', '-i', f, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 }).stdout; const o = (y * 1280 + x) * 3; return [r[o], r[o + 1], r[o + 2]]; };
  const o2 = rgb(par.out, 40, 40), i2 = rgb(par.out, 640, 360);
  ok(o2[0] > 200 && o2[1] > 100 && o2[2] < 80, 'transparent part of the nest shows the background beneath (orange ' + o2 + ')');
  ok(i2[0] > 200 && i2[1] < 60 && i2[2] < 60, 'opaque part of the nest covers it (red ' + i2 + ')');
  P.clips = saved; P.media.pop();
}

console.log('Error handling:');
let threw = false;
try { buildExport(DS.newProject(), { format: 'mp4-h264' }, {}); } catch (e) { threw = /empty/i.test(e.message); }
ok(threw, 'empty timeline gives a clear error');

console.log(failed ? '\n' + failed + ' check(s) FAILED. Temp dir: ' + tmp : '\nAll checks passed. Temp dir: ' + tmp);
process.exit(failed ? 1 : 0);
