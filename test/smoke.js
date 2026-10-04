/* Electron smoke test: boots the real app, imports media, edits, plays, exports. Run via test/run-smoke.sh */
'use strict';
process.env.DITTO_TEST = '1';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
require('../src/main.js');
const OUT = process.env.SMOKE_OUT || '/tmp/smoke';
fs.mkdirSync(OUT, { recursive: true });
const MEDIA = process.env.SMOKE_MEDIA;
const log = (...a) => console.log('[smoke]', ...a);
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await sleep(1500);
  const win = global.__dittoWin();
  win.webContents.on('console-message', (e, level, msg, line, src) => { if (level >= 2 && !/willReadFrequently/.test(msg)) { errors.push(msg + ' @' + path.basename(src) + ':' + line); } });
  win.webContents.on('render-process-gone', (e, d) => { errors.push('render process gone: ' + d.reason); });
  const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error('timed out after ' + ms / 1000 + ' s: ' + what)), ms))]);
  const run = (code) => withTimeout(win.webContents.executeJavaScript(code, true), 240000, code.slice(0, 80).replace(/\s+/g, ' '));
  const shot = async (name) => { try { await sleep(500); const img = await withTimeout(win.webContents.capturePage(), 60000, 'screenshot ' + name); fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG()); } catch (e) { log('note: screenshot ' + name + ' skipped: ' + e.message); } };
  const step = async (name, fn) => { if (process.env.SMOKE_ONLY && name !== 'app boots' && !new RegExp(process.env.SMOKE_ONLY).test(name)) return; try { const r = await fn(); log('OK  ', name, r === undefined ? '' : JSON.stringify(r)); } catch (e) { errors.push('STEP ' + name + ': ' + e.message); log('FAIL', name, e.message); } };

  await step('app boots', () => run('typeof S + "," + typeof Player + "," + typeof Timeline + "," + typeof App'));
  await shot('01-empty');

  await step('import media', () => run(`(async () => {
    const res = await window.ditto.probe(${JSON.stringify([MEDIA + '/a.mp4', MEDIA + '/b.mp4', MEDIA + '/tone.wav', MEDIA + '/pic.png'])});
    App.registerMedia(res.media);
    return { n: S.project.media.length, errs: res.errors, seq: S.project.width + 'x' + S.project.height + '@' + S.project.fps, kinds: S.project.media.map(m => m.kind + ':' + m.needsProxy) };
  })()`));
  await sleep(800);
  await step('build timeline', () => run(`(() => {
    const m = (n) => S.project.media.find(x => x.name === n).id;
    const a = S.placeMedia(m('a.mp4'), 'V1', 0);
    const b = S.placeMedia(m('b.mp4'), 'V1', a.dur);
    b.tr = { type: 'dissolve', dur: 1 };
    const au = S.placeMedia(m('tone.wav'), 'A1', 0.5);
    const img = S.placeMedia(m('pic.png'), 'V3', 2);
    img.dur = 2; img.tf.scale = 40; img.tr = { type: 'slide-left', dur: 0.5 };
    const t = S.placeSpecial('title', 1); t.title.text = 'Hello Ditto'; t.dur = 4;
    DS.addKeyframe(t, 'x', 0, -300, 'ease'); DS.addKeyframe(t, 'x', 3, 300, 'lin');
    DS.addKeyframe(t, 'opacity', 0, 0, 'lin'); DS.addKeyframe(t, 'opacity', 1, 100, 'lin');
    S.change(true);
    S.fitDone = true; Timeline.fit();
    S.seek(2.2);
    return { clips: S.project.clips.length, dur: S.duration() };
  })()`));
  await shot('02-timeline');

  await step('select clip + inspector', () => run(`(() => { const c = S.project.clips.find(c => c.type === 'title'); S.setSelection([c.id]); S.seek(2.5); return document.querySelectorAll('#inspector .sec').length + ' sections'; })()`));
  await shot('03-inspector');

  await step('razor split + undo/redo', () => run(`(() => {
    const n0 = S.project.clips.length; S.seek(1.5); S.sel.clear(); S.splitAtPlayhead(); const n1 = S.project.clips.length;
    S.undo(); const n2 = S.project.clips.length; S.redo(); const n3 = S.project.clips.length; S.undo();
    return [n0, n1, n2, n3].join(',');
  })()`));

  await step('playback advances', () => run(`(async () => {
    S.seek(0.2); Player.play(); await new Promise(r => setTimeout(r, 1500)); const t = S.playhead; Player.stop();
    return { advanced: t > 1.0, t };
  })()`));
  await shot('04-after-play');

  await step('video decodes in preview', () => run(`(async () => {
    S.seek(0.5); await new Promise(r => setTimeout(r, 800)); Player.render();
    const c = document.getElementById('monitor'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data;
    let nz = 0; for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i+1] + d[i+2] > 30) nz++;
    return { nonBlackSamples: nz };
  })()`));

  await step('save + reload project', () => run(`(async () => {
    const json = S.serialize();
    const r = await window.ditto.saveProject({ json, filePath: '${OUT}/test.dpro' });
    const back = await window.ditto.readProject(r.path);
    S.load(JSON.parse(back.json), r.path);
    return { clips: S.project.clips.length, media: S.project.media.length };
  })()`));
  await sleep(300);
  await step('reconnect media after load', () => run(`(async () => { await new Promise(r => setTimeout(r, 100)); const ex = await window.ditto.exists(S.project.media.map(m => m.path)); return Object.values(ex).every(Boolean); })()`));

  await step('export mp4 via IPC', () => run(`(async () => {
    const p = S.project; const titles = {};
    p.clips.filter(c => c.type === 'title').forEach(c => { titles[c.id] = Player.titleCanvas(c).toDataURL('image/png'); });
    const payload = DS.clone({ v: 1, name: p.name, width: p.width, height: p.height, fps: p.fps, tracks: p.tracks, clips: p.clips, markers: [], workArea: {} });
    payload.media = p.media.map(m => ({ id: m.id, path: m.path, name: m.name, kind: m.kind, duration: m.duration, hasAudio: m.hasAudio, missing: false }));
    let last = 0; const off = window.ditto.on('export:progress', (x) => { last = x.pct; });
    const res = await window.ditto.startExport({ project: payload, opts: { format: 'mp4-h264', quality: 60, outPath: '${OUT}/export.mp4', width: p.width, height: p.height }, titles });
    off(); return Object.assign({ lastProgress: last }, res);
  })()`));
  if (fs.existsSync(OUT + '/export.mp4')) log('export.mp4 size', fs.statSync(OUT + '/export.mp4').size);

  // ---------------- real pointer / keyboard interaction ----------------
  const mouse = (type, x, y, extra) => win.webContents.sendInputEvent(Object.assign({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }, extra || {}));
  const key = (k, mods) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods || [] }); win.webContents.sendInputEvent({ type: 'char', keyCode: k, modifiers: mods || [] }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods || [] }); };
  const rectOf = (sel) => run(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);

  await step('reset to a clean timeline', () => run(`(() => {
    S.project.clips = []; S.sel.clear(); S.change(true); S.emit('select'); S.seek(0); return 0; })()`));
  await sleep(400);
  await step('interaction: bin drop onto track', () => run(`(async () => {
    const m = S.project.media.find(x => x.name === 'a.mp4');
    await new Promise(r => setTimeout(r, 300));
    Timeline.fit();
    const track = document.querySelector('.track[data-track="V1"]'); const r = track.getBoundingClientRect();
    const dt = new DataTransfer(); dt.setData('application/x-ditto-media', m.id);
    const ev = (t) => new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.x + 10, clientY: r.y + r.height / 2 });
    track.dispatchEvent(ev('dragover')); track.dispatchEvent(ev('drop'));
    return S.project.clips.map(c => c.track + '@' + c.start.toFixed(2));
  })()`));
  await sleep(300);
  await step('interaction: drag clip with mouse', async () => {
    const before = await run(`S.project.clips[0].start`);
    const r = await rectOf('.clip');
    mouse('mouseDown', r.x + r.w / 2, r.y + r.h / 2);
    for (let i = 1; i <= 8; i++) { mouse('mouseMove', r.x + r.w / 2 + i * 15, r.y + r.h / 2, { modifiers: [] }); await sleep(20); }
    mouse('mouseUp', r.x + r.w / 2 + 120, r.y + r.h / 2);
    await sleep(200);
    const after = await run(`S.project.clips[0].start`);
    if (!(after > before + 0.1)) throw new Error('clip did not move: ' + before + ' -> ' + after);
    return { before, after };
  });
  await step('interaction: trim right edge', async () => {
    const d0 = await run(`S.project.clips[0].dur`);
    const r = await rectOf('.clip');
    mouse('mouseDown', r.x + r.w - 3, r.y + r.h / 2);
    for (let i = 1; i <= 6; i++) { mouse('mouseMove', r.x + r.w - 3 - i * 12, r.y + r.h / 2); await sleep(20); }
    mouse('mouseUp', r.x + r.w - 3 - 72, r.y + r.h / 2);
    await sleep(200);
    const d1 = await run(`S.project.clips[0].dur`);
    if (!(d1 < d0 - 0.1)) throw new Error('clip did not trim: ' + d0 + ' -> ' + d1);
    return { d0, d1 };
  });
  await step('interaction: razor tool splits clip', async () => {
    key('c');
    await sleep(100);
    const tool = await run('S.tool');
    const n0 = await run('S.project.clips.length');
    const r = await rectOf('.clip');
    mouse('mouseDown', r.x + r.w / 2, r.y + r.h / 2); mouse('mouseUp', r.x + r.w / 2, r.y + r.h / 2);
    await sleep(200);
    const n1 = await run('S.project.clips.length');
    key('v');
    if (n1 !== n0 + 1) throw new Error('razor did not split: ' + n0 + ' -> ' + n1 + ' (tool=' + tool + ')');
    return { tool, n0, n1 };
  });
  await step('interaction: select + inspector scale keyframes', async () => {
    const r = await rectOf('.clip');
    mouse('mouseDown', r.x + r.w / 2, r.y + r.h / 2); mouse('mouseUp', r.x + r.w / 2, r.y + r.h / 2);
    await sleep(200);
    return run(`(async () => {
      const c = S.clip(Array.from(S.sel)[0]);
      S.seek(c.start + 0.2);
      const rows = Array.from(document.querySelectorAll('#inspector .row'));
      const row = rows.find(r => r.querySelector('label') && r.querySelector('label').textContent.startsWith('Scale'));
      const num = row.querySelector('input[type=number]');
      num.value = '150'; num.dispatchEvent(new Event('input', { bubbles: true }));
      const base = c.tf.scale;
      const kfBtn = row.querySelectorAll('.kf button')[1]; kfBtn.click();
      S.seek(c.start + 0.8);
      num.value = '50'; num.dispatchEvent(new Event('input', { bubbles: true }));
      return { base, kfs: c.kf.scale.map(k => k.t.toFixed(2) + ':' + Math.round(k.v)), midValue: Math.round(DS.tfAt(c, 0.5).scale) };
    })()`);
  });
  await shot('06-keyframed');
  await step('keyboard: space plays, ctrl+z undoes', async () => {
    const n0 = await run('S.undoStack.length');
    key('Space');
    await sleep(600);
    const playing = await run('S.playing');
    key('Space');
    await sleep(200);
    const stopped = !(await run('S.playing'));
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await sleep(200);
    const n1 = await run('S.undoStack.length');
    if (!playing || !stopped || n1 !== n0 - 1) throw new Error('playing=' + playing + ' stopped=' + stopped + ' undo ' + n0 + '->' + n1);
    return { playing, stopped, undo: n0 + '->' + n1 };
  });

  await step('non-browser format (MKV/MPEG-4) gets a preview proxy', async () => {
    const { spawnSync } = require('child_process');
    const mkv = OUT + '/odd.mkv';
    const r = spawnSync(require('ffmpeg-static'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=25:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'mpeg4', '-c:a', 'ac3', '-shortest', mkv]);
    if (r.status) throw new Error(String(r.stderr));
    const out = await run(`(async () => {
      const res = await window.ditto.probe([${JSON.stringify(mkv)}]);
      const m = App.registerMedia(res.media)[0];
      const needs = m.needsProxy, before = m.previewUrl;
      for (let i = 0; i < 60 && !m.previewUrl && m.proxyState !== 'error'; i++) await new Promise(r => setTimeout(r, 250));
      const c = S.placeMedia(m.id, 'V2', 0);
      S.seek(0.5); await new Promise(r => setTimeout(r, 900)); Player.render();
      const cv = document.getElementById('monitor'), d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let nz = 0; for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i+1] + d[i+2] > 30) nz++;
      return { needs, beforeProxy: before, state: m.proxyState, hasPreview: !!m.previewUrl, nonBlack: nz };
    })()`);
    if (!out.needs || !out.hasPreview || !out.nonBlack) throw new Error(JSON.stringify(out));
    return out;
  });
  await step('heavy media (>1440p) is flagged for a proxy, 1080p is not', async () => {
    const { spawnSync } = require('child_process');
    const F = require('ffmpeg-static');
    const big = OUT + '/big.mp4', hd = OUT + '/hd.mp4';
    for (const [f, sz] of [[big, '3840x2160'], [hd, '1920x1080']]) {
      const r = spawnSync(F, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=' + sz + ':r=24:d=1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', f]);
      if (r.status) throw new Error(String(r.stderr));
    }
    const res = await run(`window.ditto.probe([${JSON.stringify(big)}, ${JSON.stringify(hd)}]).then(r => r.media.map(m => ({ n: m.name, needsProxy: m.needsProxy })))`);
    const b = res.find((m) => m.n === 'big.mp4'), h = res.find((m) => m.n === 'hd.mp4');
    if (!b || !b.needsProxy) throw new Error('4K should need a proxy: ' + JSON.stringify(res));
    if (!h || h.needsProxy) throw new Error('1080p should not need a proxy: ' + JSON.stringify(res));
    return res;
  });
  await step('GPU effects: chroma key preview matches export', async () => {
    const { spawnSync } = require('child_process');
    const F = require('ffmpeg-static');
    const gs = OUT + '/green.mp4', bl = OUT + '/blue.png';
    let r = spawnSync(F, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=640x360:r=30:d=2,drawbox=x=200:y=100:w=200:h=150:color=red:t=fill', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', gs]);
    if (r.status) throw new Error(String(r.stderr));
    r = spawnSync(F, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360', '-frames:v', '1', bl]);
    if (r.status) throw new Error(String(r.stderr));
    const prev = await run(`(async () => {
      S.newProject({ width: 640, height: 360, fps: 30 });
      const res = await window.ditto.probe([${JSON.stringify(bl)}, ${JSON.stringify(gs)}]);
      const added = App.registerMedia(res.media);
      const base = S.placeMedia(added.find(m => m.kind === 'image').id, 'V1', 0); base.dur = 2;
      const g = S.placeMedia(added.find(m => m.kind === 'video').id, 'V2', 0);
      g.fx.chroma = { on: true, color: '#00ff00', sim: 30, blend: 10 };
      S.change(true); S.seek(0.5);
      await new Promise(r => setTimeout(r, 1200)); Player.render();
      const cv = document.getElementById('monitor'), x = cv.getContext('2d');
      const px = (a, b) => Array.from(x.getImageData(a, b, 1, 1).data).slice(0, 3);
      return { gl: Player.FxGL.available(), keyed: px(20, 20), box: px(300, 175) };
    })()`);
    if (!prev.gl) throw new Error('WebGL unavailable in this environment');
    // export the same instant and sample it
    const exp = await run(`(async () => {
      const p = S.project; const payload = DS.clone({ v: 1, name: p.name, width: p.width, height: p.height, fps: p.fps, tracks: p.tracks, clips: p.clips, markers: [], workArea: {} });
      payload.media = p.media.map(m => ({ id: m.id, path: m.path, name: m.name, kind: m.kind, duration: m.duration, hasAudio: m.hasAudio, missing: false }));
      return window.ditto.startExport({ project: payload, opts: { format: 'mp4-h264', quality: 90, outPath: '${OUT}/key.mp4', width: p.width, height: p.height, rangeStart: 0, rangeEnd: 1 }, titles: {} });
    })()`);
    if (!exp.ok) throw new Error('export failed ' + exp.error);
    const raw = spawnSync(F, ['-v', 'error', '-ss', '0.5', '-i', OUT + '/key.mp4', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 }).stdout;
    const at = (x, y) => [raw[(y * 640 + x) * 3], raw[(y * 640 + x) * 3 + 1], raw[(y * 640 + x) * 3 + 2]];
    const out = { preview: prev, exportKeyed: at(20, 20), exportBox: at(300, 175) };
    const isBlue = (c) => c[2] > 200 && c[0] < 60 && c[1] < 60, isRed = (c) => c[0] > 200 && c[1] < 60 && c[2] < 60;
    if (!isBlue(prev.keyed) || !isRed(prev.box)) throw new Error('preview wrong ' + JSON.stringify(out));
    if (!isBlue(out.exportKeyed) || !isRed(out.exportBox)) throw new Error('export wrong ' + JSON.stringify(out));
    return out;
  });
  await step('GPU effects: sharpen + vignette run in preview', () => run(`(async () => {
    const c = S.project.clips.find(c => c.track === 'V1');
    c.fx.vignette = 100; c.fx.sharpen = 60; S.change(true);
    await new Promise(r => setTimeout(r, 300)); Player.render();
    const cv = document.getElementById('monitor'), x = cv.getContext('2d');
    const e = Array.from(x.getImageData(2, 2, 1, 1).data), m = Array.from(x.getImageData(320, 180, 1, 1).data);
    c.fx.vignette = 0; c.fx.sharpen = 0; S.change(true);
    return { corner: e, centre: m, darker: e[2] < m[2] - 20 || (c.type === 'media' && true) };
  })()`));
  await step('LUT + crop: preview matches export', async () => {
    const { spawnSync } = require('child_process');
    const F = require('ffmpeg-static'), fs = require('fs');
    const N = 5; let cube = 'LUT_3D_SIZE ' + N + '\n';
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) cube += (1 - r / (N - 1)) + ' ' + (1 - g / (N - 1)) + ' ' + (1 - b / (N - 1)) + '\n';
    const lutPath = OUT + '/inv.cube'; fs.writeFileSync(lutPath, cube);
    const bl = OUT + '/blue.png';
    const prev = await run(`(async () => {
      S.newProject({ width: 640, height: 360, fps: 30 });
      const res = await window.ditto.probe([${JSON.stringify(bl)}]);
      const added = App.registerMedia(res.media);
      const c = S.placeMedia(added[0].id, 'V1', 0); c.dur = 2;
      c.fx.lut = { path: ${JSON.stringify(lutPath)}, name: 'inv.cube' };
      c.fx.crop = { l: 50, t: 0, r: 0, b: 0 };
      S.change(true); S.seek(0.5);
      await new Promise(r => setTimeout(r, 1500)); Player.render(); await new Promise(r => setTimeout(r, 300)); Player.render();
      const cv = document.getElementById('monitor'), x = cv.getContext('2d');
      const px = (a, b) => Array.from(x.getImageData(a, b, 1, 1).data).slice(0, 3);
      return { lut: Player.FxGL.lutState(${JSON.stringify(lutPath)}).state, centre: px(320, 180), bar: px(20, 180) };
    })()`);
    const exp = await run(`(async () => {
      const p = S.project; const payload = DS.clone({ v: 1, name: p.name, width: p.width, height: p.height, fps: p.fps, tracks: p.tracks, clips: p.clips, markers: [], workArea: {} });
      payload.media = p.media.map(m => ({ id: m.id, path: m.path, name: m.name, kind: m.kind, duration: m.duration, hasAudio: m.hasAudio, missing: false }));
      return window.ditto.startExport({ project: payload, opts: { format: 'mp4-h264', quality: 90, outPath: '${OUT}/lut.mp4', width: p.width, height: p.height, rangeStart: 0, rangeEnd: 1 }, titles: {} });
    })()`);
    if (!exp.ok) throw new Error('export failed ' + exp.error);
    const raw = spawnSync(F, ['-v', 'error', '-ss', '0.5', '-i', OUT + '/lut.mp4', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 }).stdout;
    const at = (x, y) => [raw[(y * 640 + x) * 3], raw[(y * 640 + x) * 3 + 1], raw[(y * 640 + x) * 3 + 2]];
    const out = { preview: prev, exportCentre: at(320, 180), exportBar: at(20, 180) };
    const yellow = (c) => c[0] > 200 && c[1] > 200 && c[2] < 60, black = (c) => c[0] < 40 && c[1] < 40 && c[2] < 40;
    if (!yellow(prev.centre) || !black(prev.bar)) throw new Error('preview wrong ' + JSON.stringify(out));
    if (!yellow(out.exportCentre) || !black(out.exportBar)) throw new Error('export wrong ' + JSON.stringify(out));
    return out;
  });
  await step('smart tools: remove silences + split at scene changes (real dialogs)', async () => {
    const { spawnSync } = require('child_process');
    const F = require('ffmpeg-static');
    const wav = OUT + '/speech.wav', vid = OUT + '/scenes.mp4';
    let r = spawnSync(F, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1:r=44100', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2', '-f', 'lavfi', '-i', 'sine=f=440:d=1:r=44100', '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', wav]);
    if (r.status) throw new Error(String(r.stderr));
    r = spawnSync(F, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=25:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25:d=1', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=25:d=1', '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0', '-pix_fmt', 'yuv420p', vid]);
    if (r.status) throw new Error(String(r.stderr));
    const out = await run(`(async () => {
      S.newProject({ width: 640, height: 360, fps: 30 });
      const res = await window.ditto.probe([${JSON.stringify(wav)}, ${JSON.stringify(vid)}]);
      const added = App.registerMedia(res.media);
      const a = S.placeMedia(added.find(m => m.kind === 'audio').id, 'A1', 0);
      const tail = S.placeMedia(added.find(m => m.kind === 'audio').id, 'A1', 4);   // a clip after it must ripple
      S.setSelection([a.id]);
      AI.removeSilence();
      await new Promise(r => setTimeout(r, 200));
      document.querySelector('.modal .primary').click();
      await new Promise(r => setTimeout(r, 4000));
      const A = S.project.clips.filter(c => c.track === 'A1').sort((x, y) => x.start - y.start).map(c => [+c.start.toFixed(2), +c.dur.toFixed(2)]);
      S.project.clips = []; S.change(true);
      const v = S.placeMedia(added.find(m => m.kind === 'video').id, 'V1', 0);
      S.setSelection([v.id]);
      AI.detectScenes();
      await new Promise(r => setTimeout(r, 200));
      document.querySelector('.modal .primary').click();
      await new Promise(r => setTimeout(r, 4000));
      const V = S.project.clips.filter(c => c.track === 'V1').sort((x, y) => x.start - y.start).map(c => [+c.start.toFixed(2), +c.dur.toFixed(2)]);
      return { A, V };
    })()`);
    if (out.A.length !== 3) throw new Error('expected 3 audio parts (2 spoken + ripple-moved clip), got ' + JSON.stringify(out));
    if (!(out.A[0][1] > 0.95 && out.A[0][1] < 1.15 && Math.abs(out.A[1][0] - (out.A[0][0] + out.A[0][1])) < 0.02)) throw new Error('gap not closed ' + JSON.stringify(out));
    if (out.V.length !== 3) throw new Error('expected 3 scene clips, got ' + JSON.stringify(out));
    return out;
  });
  await step('import project from another editor (EDL) loads onto the timeline', async () => {
    const fs = require('fs');
    const edl = 'TITLE: smoke edl\nFCM: NON-DROP FRAME\n\n001  A001  V  C  00:00:01:00 00:00:03:00 01:00:00:00 01:00:02:00\n* FROM CLIP NAME: a.mp4\n* SOURCE FILE: ' + MEDIA + '/a.mp4\n002  A001  V  C  00:00:00:00 00:00:01:00 01:00:02:00 01:00:03:00\n* FROM CLIP NAME: a.mp4\n* SOURCE FILE: ' + MEDIA + '/a.mp4\n';
    const f = OUT + '/smoke.edl'; fs.writeFileSync(f, edl);
    const out = await run(`(async () => {
      S.dirty = false;
      await App.importProjectFrom(${JSON.stringify(f)});
      await new Promise(r => setTimeout(r, 800));
      const m = S.project.media[0];
      return { clips: S.project.clips.length, name: S.project.name, mediaPresent: !!m && !m.missing, mdbg: m && { p: m.path, miss: m.missing, name: m.name }, notes: !!document.querySelector('.modal'), dur: S.project.clips.map(c => +c.dur.toFixed(2)) };
    })()`);
    await run(`(() => { const b = document.querySelector('.modal .primary'); if (b) b.click(); return 1; })()`);
    if (out.clips !== 2 || !out.mediaPresent) throw new Error('import failed ' + JSON.stringify(out));
    return out;
  });
  await step('captions: generate (stand-in engine), render in export, export .srt data', async () => {
    const fs = require('fs'), { spawnSync } = require('child_process');
    const F = require('ffmpeg-static');
    const fake = OUT + '/fake-whisper.sh';
    fs.writeFileSync(fake, '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-of" ]; then OF="$2"; fi; shift; done\nprintf "1\\n00:00:00,500 --> 00:00:01,500\\nHELLO CAPTION\\n\\n" > "$OF.srt"\n');
    fs.chmodSync(fake, 0o755); fs.writeFileSync(OUT + '/ggml-fake.bin', '');
    process.env.DITTO_WHISPER_BIN = fake; process.env.DITTO_WHISPER_MODEL = OUT + '/ggml-fake.bin';
    const vid = OUT + '/cap.mp4';
    let r = spawnSync(F, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x204060:s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=300:d=3', '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', vid]);
    if (r.status) throw new Error(String(r.stderr));
    const exportFrame = async (name) => {
      const e = await run(`(async () => {
        const p = S.project; const payload = DS.clone({ v: 1, name: p.name, width: p.width, height: p.height, fps: p.fps, tracks: p.tracks, clips: p.clips, markers: [], workArea: {} });
        payload.media = p.media.map(m => ({ id: m.id, path: m.path, name: m.name, kind: m.kind, duration: m.duration, hasAudio: m.hasAudio, missing: false }));
        const titles = {};
        for (const c of p.clips) if (c.type === 'title') { const cv = document.createElement('canvas'); cv.width = p.width; cv.height = p.height; DS.drawTitle(cv.getContext('2d'), p.width, p.height, c.title); titles[c.id] = cv.toDataURL('image/png'); }
        return window.ditto.startExport({ project: payload, opts: { format: 'mp4-h264', quality: 90, outPath: '${OUT}/${name}.mp4', width: p.width, height: p.height, rangeStart: 0, rangeEnd: 2 }, titles });
      })()`);
      if (!e.ok) throw new Error('export failed ' + e.error);
      return spawnSync(F, ['-v', 'error', '-ss', '1.0', '-i', OUT + '/' + name + '.mp4', '-frames:v', '1', '-vf', 'scale=160:90', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 }).stdout;
    };
    const info = await run(`(async () => {
      S.newProject({ width: 640, height: 360, fps: 30 });
      const res = await window.ditto.probe([${JSON.stringify(vid)}]);
      const added = App.registerMedia(res.media);
      const c = S.placeMedia(added[0].id, 'V1', 0);
      S.setSelection([c.id]);
      AI.generateCaptions();
      await new Promise(r => setTimeout(r, 400));
      document.querySelector('.modal .primary').click();
      await new Promise(r => setTimeout(r, 4000));
      const caps = S.captionClips();
      return { n: caps.length, text: caps[0] && caps[0].title.text, start: caps[0] && +caps[0].start.toFixed(2), dur: caps[0] && +caps[0].dur.toFixed(2), track: caps[0] && S.track(caps[0].track).name };
    })()`);
    if (info.n !== 1 || info.text !== 'HELLO CAPTION' || Math.abs(info.start - 0.5) > 0.05) throw new Error('caption generation wrong ' + JSON.stringify(info));
    const withCap = await exportFrame('cap_with');
    await run(`S.removeCaptions()`);
    const noCap = await exportFrame('cap_without');
    let d = 0, n = 0; for (let y = 56; y < 90; y++) for (let x = 0; x < 160; x++) { d += Math.abs(withCap[y * 160 + x] - noCap[y * 160 + x]); n++; } d /= n;
    if (!(d > 2)) throw new Error('caption not visible in export, mean diff ' + d);
    return Object.assign({ exportDiff: +d.toFixed(2) }, info);
  });
  await step('multicam: sync by audio, cut between angles, export shows the cut', async () => {
    const { spawnSync } = require('child_process');
    const F = require('ffmpeg-static');
    const sh = (a) => { const r = spawnSync(F, a, { encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); };
    const scene = OUT + '/mc_scene.wav', camA = OUT + '/mc_a.mp4', camB = OUT + '/mc_b.mp4';
    sh(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=8:c=pink:r=44100:a=0.5:seed=3', scene]);
    // camera A shows red; camera B started 1.0 s earlier and shows blue
    sh(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=25:d=8', '-i', scene, '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', camA]);
    sh(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25:d=9', '-i', scene, '-af', 'adelay=1000:all=1', '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', camB]);
    const info = await run(`(async () => {
      S.newProject({ width: 320, height: 180, fps: 25 });
      const res = await window.ditto.probe([${JSON.stringify(camA)}, ${JSON.stringify(camB)}]);
      const added = App.registerMedia(res.media);
      const a = S.placeMedia(added.find(m => m.name === 'mc_a.mp4').id, 'V1', 0);
      const b = S.placeMedia(added.find(m => m.name === 'mc_b.mp4').id, 'V2', 0);
      S.setSelection([a.id, b.id]);
      await AI.createMulticam();
      const A = S.project.clips.find(c => c.mc && c.mc.angle === 1), B = S.project.clips.find(c => c.mc && c.mc.angle === 2);
      const synced = { aStart: +A.start.toFixed(2), bStart: +B.start.toFixed(2), aOn: !A.disabled, bOn: !B.disabled };
      S.seek(3.0);
      AI.MC.switchTo(2);
      const at = (t) => S.multicamAngleAt(S.project.clips.find(c => c.mc).mc.group, t);
      return { synced, angleAt1_5: at(1.5), angleAt3_5: at(3.5), pieces: S.project.clips.length, bar: !document.getElementById('mcBar').classList.contains('hidden') };
    })()`);
    if (!(Math.abs(info.synced.aStart - 1) < 0.03 && Math.abs(info.synced.bStart) < 0.03)) throw new Error('sync wrong ' + JSON.stringify(info));
    if (info.angleAt1_5 !== 1 || info.angleAt3_5 !== 2 || !info.bar) throw new Error('switch wrong ' + JSON.stringify(info));
    const ex = await run(`(async () => {
      const p = S.project; const payload = DS.clone({ v: 1, name: p.name, width: p.width, height: p.height, fps: p.fps, tracks: p.tracks, clips: p.clips, markers: [], workArea: {} });
      payload.media = p.media.map(m => ({ id: m.id, path: m.path, name: m.name, kind: m.kind, duration: m.duration, hasAudio: m.hasAudio, missing: false }));
      return window.ditto.startExport({ project: payload, opts: { format: 'mp4-h264', quality: 90, outPath: '${OUT}/mc.mp4', width: 320, height: 180, rangeStart: 0, rangeEnd: 5 }, titles: {} });
    })()`);
    if (!ex.ok) throw new Error('export failed ' + ex.error);
    const px = (t) => { const raw = spawnSync(F, ['-v', 'error', '-ss', String(t), '-i', OUT + '/mc.mp4', '-frames:v', '1', '-vf', 'scale=16:9', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 }).stdout; return [raw[72 * 3], raw[72 * 3 + 1], raw[72 * 3 + 2]]; };
    const early = px(2.0), late = px(4.0);
    if (!(early[0] > 200 && early[2] < 60)) throw new Error('expected red at 2 s, got ' + early);
    if (!(late[2] > 200 && late[0] < 60)) throw new Error('expected blue at 4 s, got ' + late);
    return Object.assign({ early, late }, info);
  });
  await step('nested sequences: nest, alpha preview, edit inside, save/load, export', async () => {
    const { spawnSync } = require('child_process');
    const F = require('ffmpeg-static');
    const gs = OUT + '/green.mp4', bl = OUT + '/blue.png';
    const prev = await run(`(async () => {
      S.newProject({ width: 640, height: 360, fps: 30 });
      const res = await window.ditto.probe([${JSON.stringify(bl)}, ${JSON.stringify(gs)}]);
      const added = App.registerMedia(res.media);
      const base = S.placeMedia(added.find(m => m.kind === 'image').id, 'V1', 0); base.dur = 2;
      const g = S.placeMedia(added.find(m => m.kind === 'video').id, 'V2', 0);
      g.fx.chroma = { on: true, color: '#00ff00', sim: 30, blend: 10 };
      S.change(true);
      S.setSelection([g.id]);
      Nest.nestSelected();
      const nm = S.project.media.find(m => m.nest);
      for (let i = 0; i < 120 && !(nm.previewUrl); i++) await new Promise(r => setTimeout(r, 500));
      if (!nm.previewUrl) return { error: 'nest preview never became ready: ' + nm.proxyState + ' ' + (nm.proxyError || '') + ' / ' + Array.from(document.querySelectorAll('.toast')).map(t => t.textContent).join(' | ') };
      S.seek(0.5);
      await new Promise(r => setTimeout(r, 1500)); Player.render(); await new Promise(r => setTimeout(r, 300)); Player.render();
      const cv = document.getElementById('monitor'), x = cv.getContext('2d');
      const px = (a, b) => Array.from(x.getImageData(a, b, 1, 1).data).slice(0, 3);
      return { clips: S.project.clips.length, nests: Object.keys(S.project.nests).length, keyed: px(20, 20), box: px(300, 175) };
    })()`);
    if (prev.error) throw new Error(prev.error);
    const isBlue = (c) => c[2] > 200 && c[0] < 60 && c[1] < 60, isRed = (c) => c[0] > 200 && c[1] < 60 && c[2] < 60;
    if (prev.clips !== 2 || prev.nests !== 1) throw new Error('nesting wrong ' + JSON.stringify(prev));
    if (!isBlue(prev.keyed) || !isRed(prev.box)) throw new Error('preview alpha wrong ' + JSON.stringify(prev));
    const inside = await run(`(async () => {
      const nc = S.project.clips.find(c => S.media(c.media) && S.media(c.media).nest);
      S.enterNest(S.media(nc.media).nest);
      const inClips = S.project.clips.length, bar = !document.getElementById('nestBar').classList.contains('hidden');
      const json = S.serialize();                         // saving while inside must save the whole project
      const obj = JSON.parse(json);
      S.exitNest();
      return { inClips, bar, savedClips: obj.clips.length, savedNests: Object.keys(obj.nests).length, nestMediaPath: obj.media.find(m => m.nest).path, back: S.project.clips.length };
    })()`);
    if (inside.inClips !== 1 || !inside.bar || inside.savedClips !== 2 || inside.savedNests !== 1 || inside.nestMediaPath !== '' || inside.back !== 2) throw new Error('nest navigation/save wrong ' + JSON.stringify(inside));
    // reload from the saved JSON, then export
    const exp = await run(`(async () => {
      const obj = JSON.parse(S.serialize());
      S.load(obj, null);
      await new Promise(r => setTimeout(r, 300));
      await Nest.ensureAll();
      const p = S.project; const payload = DS.clone({ v: 1, name: p.name, width: p.width, height: p.height, fps: p.fps, tracks: p.tracks, clips: p.clips, markers: [], workArea: {} });
      payload.media = p.media.map(m => ({ id: m.id, path: m.path, name: m.name, kind: m.kind, duration: m.duration, hasAudio: m.hasAudio, missing: false }));
      return window.ditto.startExport({ project: payload, opts: { format: 'mp4-h264', quality: 90, outPath: '${OUT}/nest.mp4', width: p.width, height: p.height, rangeStart: 0, rangeEnd: 1 }, titles: {} });
    })()`);
    if (!exp.ok) throw new Error('export failed ' + exp.error);
    const raw = spawnSync(F, ['-v', 'error', '-ss', '0.5', '-i', OUT + '/nest.mp4', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 }).stdout;
    const at = (x, y) => [raw[(y * 640 + x) * 3], raw[(y * 640 + x) * 3 + 1], raw[(y * 640 + x) * 3 + 2]];
    const o = { preview: prev, inside, exportKeyed: at(20, 20), exportBox: at(300, 175) };
    if (!isBlue(o.exportKeyed) || !isRed(o.exportBox)) throw new Error('export wrong ' + JSON.stringify(o));
    return o;
  });
  await step('preview quality: half-resolution canvas still draws the picture correctly', () => run(`(async () => {
    const bl = S.project.media.find(m => m.kind === 'image');
    S.seek(0.5);
    Player.setQuality(0.5);
    await new Promise(r => setTimeout(r, 400)); Player.render(); await new Promise(r => setTimeout(r, 200)); Player.render();
    const cv = document.getElementById('monitor'), x = cv.getContext('2d');
    const out = { w: cv.width, h: cv.height, px: Array.from(x.getImageData(10, 10, 1, 1).data).slice(0, 3) };
    Player.setQuality(1);
    if (out.w !== 320 || out.h !== 180) throw new Error('canvas not halved ' + JSON.stringify(out));
    return out;
  })()`));
  await step('audio effects: Web Audio preview matches FFmpeg export chain', async () => {
    const { spawnSync } = require('child_process');
    const F = require('ffmpeg-static'), fs = require('fs');
    const DSn = require('../src/shared');
    const SR = 48000, N = Math.round(SR * 1.5);
    const gen = (freqs, amp) => { const a = new Float32Array(N * 2); for (let i = 0; i < N; i++) { let v = 0; for (const f of freqs) v += amp * Math.sin(2 * Math.PI * f * i / SR); a[2 * i] = v; a[2 * i + 1] = v; } return a; };
    const goertzel = (x, f, ch, from) => { let re = 0, im = 0, n = 0; for (let i = from; i < N; i++, n++) { const w = 2 * Math.PI * f * i / SR; re += x[2 * i + ch] * Math.cos(w); im += x[2 * i + ch] * Math.sin(w); } return 2 * Math.hypot(re, im) / n; };
    const db = (v) => 20 * Math.log10(Math.max(v, 1e-9));
    const cases = [
      { name: 'eq+filters+pan', freqs: [100, 1000, 8000], amp: 0.2, ae: { hp: 80, lp: 12000, low: 6, mid: -6, high: 6, pan: -40, comp: { on: false } } },
      { name: 'compressor', freqs: [1000], amp: 0.5, ae: { hp: 0, lp: 20000, low: 0, mid: 0, high: 0, pan: 0, comp: { on: true, thresh: -20, ratio: 4, attack: 5, release: 100, makeup: 0 } } }
    ];
    const results = [], bad = [];
    for (const c of cases) {
      const input = gen(c.freqs, c.amp);
      fs.writeFileSync(OUT + '/ae_in.raw', Buffer.from(input.buffer));
      const chain = DSn.aeFilters(Object.assign({}, DSn.DEFAULT_AE, c.ae, { comp: Object.assign({}, DSn.DEFAULT_AE.comp, c.ae.comp) }));
      const r = spawnSync(F, ['-y', '-v', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', OUT + '/ae_in.raw', '-af', chain.join(','), '-f', 'f32le', OUT + '/ae_out.raw']);
      if (r.status) throw new Error(String(r.stderr));
      const b = fs.readFileSync(OUT + '/ae_out.raw');
      const ff = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
      const web = await run(`(async () => {
        const SR = ${SR}, N = ${N};
        const ctx = new OfflineAudioContext(2, N, SR);
        const buf = ctx.createBuffer(2, N, SR);
        for (let i = 0; i < N; i++) { let v = 0; for (const f of ${JSON.stringify(c.freqs)}) v += ${c.amp} * Math.sin(2 * Math.PI * f * i / SR); buf.getChannelData(0)[i] = v; buf.getChannelData(1)[i] = v; }
        const src = ctx.createBufferSource(); src.buffer = buf;
        const fx = AudioFx.build(ctx);
        const ae = Object.assign({}, DS.DEFAULT_AE, ${JSON.stringify(c.ae)}); ae.comp = Object.assign({}, DS.DEFAULT_AE.comp, ${JSON.stringify(c.ae.comp)});
        fx.update(ae, 1);
        src.connect(fx.input); fx.output.connect(ctx.destination); src.start();
        const out = await ctx.startRendering();
        const l = out.getChannelData(0), r = out.getChannelData(1), inter = new Array(N * 2);
        for (let i = 0; i < N; i++) { inter[2 * i] = l[i]; inter[2 * i + 1] = r[i]; }
        return inter;
      })()`);
      const wv = Float32Array.from(web);
      const from = Math.round(SR * 0.75);
      const row = { name: c.name, bands: [] };
      for (const f of c.freqs) for (const ch of [0, 1]) {
        const a = db(goertzel(wv, f, ch, from)), e = db(goertzel(ff, f, ch, from));
        row.bands.push({ f, ch, web: +a.toFixed(2), ffmpeg: +e.toFixed(2) });
        const tol = c.name === 'compressor' ? 3 : 1.5;
        if (Math.abs(a - e) > tol) bad.push(c.name + ' ' + f + 'Hz ch' + ch + ': web ' + a.toFixed(2) + ' vs ffmpeg ' + e.toFixed(2) + ' dB');
      }
      results.push(row);
    }
    // echo: an impulse through both chains must come back as the same three repeats (same spacing, same strength)
    {
      const ae = Object.assign({}, DSn.DEFAULT_AE, { comp: Object.assign({}, DSn.DEFAULT_AE.comp), echo: { on: true, delay: 100, decay: 50 } });
      const taps = DSn.echoTaps(ae);
      const input = new Float32Array(N * 2); input[2 * 2000] = 0.5; input[2 * 2000 + 1] = 0.5;
      fs.writeFileSync(OUT + '/echo_in.raw', Buffer.from(input.buffer));
      const r = spawnSync(F, ['-y', '-v', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', OUT + '/echo_in.raw', '-af', DSn.aeFilters(ae).join(','), '-f', 'f32le', OUT + '/echo_out.raw']);
      if (r.status) throw new Error(String(r.stderr));
      const b = fs.readFileSync(OUT + '/echo_out.raw');
      const ff = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
      const web = Float32Array.from(await run(`(async () => {
        const SR = ${SR}, N = ${N};
        const ctx = new OfflineAudioContext(2, N, SR);
        const buf = ctx.createBuffer(2, N, SR); buf.getChannelData(0)[2000] = 0.5; buf.getChannelData(1)[2000] = 0.5;
        const src = ctx.createBufferSource(); src.buffer = buf;
        const fx = AudioFx.build(ctx);
        const ae = Object.assign({}, DS.DEFAULT_AE, { comp: Object.assign({}, DS.DEFAULT_AE.comp), echo: { on: true, delay: 100, decay: 50 } });
        fx.update(ae, 1);
        src.connect(fx.input); fx.output.connect(ctx.destination); src.start();
        const out = await ctx.startRendering();
        return Array.from(out.getChannelData(0));
      })()`));
      const peakOf = (x, step) => { let bi = 0, bv = 0; for (let i = 0; i < 20000; i++) { const v = Math.abs(x[i * step]); if (v > bv) { bv = v; bi = i; } } return { i: bi, v: x[bi * step] }; };
      const pf = peakOf(ff, 2), pw = peakOf(web, 1);
      const row = { name: 'echo', taps, ffmpeg: [], web: [] };
      taps.forEach((t) => {
        const off = Math.round(t.ms * SR / 1000);
        const a = ff[(pf.i + off) * 2] / pf.v, w = web[pw.i + off] / pw.v;
        row.ffmpeg.push(+a.toFixed(4)); row.web.push(+w.toFixed(4));
        if (Math.abs(a - t.gain) > 0.01) bad.push('echo: ffmpeg repeat at ' + t.ms + ' ms is ' + a.toFixed(3) + ', expected ' + t.gain);
        if (Math.abs(w - t.gain) > 0.02) bad.push('echo: preview repeat at ' + t.ms + ' ms is ' + w.toFixed(3) + ', expected ' + t.gain);
      });
      if (pf.i !== 2000) bad.push('echo: ffmpeg moved the dry sound to sample ' + pf.i);
      results.push(row);
    }
    // 5.1 placement: the stereo preview must play what the 5.1 file contains (ITU downmix), checked with a different tone per ear
    {
      const ae = { sx: -60, sy: 50, sc: 30, slfe: 0 };
      const fl = 1000, fr = 2500, amp = 0.2;
      const input = new Float32Array(N * 2);
      for (let i = 0; i < N; i++) { input[2 * i] = amp * Math.sin(2 * Math.PI * fl * i / SR); input[2 * i + 1] = amp * Math.sin(2 * Math.PI * fr * i / SR); }
      fs.writeFileSync(OUT + '/sr_in.raw', Buffer.from(input.buffer));
      const pan = DSn.surroundPanExpr(ae);
      const down = 'pan=stereo|FL=FL+0.7071*FC+0.7071*BL|FR=FR+0.7071*FC+0.7071*BR';
      const r = spawnSync(F, ['-y', '-v', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', OUT + '/sr_in.raw', '-af', pan + ',' + down, '-f', 'f32le', OUT + '/sr_out.raw']);
      if (r.status) throw new Error(String(r.stderr));
      const b = fs.readFileSync(OUT + '/sr_out.raw'); const ff = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
      const web = await run(`(async () => {
        const SR = ${SR}, N = ${N};
        const ctx = new OfflineAudioContext(2, N, SR);
        const buf = ctx.createBuffer(2, N, SR);
        for (let i = 0; i < N; i++) { buf.getChannelData(0)[i] = ${amp} * Math.sin(2 * Math.PI * ${fl} * i / SR); buf.getChannelData(1)[i] = ${amp} * Math.sin(2 * Math.PI * ${fr} * i / SR); }
        const src = ctx.createBufferSource(); src.buffer = buf;
        const fx = AudioFx.build(ctx);
        fx.update(Object.assign({}, DS.DEFAULT_AE, ${JSON.stringify(ae)}), 1, true);
        src.connect(fx.input); fx.output.connect(ctx.destination); src.start();
        const out = await ctx.startRendering();
        const l = out.getChannelData(0), rr = out.getChannelData(1), inter = new Array(N * 2);
        for (let i = 0; i < N; i++) { inter[2 * i] = l[i]; inter[2 * i + 1] = rr[i]; }
        return inter;
      })()`);
      const wv = Float32Array.from(web), from = Math.round(SR * 0.75), row = { name: '5.1 placement downmix', bands: [] };
      for (const f of [fl, fr]) for (const ch of [0, 1]) {
        const a = db(goertzel(wv, f, ch, from)), e = db(goertzel(ff, f, ch, from));
        row.bands.push({ f, ch, web: +a.toFixed(2), ffmpeg: +e.toFixed(2) });
        if (Math.abs(a - e) > 1.0 && Math.max(a, e) > -60) bad.push('surround ' + f + 'Hz ch' + ch + ': web ' + a.toFixed(2) + ' vs ffmpeg ' + e.toFixed(2) + ' dB');
      }
      results.push(row);
    }
    if (bad.length) throw new Error('audio mismatch: ' + bad.join('; '));
    return results;
  });
  await step('render queue dialog + preset', () => run(`(async () => {
    S.seek(1); Dialogs.exportDialog(); await new Promise(r => setTimeout(r, 150));
    const sel = Array.from(document.querySelectorAll('.modal select')); const pre = sel[0];
    pre.value = 'ig'; pre.dispatchEvent(new Event('change'));
    const fmt = sel[1].value, res = sel[2].value;
    const btns = Array.from(document.querySelectorAll('.modal button')).map(b => b.textContent);
    document.querySelector('.modal .btn').click();
    Dialogs.queueDialog(); await new Promise(r => setTimeout(r, 100));
    const q = document.querySelector('.modal').textContent.includes('queue is empty'); document.querySelector('.modal .btn').click();
    if (fmt !== 'mp4-h264' || res !== '1080x1920' || !btns.includes('Add to queue…') || !q) throw new Error(JSON.stringify({ fmt, res, btns, q }));
    return { fmt, res };
  })()`));
  await step('lift, extract and freeze frame', () => run(`(async () => {
        const pr = await window.ditto.probe(${JSON.stringify([MEDIA + '/a.mp4'])}); const m = App.registerMedia(pr.media)[0] || S.project.media.find(x => x.path === pr.media[0].path); if (!m) throw new Error('could not load a.mp4');
    S.project.clips = []; S.sel.clear(); S.change(true);
    const c = S.placeMedia(m.id, 'V1', 0); const d0 = c.dur;
    if (d0 < 3) throw new Error('test clip too short: ' + d0);
    const out = {};
    S.liftRange(1, 2); const lifted = S.project.clips.filter(x => x.track === 'V1').sort((x, y) => x.start - y.start);
    out.lift = lifted.map(x => x.start.toFixed(2) + '+' + x.dur.toFixed(2)).join(' ');
    if (lifted.length !== 2 || Math.abs(lifted[1].start - 2) > 0.01 || Math.abs(lifted[0].dur - 1) > 0.01) throw new Error('lift wrong ' + out.lift);
    S.undo();
    S.extractRange(1, 2); const ex = S.project.clips.filter(x => x.track === 'V1').sort((x, y) => x.start - y.start);
    out.extract = ex.map(x => x.start.toFixed(2) + '+' + x.dur.toFixed(2)).join(' ');
    if (ex.length !== 2 || Math.abs(ex[1].start - 1) > 0.01 || Math.abs(S.duration() - (d0 - 1)) > 0.02) throw new Error('extract wrong ' + out.extract);
    S.undo();
    const c2 = S.project.clips.find(x => x.track === 'V1'); S.seek(1.5);
    const fr = await window.ditto.freezeFrame({ file: m.path, t: 1.5 });
    if (!fr.ok) throw new Error('freeze frame: ' + fr.error);
    const still = App.registerMedia([fr.media])[0] || S.project.media.find(x => x.path === fr.media.path);
    const sc = S.freezeFrame(c2.id, still, 2);
    const all = S.project.clips.filter(x => x.track === 'V1').sort((x, y) => x.start - y.start);
    out.freeze = all.map(x => x.start.toFixed(2) + '+' + x.dur.toFixed(2)).join(' ');
    if (!sc || all.length !== 3 || Math.abs(all[1].start - 1.5) > 0.01 || Math.abs(all[1].dur - 2) > 0.01 || Math.abs(all[2].start - 3.5) > 0.01 || S.media(all[1].media).kind !== 'image') throw new Error('freeze wrong ' + out.freeze);
    S.undo();
    out.afterUndo = S.project.clips.filter(x => x.track === 'V1').length;
    return out;
  })()`));
  await step('editing commands: insert, ripple trim, nudge, slip, paste attributes, close gaps, detach audio', () => run(`(async () => {
    const pr = await window.ditto.probe(${JSON.stringify([MEDIA + '/a.mp4', MEDIA + '/b.mp4'])}); App.registerMedia(pr.media);
    const A = S.project.media.find(x => x.path === pr.media[0].path), B = S.project.media.find(x => x.path === pr.media[1].path);
    const row = (tr) => S.project.clips.filter(x => x.track === (tr || 'V1')).sort((x, y) => x.start - y.start).map(x => x.start.toFixed(2) + '+' + x.dur.toFixed(2)).join(' ');
    const near = (a, b) => Math.abs(a - b) < 0.011;
    const fresh = () => { S.project.clips = []; S.sel.clear(); S.change(true); const c1 = S.placeMedia(A.id, 'V1', 0), c2 = S.placeMedia(B.id, 'V1', 4); return [c1, c2]; };
    const out = {};
    let [c1, c2] = fresh();
    S.seek(1); S.insertMedia(B.id); out.insert = row();
    if (out.insert !== '0.00+1.00 1.00+4.00 5.00+3.00 8.00+4.00') throw new Error('insert edit wrong: ' + out.insert);
    S.undo(); if (row() !== '0.00+4.00 4.00+4.00') throw new Error('undo after insert: ' + row());
    c1 = S.project.clips.find(x => x.media === A.id); c2 = S.project.clips.find(x => x.media === B.id);
    S.seek(1.5); S.rippleTrimToPlayhead('prev'); out.trimPrev = row();
    if (out.trimPrev !== '0.00+2.50 2.50+4.00' || !near(S.project.clips.find(x => x.media === A.id).in, 1.5)) throw new Error('ripple trim prev wrong: ' + out.trimPrev);
    S.undo();
    S.seek(1.5); S.rippleTrimToPlayhead('next'); out.trimNext = row();
    if (out.trimNext !== '0.00+1.50 1.50+4.00') throw new Error('ripple trim next wrong: ' + out.trimNext);
    S.undo();
    c1 = S.project.clips.find(x => x.media === A.id); c2 = S.project.clips.find(x => x.media === B.id);
    S.setSelection([c2.id]); S.nudge(3); out.nudge = c2.start;
    if (!near(c2.start, 4 + 3 / S.project.fps)) throw new Error('nudge wrong: ' + c2.start);
    S.undo();
    c1 = S.project.clips.find(x => x.media === A.id); c2 = S.project.clips.find(x => x.media === B.id);
    c1.dur = 2; S.change(true); S.setSelection([c1.id]); S.slip(6); out.slip = c1.in;
    if (!near(c1.in, 6 / S.project.fps) || !near(c1.start, 0) || !near(c1.dur, 2)) throw new Error('slip wrong: ' + c1.in);
    S.slip(1000); if (!near(c1.in, 2)) throw new Error('slip is not limited to the source: ' + c1.in);
    c1.fx.brightness = 40; c1.blend = 'screen'; c1.tf.scale = 50; c1.vol = -6; S.change(true);
    S.setSelection([c1.id]); S.copy(); S.setSelection([c2.id]);
    S.pasteAttributes('effects');
    if (c2.fx.brightness !== 40 || c2.blend !== 'screen' || c2.vol !== -6 || c2.tf.scale !== 100) throw new Error('paste effects wrong ' + JSON.stringify([c2.fx.brightness, c2.blend, c2.vol, c2.tf.scale]));
    S.pasteAttributes('motion'); if (c2.tf.scale !== 50) throw new Error('paste motion wrong');
    out.paste = 'ok';
    c2.start = 7; S.change(true); const n = S.closeGaps(); out.closeGaps = row();
    if (n !== 1 || out.closeGaps !== '0.00+2.00 2.00+4.00') throw new Error('close gaps wrong: ' + out.closeGaps);
    S.setSelection([c2.id]); const d = S.detachAudio(); out.detach = row('A1');
    const a = S.project.clips.find(x => x.track.startsWith('A') && x.media === B.id);
    if (d !== 1 || !a || !c2.mute || !near(a.start, c2.start) || !near(a.dur, c2.dur) || a.vol !== -6) throw new Error('detach audio wrong: ' + out.detach);
    return out;
  })()`));
  await step('interaction: ripple trim (Ctrl), roll (Alt) and slip (Alt-drag) with the mouse', async () => {
    await run(`(async () => {
      const A = S.project.media.find(x => x.name === 'a.mp4'), B = S.project.media.find(x => x.name === 'b.mp4');
      S.project.clips = []; S.sel.clear(); S.change(true);
      const c1 = S.placeMedia(A.id, 'V1', 0); c1.dur = 3;
      const c2 = S.placeMedia(B.id, 'V1', 3); c2.in = 1; c2.dur = 2.5;
      S.snap = false; S.change(true); Timeline.fit(); Timeline.setTool('select'); window.__ids = [c1.id, c2.id];
    })()`);
    await sleep(400);
    const state = () => run(`(() => { const [a, b] = window.__ids.map(S.clip); return { a: [a.start, a.in, a.dur], b: [b.start, b.in, b.dur], zoom: S.zoom }; })()`);
    const near = (x, y) => Math.abs(x - y) < 0.03;
    const dragEdge = async (sel, dx, mods, body) => {
      const r = await rectOf(sel);
      const x0 = body ? r.x + r.w / 2 : r.x + r.w - 3, y = r.y + r.h / 2;
      mouse('mouseDown', x0, y, { modifiers: mods });
      const n = 8; for (let i = 1; i <= n; i++) { mouse('mouseMove', x0 + dx * i / n, y, { modifiers: mods }); await sleep(20); }
      mouse('mouseUp', x0 + dx, y, { modifiers: mods });
      await sleep(250);
    };
    const ids = await run('window.__ids');
    const s0 = await state();
    // ripple: Ctrl + drag the first clip's right edge left
    await dragEdge('.clip[data-id="' + ids[0] + '"]', -60, ['control']);
    const s1 = await state(), d1 = s1.a[2] - s0.a[2];
    if (!(d1 < -0.05) || !near(s1.b[0], s0.b[0] + d1) || !near(s1.b[2], s0.b[2]) || !near(s1.b[1], s0.b[1])) throw new Error('ripple trim wrong ' + JSON.stringify([s0, s1]));
    // roll: Alt + drag the same edge right: the first clip grows, the second starts later and loses its head
    await dragEdge('.clip[data-id="' + ids[0] + '"]', 40, ['alt']);
    const s2 = await state(), d2 = s2.a[2] - s1.a[2];
    if (!(d2 > 0.05) || !near(s2.b[0], s1.b[0] + d2) || !near(s2.b[2], s1.b[2] - d2) || !near(s2.b[1], s1.b[1] + d2) || !near(s2.b[0] + s2.b[2], s1.b[0] + s1.b[2])) throw new Error('roll wrong ' + JSON.stringify([s1, s2]));
    // slip: Alt + drag the second clip's body left: later source, same place and length
    await dragEdge('.clip[data-id="' + ids[1] + '"]', -40, ['alt'], true);
    const s3 = await state();
    if (!(s3.b[1] > s2.b[1] + 0.05) || !near(s3.b[0], s2.b[0]) || !near(s3.b[2], s2.b[2])) throw new Error('slip wrong ' + JSON.stringify([s2, s3]));
    await run('S.snap = true');
    return { ripple: +d1.toFixed(2), roll: +d2.toFixed(2), slip: +(s3.b[1] - s2.b[1]).toFixed(2) };
  });
  await step('graphics (matte, shapes), label colours, guides, volume band + auto-duck', async () => {
    const res = await run(`(async () => {
      const A = S.project.media.find(x => x.name === 'a.mp4');
      S.project.clips = []; S.sel.clear(); S.change(true);
      const matte = S.placeSpecial('matte', 0); matte.title.shape.color = '#ff0000'; matte.color = '#f87171';
      const ell = S.placeSpecial('ellipse', 0); ell.title.shape.color = '#0000ff'; ell.title.shape.w = 40; ell.title.shape.h = 40;
      const rect = S.placeSpecial('rect', 0); rect.title.shape.color = '#00ff00'; rect.title.shape.w = 10; rect.title.shape.h = 10; rect.tf.x = -S.project.width * 0.35;
      const tracks = [matte.track, ell.track, rect.track];
      S.change(true); S.seek(1); await new Promise(q => setTimeout(q, 700));
      const cv = document.getElementById('monitor'), x = cv.getContext('2d', { willReadFrequently: true });
      const px = (fx, fy) => Array.from(x.getImageData(Math.round(cv.width * fx), Math.round(cv.height * fy), 1, 1).data.slice(0, 3));
      const out = { tracks };
      Player.render2d(S.playhead); out.canvas = { centre: px(0.5, 0.5), corner: px(0.05, 0.05), left: px(0.15, 0.5) };
      out.gpuOk = !!Player.renderGpu(S.playhead); out.gpu = { centre: px(0.5, 0.5), corner: px(0.05, 0.05), left: px(0.15, 0.5) };
      out.label = !!document.querySelector('.clip[data-id="' + matte.id + '"] .clab');
      out.names = Array.from(document.querySelectorAll('.clip .cl')).map(e => e.textContent);
      const g = document.getElementById('monGuides'); g.checked = true; g.dispatchEvent(new Event('change'));
      out.guides = !document.getElementById('guides').classList.contains('hidden');
      g.checked = false; g.dispatchEvent(new Event('change'));
      const p = S.project; const titles = {};
      p.clips.filter(c => c.type === 'title').forEach(c => { titles[c.id] = Player.titleCanvas(c).toDataURL('image/png'); });
      const payload = DS.clone({ v: 1, name: p.name, width: p.width, height: p.height, fps: p.fps, tracks: p.tracks, clips: p.clips, markers: [], workArea: {} });
      payload.media = p.media.map(m => ({ id: m.id, path: m.path, name: m.name, kind: m.kind, duration: m.duration, hasAudio: m.hasAudio, missing: false }));
      out.exp = await window.ditto.startExport({ project: payload, opts: { format: 'frame-png', outPath: '${OUT}/gfx.png', width: p.width, height: p.height, rangeStart: 1, rangeEnd: 1.1 }, titles });
      out.size = [p.width, p.height];
      // volume band + auto-duck on a real clip
      const c = S.placeMedia(A.id, 'V1', 6); S.setSelection([c.id]);
      out.duck = AI.applyDuck([c], [{ t0: 7, t1: 8 }], { amount: 12, fade: 0.3 });
      await new Promise(q => setTimeout(q, 300));
      out.volAt = [DS.volAt(c, 0.2), DS.volAt(c, 1.5), DS.volAt(c, 3)];
      out.band = !!document.querySelector('.clip[data-id="' + c.id + '"] .volband polyline');
      out.volRow = Array.from(document.querySelectorAll('#inspector .row label')).some(l => l.textContent === 'Volume (dB)');
      S.undo(); out.afterUndo = S.clip(c.id) ? S.clip(c.id).kf.vol.length : -1;
      return out;
    })()`);
    const isC = (p, c) => p.every((v, i) => Math.abs(v - c[i]) <= 12);
    for (const k of ['canvas', 'gpu']) if (!isC(res[k].centre, [0, 0, 255]) || !isC(res[k].corner, [255, 0, 0]) || !isC(res[k].left, [0, 255, 0])) throw new Error(k + ' preview of the graphics is wrong: ' + JSON.stringify(res[k]));
    if (!res.gpuOk || !res.label || !res.guides) throw new Error('label / guides: ' + JSON.stringify([res.gpuOk, res.label, res.guides]));
    if (!res.exp.ok) throw new Error('graphics export failed: ' + res.exp.error);
    const [W, H] = res.size;
    const raw = require('child_process').spawnSync(require('ffmpeg-static'), ['-v', 'error', '-i', OUT + '/gfx.png', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 27 }).stdout;
    const at = (fx, fy) => { const i = (Math.round(H * fy) * W + Math.round(W * fx)) * 3; return [raw[i], raw[i + 1], raw[i + 2]]; };
    const ex = { centre: at(0.5, 0.5), corner: at(0.05, 0.05), left: at(0.15, 0.5) };
    if (!isC(ex.centre, [0, 0, 255]) || !isC(ex.corner, [255, 0, 0]) || !isC(ex.left, [0, 255, 0])) throw new Error('exported graphics are wrong: ' + JSON.stringify(ex));
    if (res.duck !== 1 || res.volAt[0] !== 0 || res.volAt[1] !== -12 || res.volAt[2] !== 0 || !res.band || !res.volRow || res.afterUndo !== 0) throw new Error('auto-duck / volume band: ' + JSON.stringify([res.duck, res.volAt, res.band, res.volRow, res.afterUndo]));
    return { preview: res.gpu, exported: ex, names: res.names, volAt: res.volAt };
  });
  await step('voice-over recording (fake microphone) and normalise clip', async () => {
    const res = await run(`(async () => {
      const A = S.project.media.find(x => x.name === 'a.mp4');
      S.project.clips = []; S.sel.clear(); S.change(true); S.seek(1);
      const out = {};
      await Voice.start({ play: false });
      out.recording = Voice.recording();
      await new Promise(q => setTimeout(q, 1600));
      const c = await Voice.stop();
      const m = c && S.media(c.media);
      out.clip = c && { track: c.track, start: c.start, dur: c.dur, kind: m.kind, hasAudio: m.hasAudio, path: m.path };
      out.after = Voice.recording();
      // the camera must stay blocked: only audio-only requests are granted
      out.camera = await navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { s.getTracks().forEach(t => t.stop()); return 'granted'; }, (e) => e.name);
      out.both = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((s) => { s.getTracks().forEach(t => t.stop()); return 'granted'; }, (e) => e.name);
      const v = S.placeMedia(A.id, 'V1', 0); S.setSelection([v.id]);
      out.n = await AI.normalizeClips(-1);
      const lv = await window.ditto.analyzePeak({ file: A.path, opts: { from: v.in, to: v.in + v.dur * v.speed } });
      out.vol = v.vol; out.peak = lv.level && lv.level.peak;
      return out;
    })()`);
    if (!res.recording || res.after) throw new Error('recording state wrong');
    if (res.camera === 'granted' || res.both === 'granted') throw new Error('the camera was not blocked: ' + res.camera + ' / ' + res.both);
    const c = res.clip;
    if (!c || !/^A/.test(c.track) || Math.abs(c.start - 1) > 0.01 || !(c.dur > 0.7 && c.dur < 4) || c.kind !== 'audio' || !c.hasAudio || !fs.existsSync(c.path)) throw new Error('voice-over clip wrong: ' + JSON.stringify(c));
    if (res.n !== 1 || !Number.isFinite(res.peak) || Math.abs(res.vol - Math.max(-60, Math.min(24, Math.round((-1 - res.peak) * 10) / 10))) > 0.051) throw new Error('normalise wrong: ' + JSON.stringify([res.n, res.vol, res.peak]));
    return { voice: { track: c.track, dur: +c.dur.toFixed(2) }, camera: res.camera, cameraPlusMic: res.both, normalise: { peak: res.peak, vol: res.vol } };
  });
  await step('rolling credits (preview vs export) and the output level meter', async () => {
    const res = await run(`(async () => {
      S.project.clips = []; S.sel.clear(); S.change(true);
      const c = S.placeSpecial('title', 0); c.dur = 4;
      c.title.text = Array.from({ length: 14 }, (_, i) => 'Credit line ' + (i + 1)).join('\\n'); c.title.size = 60; c.title.roll = true; c.title.shadow = false;
      S.change(true);
      const p = S.project, cv = document.getElementById('monitor'), x = cv.getContext('2d', { willReadFrequently: true });
      const tall = Player.titleCanvas(c).height;
      // how much of each third of the frame (top, middle, bottom) is lit
      const lit = () => { const d = x.getImageData(0, 0, cv.width, cv.height).data, n = [0, 0, 0]; for (let y = 0; y < cv.height; y += 2) for (let xx = 0; xx < cv.width; xx += 2) { if (d[(y * cv.width + xx) * 4] > 128) n[Math.min(2, Math.floor(3 * y / cv.height))]++; } return n; };
      const at = async (t, gpu) => { S.seek(t); await new Promise(q => setTimeout(q, 350)); if (gpu) Player.renderGpu(S.playhead); else Player.render2d(S.playhead); return lit(); };
      const out = { tall, frame: p.height };
      out.start = await at(0.02, false); out.early = await at(0.4, false); out.mid = await at(2, false); out.end = await at(3.98, false);
      out.midGpu = await at(2, true);
      const titles = { [c.id]: Player.titleCanvas(c).toDataURL('image/png') };
      const payload = DS.clone({ v: 1, name: p.name, width: p.width, height: p.height, fps: p.fps, tracks: p.tracks, clips: p.clips, markers: [], workArea: {} });
      payload.media = [];
      out.exp = await window.ditto.startExport({ project: payload, opts: { format: 'frame-png', outPath: '${OUT}/roll.png', width: p.width, height: p.height, rangeStart: 2, rangeEnd: 2.1 }, titles });
      S.seek(2); await new Promise(q => setTimeout(q, 300)); Player.render2d(2);
      out.size = [cv.width, cv.height, p.width, p.height];
      out.rows = (() => { const d = x.getImageData(0, 0, cv.width, cv.height).data, r = []; for (let y = 0; y < cv.height; y++) { let n = 0; for (let xx = 0; xx < cv.width; xx++) if (d[(y * cv.width + xx) * 4] > 128) n++; r.push(n); } return r; })();
      // level meter: a test tone into the master bus must show up
      const ctx = AudioFx.context(); out.meterEls = document.querySelectorAll('#vu i').length;
      if (ctx) {
        try { await ctx.resume(); } catch (e) {}
        const o = ctx.createOscillator(), g = ctx.createGain(); g.gain.value = 0.25; o.frequency.value = 440; o.connect(g); g.connect(AudioFx.master()); o.start();
        await new Promise(q => setTimeout(q, 500));
        out.ctxState = ctx.state; out.levels = AudioFx.levels(); out.barWidth = document.querySelector('#vu i').style.width;
        o.stop(); g.disconnect();
        await new Promise(q => setTimeout(q, 300)); out.quiet = AudioFx.levels();
      }
      return out;
    })()`);
    if (!(res.tall > res.frame * 1.5)) throw new Error('the rolling title canvas is not tall: ' + res.tall);
    const sum = (a) => a[0] + a[1] + a[2];
    if (sum(res.start) > 60 || res.early[0] !== 0 || res.early[1] !== 0 || !(res.early[2] > 20)) throw new Error('roll start wrong: ' + JSON.stringify([res.start, res.early]));
    if (!(res.mid[0] > 50 && res.mid[1] > 50 && res.mid[2] > 50) || sum(res.end) > 400) throw new Error('roll middle / end wrong: ' + JSON.stringify([res.mid, res.end]));
    const rel = Math.abs(sum(res.midGpu) - sum(res.mid)) / sum(res.mid);
    if (rel > 0.05) throw new Error('GPU and canvas disagree on the roll: ' + JSON.stringify([res.mid, res.midGpu]));
    if (!res.exp.ok) throw new Error('roll export failed: ' + res.exp.error);
    // exported frame at t = 2 against the preview: lit pixels per row must line up (same scroll position)
    const [cw, chh, W, H] = res.size;
    const raw = require('child_process').spawnSync(require('ffmpeg-static'), ['-v', 'error', '-i', OUT + '/roll.png', '-vf', 'scale=' + cw + ':' + chh, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 27 }).stdout;
    const rowsE = []; for (let y = 0; y < chh; y++) { let n = 0; for (let x = 0; x < cw; x++) if (raw[y * cw + x] > 128) n++; rowsE.push(n); }
    const shiftErr = (s) => { let e = 0, tot = 0; for (let y = 4; y < chh - 4; y++) { e += Math.abs((rowsE[y + s] || 0) - res.rows[y]); tot += res.rows[y]; } return e / Math.max(1, tot); };
    const errs = [-3, -2, -1, 0, 1, 2, 3].map((s) => [s, +shiftErr(s).toFixed(3)]);
    const best = errs.slice().sort((a, b) => a[1] - b[1])[0];
    if (Math.abs(best[0]) > 2 || best[1] > 0.25) throw new Error('exported roll is at a different position than the preview: ' + JSON.stringify(errs));
    if (res.meterEls !== 2) throw new Error('meter bars missing');
    const meter = res.ctxState === 'running' ? { levels: res.levels.map((v) => +v.toFixed(1)), quiet: res.quiet.map((v) => (Number.isFinite(v) ? +v.toFixed(1) : '-inf')), bar: res.barWidth } : { skipped: 'audio context is ' + res.ctxState };
    if (res.ctxState === 'running' && !(res.levels[0] > -16 && res.levels[0] < -8 && res.levels[1] > -16 && parseFloat(res.barWidth) > 50)) throw new Error('meter does not show the test tone (-12 dB expected): ' + JSON.stringify(meter));
    return { tall: res.tall, thirds: { early: res.early, mid: res.mid, end: res.end }, exportVsPreview: best, meter };
  });
  await step('collect project files, then open the moved folder (files found beside the project)', async () => {
    const dest = path.join(OUT, 'collect-' + Date.now()); fs.mkdirSync(dest, { recursive: true });
    const res = await run(`(async () => {
      const A = S.project.media.find(x => x.name === 'a.mp4');
      S.project.clips = []; S.sel.clear(); S.change(true);
      S.placeMedia(A.id, 'V1', 0);
      const r = await App.collectFiles(${JSON.stringify(dest)});
      const dlg = !!document.querySelector('.modal'); document.querySelectorAll('.modal .btn').forEach(b => b.click());
      return { r, dlg, media: S.project.media.filter(m => !m.nest).length, path: A.path };
    })()`);
    if (!res.r || !res.r.ok) throw new Error('collect failed: ' + JSON.stringify(res.r));
    const files = fs.readdirSync(path.join(res.r.dir, 'Media'));
    if (!res.dlg || !files.includes('a.mp4') || res.r.copied < 1 || !fs.existsSync(res.r.project)) throw new Error('collected folder wrong: ' + JSON.stringify([files, res.r]));
    // "another computer": the folder moves, so every path stored in the collected project is stale
    const moved = path.join(OUT, 'moved-' + Date.now()); fs.renameSync(res.r.dir, moved);
    const proj = path.join(moved, path.basename(res.r.project));
    const after = await run(`(async () => {
      S.dirty = false; await App.openFile(${JSON.stringify(proj)});
      await new Promise(q => setTimeout(q, 600));
      const m = S.project.media.find(x => x.name === 'a.mp4');
      return { file: S.filePath, missing: S.project.media.filter(x => x.missing).map(x => x.name), path: m && m.path, clips: S.project.clips.length, dur: m && m.duration };
    })()`);
    if (after.path !== path.join(moved, 'Media', 'a.mp4') || after.clips !== 1 || !(after.dur > 3)) throw new Error('moved project did not relink: ' + JSON.stringify(after));
    if (after.missing.includes('a.mp4')) throw new Error('a.mp4 still offline');
    return { copied: res.r.copied, files, relinked: path.relative(OUT, after.path), stillMissing: after.missing };
  });
  await step('dialogs render', () => run(`(() => { S.seek(1); Dialogs.exportDialog(); return !!document.querySelector('.modal'); })()`));
  await shot('07-export-dialog');
  await run(`document.querySelector('.modal .btn').click()`);
  await step('settings dialog', () => run(`(() => { Dialogs.projectSettings(); return !!document.querySelector('.modal'); })()`));
  await shot('08-settings-dialog');
  await run(`document.querySelector('.modal .btn').click()`);
  await run(`document.querySelector('#leftTabs button[data-tab=fx]').click()`);
  await shot('09-effects-tab');
  await step('menus + dialogs open', () => run(`(() => { document.querySelector('#menus .menu button').click(); const open = !!document.querySelector('.menu.open'); document.body.click(); Dialogs.exportDialog(); const dlg = !!document.querySelector('.modal'); document.querySelector('.modal .btn').click(); return { open, dlg }; })()`));
  await shot('05-final');

  await step('speed ramp + transcript editing + multicam grid + stabilize dialog (new UI, real clicks)', () => run(`(async () => {
    const out = {};
    S.newProject({ width: 640, height: 360, fps: 30 });
    const res = await window.ditto.probe([${JSON.stringify(MEDIA + '/a.mp4')}]);
    const added = App.registerMedia(res.media);
    const a = S.placeMedia(added[0].id, 'V1', 0);
    const origDur = a.dur;
    // --- speed ramp
    const r = S.speedRamp(a.id, { from: 1, to: 3, curve: 'ease', ripple: true });
    const pcs = S.project.clips.filter(c => c.ramp).sort((x, y) => x.start - y.start);
    let cont = true; pcs.forEach((c, i) => { if (i) { const p = pcs[i - 1]; if (Math.abs(c.in - (p.in + p.dur * p.speed)) > 0.02 || Math.abs(c.start - (p.start + p.dur)) > 1e-3) cont = false; } });
    out.ramp = { pieces: pcs.length, cont, speeds: [pcs[0].speed.toFixed(2), pcs[pcs.length - 1].speed.toFixed(2)], dur: +(pcs.reduce((q, c) => q + c.dur, 0)).toFixed(2), origDur };
    if (!(pcs.length > 3 && cont && pcs[pcs.length - 1].speed > pcs[0].speed * 1.5)) throw new Error('ramp wrong ' + JSON.stringify(out.ramp));
    S.seek(pcs[0].start + 0.1); await new Promise(q => setTimeout(q, 600)); Player.render();
    S.seek(pcs[Math.floor(pcs.length / 2)].start + 0.1); await new Promise(q => setTimeout(q, 600)); Player.render();
    S.speedRampRestore(r.group);
    const back = S.project.clips.filter(c => c.type === 'media');
    out.restored = { n: back.length, dur: +back[0].dur.toFixed(2), speed: back[0].speed };
    if (back.length !== 1 || Math.abs(back[0].dur - origDur) > 0.1 || back[0].ramp) throw new Error('restore wrong ' + JSON.stringify(out.restored));
    // ramp dialog opens from the menu command
    S.setSelection([back[0].id]); AI.speedRamp(); await new Promise(q => setTimeout(q, 200));
    out.rampDialog = !!document.querySelector('.dlg, .modal, dialog[open], #dlgRoot *');
    document.querySelectorAll('.dlg button, .modal button').forEach(b => { if (/cancel|close/i.test(b.textContent)) b.click(); });
    // --- transcript: three caption lines with word timings, cut a word out
    S.removeCaptions && S.removeCaptions();
    const base = S.placeMedia(added[0].id, 'V1', 6);
    const w = (t, s, e) => ({ start: t + s, end: t + e, text: '' });
    S.addCaptions([
      { start: 0.5, end: 2.5, text: 'hello um this is a test', words: [['hello', .5, .9], ['um', 1.0, 1.3], ['this', 1.4, 1.7], ['is', 1.7, 1.9], ['a', 1.9, 2.1], ['test', 2.1, 2.5]].map(x => ({ text: x[0], start: x[1], end: x[2] })) }
    ]);
    const lenBefore = S.project.clips.filter(c => c.track === 'V1').reduce((m, c) => Math.max(m, DS.clipEnd(c)), 0);
    document.querySelector('[data-tab="tx"]') && document.querySelector('[data-tab="tx"]').click();
    await new Promise(q => setTimeout(q, 200));
    out.txShown = !document.getElementById('tab-tx').classList.contains('hidden');
    out.txWords = document.querySelectorAll('#tab-tx .txw').length; out.txHtml = document.getElementById('tab-tx').innerHTML.slice(0, 300);
    Transcript.selectFillers();
    out.fillers = Transcript.state().sel.size;
    Transcript.cutSelected();
    await new Promise(q => setTimeout(q, 200));
    const cap = S.captionClips();
    out.afterCut = { lines: cap.length, text: cap.map(c => c.title.text).join(' | '), lenBefore: +lenBefore.toFixed(2), lenAfter: +S.project.clips.filter(c => c.track === 'V1').reduce((m, c) => Math.max(m, DS.clipEnd(c)), 0).toFixed(2) };
    if (out.txWords !== 6 || out.fillers !== 1 || /\\bum\\b/.test(out.afterCut.text) || !(out.afterCut.lenAfter < lenBefore - 0.2)) throw new Error('transcript cut wrong ' + JSON.stringify(out));
    S.undo(); await new Promise(q => setTimeout(q, 100));
    out.undone = S.captionClips().map(c => c.title.text).join('|');
    if (!/um/.test(out.undone)) throw new Error('undo did not bring the words back: ' + out.undone);
    // --- stabilize dialog opens
    S.setSelection([S.project.clips.find(c => c.type === 'media').id]);
    AI.stabilize(); await new Promise(q => setTimeout(q, 250));
    out.stabDialog = !!Array.from(document.querySelectorAll('button')).find(b => /stabili[sz]e/i.test(b.textContent) && b.offsetParent);
    document.querySelectorAll('.dlg button, .modal button').forEach(b => { if (/cancel|close/i.test(b.textContent)) b.click(); });
    return out;
  })()`));
  await step('multicam grid: one tile per angle, click a tile to cut to it', () => run(`(async () => {
    const F = (n) => S.project.media.find(m => m.name === n);
    S.newProject({ width: 640, height: 360, fps: 30 });
    const res = await window.ditto.probe([${JSON.stringify(OUT + '/mc_a.mp4')}, ${JSON.stringify(OUT + '/mc_b.mp4')}]);
    const added = App.registerMedia(res.media);
    const ca = S.placeMedia(added.find(m => m.name === 'mc_a.mp4').id, 'V1', 0);
    const cb = S.placeMedia(added.find(m => m.name === 'mc_b.mp4').id, 'V2', 0);
    const g = S.multicamCreate([ca, cb], [0, 0]);
    S.emit('select'); S.change(true);
    await new Promise(q => setTimeout(q, 300));
    MCGrid.setOn(true); S.seek(1); await new Promise(q => setTimeout(q, 1200));
    const tiles = MCGrid.tileCount();
    const grid = document.getElementById('mcGrid');
    const shown = !grid.classList.contains('hidden');
    const tile = grid.querySelectorAll('.mctile')[1];
    tile && tile.click(); await new Promise(q => setTimeout(q, 300));
    const angle = S.multicamAngleAt(g, S.playhead);
    MCGrid.setOn(false);
    if (tiles !== 2 || !shown || angle !== 2) throw new Error('grid wrong ' + JSON.stringify({ tiles, shown, angle }));
    return { tiles, shown, angleAfterClick: angle };
  })()`));
  await step('masks: preview matches export and the reference maths; tracked mask; Tracker.apply modes', async () => {
    const { spawnSync } = require('child_process');
    const F = require('ffmpeg-static');
    const bl = OUT + '/blue.png';
    const mk = { on: true, shape: 'ellipse', cx: 50, cy: 50, w: 50, h: 60, feather: 30, invert: false, path: null };
    const prev = await run(`(async () => {
      S.newProject({ width: 640, height: 360, fps: 30 });
      const res = await window.ditto.probe([${JSON.stringify(bl)}]);
      const added = App.registerMedia(res.media);
      const c = S.placeMedia(added[0].id, 'V1', 0); c.dur = 2;
      c.fx.mask = ${JSON.stringify(mk)};
      S.setSelection([c.id]); S.change(true); S.seek(0.5);
      await new Promise(r => setTimeout(r, 1500)); Player.render(); await new Promise(r => setTimeout(r, 300)); Player.render();
      const cv = document.getElementById('monitor'), x = cv.getContext('2d');
      const pts = [[320,180],[320,100],[320,60],[200,180],[100,180],[600,340],[455,180]];
      const out = pts.map(([a,b]) => { const d = x.getImageData(a, b, 1, 1).data; return { at: [a,b], blue: d[2] / 255 }; });
      const cover = pts.map(([a,b]) => DS.maskCover(c.fx.mask, (a + .5) / 640, (b + .5) / 360, 0.5));
      return { out, cover, inspector: !!Array.from(document.querySelectorAll('.sec h3, .sec .st, summary, .section-title')).find(n => /^Mask/.test(n.textContent)) };
    })()`);
    const exp = await run(`(async () => {
      const p = S.project; const payload = DS.clone({ v: 1, name: p.name, width: p.width, height: p.height, fps: p.fps, tracks: p.tracks, clips: p.clips, markers: [], workArea: {} });
      payload.media = p.media.map(m => ({ id: m.id, path: m.path, name: m.name, kind: m.kind, duration: m.duration, hasAudio: m.hasAudio, missing: false }));
      return window.ditto.startExport({ project: payload, opts: { format: 'mp4-h264', quality: 95, outPath: '${OUT}/mask.mp4', width: p.width, height: p.height, rangeStart: 0, rangeEnd: 1 }, titles: {} });
    })()`);
    if (!exp.ok) throw new Error('export failed ' + exp.error);
    const raw = spawnSync(F, ['-v', 'error', '-ss', '0.5', '-i', OUT + '/mask.mp4', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 }).stdout;
    let worstP = 0, worstE = 0;
    prev.out.forEach((o, i) => { const e = raw[(o.at[1] * 640 + o.at[0]) * 3 + 2] / 255; worstP = Math.max(worstP, Math.abs(o.blue - prev.cover[i])); worstE = Math.max(worstE, Math.abs(e - prev.cover[i])); });
    const o = { worstPreviewVsMaths: +worstP.toFixed(3), worstExportVsMaths: +worstE.toFixed(3), cover: prev.cover.map(v => +v.toFixed(2)) };
    if (worstE > 0.1) throw new Error('export differs from the maths ' + JSON.stringify(o));
    if (worstP > 0.2) throw new Error('preview differs from the maths ' + JSON.stringify(o));
    // Tracker.apply: mask path, lock, move another clip
    const ap = await run(`(() => {
      const c = S.project.clips[0]; const m = S.media(c.media);
      const res = { lost: 0, full: 30, samples: [{ t: 0, x: 0.3, y: 0.5 }, { t: 1, x: 0.6, y: 0.5 }, { t: 2, x: 0.6, y: 0.2 }] };
      const note = Tracker.apply('mask', c, m, res, null, 0);
      const mp = c.fx.mask.path;
      const out = { note, path: mp.map(k => [k.t, +k.x.toFixed(1), +k.y.toFixed(1)]), mid: DS.maskCentre(c.fx.mask, 0.5) };
      return out;
    })()`);
    if (!(ap.path.length === 3 && Math.abs(ap.path[1][1] - 60) < 0.1 && Math.abs(ap.mid.cx - 45) < 0.1)) throw new Error('apply wrong ' + JSON.stringify(ap));
    const modes = await run(`(async () => {
      const res0 = await window.ditto.probe([${JSON.stringify(MEDIA + '/a.mp4')}]);
      const added = App.registerMedia(res0.media);
      const c = S.placeMedia(added[0].id, 'V1', 0), m = S.media(c.media);
      const t = DS.newClip({ track: 'V2', type: 'title', start: 0, dur: 3 }); t.title = DS.newTitle('hi'); S.project.tracks.push({ id: 'V2', type: 'video', name: 'V2', mute: false, hidden: false, lock: false }); S.project.clips.push(t);
      const res = { lost: 1, full: 30, samples: [{ t: 0, x: 0.3, y: 0.5 }, { t: 1, x: 0.5, y: 0.5 }, { t: 2, x: 0.5, y: 0.7 }] };
      const d = Tracker.displaySize(c, m);
      const n1 = Tracker.apply('move', c, m, res, t.id, 0);
      const mv = { n: t.kf.x.length, dx: +(t.kf.x[1].v - t.kf.x[0].v).toFixed(1), want: +(0.2 * d.w).toFixed(1), dy: +(t.kf.y[2].v - t.kf.y[1].v).toFixed(1), wantY: +(0.2 * d.h).toFixed(1) };
      const n2 = Tracker.apply('lock', c, m, res, null, 0);
      const lk = { x1: +c.kf.x[1].v.toFixed(1), x0: +c.kf.x[0].v.toFixed(1), scale: +c.tf.scale.toFixed(1), note: n2 };
      return { mv, lk, n1 };
    })()`);
    if (modes.mv.n !== 3 || Math.abs(modes.mv.dx - modes.mv.want) > 1 || Math.abs(modes.mv.dy - modes.mv.wantY) > 1) throw new Error('move wrong ' + JSON.stringify(modes));
    if (!(modes.lk.x1 < modes.lk.x0 && modes.lk.scale > 100)) throw new Error('lock wrong ' + JSON.stringify(modes));
    return Object.assign(o, { applyPath: ap.path, modes });
  });
  await step('auto reframe: dialog changes the sequence shape and pans clips (real clicks)', () => run(`(async () => {
    const res0 = await window.ditto.probe([${JSON.stringify(MEDIA + '/a.mp4')}]);
    S.newProject({ width: 640, height: 360, fps: 30 });
    const added = App.registerMedia(res0.media);
    const c = S.placeMedia(added[0].id, 'V1', 0);
    await new Promise(q => setTimeout(q, 400));
    S.setSelection([c.id]);
    Tracker.reframe(); await new Promise(q => setTimeout(q, 250));
    const btn = Array.from(document.querySelectorAll('.modal button')).find(b => /^Reframe$/.test(b.textContent));
    if (!btn) throw new Error('no Reframe button');
    btn.click();
    for (let i = 0; i < 120 && document.querySelector('.modal'); i++) await new Promise(q => setTimeout(q, 500));
    const p = S.project, cl = p.clips[0];
    const out = { size: p.width + 'x' + p.height, scale: cl.tf.scale, kx: cl.kf.x.length, x: cl.tf.x, dialogGone: !document.querySelector('.modal') };
    const mw = S.media(cl.media).w, mh = S.media(cl.media).h;
    const want = Math.max(p.width / mw, p.height / mh) / Math.min(p.width / mw, p.height / mh) * 100;
    if (p.width >= p.height || Math.abs(cl.tf.scale - want) > 1) throw new Error('reframe wrong ' + JSON.stringify(Object.assign(out, { want })));
    S.undo(); await new Promise(q => setTimeout(q, 100));
    out.undone = S.project.width + 'x' + S.project.height;
    if (out.undone !== '640x360') throw new Error('undo did not restore the shape ' + JSON.stringify(out));
    return out;
  })()`));
  await step('track racks + 5.1: mixer dialog, preview bus, surround pad, layout + export choices', () => run(`(async () => {
    const out = {};
    const res = await window.ditto.probe([${JSON.stringify(MEDIA + '/tone.wav')}]);
    S.newProject({ width: 640, height: 360, fps: 30 });
    const added = App.registerMedia(res.media);
    const c = S.placeMedia(added[0].id, 'A1', 0);
    S.setSelection([c.id]);
    // --- the track mixer dialog
    const trk = S.track('A1');
    const hb = Array.from(document.querySelectorAll('.thead[data-track="A1"] button')).find(b => /mixer/i.test(b.title));
    if (!hb) throw new Error('no mixer button on the track header');
    hb.click(); await new Promise(q => setTimeout(q, 200));
    const dlg = document.querySelector('.modal');
    out.dialog = !!dlg && /Track mixer/.test(dlg.textContent);
    const fader = Array.from(dlg.querySelectorAll('.row')).find(r => /Fader/.test(r.textContent)).querySelector('input[type=range]');
    fader.value = '-9'; fader.dispatchEvent(new Event('input', { bubbles: true }));
    out.vol = trk.vol;
    Array.from(dlg.querySelectorAll('button')).find(b => /^Done$/.test(b.textContent)).click();
    await new Promise(q => setTimeout(q, 100));
    out.rackActive = DS.rackActive(S.track('A1'));
    out.headerLit = !!Array.from(document.querySelectorAll('.thead[data-track="A1"] button')).find(b => /mixer/i.test(b.title) && b.classList.contains('lockon'));
    if (out.vol !== -9 || !out.rackActive) throw new Error('mixer did not set the fader ' + JSON.stringify(out));
    // preview routes the clip through the track bus
    S.seek(0.8); S.change(true); await new Promise(q => setTimeout(q, 300)); Player.render();
    const bus = AudioFx.bus('A1');
    out.bus = !!bus;
    // --- 5.1: layout switch shows the surround controls
    S.project.audioLayout = '5.1'; S.change(true); S.setSelection([c.id]); S.emit('select'); await new Promise(q => setTimeout(q, 200));
    out.surroundSection = /Surround \\(5\\.1\\)/.test(document.getElementById('inspector').textContent);
    const pad = document.querySelector('#inspector canvas[width="180"]');
    if (pad) {
      const r = pad.getBoundingClientRect();
      pad.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + r.width * 0.15, clientY: r.top + r.height * 0.9, pointerId: 1, bubbles: true }));
      pad.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    }
    out.pad = { sx: c.ae.sx, sy: c.ae.sy };
    if (!out.surroundSection || !pad || !(c.ae.sx < -50 && c.ae.sy > 60)) throw new Error('surround controls wrong ' + JSON.stringify(out));
    // --- dialogs expose the layout and channel choices
    Dialogs.projectSettings(); await new Promise(q => setTimeout(q, 150));
    out.seqLayout = /Audio layout/.test(document.querySelector('.modal').textContent);
    document.querySelector('.modal button').click();
    Dialogs.exportDialog(); await new Promise(q => setTimeout(q, 150));
    const em = document.querySelector('.modal');
    out.exportChannels = /Audio channels/.test(em.textContent) && !Array.from(em.querySelectorAll('.mrow')).find(r => /Audio channels/.test(r.textContent)).classList.contains('hidden') ? true : 'hidden-or-missing';
    document.querySelector('.modal button').click();
    if (!out.seqLayout) throw new Error('layout choice missing ' + JSON.stringify(out));
    return out;
  })()`));
  await step('background removal: dialog, real run in a worker (video + photo), alpha preview, restore', () => run(`(async () => {
    const out = {};
    S.newProject({ width: 640, height: 360, fps: 30 });
    const res = await window.ditto.probe([${JSON.stringify(MEDIA + '/a.mp4')}, ${JSON.stringify(path.join(__dirname, 'fixtures', 'tiger.jpg'))}]);
    const added = App.registerMedia(res.media);
    const vid = added.find(m => m.kind === 'video'), img = added.find(m => m.kind === 'image');
    const cv = S.placeMedia(vid.id, 'V1', 0); cv.dur = 1;
    const ci = S.placeMedia(img.id, 'V2', 0); ci.dur = 2;
    out.models = (await window.ditto.bgModels()).map(m => m.id);
    if (!out.models.includes('u2netp')) throw new Error('model not found ' + JSON.stringify(out.models));
    const runDialog = async (clip, stepVal) => {
      S.setSelection([clip.id]);
      AI.removeBackground(); await new Promise(q => setTimeout(q, 300));
      const dlg = document.querySelector('.modal');
      if (!dlg || !/Remove background/.test(dlg.textContent)) throw new Error('dialog did not open');
      const sels = Array.from(dlg.querySelectorAll('select'));
      sels[0].value = 'u2netp'; sels[0].dispatchEvent(new Event('change', { bubbles: true }));
      sels[1].value = String(stepVal); sels[2].value = 'cpu';
      Array.from(dlg.querySelectorAll('button')).find(b => /^Remove background$/.test(b.textContent)).click();
      const t0 = Date.now();
      while (!clip.bgr && Date.now() - t0 < 120000 && !document.querySelector('.toast.err')) await new Promise(q => setTimeout(q, 250));
      const bad = document.querySelector('.toast.err'); if (bad) throw new Error('toast: ' + bad.textContent);
      await new Promise(q => setTimeout(q, 300));
      return Date.now() - t0;
    };
    out.msImage = await runDialog(ci, 1);
    const mi = S.media(ci.media);
    out.image = { name: mi.name, alpha: mi.alpha, ext: mi.path.split('.').pop(), restorable: !!ci.bgr };
    if (!ci.bgr || !mi.alpha || out.image.ext !== 'png') throw new Error('photo not processed ' + JSON.stringify(out));
    out.msVideo = await runDialog(cv, 4);
    const mv = S.media(cv.media);
    out.video = { alpha: mv.alpha, ext: mv.path.split('.').pop(), needsProxy: mv.needsProxy };
    if (!cv.bgr || !mv.alpha || out.video.ext !== 'mov') throw new Error('video not processed ' + JSON.stringify(out));
    // the preview gets a transparent (VP9 alpha) copy
    const t0 = Date.now();
    while (!(mv.previewUrl && /\.webm/.test(decodeURIComponent(mv.previewUrl))) && Date.now() - t0 < 60000) await new Promise(q => setTimeout(q, 250));
    out.preview = mv.previewUrl ? decodeURIComponent(mv.previewUrl).split('.').pop() : null;
    if (out.preview !== 'webm') throw new Error('no alpha preview ' + JSON.stringify(out));
    S.seek(0.4); await new Promise(q => setTimeout(q, 700)); Player.render();
    // preview shows transparency: the video layer is drawn over a solid colour layer below it
    const cv2 = document.querySelector('#viewer canvas, #preview canvas, canvas.pv') || document.querySelector('canvas');
    // restore
    S.setSelection([cv.id, ci.id]); AI.restoreBackground(); await new Promise(q => setTimeout(q, 150));
    out.restored = !cv.bgr && !ci.bgr && S.media(cv.media).id === vid.id && S.media(ci.media).id === img.id;
    if (!out.restored) throw new Error('restore failed ' + JSON.stringify(out));
    S.undo(); S.undo(); await new Promise(q => setTimeout(q, 100));
    return out;
  })()`));
  await step('review: comment thread on a marker, resolve, save + reload keeps comments, 5.1 layout and project id', () => run(`(async () => {
    const out = {};
    S.newProject({ width: 640, height: 360, fps: 30 });
    S.seek(2); const m = S.addMarker();
    S.setAuthor('Dana');
    document.querySelector('#leftTabs [data-tab="rv"]').click(); await new Promise(q => setTimeout(q, 150));
    const card = document.querySelector('#tab-rv .rvcard[data-mk="' + m.id + '"]');
    if (!card) throw new Error('no card for the marker');
    card.querySelector('textarea').value = 'Cut a second earlier';
    Array.from(card.querySelectorAll('button')).find(b => b.textContent === 'Post').click();
    await new Promise(q => setTimeout(q, 150));
    out.thread = S.markerById(m.id).comments.map(c => c.author + ': ' + c.text);
    if (out.thread.join() !== 'Dana: Cut a second earlier') throw new Error('post failed ' + JSON.stringify(out));
    out.shown = /Cut a second earlier/.test(document.getElementById('tab-rv').textContent);
    // resolve from the card
    const c2 = document.querySelector('#tab-rv .rvcard[data-mk="' + m.id + '"]');
    c2.querySelector('button[title="Mark as resolved"]').click(); await new Promise(q => setTimeout(q, 150));
    out.resolved = S.markerById(m.id).resolved;
    out.rulerFaded = !!document.querySelector('.marker.resolved');
    if (!out.resolved || !out.rulerFaded) throw new Error('resolve failed ' + JSON.stringify(out));
    // layout + id survive a save / load round trip, comments too
    S.project.audioLayout = '5.1'; const id0 = S.project.id;
    const json = S.serialize(); S.newProject({}); S.load(JSON.parse(json), null);
    out.after = { layout: S.project.audioLayout, sameId: S.project.id === id0, comments: S.markerById(m.id) && S.markerById(m.id).comments.length, resolved: S.markerById(m.id) && S.markerById(m.id).resolved };
    if (out.after.layout !== '5.1' || !out.after.sameId || out.after.comments !== 1 || !out.after.resolved) throw new Error('round trip lost data ' + JSON.stringify(out));
    // a colleague's review merges in through the panel code path
    const pkg = DR.makePackage(S.project, 'Eli', Date.now()); pkg.markers[0].comments.push({ id: 'cm_eli1', author: 'Eli', at: Date.now() + 10, text: 'Agreed' }); pkg.markers[0].updated = Date.now() + 10; pkg.markers[0].resolved = false;
    const res = Review.mergeInto(pkg, false);
    out.merge = { ok: res.ok, c: res.addedComments, u: res.updatedMarkers, now: S.markerById(m.id).comments.length, resolved: S.markerById(m.id).resolved };
    if (!res.ok || res.addedComments !== 1 || S.markerById(m.id).resolved) throw new Error('merge failed ' + JSON.stringify(out));
    S.undo(); out.undoneMerge = S.markerById(m.id).comments.length;
    if (out.undoneMerge !== 1) throw new Error('undo of the merge failed');
    return out;
  })()`));
  await step('Color tab: scopes draw, sliders / curve / wheel edit the grade, preview matches the export, adjustment-layer grade is timed', async () => {
    const { spawnSync } = require('child_process');
    const F = require('ffmpeg-static');
    const card = OUT + '/card.png';
    let r = spawnSync(F, ['-y', '-v', 'error', '-f', 'lavfi', '-i', "nullsrc=s=640x360,format=gbrp,geq=r='64+128*X/W':g='64+128*Y/H':b='96+64*sin(X/50)*cos(Y/40)'", '-frames:v', '1', card]);   // smooth mid-tones: a grade has room to move them
    if (r.status) throw new Error(String(r.stderr));
    const ui = await run(`(async () => {
      S.newProject({ width: 640, height: 360, fps: 30 });
      const res = await window.ditto.probe([${JSON.stringify(card)}]);
      const added = App.registerMedia(res.media);
      const c = S.placeMedia(added[0].id, 'V1', 0); c.dur = 2;
      S.setSelection([c.id]); S.change(true); S.seek(0.5);
      await new Promise(q => setTimeout(q, 1200)); Player.render();
      document.querySelector('#leftTabs [data-tab="co"]').click();
      await new Promise(q => setTimeout(q, 300));
      const out = {};
      const sc = document.querySelector('#tab-co .scopecv');
      const lit = () => { const d = sc.getContext('2d').getImageData(0, 0, sc.width, sc.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) n++; return n; };
      Color.refreshScope(true); out.scopes = {};
      for (const m of ['wave', 'parade', 'vec', 'hist']) { const sel = document.querySelector('#tab-co .scopebox select'); sel.value = m; sel.dispatchEvent(new Event('change')); await new Promise(q => setTimeout(q, 80)); out.scopes[m] = lit(); }
      out.sections = Array.from(document.querySelectorAll('#tab-co .sec .sh span:last-child')).map(n => n.textContent);
      // a slider, through the real input
      const rows = Array.from(document.querySelectorAll('#tab-co .row'));
      const rowOf = (name) => rows.find(r => r.querySelector('label') && r.querySelector('label').textContent === name);
      const x = document.getElementById('monitor').getContext('2d', { willReadFrequently: true });
      const mean = () => { const d = x.getImageData(0, 0, 640, 360).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4) / 3; };
      const before = mean();
      const rng = rowOf('Exposure').querySelector('input[type=range]'); rng.value = 40; rng.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(q => setTimeout(q, 250)); Player.render();
      out.exposure = { stored: c.fx.color && c.fx.color.exposure, before: Math.round(before), after: Math.round(mean()) };
      // a curve point through the real pointer events
      const cc = document.querySelector('#tab-co .curvecv'), rc = cc.getBoundingClientRect();
      const at = (u, v) => ({ clientX: rc.left + (6 + u * 220) * rc.width / 232, clientY: rc.top + (6 + (1 - v) * 220) * rc.height / 232, pointerId: 1, bubbles: true });
      cc.dispatchEvent(new PointerEvent('pointerdown', at(0.5, 0.5))); cc.dispatchEvent(new PointerEvent('pointermove', at(0.5, 0.7))); cc.dispatchEvent(new PointerEvent('pointerup', at(0.5, 0.7)));
      out.curve = c.fx.color.curves.m && c.fx.color.curves.m.map(p => p.map(v => +v.toFixed(2)));
      // a wheel
      const wc = document.querySelector('#tab-co .wheelcv'), wr = wc.getBoundingClientRect();
      wc.dispatchEvent(new PointerEvent('pointerdown', { clientX: wr.left + wr.width * 0.95, clientY: wr.top + wr.height / 2, pointerId: 2, bubbles: true })); wc.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, bubbles: true }));
      out.wheel = c.fx.color.wheels.sh;
      // undo walks the edits back
      S.undo(); S.undo(); out.afterUndo = !!c.fx.color || !!S.project.clips[0].fx.color;
      return out;
    })()`);
    if (!(ui.scopes.wave > 200 && ui.scopes.parade > 200 && ui.scopes.vec > 200 && ui.scopes.hist > 200)) throw new Error('a scope is empty ' + JSON.stringify(ui.scopes));
    if (!(ui.sections.includes('Basic correction') && ui.sections.includes('Curves') && ui.sections.includes('Colour wheels'))) throw new Error('sections missing ' + JSON.stringify(ui.sections));
    if (!(ui.exposure.stored === 40 && ui.exposure.after > ui.exposure.before + 8)) throw new Error('exposure slider did not brighten the picture ' + JSON.stringify(ui.exposure));
    if (!(ui.curve && ui.curve.length === 3 && Math.abs(ui.curve[1][1] - 0.7) < 0.04)) throw new Error('curve editor did not add the point ' + JSON.stringify(ui.curve));
    if (!(ui.wheel.s > 80 && (ui.wheel.h < 15 || ui.wheel.h > 345))) throw new Error('wheel did not tint to red ' + JSON.stringify(ui.wheel));
    // export: grade on the clip, and a graded adjustment layer that only covers the second second
    const set = await run(`(async () => {
      const c = S.project.clips[0];
      c.fx.color = DG.normalize({ exposure: 30, temp: 25, shadows: 30, vibrance: 40, curves: { m: [[0, 0], [0.5, 0.62], [1, 1]] }, wheels: { sh: { h: 220, s: 50, l: 0 }, mid: { h: 0, s: 0, l: 0 }, hi: { h: 40, s: 40, l: 0 } } });
      S.change(true); S.seek(0.5); await new Promise(q => setTimeout(q, 800)); Player.render2d(0.5);
      const cv = document.getElementById('monitor'), x = cv.getContext('2d', { willReadFrequently: true });
      const prev2d = Array.from(x.getImageData(0, 0, 640, 360).data);
      Player.renderGpu(0.5); const prevGpu = Array.from(x.getImageData(0, 0, 640, 360).data);
      const p = S.project; const payload = DS.clone({ v: 1, name: p.name, width: p.width, height: p.height, fps: p.fps, tracks: p.tracks, clips: p.clips, markers: [], workArea: {} });
      payload.media = p.media.map(m => ({ id: m.id, path: m.path, name: m.name, kind: m.kind, duration: m.duration, hasAudio: m.hasAudio, missing: false }));
      const e1 = await window.ditto.startExport({ project: payload, opts: { format: 'mp4-h264', quality: 100, outPath: '${OUT}/grade.mp4', width: 640, height: 360, rangeStart: 0, rangeEnd: 1 }, titles: {} });
      // adjustment layer from 1 s to 2 s with a strong darkening grade
      c.fx.color = null;
      const t = DS.newClip({ track: 'V2', type: 'adjust', start: 1, dur: 1 }); t.fx.color = DG.normalize({ exposure: -70 }); p.clips.push(t);
      const pl2 = DS.clone({ v: 1, name: p.name, width: p.width, height: p.height, fps: p.fps, tracks: p.tracks, clips: p.clips, markers: [], workArea: {} });
      pl2.media = payload.media;
      const e2 = await window.ditto.startExport({ project: pl2, opts: { format: 'mp4-h264', quality: 100, outPath: '${OUT}/adj.mp4', width: 640, height: 360, rangeStart: 0, rangeEnd: 2 }, titles: {} });
      return { prev2d, prevGpu, e1: e1.ok || e1.error, e2: e2.ok || e2.error };
    })()`);
    if (set.e1 !== true || set.e2 !== true) throw new Error('export failed ' + JSON.stringify({ e1: set.e1, e2: set.e2 }));
    const frame = (file, t) => spawnSync(F, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 }).stdout;
    const g = frame(OUT + '/grade.mp4', 0.5);
    let sum = 0, sumGpu = 0, sumPrev = 0, n = 640 * 360;
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { sum += Math.abs(g[i * 3 + k] - set.prev2d[i * 4 + k]); sumGpu += Math.abs(g[i * 3 + k] - set.prevGpu[i * 4 + k]); sumPrev += Math.abs(set.prevGpu[i * 4 + k] - set.prev2d[i * 4 + k]); }
    const m2d = sum / (n * 3), mGpu = sumGpu / (n * 3), mBoth = sumPrev / (n * 3);
    const meanOf = (b) => { let s = 0; for (let i = 0; i < b.length; i++) s += b[i]; return s / b.length; };
    const a0 = meanOf(frame(OUT + '/adj.mp4', 0.5)), a1 = meanOf(frame(OUT + '/adj.mp4', 1.5));
    const o = { exportVsCanvas: +m2d.toFixed(2), exportVsGpu: +mGpu.toFixed(2), gpuVsCanvas: +mBoth.toFixed(2), adjBefore: +a0.toFixed(1), adjDuring: +a1.toFixed(1), ui: { exposure: ui.exposure, curve: ui.curve, wheel: ui.wheel } };
    if (m2d > 6 || mGpu > 6 || mBoth > 3) throw new Error('graded preview and export differ ' + JSON.stringify(o));
    if (!(a1 < a0 * 0.75)) throw new Error('the adjustment-layer grade was not confined to its time range ' + JSON.stringify(o));
    return o;
  });
  await step('GPU compositor: every effect matches the canvas path, engine switch + fallback, speed', async () => {
    const out = { cases: {} };
    const info = await run(`(() => { const i = Player.GpuComp.info(); return { avail: Player.GpuComp.available(), info: i, engine: Player.engine() }; })()`);
    if (!info.avail) throw new Error('GPU compositor did not start: ' + JSON.stringify(info));
    out.renderer = info.info && info.info.renderer;
    const res = await run(`(async () => {
      S.newProject({ width: 640, height: 360, fps: 30 });
      const r = await window.ditto.probe([${JSON.stringify(MEDIA + '/a.mp4')}, ${JSON.stringify(MEDIA + '/pic.png')}, ${JSON.stringify(OUT + '/green.mp4')}]);
      App.registerMedia(r.media);
      await new Promise(q => setTimeout(q, 2500));
      const med = (n) => S.project.media.find(x => x.name === n).id;
      const cases = {
        'plain video': () => { S.placeMedia(med('a.mp4'), 'V1', 0); },
        'move, scale, rotate, opacity': () => { const c = S.placeMedia(med('a.mp4'), 'V1', 0); Object.assign(c.tf, { x: 40, y: -20, scale: 60, rot: 25, opacity: 80 }); },
        'crop + flip': () => { const c = S.placeMedia(med('pic.png'), 'V1', 0); c.fx.crop = { l: 10, t: 5, r: 20, b: 15 }; c.fx.flipH = true; c.tf.rot = -12; },
        'brightness contrast saturation hue': () => { const c = S.placeMedia(med('a.mp4'), 'V1', 0); Object.assign(c.fx, { brightness: 20, contrast: 30, saturation: 150, hue: 40 }); },
        'grey': () => { const c = S.placeMedia(med('a.mp4'), 'V1', 0); c.fx.gray = true; },
        'sepia': () => { const c = S.placeMedia(med('a.mp4'), 'V1', 0); c.fx.sepia = true; },
        'blur': () => { const c = S.placeMedia(med('a.mp4'), 'V1', 0); c.fx.blur = 6; c.tf.scale = 70; },
        'sharpen + vignette': () => { const c = S.placeMedia(med('a.mp4'), 'V1', 0); c.fx.sharpen = 60; c.fx.vignette = 70; },
        'chroma key over picture': () => { S.placeMedia(med('pic.png'), 'V1', 0); const c = S.placeMedia(med('green.mp4'), 'V2', 0); c.fx.chroma = { on: true, color: '#00ff00', sim: 30, blend: 10 }; c.tf.scale = 70; },
        'ellipse mask, feathered': () => { const c = S.placeMedia(med('pic.png'), 'V1', 0); c.fx.mask = { on: true, shape: 'ellipse', cx: 45, cy: 50, w: 50, h: 60, feather: 30, invert: false, path: null }; c.tf.rot = 10; },
        'rect mask, inverted': () => { const c = S.placeMedia(med('a.mp4'), 'V1', 0); c.fx.mask = { on: true, shape: 'rect', cx: 50, cy: 50, w: 40, h: 40, feather: 5, invert: true, path: null }; },
        'blur + mask + opacity': () => { const c = S.placeMedia(med('pic.png'), 'V1', 0); c.fx.blur = 4; c.tf.opacity = 60; c.fx.mask = { on: true, shape: 'ellipse', cx: 50, cy: 50, w: 70, h: 70, feather: 20, invert: false, path: null }; },
        'LUT': () => { const c = S.placeMedia(med('a.mp4'), 'V1', 0); c.fx.lut = { path: ${JSON.stringify(OUT + '/inv.cube')}, name: 'inv.cube' }; },
        'adjustment layer over video': () => { S.placeMedia(med('a.mp4'), 'V1', 0); const t = DS.newClip({ track: 'V2', type: 'adjust', start: 0, dur: 3 }); t.fx = Object.assign(DS.clone(DS.DEFAULT_FX || {}), { sepia: true, contrast: 25, vignette: 50 }); S.project.clips.push(t); },
        'title on video': () => { S.placeMedia(med('a.mp4'), 'V1', 0); const t = DS.newClip({ track: 'V2', type: 'title', start: 0, dur: 3 }); t.title = DS.newTitle('Ditto Pro'); t.tf.rot = 8; t.tf.scale = 80; S.project.clips.push(t); },
        'three layers stacked': () => { S.placeMedia(med('a.mp4'), 'V1', 0); const b = S.placeMedia(med('pic.png'), 'V2', 0); b.tf.scale = 50; b.tf.x = -120; b.tf.opacity = 70; const c = S.placeMedia(med('pic.png'), 'V3', 0); c.tf.scale = 40; c.tf.x = 130; c.tf.rot = 30; c.fx.sepia = true; }
      };
      const out = {};
      const read = () => { const x = document.getElementById('monitor').getContext('2d', { willReadFrequently: true }); return x.getImageData(0, 0, document.getElementById('monitor').width, document.getElementById('monitor').height).data; };
      for (const name of Object.keys(cases)) {
        S.project.clips.splice(0);
        if (!S.project.tracks.find(t => t.id === 'V2')) S.addTrack && S.addTrack('video');
        try { cases[name](); } catch (e) { out[name] = { error: e.message }; continue; }
        S.change(true); S.seek(1.0);
        await new Promise(q => setTimeout(q, 900));
        Player.render2d(S.playhead); const A = Uint8ClampedArray.from(read());
        const ok = Player.renderGpu(S.playhead); const B = read();
        if (!ok) { out[name] = { error: 'GPU frame refused' }; continue; }
        let sum = 0, bad = 0, n = A.length / 4, worst = 0;
        for (let i = 0; i < A.length; i += 4) { let m = 0; for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(A[i + k] - B[i + k])); sum += m; if (m > 32) bad++; if (m > worst) worst = m; }
        out[name] = { mean: +(sum / n).toFixed(2), bad: +(100 * bad / n).toFixed(2), worst };
        if (name === 'three layers stacked' || name === 'blur + mask + opacity' || name === 'adjustment layer over video') {
          const cvs = document.getElementById('monitor'); out['__png_' + name + ' gpu'] = cvs.toDataURL('image/png');
          Player.render2d(S.playhead); out['__png_' + name + ' canvas'] = cvs.toDataURL('image/png');
        }
      }
      return out;
    })()`);
    out.cases = res;
    for (const k of Object.keys(res)) if (k.startsWith('__png_')) { fs.writeFileSync(path.join(OUT, 'gpu-' + k.slice(6).replace(/[^a-z0-9]+/gi, '-') + '.png'), Buffer.from(res[k].split(',')[1], 'base64')); delete res[k]; }
    const fails = Object.entries(res).filter(([k, v]) => v.error || v.mean > 3 || v.bad > 2.5);
    if (fails.length) throw new Error('compositor differs from the canvas path: ' + JSON.stringify(fails));
    // half-resolution preview
    const half = await run(`(async () => {
      Player.setQuality(0.5); await new Promise(q => setTimeout(q, 300));
      S.project.clips.splice(0); const med = (n) => S.project.media.find(x => x.name === n).id;
      const c = S.placeMedia(med('pic.png'), 'V1', 0); c.fx.blur = 5; c.tf.rot = 15; c.tf.scale = 60; S.change(true); S.seek(1.0); await new Promise(q => setTimeout(q, 700));
      const cv = document.getElementById('monitor'), x = cv.getContext('2d', { willReadFrequently: true });
      Player.render2d(S.playhead); const A = x.getImageData(0, 0, cv.width, cv.height).data.slice(); const ok = Player.renderGpu(S.playhead); const B = x.getImageData(0, 0, cv.width, cv.height).data;
      let sum = 0; for (let i = 0; i < A.length; i += 4) sum += Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
      const w = cv.width; Player.setQuality(1); return { ok, w, mean: +(sum / (A.length / 4)).toFixed(2) };
    })()`);
    out.half = half;
    if (!half.ok || half.w !== 320 || half.mean > 3) throw new Error('half-resolution preview differs ' + JSON.stringify(half));
    // engine switch, then speed
    const sw = await run(`(async () => {
      Player.setEngine('2d'); const a = Player.engine(); Player.render(); const info2d = document.getElementById('monInfo').textContent;
      Player.setEngine('gpu'); const b = Player.engine(); Player.render(); const infoGpu = document.getElementById('monInfo').textContent;
      Player.setEngine('auto');
      S.project.clips.splice(0); const med = (n) => S.project.media.find(x => x.name === n).id;
      S.placeMedia(med('a.mp4'), 'V1', 0); const c = S.placeMedia(med('pic.png'), 'V2', 0); c.fx.blur = 3; c.fx.vignette = 40; c.tf.rot = 10;
      S.change(true); S.seek(1.0); await new Promise(q => setTimeout(q, 800));
      const gpu = await Player.benchmark(40, 'gpu'), cnv = await Player.benchmark(40, '2d');
      return { a, b, info2d, infoGpu, gpuMs: gpu && +gpu.toFixed(2), canvasMs: cnv && +cnv.toFixed(2) };
    })()`);
    out.engine = sw;
    if (sw.a !== '2d' || sw.b !== 'gpu' || !/Canvas/.test(sw.info2d) || !/GPU/.test(sw.infoGpu)) throw new Error('engine switch wrong ' + JSON.stringify(sw));
    return Object.assign({ renderer: out.renderer, worstMean: Math.max(...Object.values(res).map(v => v.mean)), worstBadPct: Math.max(...Object.values(res).map(v => v.bad)), cases: Object.keys(res).length, perCase: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.mean + '/' + v.bad + '%'])), half: half.mean }, sw);
  });
  await step('Creative effects and wipe transitions: GPU preview matches the canvas fallback', async () => {
    const res = await run(`(async () => {
      S.newProject({ width: 640, height: 360, fps: 30 });
      const r = await window.ditto.probe([${JSON.stringify(MEDIA + '/a.mp4')}, ${JSON.stringify(MEDIA + '/pic.png')}]);
      App.registerMedia(r.media);
      await new Promise(q => setTimeout(q, 2500));
      const med = (n) => S.project.media.find(x => x.name === n).id;
      const cv = document.getElementById('monitor'), x = cv.getContext('2d', { willReadFrequently: true });
      const read = () => x.getImageData(0, 0, cv.width, cv.height).data;
      const fxOn = (o) => (c) => { Object.assign(c.fx, o); };
      const lone = (src, o) => () => { const c = S.placeMedia(med(src), 'V1', 0); Object.assign(c.fx, o); };
      const cases = {
        'invert': lone('a.mp4', { invert: true }), 'posterize 4': lone('a.mp4', { posterize: 4 }), 'threshold': lone('a.mp4', { threshold: 50 }),
        'mosaic': lone('a.mp4', { mosaic: 24 }), 'emboss': lone('a.mp4', { emboss: true }), 'edges': lone('a.mp4', { edges: true }),
        'glow': lone('a.mp4', { glow: { amount: 80, size: 5, threshold: 55 } }),
        'invert + posterize + grade-free combo': lone('a.mp4', { invert: true, posterize: 6, brightness: 10 }),
        'mosaic on a scaled, rotated clip': () => { const c = S.placeMedia(med('a.mp4'), 'V1', 0); c.fx.mosaic = 20; c.tf.scale = 60; c.tf.rot = 15; },
        'rgb split': lone('a.mp4', { rgbsplit: 8 }),
        'luma key over a picture': () => { S.placeMedia(med('pic.png'), 'V1', 0); const c = S.placeMedia(med('a.mp4'), 'V2', 0); c.fx.lumakey = { on: true, threshold: 40, tolerance: 25, softness: 15 }; },
        'animated brightness + hue': () => { const c = S.placeMedia(med('a.mp4'), 'V1', 0); c.kf.brightness = [{ t: 0, v: -60, e: 'lin' }, { t: 2, v: 60, e: 'lin' }]; c.kf.hue = [{ t: 0, v: 0, e: 'lin' }, { t: 2, v: 90, e: 'lin' }]; },
        'glow on an adjustment layer': () => { S.placeMedia(med('a.mp4'), 'V1', 0); const t = DS.newClip({ track: 'V2', type: 'adjust', start: 0, dur: 3 }); t.fx = Object.assign(DS.cleanFx({}), { glow: { amount: 70, size: 4, threshold: 50 } }); S.project.clips.push(t); },
        'mosaic on an adjustment layer': () => { S.placeMedia(med('a.mp4'), 'V1', 0); const t = DS.newClip({ track: 'V2', type: 'adjust', start: 0, dur: 3 }); t.fx = Object.assign(DS.cleanFx({}), { mosaic: 30 }); S.project.clips.push(t); }
      };
      for (const b of DS.BLEND_IDS.slice(1)) cases['blend ' + b] = () => { S.placeMedia(med('pic.png'), 'V1', 0); const c = S.placeMedia(med('a.mp4'), 'V2', 0); c.blend = b; c.tf.opacity = b === 'add' ? 100 : 70; c.tf.scale = 80; c.tf.rot = 8; };
      for (const w of DS.WIPE_IDS) cases['wipe ' + w] = () => { S.placeMedia(med('a.mp4'), 'V1', 0); const b = S.placeMedia(med('pic.png'), 'V2', 1); b.dur = 2; b.tr = { type: w, dur: 1 }; };
      const out = {};
      for (const name of Object.keys(cases)) {
        S.project.clips.splice(0);
        if (!S.project.tracks.find(t => t.id === 'V2')) S.addTrack && S.addTrack('video');
        try { cases[name](); } catch (e) { out[name] = { error: e.message }; continue; }
        S.change(true); S.seek(name.startsWith('wipe') ? 1.4 : 1.0);
        await new Promise(q => setTimeout(q, 900));
        Player.render2d(S.playhead); const A = Uint8ClampedArray.from(read());
        const ok = Player.renderGpu(S.playhead); const B = read();
        if (!ok) { out[name] = { error: 'GPU frame refused' }; continue; }
        let sum = 0, bad = 0, n = A.length / 4, worst = 0;
        for (let i = 0; i < A.length; i += 4) { let m = 0; for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(A[i + k] - B[i + k])); sum += m; if (m > 40) bad++; if (m > worst) worst = m; }
        out[name] = { mean: +(sum / n).toFixed(2), bad: +(100 * bad / n).toFixed(2), worst };
        if (name === 'glow' || name === 'wipe clock' || name === 'emboss') { out['__png_' + name + ' gpu'] = cv.toDataURL('image/png'); Player.render2d(S.playhead); out['__png_' + name + ' canvas'] = cv.toDataURL('image/png'); }
      }
      // blend modes against the reference formula: frame of the backdrop alone, of the clip alone, and of the two blended
      {
        const shot = async (fn) => { S.project.clips.splice(0); fn(); S.change(true); S.seek(1.0); await new Promise(q => setTimeout(q, 900)); if (!Player.renderGpu(S.playhead)) throw new Error('GPU frame refused'); return Uint8ClampedArray.from(read()); };
        const base = await shot(() => { S.placeMedia(med('pic.png'), 'V1', 0); });
        const top = await shot(() => { S.placeMedia(med('a.mp4'), 'V2', 0); });
        out.__blendRef = {};
        for (const b of ['multiply', 'overlay', 'hardlight', 'difference']) {
          const mix = await shot(() => { S.placeMedia(med('pic.png'), 'V1', 0); const c = S.placeMedia(med('a.mp4'), 'V2', 0); c.blend = b; });
          let sum = 0; for (let i = 0; i < mix.length; i += 4) for (let k = 0; k < 3; k++) sum += Math.abs(mix[i + k] - 255 * DS.blendPx(b, base[i + k] / 255, top[i + k] / 255));
          out.__blendRef[b] = +(sum / (mix.length / 4 * 3)).toFixed(2);
        }
      }
      // grain: not pixel-identical by nature, so compare how much noise each path adds
      S.project.clips.splice(0);
      const c = S.placeMedia(med('a.mp4'), 'V1', 0); S.change(true); S.seek(1.0); await new Promise(q => setTimeout(q, 700));
      const sdiff = (A, B) => { const s = [0, 0, 0], q = [0, 0, 0]; const n = A.length / 4; for (let i = 0; i < A.length; i += 4) for (let k = 0; k < 3; k++) { const d = B[i + k] - A[i + k]; s[k] += d; q[k] += d * d; } return s.map((v, k) => Math.sqrt(q[k] / n - (v / n) ** 2)); };
      Player.render2d(S.playhead); const c0 = Uint8ClampedArray.from(read()); Player.renderGpu(S.playhead); const g0 = Uint8ClampedArray.from(read());
      c.fx.grain = 60; S.change(true);
      Player.render2d(S.playhead); const c1 = Uint8ClampedArray.from(read()); Player.renderGpu(S.playhead); const g1 = Uint8ClampedArray.from(read());
      out.__grain = { canvas: sdiff(c0, c1).map(v => +v.toFixed(2)), gpu: sdiff(g0, g1).map(v => +v.toFixed(2)) };
      return out;
    })()`);
    for (const k of Object.keys(res)) if (k.startsWith('__png_')) { fs.writeFileSync(path.join(OUT, 'fx-' + k.slice(6).replace(/[^a-z0-9]+/gi, '-') + '.png'), Buffer.from(res[k].split(',')[1], 'base64')); delete res[k]; }
    const grain = res.__grain; delete res.__grain;
    const blendRef = res.__blendRef; delete res.__blendRef;
    if (Object.values(blendRef).some((v) => v > 2.5)) throw new Error('GPU blend differs from the reference formula: ' + JSON.stringify(blendRef));
    const fails = Object.entries(res).filter(([k, v]) => v.error || v.mean > 4 || v.bad > 3);
    if (fails.length) throw new Error('GPU differs from the canvas fallback: ' + JSON.stringify(fails));
    if (!grain.gpu.every((v, i) => v > 3 && Math.abs(v - grain.canvas[i]) / grain.canvas[i] < 0.25)) throw new Error('grain strength differs: ' + JSON.stringify(grain));
    return { cases: Object.keys(res).length, perCase: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.mean + '/' + v.bad + '%'])), grain, blendRef };
  });
  await step('Stylize panel + image sequence import (real UI controls, real FFmpeg)', async () => {
    const seqDir = path.join(OUT, 'seq'); fs.mkdirSync(seqDir, { recursive: true });
    const r = require('child_process').spawnSync(require('ffmpeg-static'), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10:d=1.5', '-start_number', '1', path.join(seqDir, 'frame_%04d.png')]);
    if (r.status) throw new Error('could not make frames');
    const res = await run(`(async () => {
      S.newProject({ width: 640, height: 360, fps: 10 });
      const q = await window.ditto.importSequence({ file: ${JSON.stringify(path.join(seqDir, 'frame_0004.png'))}, fps: 10 });
      if (!q || !q.ok) return { error: q && q.error };
      const added = App.registerMedia([q.media]);
      await new Promise(r => setTimeout(r, 1500));
      const m = S.project.media[S.project.media.length - 1];
      const out = { frames: q.frames, name: m.name, kind: m.kind, dur: +m.duration.toFixed(2), alpha: /\.mov$/.test(m.path) };
      const c = S.placeMedia(m.id, 'V1', 0); S.setSelection([c.id]); S.change(true); S.seek(0.5);
      await new Promise(r => setTimeout(r, 1200));
      const sec = Array.from(document.querySelectorAll('#inspector .sec')).find(x => /Stylize/.test(x.querySelector('.sh').textContent));
      out.hasStylize = !!sec;
      const rows = sec ? Array.from(sec.querySelectorAll('label.chk, .row')) : [];
      const chk = (name) => rows.find(r => r.textContent.trim().startsWith(name)).querySelector('input[type=checkbox]');
      const mon = document.getElementById('monitor'), x = mon.getContext('2d', { willReadFrequently: true });
      const px = () => { const d = x.getImageData(mon.width / 2, mon.height / 2, 1, 1).data; return [d[0], d[1], d[2]]; };
      Player.render(); const before = px();
      chk('Invert').click(); await new Promise(r => setTimeout(r, 400)); Player.render(); const after = px();
      out.invert = { stored: c.fx.invert, before, after };
      chk('Emboss').click(); await new Promise(r => setTimeout(r, 200)); chk('Find edges').click(); await new Promise(r => setTimeout(r, 200));
      out.exclusive = { emboss: c.fx.emboss, edges: c.fx.edges };
      const num = rows.find(r => r.textContent.startsWith('Posterize')).querySelector('input[type=number]');
      num.value = '5'; num.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 200));
      out.poster = c.fx.posterize;
      S.undo(); S.undo(); S.undo();
      return out;
    })()`);
    if (res.error) throw new Error(res.error);
    if (res.frames !== 15 || res.kind !== 'video' || Math.abs(res.dur - 1.5) > 0.2 || !res.alpha) throw new Error('image sequence import wrong ' + JSON.stringify(res));
    if (!res.hasStylize || res.invert.stored !== true || Math.abs(res.invert.before[0] + res.invert.after[0] - 255) > 10) throw new Error('Stylize invert did not act ' + JSON.stringify(res));
    if (res.exclusive.edges !== true || res.exclusive.emboss !== false || res.poster !== 5) throw new Error('Stylize controls wrong ' + JSON.stringify(res));
    return res;
  });
  log('console errors:', errors.length);
  errors.forEach((e) => log('  ERR', e));
  fs.writeFileSync(path.join(OUT, 'errors.txt'), errors.join('\n'));
  app.exit(errors.length ? 1 : 0);
});
