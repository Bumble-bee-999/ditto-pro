/* Hardware encoders: argument building, the export wiring, the capability probe (against a stand-in FFmpeg), and the
   automatic fall back to software when a hardware export fails (against the real FFmpeg, which has no GPU encoder here). */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const H = require('../src/hwenc');
const DS = require('../src/shared');
const { buildExport } = require('../src/exporter');
const FFMPEG = require('ffmpeg-static');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-hw-'));
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };

console.log('Arguments:');
for (const id of Object.keys(H.HW)) {
  const a = H.videoArgs(id, 60), hi = H.videoArgs(id, 100), lo = H.videoArgs(id, 0);
  const num = (arr, flag) => +arr[arr.indexOf(flag) + 1];
  const flag = /nvenc/.test(id) ? '-cq' : /qsv/.test(id) ? '-global_quality' : '-qp_i';
  ok(a[0] === '-c:v' && a[1] === id && num(hi, flag) < num(a, flag) && num(a, flag) < num(lo, flag), id + ': codec set, higher quality means a lower quantiser (' + num(hi, flag) + ' < ' + num(a, flag) + ' < ' + num(lo, flag) + ')');
  ok((H.HW[id].family === 'hevc') === a.includes('hvc1'), id + ': HEVC files get the hvc1 tag');
}
ok(H.pick('h264_nvenc', 'mp4-h264') === 'h264_nvenc' && H.pick('hevc_amf', 'mp4-h265') === 'hevc_amf', 'a matching encoder is accepted');
ok(H.pick('hevc_nvenc', 'mp4-h264') === null && H.pick('h264_nvenc', 'webm-vp9') === null, 'a codec / format mismatch falls back to software');
ok(H.pick('libx264; rm -rf /', 'mp4-h264') === null && H.pick('__proto__', 'mp4-h264') === null && H.pick('constructor', 'mp4-h264') === null && H.pick(undefined, 'mp4-h264') === null && H.pick({}, 'mp4-h264') === null, 'unknown or hostile encoder names are ignored');

console.log('Export wiring:');
const P = DS.newProject({ width: 640, height: 360, fps: 30 });
P.media = [{ id: 'm', path: '/x/a.mp4', name: 'a', kind: 'video', duration: 3, hasAudio: true, w: 640, h: 360 }];
P.clips = [DS.newClip({ track: 'V1', media: 'm', start: 0, in: 0, dur: 2 })];
const args = (o) => buildExport(P, Object.assign({ outPath: '/x/o.mp4', scriptPath: '/x/f.txt', newFilterFlag: false, quality: 70 }, o), {}).args;
const a1 = args({ format: 'mp4-h264', encoder: 'h264_nvenc' }), a2 = args({ format: 'mp4-h265', encoder: 'hevc_qsv' }), a3 = args({ format: 'mp4-h264' }), a4 = args({ format: 'mp4-h265' }), a5 = args({ format: 'mp4-h264', encoder: 'hevc_nvenc' });
ok(a1.includes('h264_nvenc') && !a1.includes('libx264') && a1.includes('aac') && a1.includes('+faststart'), 'H.264 export with NVENC uses it, keeps AAC and faststart');
ok(a2.includes('hevc_qsv') && a2.includes('hvc1') && !a2.includes('libx265'), 'HEVC export with Quick Sync');
ok(a3.includes('libx264') && a4.includes('libx265') && a4.includes('hvc1'), 'without a choice the software encoders are used exactly as before');
ok(a5.includes('libx264'), 'a mismatched choice is not passed to FFmpeg');

console.log('Capability probe (stand-in FFmpeg):');
// a small script that behaves like FFmpeg: lists three encoders, and only "encodes" with NVENC
const fake = path.join(tmp, 'fakeffmpeg.sh');
fs.writeFileSync(fake, `#!/bin/sh
case "$*" in
  *-encoders*) printf ' V....D h264_nvenc NVIDIA\\n V....D h264_amf AMD\\n V....D hevc_qsv Intel\\n V....D libx264 x\\n'; exit 0;;
  *h264_nvenc*) exit 0;;
  *hevc_qsv*) sleep 30;;
  *) echo "Cannot load amfrt64.dll" >&2; exit 1;;
esac
`, { mode: 0o755 });
(async () => {
  const t0 = Date.now();
  const got = await H.probe(fake, 1500);
  ok(got.length === 1 && got[0].id === 'h264_nvenc' && /NVIDIA/.test(got[0].label), 'only the encoder whose test encode succeeded is offered (' + JSON.stringify(got.map((g) => g.id)) + ')');
  ok(Date.now() - t0 < 5000, 'an encoder that hangs is abandoned after its time limit');
  ok((await H.probe(path.join(tmp, 'does-not-exist'))).length === 0, 'a missing FFmpeg yields an empty list, not an error');
  const real = await H.probe(FFMPEG, 8000);
  ok(Array.isArray(real), 'the real FFmpeg is probed without throwing (' + real.length + ' hardware encoders work on this machine)');

  console.log('Fall back to software (real FFmpeg):');
  const src = path.join(tmp, 'src.mp4');
  spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const Q = DS.newProject({ width: 320, height: 180, fps: 30 });
  Q.media = [{ id: 'm', path: src, name: 'src.mp4', kind: 'video', duration: 2, hasAudio: true, w: 320, h: 180 }];
  Q.clips = [DS.newClip({ track: 'V1', media: 'm', start: 0, in: 0, dur: 1 })];
  const tries = [];
  const runOnce = (o) => {
    const out = path.join(tmp, 'out-' + tries.length + '.mp4'), sc = path.join(tmp, 'f' + tries.length + '.txt');
    tries.push(o.encoder);
    const b = buildExport(Q, Object.assign({}, o, { outPath: out, scriptPath: sc, newFilterFlag: false }), {});
    fs.writeFileSync(sc, b.script);
    const r = spawnSync(FFMPEG, b.args, { encoding: 'utf8', cwd: tmp, maxBuffer: 1 << 26 });
    return Promise.resolve(r.status === 0 ? { ok: true, outPath: out } : { ok: false, error: r.stderr.split('\n').filter(Boolean).slice(-2).join(' ') });
  };
  // this FFmpeg has no NVENC hardware in this sandbox: the export must still finish, in software
  const r1 = await H.runWithFallback(runOnce, { format: 'mp4-h264', quality: 60, encoder: 'h264_nvenc' });
  ok(r1.ok && r1.fellBack && /nvenc|encoder|Unknown|Error/i.test(r1.hwError) && tries.join() === 'h264_nvenc,software', 'a failing hardware export is redone in software and reports why (' + tries.join(' → ') + ')');
  const probe = spawnSync(FFMPEG, ['-v', 'error', '-i', r1.outPath, '-f', 'null', '-']);
  ok(probe.status === 0 && fs.statSync(r1.outPath).size > 1000, 'the file that comes out is valid');
  tries.length = 0;
  const r2 = await H.runWithFallback(runOnce, { format: 'mp4-h264', quality: 60, encoder: 'software' });
  ok(r2.ok && !r2.fellBack && tries.length === 1, 'a normal software export runs once with no fall back');
  tries.length = 0;
  const r3 = await H.runWithFallback(() => Promise.resolve({ ok: false, cancelled: true }), { format: 'mp4-h264', encoder: 'h264_nvenc' });
  ok(r3.cancelled && !r3.fellBack, 'cancelling is never retried');
  const r4 = await H.runWithFallback(() => Promise.resolve({ ok: false, error: 'disk full' }), { format: 'webm-vp9', encoder: 'h264_nvenc' });
  ok(!r4.ok && !r4.fellBack, 'a format that cannot use hardware encoding is not retried either');
  process.exit(failed ? 1 : 0);
})();
