'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, net, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const DS = require('./shared');
const { buildExport } = require('./exporter');
const { parseCube } = require('./lut');
const analysis = require('./analysis');
const { importProjectFile } = require('./importers');
const whisper = require('./whisper');
const syncLib = require('./sync');
const { parseSrt, formatSrt, parseCaptions } = require('./srt');
const imgseq = require('./imgseq');
const stabilizer = require('./stabilize');
const tracker = require('./tracker');
const bgremove = require('./bgremove');
const collab = require('./collab');
const hwenc = require('./hwenc');
const sec = require('./security');

// Every privileged IPC call must come from the app's own top-level page (never a sub-frame or foreign page).
const INDEX_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href;
const _handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => _handle(channel, (e, ...a) => {
  if (!sec.isTrustedSender(e, INDEX_URL)) throw new Error('Blocked: untrusted caller');
  return fn(e, ...a);
});
const FEEDBACK_HOSTS = ['github.com'];
const FEEDBACK_URL = 'https://github.com/Bumble-bee-999/ditto-pro/issues/new/choose';
const readCapped = (file, max) => { const st = fs.statSync(file); if (st.size > max) throw new Error('File is too large to open safely.'); return fs.readFileSync(file, 'utf8'); };
// Parses an externally supplied project, drops unsafe file references, tells the user if any were dropped.
function vetProjectJson(json) {
  let proj; try { proj = JSON.parse(json); } catch (_) { return json; }
  const n = sec.sanitizeProject(proj);
  if (n && win) dialog.showMessageBoxSync(win, { type: 'warning', title: 'Ditto Pro', message: n + ' media reference' + (n > 1 ? 's' : '') + ' in this project pointed at a network address or an unsupported location and ' + (n > 1 ? 'were' : 'was') + ' disconnected.', detail: 'Only files on your own drives are loaded. Use Relink to reconnect them if you trust the project.' });
  return n ? JSON.stringify(proj) : json;
}

// ffmpeg / ffprobe live outside the asar archive once packaged
const unpack = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const FFMPEG = unpack(require('ffmpeg-static'));
const FFPROBE = unpack(require('ffprobe-static').path);

const VIDEO_EXT = ['.mp4', '.m4v', '.mov', '.mkv', '.avi', '.webm', '.wmv', '.flv', '.mts', '.m2ts', '.mxf', '.mpg', '.mpeg', '.ts', '.3gp', '.ogv', '.gif'];
const AUDIO_EXT = ['.mp3', '.wav', '.aac', '.m4a', '.flac', '.ogg', '.opus', '.wma', '.aif', '.aiff'];
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'];
const BROWSER_CONTAINERS = ['.mp4', '.m4v', '.mov', '.webm', '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus'];
const BROWSER_VCODECS = ['h264', 'vp8', 'vp9', 'av1'];
const BROWSER_ACODECS = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le'];

// Media is served to the renderer through a private dmedia:// scheme (with range support and CORS headers)
// so the canvas stays untainted: that is what lets the preview run GPU shaders and Web Audio on it.
protocol.registerSchemesAsPrivileged([{ scheme: 'dmedia', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
const allowedFiles = new Set();
const mediaUrl = (p) => { allowedFiles.add(p); return 'dmedia://local/' + encodeURIComponent(p); };

// let Chromium use the GPU on drivers it would otherwise blocklist (video decode, WebGL, canvas rasterisation)
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

let win = null;
if (process.env.DITTO_TEST) global.__dittoWin = () => win;
let forceClose = false;
let startupFile = process.argv.slice(1).find((a) => a.toLowerCase().endsWith('.dpro')) || null;
let exportProc = null;
let exportCancelled = false;
let ffmpegMajor = null;

const userData = () => app.getPath('userData');
const ensureDir = (d) => { fs.mkdirSync(d, { recursive: true }); return d; };

// ------------------------------------------------------------------ helpers
function run(bin, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, Object.assign({ maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'buffer' }, opts), (err, stdout, stderr) => {
      if (err) { err.stderr = stderr && stderr.toString(); reject(err); } else resolve(stdout);
    });
  });
}

async function getFfmpegMajor() {
  if (ffmpegMajor != null) return ffmpegMajor;
  try {
    const out = (await run(FFMPEG, ['-version'])).toString();
    const m = out.match(/ffmpeg version\D*(\d+)/i);
    ffmpegMajor = m ? parseInt(m[1], 10) : 6;
  } catch (e) { ffmpegMajor = 6; }
  return ffmpegMajor;
}

async function probeFile(file) {
  const ext = path.extname(file).toLowerCase();
  const name = path.basename(file);
  let info;
  try {
    const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    info = JSON.parse(out.toString());
  } catch (e) {
    return { error: 'Could not read "' + name + '" — unsupported or damaged file.' };
  }
  const streams = info.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v && !a) return { error: '"' + name + '" has no video or audio.' };
  let kind = v ? 'video' : 'audio';
  if (IMAGE_EXT.includes(ext)) kind = 'image';
  let w = v ? v.width : 0, h = v ? v.height : 0;
  const rot = v && v.side_data_list ? (v.side_data_list.find((d) => d.rotation != null) || {}).rotation : 0;
  if (rot && Math.abs(rot) % 180 === 90) { const t = w; w = h; h = t; }
  let fps = 0;
  if (v) {
    const r = (v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate) || '30/1';
    const [n, d] = r.split('/').map(Number);
    fps = d ? n / d : 30;
  }
  let duration = parseFloat((info.format && info.format.duration) || (v && v.duration) || (a && a.duration) || 0) || 0;
  if (kind === 'image') duration = 5;
  const vcodec = v ? v.codec_name : null, acodec = a ? a.codec_name : null;
  const alpha = !!v && /^(yuva|rgba|bgra|argb|abgr|gbrap|ayuv)/.test(v.pix_fmt || '');
  let needsProxy = false;
  const heavy = !!v && (Math.max(w, h) > 2560 || Math.min(w, h) > 1440);
  if (kind === 'video') needsProxy = heavy || !BROWSER_CONTAINERS.includes(ext) || !BROWSER_VCODECS.includes(vcodec) || (a && !BROWSER_ACODECS.includes(acodec)) || (v && v.pix_fmt && !/^yuv420p|yuvj420p|yuva420p$/.test(v.pix_fmt)) || (alpha && vcodec !== 'vp9');
  if (kind === 'audio') needsProxy = !BROWSER_CONTAINERS.includes(ext) || !BROWSER_ACODECS.includes(acodec);
  const m = {
    id: DS.uid('m'), path: file, name, kind, duration, w, h, fps: Math.round(fps * 1000) / 1000,
    hasAudio: !!a && kind !== 'image', alpha, vcodec, acodec, needsProxy, thumb: null,
    url: mediaUrl(file), previewUrl: mediaUrl(file)
  };
  if (kind !== 'audio') m.thumb = await makeThumb(file, kind === 'image' ? 0 : Math.min(1, duration * 0.1)).catch(() => null);
  return m;
}

async function makeThumb(file, at) {
  const out = await run(FFMPEG, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=240:-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', 'pipe:1']);
  return out.length ? 'data:image/jpeg;base64,' + out.toString('base64') : null;
}

async function probeMany(paths) {
  paths = (Array.isArray(paths) ? paths : []).filter((p) => sec.isSafeLocalPath(p));
  const results = [], errors = [];
  const queue = paths.slice();
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      const ext = path.extname(f).toLowerCase();
      if (![].concat(VIDEO_EXT, AUDIO_EXT, IMAGE_EXT).includes(ext)) { errors.push('"' + path.basename(f) + '" is not a supported media file.'); continue; }
      const r = await probeFile(f);
      if (r.error) errors.push(r.error); else results.push(r);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const order = new Map(paths.map((p, i) => [p, i]));
  results.sort((a, b) => order.get(a.path) - order.get(b.path));
  return { media: results, errors };
}

function waveform(file) {
  return new Promise((resolve) => {
    if (!sec.isSafeLocalPath(file)) return resolve({ peaks: [], perSec: 40 });
    const PER_SEC = 40, RATE = 4000, BUCKET = RATE / PER_SEC;
    const p = spawn(FFMPEG, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const peaks = [];
    let carry = Buffer.alloc(0), cnt = 0, mx = 0;
    p.stdout.on('data', (d) => {
      const buf = carry.length ? Buffer.concat([carry, d]) : d;
      const n = buf.length - (buf.length % 2);
      for (let i = 0; i < n; i += 2) {
        const s = Math.abs(buf.readInt16LE(i));
        if (s > mx) mx = s;
        if (++cnt >= BUCKET) { peaks.push(Math.min(255, Math.round(mx / 32768 * 255))); cnt = 0; mx = 0; }
      }
      carry = buf.subarray(n);
    });
    p.on('error', () => resolve({ peaks: [], perSec: PER_SEC }));
    p.on('close', () => resolve({ peaks, perSec: PER_SEC }));
  });
}

function makeProxy(file, kind, onProgress, alpha) {
  const st = fs.statSync(file);
  const key = crypto.createHash('sha1').update(file + '|' + st.size + '|' + st.mtimeMs).digest('hex').slice(0, 16);
  if (alpha && kind === 'video') return alphaProxy(file, 'a' + key).then((r) => { if (!r.ok) throw new Error(r.error || 'ffmpeg failed'); return r.file; });
  const dir = ensureDir(path.join(userData(), 'proxies'));
  const out = path.join(dir, key + (kind === 'audio' ? '.m4a' : '.mp4'));
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) return Promise.resolve(out);
  return new Promise((resolve, reject) => {
    run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).then((o) => parseFloat(o.toString()) || 0).catch(() => 0).then((dur) => {
      const args = ['-y', '-v', 'error', '-nostdin', '-progress', 'pipe:1', '-nostats', '-i', file];
      if (kind === 'audio') args.push('-vn', '-c:a', 'aac', '-b:a', '160k');
      else args.push('-vf', "scale=-2:'min(720,ih)',format=yuv420p", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-g', '12', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart');
      const tmp = out + '.part.' + (kind === 'audio' ? 'm4a' : 'mp4');
      args.push(tmp);
      const p = spawn(FFMPEG, args, { windowsHide: true });
      let err = '';
      p.stdout.on('data', (d) => {
        const m = /out_time_us=(\d+)/.exec(d.toString());
        if (m && dur) onProgress && onProgress(Math.min(0.99, parseInt(m[1], 10) / 1e6 / dur));
      });
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('close', (code) => {
        if (code === 0) { fs.renameSync(tmp, out); resolve(out); }
        else { try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } reject(new Error(err.slice(-400) || 'ffmpeg failed')); }
      });
    });
  });
}

// ------------------------------------------------------------------ window
function createWindow() {
  win = new BrowserWindow({
    width: 1680, height: 980, minWidth: 1100, minHeight: 680,
    backgroundColor: '#141518', show: false, title: 'Ditto Pro',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false
    }
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => { win.show(); win.maximize(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.webContents.session.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|dmedia|blob|data|devtools|chrome-extension):/i.test(d.url) })); // fully offline: no network, ever
  // the only permission ever granted: the microphone, to the app's own page, for voice-over recording (no camera, no screen)
  win.webContents.session.setPermissionRequestHandler((wc, perm, cb, details) => {
    const types = (details && details.mediaTypes) || [];
    cb(perm === 'media' && wc === win.webContents && wc.getURL() === INDEX_URL && types.length > 0 && types.every((t) => t === 'audio'));
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged) win.webContents.toggleDevTools();
  });
  win.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    win.webContents.send('app:request-close');
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.setAppUserModelId('com.dittopro.editor');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (e, argv) => {
    const f = argv.slice(1).find((a) => a.toLowerCase().endsWith('.dpro'));
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); if (f) win.webContents.send('app:open-path', f); }
  });
  app.whenReady().then(() => {
    protocol.handle('dmedia', async (req) => {
      try {
        const p = decodeURIComponent(new URL(req.url).pathname.slice(1));
        if (!allowedFiles.has(p)) return new Response('Forbidden', { status: 403 });
        const r = await net.fetch(pathToFileURL(p).href, { headers: req.headers });
        const h = new Headers(r.headers);
        h.set('Access-Control-Allow-Origin', '*');
        h.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
        if (!h.has('Accept-Ranges')) h.set('Accept-Ranges', 'bytes');
        return new Response(r.body, { status: r.status, headers: h });
      } catch (e) { return new Response('Not found', { status: 404 }); }
    });
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

// ------------------------------------------------------------------ IPC
const MEDIA_FILTERS = [
  { name: 'All media', extensions: [].concat(VIDEO_EXT, AUDIO_EXT, IMAGE_EXT).map((e) => e.slice(1)) },
  { name: 'Video', extensions: VIDEO_EXT.map((e) => e.slice(1)) },
  { name: 'Audio', extensions: AUDIO_EXT.map((e) => e.slice(1)) },
  { name: 'Images', extensions: IMAGE_EXT.map((e) => e.slice(1)) }
];

ipcMain.handle('app:info', async () => ({
  version: app.getVersion(), platform: process.platform, ffmpeg: FFMPEG, ffmpegMajor: await getFfmpegMajor(), startupFile: startupFile
}));
ipcMain.handle('app:take-startup-file', () => { const f = startupFile; startupFile = null; return f; });
ipcMain.handle('app:confirm-close', () => { forceClose = true; win.close(); });

ipcMain.handle('dlg:import', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import media', properties: ['openFile', 'multiSelections'], filters: MEDIA_FILTERS });
  if (r.canceled || !r.filePaths.length) return { media: [], errors: [] };
  return probeMany(r.filePaths);
});

// ---- image sequences: numbered frames become one video file (cached), which is then probed like any other media
ipcMain.handle('media:importSequence', async (e, a) => {
  try {
    let f = a && a.file;
    if (!f) {
      const r = await dialog.showOpenDialog(win, { title: 'Import an image sequence: choose any frame of it', properties: ['openFile'], filters: [{ name: 'Image frames', extensions: imgseq.SEQ_EXT.map((x) => x.slice(1)) }] });
      if (r.canceled || !r.filePaths[0]) return null;
      f = r.filePaths[0];
    }
    sec.assertSafePath(f, 'Image');
    const seq = imgseq.detectSequence(f, fs.readdirSync(path.dirname(f)));
    if (!seq) return { ok: false, error: 'The file name has no frame number (like frame0001.png), so it is not part of a sequence.' };
    const fps = Math.max(1, Math.min(240, +(a && a.fps) || 24));
    const key = require('crypto').createHash('sha1').update([seq.pattern, seq.start, seq.count, fps, fs.statSync(f).mtimeMs].join('|')).digest('hex').slice(0, 16);
    const dir = ensureDir(path.join(userData(), 'image-sequences'));
    const probeOut = (ext) => path.join(dir, key + ext);
    const plan = imgseq.sequenceArgs(seq, fps, probeOut('.tmp'));
    const out = probeOut(plan.ext);
    if (!fs.existsSync(out)) {
      plan.args[plan.args.length - 1] = out;
      await new Promise((resolve, reject) => {
        const cp = require('child_process').spawn(FFMPEG, plan.args, { windowsHide: true });
        let err = ''; cp.stderr.on('data', (d) => { err += d; if (err.length > 8000) err = err.slice(-8000); });
        cp.on('error', reject);
        cp.on('close', (code) => (code === 0 ? resolve() : reject(new Error('FFmpeg could not read the frames: ' + err.trim().split('\n').slice(-2).join(' ')))));
      });
    }
    const pr = await probeMany([out]);
    if (!pr.media.length) return { ok: false, error: pr.errors[0] || 'The converted sequence could not be opened.' };
    const m = pr.media[0];
    m.name = seq.prefix.replace(/[_\-. ]+$/, '') + ' [' + seq.start + '-' + seq.end + ']' + seq.ext + ' (image sequence)';
    const notes = [];
    if (seq.outsideRun) notes.push(seq.outsideRun + ' more numbered frame' + (seq.outsideRun > 1 ? 's' : '') + ' in the folder sit after a gap and were left out.');
    return { ok: true, media: m, frames: seq.count, fps, notes };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
// ---- freeze frame: one picture from a video at an exact time (cached), probed like an imported image
ipcMain.handle('media:freezeFrame', async (e, { file, t }) => {
  try {
    sec.assertSafePath(file, 'Media');
    const tt = Math.max(0, Math.min(1e5, +t || 0));
    const key = require('crypto').createHash('sha1').update([file, tt.toFixed(4), fs.statSync(file).mtimeMs].join('|')).digest('hex').slice(0, 16);
    const out = path.join(ensureDir(path.join(userData(), 'freeze-frames')), key + '.png');
    if (!fs.existsSync(out)) {
      await new Promise((resolve, reject) => {
        const cp = require('child_process').spawn(FFMPEG, ['-y', '-v', 'error', '-nostdin', '-ss', String(tt), '-i', file, '-frames:v', '1', '-an', out], { windowsHide: true });
        let err = ''; cp.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
        cp.on('error', reject);
        cp.on('close', (code) => (code === 0 && fs.existsSync(out) ? resolve() : reject(new Error('FFmpeg could not read a frame there. ' + err.trim().split('\n').slice(-1)[0]))));
      });
    }
    const pr = await probeMany([out]);
    if (!pr.media.length) return { ok: false, error: pr.errors[0] || 'The frame could not be opened.' };
    return { ok: true, media: pr.media[0] };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('media:probe', (e, paths) => probeMany(paths));
ipcMain.handle('media:exists', (e, paths) => Object.fromEntries(paths.map((p) => [p, fs.existsSync(p)])));
ipcMain.handle('media:waveform', (e, file) => waveform(file));
ipcMain.handle('media:proxy', async (e, { id, path: file, kind, alpha }) => {
  try {
    sec.assertSafePath(file, 'Media');
    const out = await makeProxy(file, kind, (pct) => win && win.webContents.send('proxy:progress', { id, pct }), !!alpha);
    return { ok: true, url: mediaUrl(out) };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('media:relink', async (e, oldPath) => {
  const r = await dialog.showOpenDialog(win, { title: 'Locate "' + path.basename(oldPath) + '"', properties: ['openFile'], filters: MEDIA_FILTERS });
  if (r.canceled || !r.filePaths.length) return null;
  const res = await probeMany([r.filePaths[0]]);
  return res.media[0] || null;
});

// ---- shared-folder safety: who has the project open, and has anyone else changed it
const me = { user: (() => { try { return os.userInfo().username; } catch (e) { return 'user'; } })(), host: os.hostname(), session: crypto.randomUUID() };
let heldLock = null, knownFp = null, beatTimer = null;
function releaseHeld() {
  if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
  if (heldLock) { collab.release(heldLock, me); heldLock = null; }
  knownFp = null;
}
function claim(file, take) {
  if (heldLock && heldLock !== file) releaseHeld();
  const r = collab.acquire(file, me, Date.now(), take);
  if (r.ok) {
    heldLock = file; knownFp = collab.fingerprint(file);
    if (!beatTimer) { beatTimer = setInterval(() => { if (heldLock) collab.refresh(heldLock, me, Date.now()); }, collab.BEAT_MS); if (beatTimer.unref) beatTimer.unref(); }
  }
  return r;
}
app.on('will-quit', () => { try { releaseHeld(); } catch (e) { /* ignore */ } });
const ago = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };
// Opening: if someone else has it open, offer a private copy. Returns the file's JSON result or null (cancelled).
async function openGuarded(file) {
  const json = vetProjectJson(readCapped(file, sec.MAX_PROJECT_BYTES));
  const st = collab.state(file, me, Date.now());
  if (st.state === 'other' && !process.env.DITTO_TEST) {
    const l = st.lock;
    const r = await dialog.showMessageBox(win, {
      type: 'warning', title: 'Ditto Pro', message: 'This project is open somewhere else.',
      detail: l.user + (l.host ? ' on ' + l.host : '') + ' has had it open since ' + ago(l.since) + '. If you both edit and save, the last save wins and the other person\'s work is lost.\n\nOpen a copy to look at it or work on your own version; it will not touch the original.',
      buttons: ['Open a copy', 'Open anyway', 'Cancel'], defaultId: 0, cancelId: 2
    });
    if (r.response === 2) return null;
    if (r.response === 0) { releaseHeld(); return { path: null, copyOf: path.basename(file), json }; }
    claim(file, true);
    return { path: file, json };
  }
  claim(file, true);
  return { path: file, json };
}
ipcMain.handle('project:save', async (e, { json, filePath, saveAs, name }) => {
  let target = filePath;
  if (!target || saveAs) {
    const r = await dialog.showSaveDialog(win, {
      title: 'Save project', defaultPath: (name || 'Untitled') + '.dpro', filters: [{ name: 'Ditto Pro project', extensions: ['dpro'] }]
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  } else if (!process.env.DITTO_TEST) {
    const chk = collab.saveCheck(target, me, target === heldLock ? knownFp : null, Date.now());
    if (chk.action === 'ask') {
      const msg = chk.reason === 'locked'
        ? { message: 'Someone else has this project open.', detail: chk.lock.user + (chk.lock.host ? ' on ' + chk.lock.host : '') + ' is editing the same file. Saving here will replace their version.' }
        : { message: 'This project was changed by someone else.', detail: 'The file on disk is no longer the one you opened. Saving here will replace their changes. Saving a copy keeps both.' };
      const r = await dialog.showMessageBox(win, Object.assign({ type: 'warning', title: 'Ditto Pro', buttons: ['Save a copy…', 'Overwrite', 'Cancel'], defaultId: 0, cancelId: 2 }, msg));
      if (r.response === 2) return null;
      if (r.response === 0) {
        const d = await dialog.showSaveDialog(win, { title: 'Save a copy', defaultPath: (name || 'Untitled') + ' (copy).dpro', filters: [{ name: 'Ditto Pro project', extensions: ['dpro'] }] });
        if (d.canceled || !d.filePath) return null;
        target = d.filePath;
      }
    }
  }
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, target);
  claim(target, true);
  return { path: target };
});
ipcMain.handle('project:open', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open project', properties: ['openFile'], filters: [{ name: 'Ditto Pro project', extensions: ['dpro'] }] });
  if (r.canceled || !r.filePaths.length) return null;
  try { return await openGuarded(r.filePaths[0]); } catch (err) { dialog.showErrorBox('Ditto Pro', err.message); return null; }
});
ipcMain.handle('project:read', async (e, p) => {
  try { if (typeof p !== 'string' || !/\.dpro$/i.test(p)) return null; return await openGuarded(p); } catch (err) { return null; }
});
ipcMain.handle('project:release', () => { releaseHeld(); return true; });
ipcMain.handle('collab:whoami', () => ({ user: me.user, host: me.host }));
// ---- review files (comments only) and the comment list as CSV
const REVIEW_MAX = 32 * 1024 * 1024;
ipcMain.handle('review:export', async (e, { json, name }) => {
  const r = await dialog.showSaveDialog(win, { title: 'Export review for a colleague', defaultPath: String(name || 'Untitled').replace(/[\\/:*?"<>|]/g, '_') + '.dreview', filters: [{ name: 'Ditto Pro review', extensions: ['dreview'] }] });
  if (r.canceled || !r.filePath) return null;
  if (typeof json !== 'string' || json.length > REVIEW_MAX) throw new Error('Review is too large.');
  fs.writeFileSync(r.filePath, json, 'utf8');
  return { path: r.filePath };
});
ipcMain.handle('review:import', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import a colleague\'s review', properties: ['openFile'], filters: [{ name: 'Ditto Pro review', extensions: ['dreview', 'json'] }] });
  if (r.canceled || !r.filePaths.length) return null;
  try { return { path: r.filePaths[0], json: readCapped(r.filePaths[0], REVIEW_MAX) }; } catch (err) { return { error: err.message }; }
});
ipcMain.handle('review:csv', async (e, { csv, name }) => {
  const r = await dialog.showSaveDialog(win, { title: 'Export comments', defaultPath: String(name || 'Untitled').replace(/[\\/:*?"<>|]/g, '_') + ' comments.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (r.canceled || !r.filePath) return null;
  if (typeof csv !== 'string' || csv.length > REVIEW_MAX) throw new Error('Too large.');
  fs.writeFileSync(r.filePath, '﻿' + csv, 'utf8');
  return { path: r.filePath };
});
ipcMain.handle('autosave:write', (e, json) => {
  try { fs.writeFileSync(path.join(ensureDir(userData()), 'autosave.dpro'), json, 'utf8'); return true; } catch (err) { return false; }
});
ipcMain.handle('autosave:read', () => {
  try { return vetProjectJson(readCapped(path.join(userData(), 'autosave.dpro'), sec.MAX_PROJECT_BYTES)); } catch (err) { return null; }
});
ipcMain.handle('shell:reveal', (e, p) => { if (sec.isSafeLocalPath(p)) shell.showItemInFolder(p); });
ipcMain.handle('app:feedback', () => { if (sec.isAllowedExternal(FEEDBACK_URL, FEEDBACK_HOSTS)) shell.openExternal(FEEDBACK_URL); });

ipcMain.handle('export:choose', async (e, { ext, defaultName, isSequence, still }) => {
  if (still) {
    const r = await dialog.showSaveDialog(win, { title: 'Export current frame', defaultPath: defaultName + '.png', filters: [{ name: 'PNG image', extensions: ['png'] }, { name: 'JPEG image', extensions: ['jpg', 'jpeg'] }] });
    if (r.canceled || !r.filePath) return null;
    return { path: /\.(png|jpe?g)$/i.test(r.filePath) ? r.filePath : r.filePath + '.png' };
  }
  if (isSequence) {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a folder for the PNG sequence', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths.length) return null;
    return { path: path.join(r.filePaths[0], defaultName + '_%05d.png'), dir: r.filePaths[0] };
  }
  const r = await dialog.showSaveDialog(win, { title: 'Export', defaultPath: defaultName + '.' + ext, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (r.canceled || !r.filePath) return null;
  return { path: r.filePath };
});

// ---- LUTs (.cube): choose + parse; preview texture is N*N x N RGBA8 (x = r + b*N, y = g)
function lutTexture(file) {
  sec.assertSafePath(file, 'LUT');
  const l = parseCube(fs.readFileSync(file, 'utf8'));
  const N = l.size, px = new Uint8Array(N * N * N * 4);
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    const src = ((b * N + g) * N + r) * 3, dst = (g * N * N + b * N + r) * 4;
    for (let k = 0; k < 3; k++) {
      const v = (l.data[src + k] - l.dmin[k]) / ((l.dmax[k] - l.dmin[k]) || 1);
      px[dst + k] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
    px[dst + 3] = 255;
  }
  return { size: N, title: l.title, pixels: px };
}
ipcMain.handle('lut:choose', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a LUT', filters: [{ name: '3D LUT (.cube)', extensions: ['cube'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  try { const t = lutTexture(r.filePaths[0]); return { path: r.filePaths[0], name: path.basename(r.filePaths[0]), size: t.size }; }
  catch (err) { return { error: err.message }; }
});
ipcMain.handle('lut:data', (e, file) => { try { return lutTexture(file); } catch (err) { return { error: err.message }; } });

ipcMain.handle('project:import', async (e, { file, fps } = {}) => {
  try {
    let f = file;
    if (!f) {
      const r = await dialog.showOpenDialog(win, { title: 'Import a project from another editor', properties: ['openFile'], filters: [
        { name: 'Editor projects', extensions: ['xml', 'fcpxml', 'edl', 'prproj', 'otio'] },
        { name: 'Final Cut Pro XML / FCPXML (also from Premiere Pro)', extensions: ['xml', 'fcpxml'] },
        { name: 'CMX 3600 EDL', extensions: ['edl'] },
        { name: 'OpenTimelineIO', extensions: ['otio'] },
        { name: 'Premiere Pro project (experimental)', extensions: ['prproj'] }] });
      if (r.canceled || !r.filePaths[0]) return null;
      f = r.filePaths[0];
    }
    sec.assertSafePath(f, 'Project');
    if (fs.statSync(f).size > sec.MAX_IMPORT_BYTES) throw new Error('File is too large to import safely.');
    const out = importProjectFile(f, { fps: fps || 30 });
    const dropped = sec.sanitizeProject(out.project);
    if (dropped) out.warnings.push(dropped + ' media reference' + (dropped > 1 ? 's' : '') + ' pointing at network or unsupported locations were disconnected.');
    return { ok: true, project: out.project, warnings: out.warnings, stats: out.stats, path: f };
  } catch (err) { return { ok: false, error: err.message }; }
});
// ---- stabilisation (renders a steadier copy of the used part of a clip)
let stabCancel = false;
ipcMain.handle('stabilize:run', async (e, a) => {
  try {
    sec.assertSafePath(a.path, 'Media');
    stabCancel = false;
    const r = await stabilizer.stabilize(FFMPEG, {
      file: a.path, from: Math.max(0, +a.from || 0), span: +a.span, fps: Math.max(1, Math.min(120, +a.fps || 30)), w: Math.max(16, Math.min(8192, +a.w || 1920)), h: Math.max(16, Math.min(8192, +a.h || 1080)),
      smoothness: +a.smoothness, method: a.method === 'locked' ? 'locked' : 'smooth', fill: a.fill === 'edges' ? 'edges' : 'zoom', rotation: a.rotation !== false,
      outDir: ensureDir(path.join(userData(), 'stabilized'))
    }, (pct) => win && win.webContents.send('stabilize:progress', { id: a.id, pct }), () => stabCancel);
    const pr = await probeMany([r.path]);
    if (!pr.media.length) return { ok: false, error: pr.errors[0] || 'The stabilised file could not be opened.' };
    return { ok: true, media: pr.media[0], zoom: r.zoom, cached: r.cached };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('stabilize:cancel', () => { stabCancel = true; });
// ---- background removal (each job runs in its own utility process: heavy maths and a native module stay out of the editor)
const modelDirs = () => [app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(__dirname, '..', 'models'), path.join(app.getPath('userData'), 'models')];
ipcMain.handle('bg:models', () => bgremove.findModels(modelDirs()).map((m) => ({ id: m.id, label: m.label, note: m.note })));
let bgChild = null;
ipcMain.handle('bg:run', async (e, a) => {
  try {
    sec.assertSafePath(a.path, 'Media');
    if (bgChild) throw new Error('Another background removal is already running.');
    const model = bgremove.findModels(modelDirs()).find((m) => m.id === a.model);
    if (!model) throw new Error('That model is not installed.');
    const kind = a.kind === 'image' ? 'image' : 'video';
    const opts = {
      file: a.path, kind, from: clampN(a.from, 0, 1e6, 0), span: clampN(a.span, 0.1, 36000, 1), fps: clampN(a.fps, 1, 120, 30),
      w: clampN(a.w, 16, 8192, 1920), h: clampN(a.h, 16, 8192, 1080), model: { id: model.id, path: model.path },
      edge: clampN(a.edge, 0, 100, 35), shift: clampN(a.shift, -100, 100, 0), temporal: clampN(a.temporal, 0, 90, 30), step: Math.round(clampN(a.step, 1, 8, 1)),
      device: a.device === 'cpu' ? 'cpu' : 'auto', outDir: ensureDir(path.join(userData(), 'bg-removed'))
    };
    const r = await new Promise((resolve, reject) => {
      const child = utilityProcess.fork(path.join(__dirname, 'bgjob.js'), [], { serviceName: 'Ditto Pro background removal', stdio: 'ignore' });
      bgChild = child;
      let settled = false;
      const fin = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      child.on('spawn', () => child.postMessage({ type: 'start', ffmpeg: FFMPEG, opts }));
      child.on('message', (m) => {
        if (!m) return;
        if (m.type === 'progress') win && win.webContents.send('bg:progress', { id: a.id, pct: m.pct });
        else if (m.type === 'done') fin(resolve, m.r);
        else if (m.type === 'error') fin(reject, new Error(m.error));
      });
      child.on('exit', (code) => fin(reject, new Error('The background-removal process stopped unexpectedly (code ' + code + ').')));
    }).finally(() => { if (bgChild) { try { bgChild.kill(); } catch (x) { /* already gone */ } } bgChild = null; });
    const pr = await probeMany([r.path]);
    if (!pr.media.length) return { ok: false, error: pr.errors[0] || 'The result could not be opened.' };
    return { ok: true, media: pr.media[0], provider: r.provider, cached: r.cached };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('bg:cancel', () => { if (bgChild) bgChild.postMessage({ type: 'cancel' }); });
// ---- motion tracking and subject finding (auto-reframe)
let trackCancel = false;
const clampN = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : d);
const trackArgs = (a) => ({ file: a.path, from: clampN(a.from, 0, 1e6, 0), span: clampN(a.span, 0.1, 3600, 1), fps: clampN(a.fps, 1, 60, 30), w: clampN(a.w, 16, 16384, 1920), h: clampN(a.h, 16, 16384, 1080) });
ipcMain.handle('track:point', async (e, a) => {
  try {
    sec.assertSafePath(a.path, 'Media');
    trackCancel = false;
    const r = await tracker.trackPoint(FFMPEG, Object.assign(trackArgs(a), {
      pointT: clampN(a.pointT, 0, 3600, 0), x: clampN(a.x, 0, 1, 0.5), y: clampN(a.y, 0, 1, 0.5), size: clampN(a.size, 0.02, 0.3, 0.06),
      direction: ['forward', 'backward'].includes(a.direction) ? a.direction : 'both'
    }), (pct) => win && win.webContents.send('track:progress', { id: a.id, pct }), () => trackCancel);
    return { ok: true, samples: tracker.simplify(r.samples, 0.0015), full: r.samples.length, fps: r.fps, truncated: r.truncated, lost: r.samples.filter((s) => !s.ok).length };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('track:subject', async (e, a) => {
  try {
    sec.assertSafePath(a.path, 'Media');
    trackCancel = false;
    const r = await tracker.analyzeSubject(FFMPEG, Object.assign(trackArgs(a), { fps: clampN(a.analysisFps, 2, 15, 8), smooth: clampN(a.smooth, 0.2, 5, 0.9) }),
      (pct) => win && win.webContents.send('track:progress', { id: a.id, pct }), () => trackCancel);
    return { ok: true, path: r.path, confidence: r.confidence };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('track:cancel', () => { trackCancel = true; });
// ---- captions: offline speech-to-text (whisper.cpp) and SubRip files
const whisperDirs = () => [app.isPackaged ? path.join(process.resourcesPath, 'whisper') : path.join(__dirname, '..', 'whisper'), path.join(app.getPath('userData'), 'whisper')];
ipcMain.handle('captions:engine', () => { const e = whisper.findEngine(whisperDirs()); return { ok: !!(e.bin && e.model), bin: !!e.bin, model: !!e.model, model_name: e.model ? path.basename(e.model) : null }; });
ipcMain.handle('captions:generate', async (e, { file, from, to, language }) => {
  if (!sec.isSafeLocalPath(file)) return { ok: false, error: 'Media path is not allowed.' };
  try {
    const eng = whisper.findEngine(whisperDirs());
    const cues = await whisper.transcribe(FFMPEG, eng, file, { from, to, language, threads: Math.max(2, Math.min(8, os.cpus().length - 1)) });
    return { ok: true, cues };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('captions:openSrt', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import captions', properties: ['openFile'], filters: [{ name: 'Captions (SubRip, WebVTT, SubStation, SBV)', extensions: ['srt', 'vtt', 'ass', 'ssa', 'sbv'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  try { sec.assertSafePath(r.filePaths[0], 'Captions'); if (fs.statSync(r.filePaths[0]).size > 32 * 1024 * 1024) throw new Error('That caption file is too large.'); return { ok: true, cues: parseCaptions(fs.readFileSync(r.filePaths[0], 'utf8'), path.extname(r.filePaths[0])), name: path.basename(r.filePaths[0]) }; } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('captions:saveSrt', async (e, { cues, name }) => {
  const r = await dialog.showSaveDialog(win, { title: 'Export captions', defaultPath: (name || 'captions') + '.srt', filters: [{ name: 'SubRip captions', extensions: ['srt'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, formatSrt(cues), 'utf8');
  return { ok: true, path: r.filePath };
});

// ---- collect project files: every file the project uses is copied into one folder beside a copy of the project
ipcMain.handle('project:collect', async (e, { json, dir }) => {
  try {
    const collect = require('./collect');
    let dest = process.env.DITTO_TEST ? dir : null;
    if (!dest) {
      const r = await dialog.showOpenDialog(win, { title: 'Collect project files: choose where the new folder goes', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths.length) return null;
      dest = r.filePaths[0];
    }
    const obj = JSON.parse(String(json));
    collect.filesOf(obj).forEach((f) => sec.assertSafePath(f.path, f.kind === 'lut' ? 'LUT' : 'Media'));
    const res = await collect.collectProject(obj, dest, { onProgress: (p) => { if (win && !win.isDestroyed()) win.webContents.send('collect:progress', p); } });
    return Object.assign({ ok: true }, res);
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('media:findBeside', (e, a) => { try { return require('./collect').findBeside(a && a.projectPath, a && a.paths); } catch (err) { return {}; } });
ipcMain.handle('project:exportEdl', async (e, { project }) => {
  const r = await dialog.showSaveDialog(win, { title: 'Export EDL', defaultPath: String((project && project.name) || 'sequence').replace(/[\\/:*?"<>|]+/g, '_') + '.edl', filters: [{ name: 'CMX 3600 EDL', extensions: ['edl'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, require('./edl').exportEDL(project || {}), 'utf8');
  return { ok: true, path: r.filePath };
});
ipcMain.handle('multicam:sync', async (e, { items }) => { try { (items || []).forEach((i) => sec.assertSafePath(i.file || i.path, 'Media')); return { ok: true, results: await syncLib.syncFiles(FFMPEG, items, {}) }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('analyze:peak', async (e, { file, opts }) => { try { sec.assertSafePath(file, 'Media'); return { ok: true, level: await analysis.detectPeak(FFMPEG, file, opts) }; } catch (err) { return { ok: false, error: err.message }; } });
// ---- voice-over: the page records the microphone (WebM/Opus) and hands the bytes over; they are stored as a WAV file
ipcMain.handle('voice:save', async (e, { data }) => {
  try {
    const buf = Buffer.from(data || []);
    if (buf.length < 200 || buf.length > 1024 * 1024 * 1024) throw new Error('The recording is empty or too large.');
    const dir = ensureDir(path.join(userData(), 'voiceovers'));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + Math.floor(Math.random() * 1e4);
    const raw = path.join(dir, 'vo-' + stamp + '.webm'), out = path.join(dir, 'Voice-over ' + stamp + '.wav');
    fs.writeFileSync(raw, buf);
    try { await run(FFMPEG, ['-y', '-v', 'error', '-nostdin', '-i', raw, '-vn', '-ar', '48000', '-c:a', 'pcm_s16le', out]); }
    finally { try { fs.unlinkSync(raw); } catch (err) { /* ignore */ } }
    const pr = await probeMany([out]);
    if (!pr.media.length) throw new Error(pr.errors[0] || 'The recording could not be opened.');
    return { ok: true, media: pr.media[0] };
  } catch (err) { return { ok: false, error: String((err.stderr || err.message || err)).slice(0, 300) }; }
});
ipcMain.handle('analyze:silence', async (e, { file, opts }) => { try { sec.assertSafePath(file, 'Media'); return { ok: true, silences: await analysis.detectSilence(FFMPEG, file, opts) }; } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('analyze:scenes', async (e, { file, opts }) => { try { sec.assertSafePath(file, 'Media'); return { ok: true, times: await analysis.detectScenes(FFMPEG, file, opts) }; } catch (err) { return { ok: false, error: err.message }; } });

// Renders `project` with FFmpeg. hooks: { onProgress(pct, speed), setProc(proc|null), cancelled() }
async function renderProject(project, opts, titles, hooks) {
  (project.media || []).forEach((m) => { if (m.path) sec.assertSafePath(m.path, 'Media'); });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dittopro-'));
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (err) { /* ignore */ } };
  try {
    const titleFiles = {}, titleSizes = {};
    for (const id of Object.keys(titles || {})) {
      const f = path.join(tmp, 'title_' + id.replace(/[^\w-]/g, '_') + '.png');
      const png = Buffer.from(String(titles[id]).replace(/^data:image\/png;base64,/, ''), 'base64');
      fs.writeFileSync(f, png);
      titleFiles[id] = f;
      // picture size from the PNG header (rolling credits are taller than the frame)
      if (png.length > 24 && png.readUInt32BE(12) === 0x49484452) titleSizes[id] = { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
    }
    // LUTs are copied next to the filter script under simple names (ffmpeg runs with that folder as cwd),
    // which avoids Windows drive-letter / backslash escaping problems inside filter graphs.
    const lutFiles = {};
    (project.clips || []).forEach((c) => {
      const lp = c.fx && c.fx.lut && c.fx.lut.path;
      if (lp && !lutFiles[lp]) { const name = 'lut' + Object.keys(lutFiles).length + '.cube'; fs.copyFileSync(lp, path.join(tmp, name)); lutFiles[lp] = name; }
    });
    // colour grades are baked to small .cube files next to the script (same reason: plain names, no escaping)
    const gradeFiles = {};
    const DGm = require('./grade');
    const allClips = (project.clips || []).concat(...Object.values(project.nests || {}).map((n) => n.clips || []));
    allClips.forEach((c) => {
      if (c && c.fx && c.fx.color && DGm.active(c.fx.color)) {
        const k = DGm.key(c.fx.color);
        if (!gradeFiles[k]) { const name = 'grade' + Object.keys(gradeFiles).length + '.cube'; fs.writeFileSync(path.join(tmp, name), DGm.cubeText(c.fx.color, 33)); gradeFiles[k] = name; }
      }
    });
    const scriptPath = path.join(tmp, 'filter.txt');
    const major = await getFfmpegMajor();
    const metaPath = path.join(tmp, 'chapters.txt');
    const b = buildExport(project, Object.assign({}, opts, { scriptPath, metaPath, newFilterFlag: major >= 7 }), { titleFiles, titleSizes, lutFiles, gradeFiles });
    fs.writeFileSync(scriptPath, b.script, 'utf8');
    if (b.metadata) fs.writeFileSync(metaPath, b.metadata, 'utf8');
    const started = Date.now();
    const res = await new Promise((resolve) => {
      const p = spawn(FFMPEG, b.args, { windowsHide: true, cwd: tmp });
      hooks.setProc(p);
      let tail = '';
      p.stdout.on('data', (d) => {
        const s = d.toString();
        const m = s.match(/out_time_us=(\d+)/g);
        if (m) {
          const us = parseInt(m[m.length - 1].split('=')[1], 10);
          const sp = s.match(/speed=\s*([\d.]+)x/);
          hooks.onProgress(Math.min(1, us / 1e6 / b.duration), sp ? parseFloat(sp[1]) : null);
        }
      });
      p.stderr.on('data', (d) => { tail = (tail + d).slice(-4000); });
      p.on('error', (err) => resolve({ ok: false, error: 'Could not start FFmpeg: ' + err.message }));
      p.on('close', (code) => {
        if (hooks.cancelled()) resolve({ ok: false, cancelled: true });
        else if (code === 0) resolve({ ok: true });
        else resolve({ ok: false, error: 'FFmpeg failed (code ' + code + ').\n' + tail.split('\n').filter(Boolean).slice(-6).join('\n') });
      });
    });
    hooks.setProc(null);
    if (!res.ok && opts.format !== 'png-seq') { try { fs.unlinkSync(opts.outPath); } catch (err) { /* ignore */ } }
    res.seconds = (Date.now() - started) / 1000;
    res.outPath = opts.outPath;
    return res;
  } catch (err) {
    hooks.setProc(null);
    return { ok: false, error: String(err.message || err) };
  } finally { cleanup(); }
}

// hardware encoders that really work on this computer (a short real test encode each; cached for the session)
let hwProbe = null;
ipcMain.handle('export:encoders', () => { if (!hwProbe) hwProbe = hwenc.probe(FFMPEG).catch(() => []); return hwProbe; });
ipcMain.handle('export:start', async (e, { project, opts, titles }) => {
  if (exportProc) return { ok: false, error: 'An export is already running.' };
  exportCancelled = false;
  const hooks = {
    onProgress: (pct, speed) => { win && win.webContents.send('export:progress', { pct, speed }); },
    setProc: (p) => { exportProc = p; },
    cancelled: () => exportCancelled
  };
  const o = Object.assign({}, opts, { encoder: hwenc.pick(opts && opts.encoder, opts && opts.format) || 'software' });
  return hwenc.runWithFallback((x) => renderProject(project, x, titles, hooks), o);
});

// ---- nested sequences: a nest is rendered once (ProRes 4444 with alpha) into a cache, then used like any media file
const nestJobs = new Map();
ipcMain.handle('nest:render', (e, { hash, payload, titles }) => {
  if (!/^[0-9a-f]{8,64}$/.test(String(hash))) return { ok: false, error: 'Invalid request.' };
  const dir = ensureDir(path.join(userData(), 'nest-cache'));
  const out = path.join(dir, hash + '.mov');
  if (fs.existsSync(out)) return { ok: true, path: out, cached: true };
  if (nestJobs.has(hash)) return nestJobs.get(hash);
  const job = (async () => {
    const part = path.join(dir, hash + '.part.mov');
    const res = await renderProject(payload, { format: 'nest-prores', outPath: part }, titles, {
      onProgress: (pct) => { win && win.webContents.send('nest:progress', { hash, pct }); },
      setProc: () => {}, cancelled: () => false
    });
    if (res.ok) { fs.renameSync(part, out); return { ok: true, path: out }; }
    try { fs.unlinkSync(part); } catch (err) { /* ignore */ }
    return { ok: false, error: res.error };
  })().finally(() => nestJobs.delete(hash));
  nestJobs.set(hash, job);
  return job;
});
// small VP9-with-alpha copy the preview can play (nested sequences, background-removed and other transparent clips)
function alphaProxy(src, hash) {
  return new Promise((resolve) => {
    const dir = ensureDir(path.join(userData(), 'nest-cache'));
    const out = path.join(dir, hash + '.webm');
    if (fs.existsSync(out)) return resolve({ ok: true, url: mediaUrl(out), file: out });
    const part = path.join(dir, hash + '.part.webm');
    const args = ['-y', '-v', 'error', '-nostdin', '-i', src, '-vf', "scale='min(960,iw)':-2,format=yuva420p", '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '2000k', '-deadline', 'realtime', '-cpu-used', '8', '-auto-alt-ref', '0', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '96k', part];
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
    p.on('error', (x) => resolve({ ok: false, error: x.message }));
    p.on('close', (code) => {
      if (code === 0) { fs.renameSync(part, out); resolve({ ok: true, url: mediaUrl(out), file: out }); }
      else { try { fs.unlinkSync(part); } catch (x) { /* ignore */ } resolve({ ok: false, error: err }); }
    });
  });
}
ipcMain.handle('nest:proxy', (e, { hash, path: src }) => {
  if (!/^[0-9a-f]{8,64}$/.test(String(hash)) || !sec.isSafeLocalPath(src)) return { ok: false, error: 'Invalid request.' };
  return alphaProxy(src, hash).then((r) => ({ ok: r.ok, url: r.url, error: r.error }));
});
ipcMain.handle('export:cancel', () => {
  if (exportProc) { exportCancelled = true; exportProc.kill(); }
  return true;
});
