/* Creative effects and wipe transitions: real FFmpeg renders compared with the reference maths. */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const DS = require('../src/shared');
const { buildExport } = require('../src/exporter');
const FFMPEG = require('ffmpeg-static');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-fx-'));
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
const W = 320, H = 180;
// a smooth picture with a bright square and some colour
const src = path.join(tmp, 'src.mp4');
spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `nullsrc=s=${W}x${H}:r=30:d=3,format=rgb24,geq=r='40+150*X/W+40*sin(Y/9)':g='60+120*Y/H':b='200-120*X/W+30*cos(X/11)',drawbox=x=200:y=60:w=60:h=50:color=white:t=fill`, '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', src]);
const readFrame = (file, f) => spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', 'select=eq(n\\,' + f + ')', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 }).stdout;
function render(name, fx, extra) {
  const P = DS.newProject({ width: W, height: H, fps: 30, name: 'fx' });
  P.media = [{ id: 'm', path: src, name: 's.mp4', kind: 'video', duration: 3, hasAudio: false, w: W, h: H }];
  const c = DS.newClip({ track: 'V1', media: 'm', start: 0, in: 0, dur: 2 });
  Object.assign(c.fx, fx); P.clips = [c];
  if (extra) extra(P, c);
  const out = path.join(tmp, name + '.mp4'), sc = path.join(tmp, name + '.txt');
  const b = buildExport(P, { outPath: out, scriptPath: sc, newFilterFlag: false, format: 'mp4-h264', quality: 100 }, {});
  fs.writeFileSync(sc, b.script);
  const r = spawnSync(FFMPEG, b.args, { encoding: 'utf8', cwd: tmp, maxBuffer: 1 << 28 });
  if (r.status) { console.log(r.stderr.slice(-1500)); return null; }
  return out;
}
const base = readFrame(src, 10);
const luma = (b, i) => 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2];
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
function cmp(out, ref) { let s = 0, mx = 0; for (let i = 0; i < ref.length; i++) { const v = Math.abs(out[i] - ref[i]); s += v; if (v > mx) mx = v; } return { mean: s / ref.length, max: mx }; }

console.log('Invert / posterize / threshold (exact per-pixel maps):');
{
  const f = render('inv', { invert: true }); ok(!!f, 'invert renders');
  if (f) { const o = readFrame(f, 10), ref = Buffer.from(base.map((v) => 255 - v)); const e = cmp(o, ref); ok(e.mean < 2.5, 'invert matches 255 - v (mean error ' + e.mean.toFixed(2) + ')'); }
  const p = render('post', { posterize: 4 }); ok(!!p, 'posterize renders');
  if (p) { const o = readFrame(p, 10), ref = Buffer.from(base.map((v) => Math.round(v / 255 * 3) / 3 * 255)); const e = cmp(o, ref); let near4 = 0; for (let i = 0; i < o.length; i++) { const q = Math.round(o[i] / 85) * 85; if (Math.abs(o[i] - q) <= 14) near4++; } ok(e.mean < 22, 'posterize 4 levels: close to the reference (mean ' + e.mean.toFixed(1) + ' - level edges differ by YUV rounding)'); ok(near4 / o.length > 0.9, 'and ' + (100 * near4 / o.length).toFixed(0) + ' % of values sit on one of the 4 levels (the rest is encoder ringing)'); }
  const t = render('thr', { threshold: 50 }); ok(!!t, 'threshold renders');
  if (t) { const o = readFrame(t, 10); let bad = 0, n = 0; for (let i = 0; i < W * H; i++) { const y = luma(base, i * 3) / 255; if (Math.abs(y - 0.5) < 0.04) continue; n++; const v = o[i * 3] > 127 ? 1 : 0; if (v !== (y >= 0.5 ? 1 : 0)) bad++; } ok(bad / n < 0.01, 'threshold 50: ' + (100 * bad / n).toFixed(2) + ' % of pixels on the wrong side'); }
}
console.log('Mosaic, emboss, edges:');
{
  const m = render('mos', { mosaic: 20 }); ok(!!m, 'mosaic renders');
  if (m) { const o = readFrame(m, 10); let blocksFlat = 0, blocks = 0; for (let by = 0; by + 20 <= H; by += 20) for (let bx = 0; bx + 20 <= W; bx += 20) { blocks++; let flat = true; const i0 = (by * W + bx) * 3; for (let y = 0; y < 20 && flat; y++) for (let x = 0; x < 20; x++) { const i = ((by + y) * W + bx + x) * 3; if (Math.abs(o[i] - o[i0]) > 6) { flat = false; break; } } if (flat) blocksFlat++; } ok(blocksFlat / blocks > 0.9, 'every 20x20 block is one colour (' + blocksFlat + '/' + blocks + ')'); }
  const lumaAt = (b, x, y) => luma(b, (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 3);
  const KE = [-2, -1, 0, -1, 0, 1, 0, 1, 2], KD = [-1, -1, -1, -1, 8, -1, -1, -1, -1];
  const ref = (kern, mul, off) => { const a = Buffer.alloc(W * H * 3); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, k = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += kern[k++] * lumaAt(base, x + i, y + j); const v = Math.max(0, Math.min(255, mul * s + off)); const o = (y * W + x) * 3; a[o] = a[o + 1] = a[o + 2] = v; } return a; };
  const e1 = render('emb', { emboss: true }); ok(!!e1, 'emboss renders');
  if (e1) { const o = readFrame(e1, 10), r = ref(KE, 1, 130.4); let d = 0, n = 0; for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) { const i = (y * W + x) * 3; d += Math.abs(o[i] - r[i]); n++; } ok(d / n < 6, 'emboss matches the 3x3 kernel on luma (mean error ' + (d / n).toFixed(2) + ')'); }
  const e2 = render('edg', { edges: true }); ok(!!e2, 'edge detect renders');
  if (e2) { const o = readFrame(e2, 10), r = ref(KD, 2, -18.6); let d = 0, n = 0; for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) { const i = (y * W + x) * 3; d += Math.abs(o[i] - r[i]); n++; } ok(d / n < 8, 'edge detect matches the kernel (mean error ' + (d / n).toFixed(2) + ')'); }
}
console.log('Grain and glow:');
{
  const g = render('grn', { grain: 40 }); ok(!!g, 'grain renders');
  if (g) { const o = readFrame(g, 10); const e = cmp(o, base); ok(e.mean > 3 && e.mean < 40, 'grain adds visible noise without destroying the picture (mean change ' + e.mean.toFixed(1) + ')'); const o2 = readFrame(g, 11); ok(cmp(o, o2).mean > 3, 'and it changes from frame to frame'); }
  const gl = render('glow', { glow: { amount: 80, size: 6, threshold: 70 } }); ok(!!gl, 'glow renders (clip chain)');
  if (gl) { const o = readFrame(gl, 10); const at = (b, x, y) => luma(b, (y * W + x) * 3); ok(at(o, 195, 85) > at(base, 195, 85) + 5, 'glow bleeds light beyond the bright square (just outside its edge)'); ok(Math.abs(at(o, 20, 20) - at(base, 20, 20)) < 6, 'and leaves the dark far corner alone'); }
  const ga = render('glowadj', {}, (P, c) => { const a = DS.newClip({ track: 'V2', type: 'adjust', start: 0, dur: 2 }); a.fx.glow = { amount: 80, size: 6, threshold: 70 }; P.clips.push(a); });
  ok(!!ga, 'glow on an adjustment layer renders');
  const gb = render('blurglow', { blur: 2, glow: { amount: 50, size: 4, threshold: 50 }, invert: true }); ok(!!gb, 'glow with other effects in the same chain renders');
}
console.log('Wipe transitions (every type, against DS.wipeCover):');
{
  const A = path.join(tmp, 'red.mp4'), B = path.join(tmp, 'blue.mp4');
  spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=30:d=3`, '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', A]);
  spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=white:s=${W}x${H}:r=30:d=3`, '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', B]);
  for (const type of DS.WIPE_IDS) {
    const P = DS.newProject({ width: W, height: H, fps: 30, name: 'wp' });
    P.media = [{ id: 'a', path: A, name: 'a.mp4', kind: 'video', duration: 3, hasAudio: false, w: W, h: H }, { id: 'b', path: B, name: 'b.mp4', kind: 'video', duration: 3, hasAudio: false, w: W, h: H }];
    const c1 = DS.newClip({ track: 'V1', media: 'a', start: 0, in: 0, dur: 2 });
    const c2 = DS.newClip({ track: 'V1', media: 'b', start: 2, in: 0, dur: 2 });
    c2.tr = { type, dur: 1 };
    P.clips = [c1, c2];
    const out = path.join(tmp, 'wp-' + type + '.mp4'), sc = path.join(tmp, 'wp.txt');
    const bx = buildExport(P, { outPath: out, scriptPath: sc, newFilterFlag: false, format: 'mp4-h264', quality: 100 }, {});
    fs.writeFileSync(sc, bx.script);
    const r = spawnSync(FFMPEG, bx.args, { encoding: 'utf8', cwd: tmp, maxBuffer: 1 << 28 });
    if (r.status) { console.log(r.stderr.slice(-800)); ok(false, type + ': renders'); continue; }
    let worst = 0, n = 0;
    for (const lt of [0.3, 0.6]) {
      const fr = readFrame(out, Math.round((2 + lt) * 30));
      const p = DS.wipeProgress(c2.tr, Math.round(lt * 30) / 30);
      for (let gy = 0; gy < 9; gy++) for (let gx = 0; gx < 16; gx++) {
        const x = Math.round((gx + .5) * W / 16), y = Math.round((gy + .5) * H / 9), i = (y * W + x) * 3;
        const got = fr[i] / 255, want = DS.wipeCover(type, (x + .5) / W, (y + .5) / H, p);
        worst = Math.max(worst, Math.abs(got - want)); n++;
      }
    }
    ok(worst < 0.1, type + ': export matches the reference (worst coverage difference ' + worst.toFixed(3) + ' over ' + n + ' points)');
    if (type === 'wipe-lr') { const fr = readFrame(out, 4 * 30 - 2); ok(fr[0] > 240, 'after the transition the new clip is fully visible'); const f0 = readFrame(out, 59); ok(f0[0] < 30, 'the outgoing clip is still there until the wipe starts'); }
  }
}
console.log('The pixel reference (src/creative.js, used by the 2D fallback) against the export:');
{
  const Creative = require('../src/creative');
  const toRgba = (rgb) => { const a = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) { a[i * 4] = rgb[i * 3]; a[i * 4 + 1] = rgb[i * 3 + 1]; a[i * 4 + 2] = rgb[i * 3 + 2]; a[i * 4 + 3] = 255; } return a; };
  const diff = (rgba, rgb, skip) => { let d = 0, n = 0; for (let y = skip; y < H - skip; y++) for (let x = skip; x < W - skip; x++) for (let k = 0; k < 3; k++) { d += Math.abs(rgba[(y * W + x) * 4 + k] - rgb[(y * W + x) * 3 + k]); n++; } return d / n; };
  const cases = { invert: [{ invert: true }, 3], posterize: [{ posterize: 5 }, 12], mosaic: [{ mosaic: 16 }, 4], emboss: [{ emboss: true }, 5], edges: [{ edges: true }, 5], glow: [{ glow: { amount: 70, size: 5, threshold: 60 } }, 6], rgbsplit: [{ rgbsplit: 6 }, 4], 'luma key': [{ lumakey: { on: true, threshold: 55, tolerance: 12, softness: 15 } }, 5] };
  for (const [name, [fx, tol]] of Object.entries(cases)) {
    const f = render('ref-' + name, fx); if (!f) { ok(false, name + ' renders'); continue; }
    const out = readFrame(f, 10), full = Object.assign(DS.cleanFx({}), fx);
    const ref = Creative.process(toRgba(base), W, H, full, 1, W);
    if (fx.lumakey) for (let i = 0; i < W * H; i++) for (let k = 0; k < 3; k++) ref[i * 4 + k] = ref[i * 4 + k] * ref[i * 4 + 3] / 255;   // keyed pixels show the black background
    const e = diff(ref, out, 3);
    ok(e < tol, name + ': pixel reference vs export, mean error ' + e.toFixed(2) + ' (limit ' + tol + ')');
  }
  const f = render('ref-thr', { threshold: 45 });
  if (f) { const out = readFrame(f, 10), ref = Creative.process(toRgba(base), W, H, Object.assign(DS.cleanFx({}), { threshold: 45 }), 1, W); let bad = 0, n = 0; for (let i = 0; i < W * H; i++) { const y = luma(base, i * 3) / 255; if (Math.abs(y - .45) < .04) continue; n++; if ((out[i * 3] > 127) !== (ref[i * 4] > 127)) bad++; } ok(bad / n < 0.01, 'threshold: pixel reference agrees with the export'); }
  // grain statistics: the reference's per-channel std matches what the export produces on a flat grey
  const flat = path.join(tmp, 'flat.mp4');
  spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x808080:s=${W}x${H}:r=30:d=3`, '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', flat]);
  const P = DS.newProject({ width: W, height: H, fps: 30, name: 'g' });
  P.media = [{ id: 'm', path: flat, name: 'f.mp4', kind: 'video', duration: 3, hasAudio: false, w: W, h: H }];
  const c = DS.newClip({ track: 'V1', media: 'm', start: 0, in: 0, dur: 2 }); c.fx.grain = 60; P.clips = [c];
  const o = path.join(tmp, 'gr.mp4'), sc = path.join(tmp, 'gr.txt'); const b = buildExport(P, { outPath: o, scriptPath: sc, newFilterFlag: false, format: 'mp4-h264', quality: 100 }, {}); fs.writeFileSync(sc, b.script);
  spawnSync(FFMPEG, b.args, { cwd: tmp });
  const fr = readFrame(o, 10), rf = Creative.process(new Uint8ClampedArray(W * H * 4).fill(128), W, H, Object.assign(DS.cleanFx({}), { grain: 60 }), 1, W);
  const sd = (get, n, k) => { let m = 0, q = 0; for (let i = 0; i < n; i++) { const v = get(i, k); m += v; q += v * v; } m /= n; return Math.sqrt(q / n - m * m); };
  const want = [0, 1, 2].map((k) => sd((i, kk) => fr[i * 3 + kk], W * H, k)), got = [0, 1, 2].map((k) => sd((i, kk) => rf[i * 4 + kk], W * H, k));
  ok([0, 1, 2].every((k) => Math.abs(want[k] - got[k]) / want[k] < 0.15), 'grain: per-channel noise std matches the export (export ' + want.map((v) => v.toFixed(1)) + ', reference ' + got.map((v) => v.toFixed(1)) + ')');
}
console.log('Animated effects (keyframes), against static renders of the same values:');
{
  const meanLuma = (b) => { let s = 0; for (let i = 0; i < W * H; i++) s += luma(b, i * 3); return s / (W * H); };
  const kfs = (p, list) => (P, c) => { c.kf[p] = list; };
  const stat = (name, fx) => { const f = render('st-' + name, fx); return f ? (fr) => readFrame(f, fr) : null; };
  const anim = render('kf-bright', {}, kfs('brightness', [{ t: 0, v: -60, e: 'lin' }, { t: 2, v: 60, e: 'lin' }]));
  ok(!!anim, 'a brightness keyframe animation exports');
  if (anim) for (const [t, v] of [[0.5, -30], [1.0, 0], [1.5, 30]]) {
    const st = stat('b' + v, { brightness: v }); const a = meanLuma(readFrame(anim, Math.round(t * 30))), b = meanLuma(st(Math.round(t * 30)));
    ok(Math.abs(a - b) < 3, 'brightness at ' + t + ' s equals a static ' + v + ' (' + a.toFixed(1) + ' vs ' + b.toFixed(1) + ')');
  }
  const ez = render('kf-ease', {}, kfs('contrast', [{ t: 0, v: 0, e: 'ease' }, { t: 2, v: 80, e: 'lin' }]));
  if (ez) { const mid = readFrame(ez, 30), st = stat('c40', { contrast: 40 })(30); let d = 0; for (let i = 0; i < mid.length; i++) d += Math.abs(mid[i] - st[i]); ok(d / mid.length < 3, 'an eased contrast ramp passes through its midpoint value'); }
  const hu = render('kf-hue', {}, kfs('hue', [{ t: 0, v: 0, e: 'lin' }, { t: 2, v: 120, e: 'lin' }])); ok(!!hu, 'hue animation exports');
  if (hu) { const o = readFrame(hu, 30), st = stat('h60', { hue: 60 })(30); let d = 0; for (let i = 0; i < o.length; i++) d += Math.abs(o[i] - st[i]); ok(d / o.length < 4, 'hue at the midpoint equals a static 60 degrees'); }
  const vg = render('kf-vig', {}, kfs('vignette', [{ t: 0, v: 0, e: 'lin' }, { t: 2, v: 100, e: 'lin' }])); ok(!!vg, 'vignette animation exports');
  if (vg) { const a = readFrame(vg, 2), z = readFrame(vg, 55); const corner = (b) => luma(b, 0); ok(corner(z) < corner(a) - 5, 'the vignette darkens the corners as it grows'); }
  const sat = render('kf-sat', {}, kfs('saturation', [{ t: 0, v: 100, e: 'lin' }, { t: 1, v: 0, e: 'lin' }]));
  if (sat) { const o = readFrame(sat, 50); let spread = 0; for (let i = 0; i < W * H; i++) spread += Math.max(o[i * 3], o[i * 3 + 1], o[i * 3 + 2]) - Math.min(o[i * 3], o[i * 3 + 1], o[i * 3 + 2]); ok(spread / (W * H) < 12, 'saturation animated to 0 turns the picture grey'); }
  const adj = render('kf-adj', {}, (P, c) => { const a = DS.newClip({ track: 'V2', type: 'adjust', start: 0, dur: 2 }); a.kf.brightness = [{ t: 0, v: 0, e: 'lin' }, { t: 2, v: -80, e: 'lin' }]; P.clips.push(a); });
  if (adj) ok(meanLuma(readFrame(adj, 58)) < meanLuma(readFrame(adj, 2)) - 20, 'an adjustment layer’s animated brightness darkens over time');
  const sp = render('kf-split', {}, (P, c) => { c.kf.brightness = [{ t: 0, v: -50, e: 'lin' }, { t: 2, v: 50, e: 'lin' }]; });
  ok(!!sp, 'keyframed effect values survive a normal export');
  const dirty = DS.cleanKf({ brightness: [{ t: 'x', v: 1 }, { t: 1, v: 2, e: '<script>' }, { t: 0, v: 5 }], bogus: [1], hue: 'junk' });
  ok(dirty.brightness.length === 2 && dirty.brightness[0].t === 0 && dirty.brightness[1].e === 'lin' && !('bogus' in dirty) && dirty.hue.length === 0, 'cleanKf drops bad keys and values, sorts and normalises easing');
}
console.log('Hostile effect values:');
{
  const bad = DS.cleanFx({ hue: '0:enable=1;movie=/etc/passwd', posterize: '9;9', mosaic: 1e9, grain: -5, glow: { amount: 'x', size: 1e9, threshold: NaN }, invert: 'yes', emboss: {}, threshold: Infinity });
  ok(typeof bad.hue === 'number' && bad.posterize >= 0 && bad.posterize <= 32 && bad.mosaic <= 200 && bad.grain === 0 && bad.glow.amount === 0 && bad.glow.size <= 20 && bad.invert === false && bad.threshold === 0, 'cleanFx coerces strings, clamps numbers, drops NaN');
  const f = render('hostile', { hue: '0:enable=1', posterize: 'z', glow: { amount: '1;2', size: 'q', threshold: {} } }); ok(!!f, 'a project carrying hostile values still exports');
  const sc = fs.readFileSync(path.join(tmp, 'hostile.txt'), 'utf8'); ok(!/movie|enable=1/.test(sc), 'and the filter script contains none of it');
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
