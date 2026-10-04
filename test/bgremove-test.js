/* Background removal: the maths (resampling, guided filter, curve), the real network on real photographs, the whole
   video pipeline (alpha ProRes out, audio kept, cuts handled, cancel), the worker thread, and an export that composites
   the cut-out over another layer. */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { fork } = require('child_process');
const FFMPEG = require('ffmpeg-static'), FFPROBE = require('ffprobe-static').path;
const B = require('../src/bgremove');
const DS = require('../src/shared');
const { buildExport } = require('../src/exporter');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-bg-'));
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
const TIGER = path.join(__dirname, 'fixtures', 'tiger.jpg'), CAR = path.join(__dirname, 'fixtures', 'car.jpg');
const MODEL = path.join(__dirname, '..', 'models', 'u2netp.onnx');

(async () => {
  console.log('Resampling:');
  const flat = new Uint8Array(64 * 48 * 4).fill(100);
  const small = B.resize(flat, 64, 48, 4, 10, 7), big = B.resize(flat, 64, 48, 4, 200, 150);
  ok(small.every((v) => Math.abs(v - 100) < 1e-3) && big.every((v) => Math.abs(v - 100) < 1e-3), 'a flat picture stays flat when shrunk or enlarged');
  const ramp = new Float32Array(100); for (let i = 0; i < 100; i++) ramp[i] = i;
  const half = B.resize(ramp, 100, 1, 1, 50, 1);
  ok(Math.abs(half[0] - 0.5) < 1e-3 && Math.abs(half[49] - 98.5) < 1e-3, 'shrinking averages the covered pixels exactly');
  const same = B.resize(ramp, 100, 1, 1, 100, 1);
  ok(same.every((v, i) => v === ramp[i]), 'same size is an exact copy');

  console.log('Guided filter and curve:');
  const w = 40, h = 30, n = w * h, rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const arr = new Float32Array(n).map(() => rnd()), box = new Float32Array(n), tmpb = new Float32Array(n);
  B.boxMean(arr, w, h, 3, box, tmpb);
  let worst = 0;
  for (const [x, y] of [[0, 0], [5, 7], [39, 29], [20, 15], [1, 28]]) {
    let s = 0, c = 0;
    for (let j = Math.max(0, y - 3); j <= Math.min(h - 1, y + 3); j++) for (let i = Math.max(0, x - 3); i <= Math.min(w - 1, x + 3); i++) { s += arr[j * w + i]; c++; }
    worst = Math.max(worst, Math.abs(box[y * w + x] - s / c));
  }
  ok(worst < 1e-4, 'box mean equals the brute-force window average (worst ' + worst.toExponential(1) + ')');
  const I = new Float32Array(n), P = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { I[y * w + x] = x < 20 ? 0.2 : 0.8; P[y * w + x] = Math.max(0, Math.min(1, (x - 14) / 12)); } // blurred step, guide has the sharp step
  const Q = B.guidedFilter(I, P, w, h, 4, 1e-4), row = 15 * w;
  const jumpP = Math.abs(P[row + 20] - P[row + 19]), jumpQ = Math.abs(Q[row + 20] - Q[row + 19]);
  ok(jumpQ > 0.3 && jumpQ > jumpP * 3, 'the matte gets a sharp edge where the picture has one (step ' + jumpP.toFixed(2) + ' → ' + jumpQ.toFixed(2) + ')');
  const flatG = B.guidedFilter(new Float32Array(n).fill(0.5), P, w, h, 4, 1e-4);
  ok(Math.abs(flatG[row + 20] - P[row + 20]) < 0.1 && flatG.every((v) => v >= 0 && v <= 1), 'with a featureless picture it just smooths and stays within 0..1');
  const c0 = B.curve(Float32Array.from([0, 0.5, 1]), 35, 0), cg = B.curve(Float32Array.from([0.4]), 35, 60), cs = B.curve(Float32Array.from([0.4]), 35, -60);
  ok(c0[0] === 0 && c0[2] === 1 && Math.abs(c0[1] - 0.5) < 1e-6, 'the curve keeps 0, ½ and 1');
  ok(cg[0] > 0.5 && cs[0] < 0.1, 'grow raises and shrink lowers partial coverage');

  console.log('The network on real photographs:');
  ok(B.findModels([path.dirname(MODEL)]).some((m) => m.id === 'u2netp'), 'the bundled model is found');
  const M = await B.createSession(MODEL, B.MODELS.u2netp, 'cpu');
  const load = (img) => { const pr = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', img]).stdout.toString().trim().split(',').map(Number); let [W, H] = pr; W -= W % 2; H -= H % 2; return { W, H, buf: Buffer.from(spawnSync(FFMPEG, ['-v', 'error', '-i', img, '-vf', 'scale=' + W + ':' + H, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 }).stdout) }; };
  const alphaAt = (f, x, y) => f.buf[(y * f.W + x) * 4 + 3];
  for (const [name, file, cx, cy] of [['tiger', TIGER, 0.45, 0.55], ['car', CAR, 0.5, 0.65]]) {
    const f = load(file), prob = await B.infer(M, f.buf, f.W, f.H);
    B.applyMatte(f.buf, f.W, f.H, prob, 320, { edge: 35, shift: 0 });
    let fg = 0; for (let i = 3; i < f.buf.length; i += 4) if (f.buf[i] > 127) fg++;
    const frac = fg / (f.W * f.H);
    ok(alphaAt(f, Math.round(f.W * cx), Math.round(f.H * cy)) > 235, name + ': the subject is opaque');
    ok(alphaAt(f, 2, 2) < 12 && alphaAt(f, f.W - 3, 2) < 12 && alphaAt(f, 2, f.H - 3) < 12, name + ': the corners are transparent');
    ok(frac > 0.08 && frac < 0.6, name + ': a plausible share of the picture is kept (' + (frac * 100).toFixed(0) + '%)');
  }

  console.log('Video pipeline:');
  // a short clip of the tiger photo, slowly panning, with a tone; then the car photo (a hard cut)
  const W = 480, H = 320, FPS = 12;
  const mk = (img, out, dur) => spawnSync(FFMPEG, ['-y', '-v', 'error', '-loop', '1', '-framerate', String(FPS), '-t', String(dur), '-i', img, '-f', 'lavfi', '-t', String(dur), '-i', 'sine=f=440:r=44100', '-vf', 'scale=' + (W + 40) + ':' + H + ',crop=' + W + ':' + H + ':x=t*10:y=0,format=yuv420p', '-c:v', 'libx264', '-crf', '12', '-c:a', 'aac', '-shortest', out]);
  const clipA = path.join(tmp, 'a.mp4'), clipB = path.join(tmp, 'b.mp4'), both = path.join(tmp, 'both.mp4');
  mk(TIGER, clipA, 1.5); mk(CAR, clipB, 1.5);
  fs.writeFileSync(path.join(tmp, 'list.txt'), "file '" + clipA + "'\nfile '" + clipB + "'\n");
  spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'), '-c', 'copy', both]);
  ok(fs.existsSync(both), 'test footage built');
  const opts = { file: both, kind: 'video', from: 0, span: 3, fps: FPS, w: W, h: H, model: { id: 'u2netp', path: MODEL }, edge: 35, shift: 0, temporal: 30, step: 2, device: 'cpu', outDir: path.join(tmp, 'out') };
  const progress = [];
  const t0 = Date.now();
  const r = await B.removeBackground(FFMPEG, opts, (p) => progress.push(p), null);
  console.log('    (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s, ' + r.frames + ' frames, ' + r.provider + ')');
  const probe = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_streams', '-of', 'json', r.path]).stdout.toString());
  const v = probe.streams.find((s) => s.codec_type === 'video'), a = probe.streams.find((s) => s.codec_type === 'audio');
  ok(v && v.codec_name === 'prores' && /^yuva444p10/.test(v.pix_fmt), 'the output is ProRes 4444 with an alpha channel (' + (v && v.pix_fmt) + ')');
  ok(r.frames === 36 && +v.width === W && +v.height === H, 'every frame was produced at the source size (' + r.frames + ' frames)');
  ok(!!a, 'the sound was carried over');
  ok(progress.length > 3 && progress[progress.length - 1] === 1 && progress.every((p, i) => !i || p >= progress[i - 1] - 1e-9), 'progress rises to 100%');
  const dec = (file, idx) => Buffer.from(spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-vf', 'select=eq(n\\,' + idx + ')', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 26 }).stdout);
  const at = (b, x, y) => b[(y * W + x) * 4 + 3];
  const f5 = dec(r.path, 5), f30 = dec(r.path, 30);
  ok(at(f5, W / 2, Math.round(H * 0.55)) > 230 && at(f5, 3, 3) < 15, 'a frame of the first shot: subject kept, background gone');
  ok(at(f30, W / 2, Math.round(H * 0.65)) > 230 && at(f30, 3, 3) < 15, 'a frame of the second shot: subject kept, background gone');
  // frames right after the cut must follow the NEW picture, not blend the old subject in (the tiger is left of centre-low, the car is not there)
  const f18 = dec(r.path, 18), f17 = dec(r.path, 17);
  const tigerPoint = [Math.round(W * 0.1), Math.round(H * 0.8)];
  ok(at(f17, tigerPoint[0], tigerPoint[1]) > 128 !== at(f18, tigerPoint[0], tigerPoint[1]) > 128 || at(f18, tigerPoint[0], tigerPoint[1]) < 40, 'the matte changes at the cut instead of smearing across it');
  const again = await B.removeBackground(FFMPEG, opts, null, null);
  ok(again.cached && again.path === r.path, 'asking again reuses the finished file');

  console.log('Still pictures:');
  const still = await B.removeBackground(FFMPEG, { file: TIGER, kind: 'image', from: 0, span: 0, fps: 30, w: 1000, h: 666, model: { id: 'u2netp', path: MODEL }, edge: 35, shift: 0, temporal: 0, step: 1, device: 'cpu', outDir: path.join(tmp, 'out') }, null, null);
  const sp = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_streams', '-of', 'json', still.path]).stdout.toString()).streams[0];
  ok(/\.png$/.test(still.path) && sp.codec_name === 'png' && /a/.test(sp.pix_fmt) && sp.width === 1000, 'a photo becomes a PNG with transparency (' + sp.pix_fmt + ')');

  console.log('Cancel:');
  let calls = 0;
  let err = null;
  try { await B.removeBackground(FFMPEG, Object.assign({}, opts, { edge: 36, outDir: path.join(tmp, 'out2') }), null, () => ++calls > 4); } catch (e) { err = e; }
  ok(err && /Cancelled/.test(err.message), 'cancelling stops the job');
  ok(!fs.readdirSync(path.join(tmp, 'out2')).some((f) => /\.part\./.test(f)) && !fs.readdirSync(path.join(tmp, 'out2')).some((f) => /\.mov$/.test(f)), 'a cancelled job leaves no half-written file');

  console.log('Separate process (how the app runs it):');
  const runJob = (o, cancelAfterMs) => new Promise((resolve) => {
    const ch = fork(path.join(__dirname, '..', 'src', 'bgjob.js'));
    let prog = 0;
    ch.on('message', (m) => { if (m.type === 'progress') prog++; if (m.type === 'done') { resolve({ r: m.r, prog }); ch.kill(); } if (m.type === 'error') { resolve({ error: m.error }); ch.kill(); } });
    ch.on('error', (e) => resolve({ error: e.message }));
    ch.send({ type: 'start', ffmpeg: FFMPEG, opts: o });
    if (cancelAfterMs) setTimeout(() => ch.send({ type: 'cancel' }), cancelAfterMs);
  });
  const jr = await runJob(Object.assign({}, opts, { span: 1, edge: 37, outDir: path.join(tmp, 'out3') }));
  ok(jr.r && fs.existsSync(jr.r.path) && jr.prog > 0, 'a separate process runs the network and reports progress' + (jr.error ? ' — ' + jr.error : ''));
  const jc = await runJob(Object.assign({}, opts, { edge: 38, step: 1, outDir: path.join(tmp, 'out4') }), 2500);
  ok(jc.error && /Cancelled/.test(jc.error), 'a cancel message stops it' + (jc.r ? ' (it finished first)' : ''));
  const second = await runJob(Object.assign({}, opts, { span: 1, edge: 39, outDir: path.join(tmp, 'out5') }));
  ok(!!second.r, 'a second job in a fresh process works too (the native module loads once per process)');

  console.log('Export with the cut-out on top of another layer:');
  const blue = path.join(tmp, 'blue.mp4');
  spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x0000ff:s=' + W + 'x' + H + ':r=' + FPS + ':d=3', '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', blue]);
  const PR = DS.newProject({ width: W, height: H, fps: FPS, name: 'bg' });
  PR.media = [
    { id: 'b', path: blue, name: 'blue.mp4', kind: 'video', duration: 3, hasAudio: false, w: W, h: H },
    { id: 'c', path: r.path, name: 'cut.mov', kind: 'video', duration: 3, hasAudio: true, alpha: true, w: W, h: H }
  ];
  PR.clips = [DS.newClip({ track: 'V1', media: 'b', start: 0, in: 0, dur: 3 }), DS.newClip({ track: 'V2', media: 'c', start: 0, in: 0, dur: 1.2 })];
  const out = path.join(tmp, 'comp.mp4'), sc = path.join(tmp, 'comp.txt');
  const bx = buildExport(PR, { outPath: out, scriptPath: sc, newFilterFlag: false, format: 'mp4-h264', quality: 95 }, {});
  fs.writeFileSync(sc, bx.script);
  const rr = spawnSync(FFMPEG, bx.args, { encoding: 'utf8', cwd: tmp, maxBuffer: 1 << 28 });
  if (rr.status) console.log(rr.stderr.slice(-1500));
  ok(rr.status === 0, 'the project with a cut-out layer exports');
  if (rr.status === 0) {
    const fr = Buffer.from(spawnSync(FFMPEG, ['-v', 'error', '-i', out, '-vf', 'select=eq(n\\,5)', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 }).stdout);
    const p = (x, y) => Array.from(fr.slice((y * W + x) * 3, (y * W + x) * 3 + 3));
    const bg = p(3, 3), mid = p(W / 2, Math.round(H * 0.55));
    ok(bg[2] > 230 && bg[0] < 25 && bg[1] < 25, 'where the background was removed the layer below shows through (' + bg + ')');
    ok(!(mid[2] > 230 && mid[0] < 25 && mid[1] < 25), 'the subject covers the layer below (' + mid + ')');
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
