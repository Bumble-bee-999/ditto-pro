'use strict';
const sec = require('../src/security');
let failed = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) failed++; };
console.log('Path safety:');
['C:\\Users\\me\\a.mp4', 'D:/clips/a.mov', '/home/me/a.mp4'].forEach((p) => ok(sec.isSafeLocalPath(p), 'allows ' + p));
['http://evil/x.mp4', 'https://evil/x', 'concat:a.mp4|b.mp4', 'subfile,,start,0:C:\\a.mp4', '\\\\server\\share\\a.mp4', '//server/share/a', '\\\\?\\C:\\a', '-f', 'pipe:0', 'rtmp://x', 'file:///etc/passwd', 'rel/a.mp4', 'a.mp4', 'C:\\a\0.mp4', '', null, 5].forEach((p) => ok(!sec.isSafeLocalPath(p), 'blocks ' + JSON.stringify(p)));
console.log('Project sanitising:');
{
  const pr = { media: [{ id: 1, path: 'http://evil/a.mp4' }, { id: 2, path: 'C:\\ok.mp4' }, { id: 3, path: '\\\\srv\\s\\b.mp4' }], clips: [{ fx: { lut: { path: 'concat:x' } } }, { fx: { lut: { path: 'C:\\a.cube' } } }], nests: { n1: { clips: [{ fx: { lut: { path: 'http://x/y.cube' } } }] } } };
  const n = sec.sanitizeProject(pr);
  ok(n === 4, 'drops 4 unsafe references (got ' + n + ')');
  ok(pr.media[0].path === '' && pr.media[0].missing && pr.media[1].path === 'C:\\ok.mp4' && pr.media[2].path === '', 'only unsafe media paths are cleared');
  ok(pr.clips[0].fx.lut === null && pr.clips[1].fx.lut.path === 'C:\\a.cube' && pr.nests.n1.clips[0].fx.lut === null, 'unsafe LUT references removed, safe ones kept');
}
console.log('IPC + links:');
const url = 'file:///app/renderer/index.html';
ok(sec.isTrustedSender({ senderFrame: { url, parent: null } }, url), 'accepts the app page');
ok(!sec.isTrustedSender({ senderFrame: { url: 'https://evil.com/', parent: null } }, url), 'rejects a foreign page');
ok(!sec.isTrustedSender({ senderFrame: { url, parent: {} } }, url), 'rejects sub-frames');
ok(!sec.isTrustedSender({}, url), 'rejects missing frame');
ok(sec.isAllowedExternal('https://github.com/a/b/issues', ['github.com']) && !sec.isAllowedExternal('http://github.com/', ['github.com']) && !sec.isAllowedExternal('https://evil.com/', ['github.com']) && !sec.isAllowedExternal('javascript:alert(1)', ['github.com']), 'only https links to allowed hosts open');

console.log('Project effect and transition values:');
{
  const sec2 = require('../src/security');
  const mk = () => ({ media: [], clips: [{ id: 'c', fx: { hue: '5:enable=1', posterize: '9;x', mosaic: 1e12, glow: { amount: '1;2', size: {}, threshold: 'q' }, emboss: true, edges: true }, tr: { type: 'x;movie=/etc/passwd', dur: 1 } }, { id: 'd', fx: null, tr: { type: 'iris', dur: -5 } }, { id: 'e', tr: { type: 'wipe-lr', dur: 1e9 } }], nests: { n: { clips: [{ id: 'f', fx: { grain: 'junk', invert: 'yes' }, tr: 'x' }] } } });
  const P = mk(); sec2.sanitizeProject(P);
  const c = P.clips[0], n = P.nests.n.clips[0];
  ok(c.fx.hue === 0 && c.fx.posterize === 0 && c.fx.mosaic <= 200 && c.fx.glow.amount === 0 && c.fx.edges === false, 'sanitizeProject coerces every effect value, also in nests');
  ok(c.tr === null && P.clips[1].tr.dur >= 0.05 && P.clips[2].tr.dur <= 60 && n.tr === null && n.fx.grain === 0, 'unknown transition types are dropped and lengths clamped');
}
{
  const sec3 = require('../src/security'), DS3 = require('../src/shared');
  const P = { media: [], clips: [{ id: 'a', blend: 'multiply', color: '#f87171', fx: {}, kf: { vol: [{ t: 0, v: '0:x' }, { t: 1, v: -6 }] } }, { id: 'b', blend: 'screen:enable=0', color: 'red;}', fx: {} }], nests: { n: { clips: [{ id: 'c', blend: {}, color: 7, fx: {} }] } } };
  sec3.sanitizeProject(P);
  ok(P.clips[0].blend === 'multiply' && P.clips[0].color === '#f87171' && P.clips[1].blend === 'normal' && P.clips[1].color === '' && P.nests.n.clips[0].blend === 'normal' && P.nests.n.clips[0].color === '', 'blend modes and label colours outside the known lists are reset, also in nests');
  ok(P.clips[0].kf.vol.length === 1 && P.clips[0].kf.vol[0].v === -6, 'volume keyframes keep only real numbers');
  ok(DS3.echoTaps({ echo: { on: 'yes', delay: 100, decay: 50 } }).length === 0 && DS3.echoTaps({ echo: { on: true, delay: 1e9, decay: 1e9 } }).every((t) => t.ms <= 3000 && t.gain <= 0.9), 'echo settings are clamped (and "on" must be a real true)');
  ok(DS3.titleHeight({ roll: true, text: 'a', size: 1e9, lineH: 1e9 }, 1080) <= DS3.ROLL_MAX_H && DS3.titleHeight({ roll: 'true', text: 'a\nb\nc' }, 1080) === 1080, 'rolling-title height is capped and needs a real true');
}
process.exit(failed ? 1 : 0);
