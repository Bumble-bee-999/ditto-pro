'use strict';
const { exportEDL } = require('../src/edl');
const { parseEDL } = require('../src/importers');
let fail = 0; const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
console.log('EDL export:');
const proj = { name: 'My Cut', fps: 25, tracks: [{ id: 'V1', type: 'video' }, { id: 'A1', type: 'audio' }],
  media: [{ id: 'm1', name: 'beach shot.mp4', path: 'C:\\x\\beach shot.mp4', hasAudio: true }],
  clips: [{ id: 'a', track: 'V1', type: 'media', media: 'm1', start: 0, in: 2, dur: 4, speed: 1 }, { id: 'b', track: 'V1', type: 'media', media: 'm1', start: 4, in: 10, dur: 3, speed: 1, tr: { type: 'dissolve', dur: 1 } }, { id: 'c', track: 'A1', type: 'media', media: 'm1', start: 0, in: 2, dur: 4, speed: 1 }] };
const t = exportEDL(proj);
ok(/^TITLE: My Cut/.test(t), 'title');
const back = parseEDL(t, { fps: 25 });
const v = back.clips.filter((c) => c.kind === 'video');
ok(v.length === 2 && Math.abs(v[0].in - 2) < 1e-6 && Math.abs(v[0].dur - 4) < 1e-6 && Math.abs(v[1].start - 4) < 1e-6 && Math.abs(v[1].in - 10) < 1e-6, 'video events round-trip through the importer');
ok(back.clips.some((c) => c.kind === 'audio'), 'audio event present');
ok(v[1].dissolve > 0.9 && v[1].dissolve < 1.1, 'dissolve length round-trips');
ok(!/\n\* SOURCE FILE:.*\r/.test('') && /SOURCE FILE: C:/.test(t), 'source file noted');
const evil = exportEDL({ name: 'a\nb', fps: 30, tracks: [{ id: 'V1', type: 'video' }], media: [{ id: 'm', name: 'x\ny.mp4', hasAudio: true }], clips: [{ track: 'V1', type: 'media', media: 'm', start: 0, in: 0, dur: 1 }] });
ok(!/^b$/m.test(evil.split('\r\n').join('\n')), 'newlines in names cannot inject lines');
process.exit(fail ? 1 : 0);
