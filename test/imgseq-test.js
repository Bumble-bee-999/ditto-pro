/* Image sequences: detection, and a real FFmpeg conversion. */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { detectSequence, sequenceArgs } = require('../src/imgseq');
const FFMPEG = require('ffmpeg-static');
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
const names = (n, w, pre, ext, from) => Array.from({ length: n }, (_, i) => pre + String(i + (from || 0)).padStart(w, '0') + ext);

console.log('Detection:');
{
  const s = detectSequence('/f/shot_0007.png', names(20, 4, 'shot_', '.png', 1).concat(['other_0001.png', 'notes.txt']));
  ok(s && s.start === 1 && s.end === 20 && s.count === 20 && s.digits === 4 && /shot_%04d\.png$/.test(s.pattern), 'a padded sequence is found from any frame: 1..20, %04d');
  ok(s.first === 'shot_0001.png', 'and the first frame is named');
  const g = detectSequence('/f/a_005.jpg', names(3, 3, 'a_', '.jpg', 1).concat(names(3, 3, 'a_', '.jpg', 5)));
  ok(g.start === 5 && g.end === 7 && g.outsideRun === 3, 'a gap ends the run: the frames on the other side of it are reported (' + g.outsideRun + ')');
  const v = detectSequence('/f/f9.png', ['f1.png', 'f2.png', 'f9.png', 'f10.png', 'f11.png']);
  ok(v.start === 9 && v.end === 11 && v.digits === 0 && /f%d\.png$/.test(v.pattern), 'unpadded numbers (9, 10, 11) use %d');
  ok(detectSequence('/f/clip.mp4', ['clip.mp4']) === null && detectSequence('/f/nonumber.png', ['nonumber.png']) === null, 'a video or a file with no frame number is not a sequence');
  ok(detectSequence('/f/Shot_01.PNG', ['Shot_01.PNG', 'Shot_02.PNG']).count === 2, 'capital letters in the extension are fine');
  let e = ''; try { sequenceArgs(Object.assign(detectSequence('/f/100%/a_01.png', ['a_01.png']), {}), 24, '/o.mov'); } catch (x) { e = x.message; } ok(/%/.test(e), 'a % in the folder name is refused (it would be read as part of the pattern)');
  ok(sequenceArgs(s, 30, '/o.mov').alpha && !sequenceArgs(g, 30, '/o.mp4').alpha, 'PNG keeps transparency (ProRes 4444), JPG becomes H.264');
}
console.log('Real conversion:');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-seq-'));
  const r0 = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=161x91:r=10:d=1.2', '-start_number', '1', path.join(dir, 'fr_%03d.png')]);
  ok(r0.status === 0, 'made 12 test frames (odd size 161x91 on purpose)');
  const files = fs.readdirSync(dir), s = detectSequence(path.join(dir, files[5]), files);
  ok(s.count === 12, 'found all 12 frames');
  const out = path.join(dir, 'out.mov'), a = sequenceArgs(s, 10, out);
  const r = spawnSync(FFMPEG, a.args, { encoding: 'utf8' });
  ok(r.status === 0, 'FFmpeg converts it' + (r.status ? ': ' + r.stderr.slice(-300) : ''));
  const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', out, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const fr = probe.match(/frame=\s*(\d+)/g), n = fr ? +fr[fr.length - 1].match(/\d+/)[0] : 0;
  ok(n === 12 && /160x90|162x92/.test(probe), 'the result has 12 frames and an even size (' + (probe.match(/\d{2,4}x\d{2,4}/) || [''])[0] + ')');
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
