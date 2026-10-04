'use strict';
/* Ditto Pro — application wiring: menus, file operations, shortcuts, import/open. */
const App = (() => {
  const FPS_LIST = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
  const api = window.ditto;
  let lastProxyEmit = 0;

  // ------------------------------------------------------------ title
  function updateTitle() {
    const p = S.project;
    $('#projname').textContent = p.name + (S.dirty ? ' •' : '');
    document.title = (S.dirty ? '• ' : '') + p.name + ' — Ditto Pro';
  }
  S.on('change', updateTitle); S.on('load', updateTitle); S.on('media', updateTitle);
  // a project that is not saved to a file holds no lock on anyone's shared folder
  S.on('load', () => { if (!S.filePath) api.releaseProject(); });
  api.whoami().then((w) => { S.defaultAuthor = w && w.user; });
  $('#projname').addEventListener('click', () => {
    const inp = el('input', { type: 'text', value: S.project.name, style: 'width:100%;text-align:left' });
    modal({ title: 'Rename project', body: [inp], buttons: [{ label: 'Cancel' }, { label: 'Rename', primary: true, onClick: () => { S.project.name = inp.value.trim() || 'Untitled'; S.dirty = true; updateTitle(); } }] });
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('.modal .primary').click(); });
  });

  // ------------------------------------------------------------ media registration / proxies
  function adoptMedia(m) {
    m.previewUrl = m.needsProxy ? null : m.url;
    m.missing = false;
  }
  function startProxy(m) {
    const rt = S.rtFor(m.id);
    rt.proxyPct = 0; m.proxyState = 'working';
    api.makeProxy({ id: m.id, path: m.path, kind: m.kind, alpha: !!m.alpha }).then((res) => {
      if (!S.media(m.id)) return;
      if (res.ok) { m.previewUrl = res.url; m.proxyState = 'ready'; }
      else { m.proxyState = 'error'; toast('Could not prepare a preview for "' + m.name + '". It can still be exported. ' + (res.error || '').split('\n').pop(), 'err'); }
      rt.proxyPct = null;
      S.emit('proxy'); Player.requestRender();
    });
  }
  api.on('proxy:progress', ({ id, pct }) => {
    S.rtFor(id).proxyPct = pct;
    const now = Date.now();
    if (now - lastProxyEmit > 400) { lastProxyEmit = now; S.emit('proxy'); }
  });

  function nearestFps(f) {
    let best = 30, bd = 99;
    FPS_LIST.forEach((x) => { const d = Math.abs(x - f); if (d < bd) { bd = d; best = x; } });
    return bd < 0.6 ? best : Math.round(f) || 30;
  }

  function registerMedia(items) {
    if (!items || !items.length) return [];
    const wasEmpty = !S.project.media.length && !S.project.clips.length;
    items.forEach(adoptMedia);
    const added = S.addMediaItems(items);
    if (wasEmpty) {
      const v = added.find((m) => m.kind === 'video' && m.w && m.h);
      if (v) {
        const p = S.project;
        p.width = Math.max(2, Math.round(v.w / 2) * 2); p.height = Math.max(2, Math.round(v.h / 2) * 2);
        if (v.fps) p.fps = nearestFps(v.fps);
        Player.resize();
        toast('Sequence set to ' + p.width + '×' + p.height + ' @ ' + (Math.round(p.fps * 100) / 100) + ' fps to match "' + v.name + '".', 'ok', 4200);
      }
    }
    added.forEach((m) => { if (m.needsProxy) startProxy(m); });
    return added;
  }

  async function importMedia() {
    const res = await api.importDialog();
    handleImportResult(res);
  }
  function rippleTrim(side) {
    const n = S.rippleTrimToPlayhead(side);
    if (!n) toast('Put the playhead inside a clip first.', 'err');
  }
  function rangeOp(extract) {
    const w = S.project.workArea || {};
    if (w.in == null || w.out == null || !(w.out > w.in)) { toast('Set an in point (I) and an out point (O) first.', 'err'); return; }
    const n = extract ? S.extractRange(w.in, w.out) : S.liftRange(w.in, w.out);
    S.project.workArea = { in: null, out: null }; S.change();
    toast(extract ? 'Extracted ' + (Math.round(n * 100) / 100) + ' s.' : 'Lifted ' + n + ' clip piece' + (n === 1 ? '' : 's') + '.');
  }
  async function freezeFrame() {
    const t = S.playhead;
    const list = Array.from(S.sel).map(S.clip).filter(Boolean);
    const c = (list.length ? list : S.project.clips).filter((x) => x.type === 'media' && DS.isVideoTrackId(x.track) && x.start < t - 0.01 && DS.clipEnd(x) > t + 0.01).sort((x, y) => S.project.tracks.findIndex((q) => q.id === y.track) - S.project.tracks.findIndex((q) => q.id === x.track))[0];
    const m = c && S.media(c.media);
    if (!c || !m || m.kind !== 'video') { toast('Put the playhead inside a video clip (or select one) first.', 'err'); return; }
    if (c.reverse) { toast('Freeze frame is not available on reversed clips.', 'err'); return; }
    const src = c.in + (t - c.start) * c.speed;
    const r = await api.freezeFrame({ file: m.path, t: src });
    if (!r || !r.ok) { toast('Could not make the freeze frame: ' + ((r && r.error) || 'unknown error'), 'err', 6000); return; }
    let still = S.project.media.find((x) => x.path.toLowerCase() === r.media.path.toLowerCase());
    if (!still) still = registerMedia([r.media])[0];
    if (!S.freezeFrame(c.id, still, 2)) toast('Could not insert the freeze frame (is the track locked?).', 'err');
    else toast('Freeze frame added (2 s). Drag its end to make it longer.', 'ok', 3500);
  }
  async function importSequence() {
    toast('Choose any frame of the sequence…', '', 1800);
    const res = await api.importSequence({ fps: S.project.fps });
    if (!res) return;
    if (!res.ok) { toast('Could not import the sequence: ' + res.error, 'err', 7000); return; }
    const added = registerMedia([res.media]);
    toast(added.length ? 'Imported a ' + res.frames + '-frame image sequence at ' + res.fps + ' fps.' + (res.notes && res.notes.length ? ' ' + res.notes.join(' ') : '') : 'That sequence is already in the project.', 'ok', 4000);
  }
  function handleImportResult(res) {
    if (!res) return;
    const added = registerMedia(res.media);
    if (res.errors && res.errors.length) toast(res.errors.slice(0, 3).join('\n'), 'err', 7000);
    if (res.media.length && !added.length) toast('That media is already in the project.');
    else if (added.length) toast('Imported ' + added.length + ' file' + (added.length > 1 ? 's' : '') + '. Drag them onto the timeline.', 'ok', 2600);
  }

  function addMediaToTimeline(id) {
    const m = S.media(id);
    if (!m) return;
    const type = m.kind === 'audio' ? 'audio' : 'video';
    const tr = S.freeTrackFor(type, S.playhead, m.duration) || S.project.tracks.find((t) => t.type === type && !t.lock);
    const c = S.placeMedia(id, tr && tr.id, S.playhead);
    if (c) S.setSelection([c.id]);
  }

  async function relink(id) {
    const m = S.media(id);
    if (!m) return;
    const n = await api.relink(m.path);
    if (!n) return;
    Object.assign(m, { path: n.path, name: n.name, duration: n.duration, w: n.w, h: n.h, fps: n.fps, hasAudio: n.hasAudio, vcodec: n.vcodec, acodec: n.acodec, kind: n.kind, thumb: n.thumb, url: n.url, needsProxy: n.needsProxy });
    adoptMedia(m);
    if (m.needsProxy) startProxy(m);
    Player.dispose && S.project.clips.filter((c) => c.media === id).forEach((c) => Player.dispose(c.id));
    S.emit('media'); S.change(true);
    toast('Relinked "' + m.name + '".', 'ok');
  }

  // ------------------------------------------------------------ files
  function sanitiseLoaded(obj) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.clips) || !Array.isArray(obj.tracks)) throw new Error('This is not a Ditto Pro project file.');
    return obj;
  }

  async function reconnectMedia() {
    try { await reconnectMedia_(); } finally { S.mediaChecked = true; Nest.refreshAll(); }
  }
  async function reconnectMedia_() {
    const list = S.project.media.filter((m) => !m.nest);
    if (!list.length) return;
    const luts = [];
    const eachClip = (fn) => { S.rootProject().clips.forEach(fn); Object.values(S.rootProject().nests || {}).forEach((n) => (n.clips || []).forEach(fn)); };
    eachClip((c) => { if (c.fx && c.fx.lut && c.fx.lut.path) luts.push(c.fx.lut); });
    let ex = await api.exists(list.map((m) => m.path).concat(luts.map((l) => l.path)));
    // a project that was collected, moved or copied to another computer: look for the same file names beside the project
    const gone = list.filter((m) => !ex[m.path]).map((m) => m.path).concat(luts.filter((l) => !ex[l.path]).map((l) => l.path));
    if (gone.length && S.filePath) {
      const found = await api.findBeside({ projectPath: S.filePath, paths: gone });
      let n = 0;
      list.forEach((m) => { if (found[m.path]) { ex[found[m.path]] = true; m.path = found[m.path]; n++; } });
      luts.forEach((l) => { if (found[l.path]) { l.path = found[l.path]; n++; } });
      if (n) toast('Found ' + n + ' file' + (n > 1 ? 's' : '') + ' beside the project.', 'ok', 3000);
    }
    const present = list.filter((m) => ex[m.path]);
    list.forEach((m) => { m.missing = !ex[m.path]; });
    if (present.length) {
      const res = await api.probe(present.map((m) => m.path));
      res.media.forEach((n) => {
        const m = present.find((x) => x.path === n.path);
        if (!m) return;
        Object.assign(m, { thumb: n.thumb, url: n.url, needsProxy: n.needsProxy, duration: n.duration, w: n.w, h: n.h, fps: n.fps, hasAudio: n.hasAudio });
        adoptMedia(m);
        if (m.needsProxy) startProxy(m);
      });
      present.forEach((m) => { if (!res.media.find((n) => n.path === m.path)) m.missing = true; });
    }
    S.emit('media'); S.change(true);
    const missing = S.project.media.filter((m) => m.missing);
    if (missing.length) toast(missing.length + ' media file' + (missing.length > 1 ? 's are' : ' is') + ' offline. Right-click it in the Project panel → Locate file…', 'err', 7000);
  }

  async function confirmDiscard() {
    if (!S.dirty) return true;
    const r = await askSave(S.project.name);
    if (r === 'cancel') return false;
    if (r === 'yes') return !!(await save(false));
    return true;
  }

  async function newProject() {
    if (!(await confirmDiscard())) return;
    Player.stop();
    Dialogs.projectSettings({ isNew: true });
  }

  async function openFile(pathOrNull) {
    if (!(await confirmDiscard())) return;
    Player.stop();
    const r = pathOrNull ? await api.readProject(pathOrNull) : await api.openProject();
    if (!r) { if (pathOrNull) toast('Could not read that project file.', 'err'); return; }
    try {
      const obj = sanitiseLoaded(JSON.parse(r.json));
      S.load(obj, r.path);
      await reconnectMedia();
      S.dirty = false;
      if (r.copyOf) { S.project.name = S.project.name + ' (copy)'; S.dirty = true; }
      updateTitle();
      toast(r.copyOf ? 'Opened a private copy of "' + r.copyOf + '". Save it under a new name.' : 'Opened "' + S.project.name + '".', 'ok', r.copyOf ? 5000 : 1800);
    } catch (e) { toast('Could not open project: ' + e.message, 'err'); }
  }

  async function importProjectFrom(file) {
    const res = await api.importProject({ file: file || null, fps: S.project.fps });
    if (!res) return;
    if (!res.ok) { toast('Could not import: ' + res.error, 'err', 7000); return; }
    if (!(await confirmDiscard())) return;
    Player.stop();
    S.load(res.project, null);
    await reconnectMedia();
    S.dirty = true; updateTitle();
    Timeline.fit && Timeline.fit();
    toast('Imported ' + res.stats.clips + ' clips from "' + res.path.split(/[\\/]/).pop() + '".', 'ok', 3000);
    if (res.warnings && res.warnings.length) {
      modal({ title: 'Import notes', width: 520, body: [el('ul', { style: 'margin:0;padding-left:18px;line-height:1.5' }, res.warnings.map((w) => el('li', { text: w })))], buttons: [{ label: 'OK', primary: true }] });
    }
  }

  async function collectFiles(testDir) {
    S.exitAllNests();
    if (!S.project.media.length) { toast('There is nothing to collect yet.', 'err'); return null; }
    const status = el('div', { text: 'Choose where the new folder should go…' }), bar = el('i');
    const dlg = modal({ title: 'Collecting project files', dismissable: false, width: 480, body: [status, el('div', { class: 'progress' }, [bar])], buttons: [] });
    const off = api.on('collect:progress', (p) => { bar.style.width = Math.round(100 * p.done / Math.max(1, p.total)) + '%'; status.textContent = p.name ? 'Copying ' + p.name + ' (' + (p.done + 1) + ' of ' + p.total + ')' : 'Finishing…'; });
    let res;
    try { res = await api.collectProject({ json: S.serialize(), dir: testDir || null }); } catch (e) { res = { ok: false, error: String(e.message || e) }; }
    off(); dlg.close();
    if (!res) return null;
    if (!res.ok) { toast('Could not collect the files: ' + res.error, 'err', 8000); return res; }
    const mb = res.bytes / 1048576;
    modal({
      title: 'Project collected', width: 520,
      body: [
        el('div', { text: res.copied + ' file' + (res.copied === 1 ? '' : 's') + ' (' + (mb >= 100 ? Math.round(mb) : mb.toFixed(1)) + ' MB) copied, with a copy of the project that uses them.' }),
        el('div', { class: 'dim', text: res.dir }),
        res.skipped.length ? el('div', { class: 'errbox', text: 'Not found, so not copied: ' + res.skipped.slice(0, 8).join(', ') + (res.skipped.length > 8 ? ' and ' + (res.skipped.length - 8) + ' more' : '') }) : null,
        el('div', { class: 'dim', style: 'font-size:11.5px', text: 'The project you have open is unchanged. The folder can be zipped, archived or moved: when it is opened elsewhere the files are found beside the project.' })
      ].filter(Boolean),
      buttons: [{ label: 'Close' }, { label: 'Show in folder', primary: true, onClick: () => window.ditto.reveal(res.project) }]
    });
    return res;
  }

  async function save(saveAs) {
    const res = await api.saveProject({ json: S.serialize(), filePath: S.filePath, saveAs: !!saveAs, name: S.project.name });
    if (!res) return null;
    S.filePath = res.path; S.dirty = false; updateTitle();
    api.autosaveWrite('');
    toast('Saved.', 'ok', 1200);
    return res.path;
  }

  // ------------------------------------------------------------ menus
  const MENUS = () => [
    ['File', [
      { label: 'New project…', key: 'Ctrl+N', run: newProject },
      { label: 'Open project…', key: 'Ctrl+O', run: () => openFile() },
      '-',
      { label: 'Save', key: 'Ctrl+S', run: () => save(false) },
      { label: 'Save as…', key: 'Ctrl+Shift+S', run: () => save(true) },
      '-',
      { label: 'Collect project files…', run: () => collectFiles() },
      '-',
      { label: 'Import media…', key: 'Ctrl+I', run: importMedia },
      { label: 'Import image sequence…', run: importSequence },
      { label: 'Import project from another editor…', run: () => importProjectFrom() },
      { label: 'Export current frame…', run: () => Dialogs.exportFrame() },
      { label: 'Render queue…', run: () => Dialogs.queueDialog() },
      { label: 'Export EDL (for other editors)…', run: async () => {
        const p = S.project; S.exitAllNests();
        if (!p.clips.length) return toast('Nothing to export yet.', 'err');
        const r = await window.ditto.exportEdl({ project: DS.clone({ name: p.name, fps: p.fps, tracks: p.tracks, clips: p.clips, media: p.media.map((m) => ({ id: m.id, path: m.path, name: m.name, hasAudio: m.hasAudio })) }) });
        if (r && r.ok) toast('EDL saved: ' + r.path);
      } },
      { label: 'Export…', key: 'Ctrl+E', run: () => Dialogs.exportDialog() },
      '-',
      { label: 'Exit', run: () => window.close() }
    ]],
    ['Edit', [
      { label: 'Undo', key: 'Ctrl+Z', run: () => S.undo() },
      { label: 'Redo', key: 'Ctrl+Shift+Z', run: () => S.redo() },
      '-',
      { label: 'Copy', key: 'Ctrl+C', run: () => S.copy() },
      { label: 'Paste at playhead', key: 'Ctrl+V', run: () => S.paste() },
      { label: 'Duplicate', key: 'Ctrl+D', run: () => S.duplicate() },
      '-',
      { label: 'Select all clips', key: 'Ctrl+A', run: () => S.setSelection(S.project.clips.map((c) => c.id)) },
      { label: 'Delete', key: 'Del', run: () => S.deleteClips(Array.from(S.sel), false) },
      { label: 'Lift in → out (leave a gap)', key: ';', run: () => rangeOp(false) },
      { label: 'Extract in → out (close the gap)', key: "'", run: () => rangeOp(true) },
      { label: 'Freeze frame at playhead', run: () => freezeFrame() },
      { label: 'Ripple trim: previous cut to playhead', key: 'Q', run: () => rippleTrim('prev') },
      { label: 'Ripple trim: playhead to next cut', key: 'W', run: () => rippleTrim('next') },
      { label: 'Nudge selection one frame left / right', key: 'Alt+← →', run: () => S.nudge(1) },
      { label: 'Slip selection one frame', key: 'Ctrl+Alt+← →', run: () => S.slip(1) },
      { label: 'Close gaps between clips', run: () => { const tr = Array.from(new Set(S.selClips().map((c) => c.track))); const n = S.closeGaps(tr.length ? tr : null); toast(n ? 'Closed ' + n + ' gap' + (n > 1 ? 's' : '') + '.' : 'There are no gaps to close.'); } },
      { label: 'Paste effects', key: 'Ctrl+Alt+V', run: () => { const n = S.pasteAttributes('effects'); toast(n ? 'Effects pasted onto ' + n + ' clip' + (n > 1 ? 's' : '') + '.' : 'Copy a clip, then select the clips to paste its effects onto.'); } },
      { label: 'Paste motion', run: () => { const n = S.pasteAttributes('motion'); toast(n ? 'Motion pasted onto ' + n + ' clip' + (n > 1 ? 's' : '') + '.' : 'Copy a clip, then select the clips to paste its motion onto.'); } },
      { label: 'Detach audio', run: () => { if (!S.detachAudio()) toast('Select a video clip that has sound.', 'err'); } },
      { label: 'Ripple delete', key: 'Shift+Del', run: () => S.deleteClips(Array.from(S.sel), true) }
    ]],
    ['Clip', [
      { label: 'Split at playhead', key: 'Ctrl+K', run: () => S.splitAtPlayhead() },
      { label: 'Nest selected clips', run: () => Nest.nestSelected() },
      { label: 'Open nested sequence', run: () => Nest.openSelected() },
      { label: 'Add title', run: () => S.placeSpecial('title', S.playhead) },
      { label: 'Add adjustment layer', run: () => S.placeSpecial('adjust', S.playhead) },
      { label: 'Add colour matte', run: () => S.placeSpecial('matte', S.playhead) },
      { label: 'Add rectangle shape', run: () => S.placeSpecial('rect', S.playhead) },
      { label: 'Add ellipse shape', run: () => S.placeSpecial('ellipse', S.playhead) },
      '-',
      { label: 'Speed ramp…', run: () => AI.speedRamp() },
      { label: 'Stabilize…', run: () => AI.stabilize() },
      { label: 'Track motion…', run: () => { const c = S.selClips()[0]; if (c) Tracker.open(c); else toast('Select a video clip first.', 'err'); } },
      { label: 'Use original (undo stabilize)', run: () => AI.unstabilize() },
      { label: 'Remove background…', run: () => AI.removeBackground() },
      { label: 'Bring background back', run: () => AI.restoreBackground() },
      '-',
      { label: 'Remove silences…', run: () => AI.removeSilence() },
      { label: 'Auto-duck music under speech…', run: () => AI.autoDuck() },
      { label: 'Normalise clip volume (peak −1 dB)', run: () => AI.normalizeClips(-1) },
      { label: 'Record voice-over…', run: () => Voice.open() },
      { label: 'Split at scene changes…', run: () => AI.detectScenes() },
      '-',
      { label: 'Add marker', key: 'M', run: () => S.addMarker() },
      { label: 'Mark in', key: 'I', run: () => S.setWorkIn() },
      { label: 'Mark out', key: 'O', run: () => S.setWorkOut() },
      { label: 'Clear in / out', key: 'Alt+X', run: () => S.clearWork() }
    ]],
    ['Multicam', [
      { label: 'Create multicam from selected clips (sync by audio)', run: () => AI.createMulticam() },
      { label: 'Cut to angle 1–9', key: '1–9', run: () => toast('Press a number key while a multicam is on the timeline.') }
    ]],
    ['Captions', [
      { label: 'Generate captions from speech…', run: () => AI.generateCaptions() },
      { label: 'Import captions (.srt, .vtt, .ass, .sbv)…', run: () => AI.importCaptions() },
      { label: 'Export captions (.srt)…', run: () => AI.exportCaptions() },
      '-',
      { label: 'Delete all captions', run: () => AI.removeCaptions() }
    ]],
    ['Sequence', [
      { label: 'Sequence settings…', run: () => Dialogs.projectSettings() },
      { label: 'Auto reframe…', run: () => Tracker.reframe() },
      '-',
      { label: 'Add video track', run: () => S.addTrack('video') },
      { label: 'Add audio track', run: () => S.addTrack('audio') },
      '-',
      { label: 'Zoom to fit', key: '\\', run: () => Timeline.fit() }
    ]],
    ['Help', [
      { label: 'Keyboard shortcuts', run: showShortcuts },
      { label: 'Suggest a feature / report a bug…', run: () => window.ditto.feedback() },
      { label: 'About Ditto Pro', run: showAbout }
    ]]
  ];

  function buildMenus() {
    const nav = $('#menus');
    nav.innerHTML = '';
    MENUS().forEach(([name, items]) => {
      const m = el('div', { class: 'menu' });
      const b = el('button', { text: name });
      const drop = el('div', { class: 'drop' });
      items.forEach((it) => {
        if (it === '-') { drop.appendChild(el('div', { class: 'sep' })); return; }
        const row = el('div', { class: 'item' }, [el('span', { text: it.label }), it.key ? el('kbd', { text: it.key }) : null]);
        row.addEventListener('click', () => { closeMenus(); it.run(); });
        drop.appendChild(row);
      });
      b.addEventListener('click', (e) => { e.stopPropagation(); const open = m.classList.contains('open'); closeMenus(); if (!open) m.classList.add('open'); });
      b.addEventListener('mouseenter', () => { if ($('.menu.open')) { closeMenus(); m.classList.add('open'); } });
      m.appendChild(b); m.appendChild(drop); nav.appendChild(m);
    });
  }
  const closeMenus = () => $$('#menus .menu.open').forEach((n) => n.classList.remove('open'));
  document.addEventListener('click', closeMenus);
  window.addEventListener('blur', closeMenus);

  function showShortcuts() {
    const rows = [
      ['Space', 'Play / pause'], ['← / →', 'Step one frame (Shift: one second)'], ['↑ / ↓', 'Previous / next cut'], ['Home / End', 'Go to start / end'],
      ['V / C', 'Selection tool / Razor tool'], ['Ctrl+K', 'Split at playhead'], ['Delete', 'Delete selection'], ['Shift+Delete', 'Ripple delete (closes the gap)'],
      ['Ctrl+C / V / D', 'Copy / paste at playhead / duplicate'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'], ['S', 'Toggle snapping'], ['M', 'Add marker'],
      ['I / O', 'Mark in / out (limits the export range)'], ['; / \'', 'Lift / extract the marked range'], ['Q / W', 'Ripple trim from the previous cut / to the next cut'], ['Alt + ← →', 'Nudge the selected clips a frame (Shift: five)'], ['Ctrl + Alt + ← →', 'Slip the selected clips a frame'], ['Ctrl / Alt + drag a clip edge', 'Ripple trim / roll the cut'], ['Alt + drag a clip', 'Slip'], ['Ctrl + Alt + V', 'Paste effects'], ['= / −', 'Zoom timeline in / out'], ['\\', 'Zoom timeline to fit'],
      ['Ctrl+I / E', 'Import media / export'], ['Ctrl+S', 'Save project'], ['Ctrl+wheel', 'Zoom timeline at the cursor'], ['Shift+wheel', 'Scroll timeline sideways']
    ];
    const t = el('div', { style: 'display:grid;grid-template-columns:auto 1fr;gap:6px 18px' });
    rows.forEach(([k, d]) => { t.appendChild(el('div', { style: 'font-family:var(--mono);color:var(--accent)', text: k })); t.appendChild(el('div', { text: d })); });
    modal({ title: 'Keyboard shortcuts', body: [t], width: 520, buttons: [{ label: 'Close', primary: true }] });
  }
  async function showAbout() {
    const info = await api.info();
    modal({
      title: 'About Ditto Pro',
      body: [el('div', { text: 'Ditto Pro ' + info.version + ' — a desktop video editor.' }), el('div', { class: 'dim', text: 'Multi-track timeline, keyframes, transitions, titles and FFmpeg export. FFmpeg is bundled and runs entirely on your computer; nothing is uploaded.' }), el('div', { class: 'dim', text: 'FFmpeg ' + info.ffmpegMajor + '.x · ' + info.platform })],
      buttons: [{ label: 'Close', primary: true }]
    });
  }

  // ------------------------------------------------------------ keyboard
  const typing = (t) => t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !['range', 'checkbox', 'button', 'color'].includes(t.type)));
  document.addEventListener('keydown', (e) => {
    if ($('#modalRoot .back')) { return; }
    const k = e.key, ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey;
    const inField = typing(e.target);
    if (!inField && !ctrl && !e.altKey && /^[1-9]$/.test(k) && AI.MC.active()) { e.preventDefault(); AI.MC.switchTo(+k); return; }
    if (ctrl) {
      const lk = k.toLowerCase();
      if (lk === 's') { e.preventDefault(); save(shift); return; }
      if (lk === 'e') { e.preventDefault(); Dialogs.exportDialog(); return; }
      if (lk === 'i') { e.preventDefault(); importMedia(); return; }
      if (lk === 'o') { e.preventDefault(); openFile(); return; }
      if (lk === 'n') { e.preventDefault(); newProject(); return; }
      if (inField) return;
      if (lk === 'z') { e.preventDefault(); if (shift) S.redo(); else S.undo(); return; }
      if (lk === 'y') { e.preventDefault(); S.redo(); return; }
      if (lk === 'k') { e.preventDefault(); S.splitAtPlayhead(); return; }
      if (lk === 'c') { e.preventDefault(); S.copy(); return; }
      if (lk === 'v' && e.altKey) { e.preventDefault(); const n = S.pasteAttributes('effects'); if (n) toast('Effects pasted onto ' + n + ' clip' + (n > 1 ? 's' : '') + '.'); return; }
      if (e.altKey && (k === 'ArrowLeft' || k === 'ArrowRight')) { e.preventDefault(); S.slip((k === 'ArrowLeft' ? -1 : 1) * (shift ? 5 : 1)); return; }
      if (lk === 'v') { e.preventDefault(); S.paste(); return; }
      if (lk === 'd') { e.preventDefault(); S.duplicate(); return; }
      if (lk === 'a') { e.preventDefault(); S.setSelection(S.project.clips.map((c) => c.id)); return; }
      return;
    }
    if (inField) { if (k === 'Escape' || (k === 'Enter' && e.target.tagName !== 'TEXTAREA')) e.target.blur(); return; }
    const fr = S.frame();
    switch (k) {
      case ' ': e.preventDefault(); Player.toggle(); break;
      case 'k': case 'K': Player.stop(); break;
      case 'ArrowLeft': e.preventDefault(); if (e.altKey) { S.nudge(shift ? -5 : -1); break; } Player.stop(); S.seek(S.playhead - (shift ? 1 : fr)); break;
      case 'ArrowRight': e.preventDefault(); if (e.altKey) { S.nudge(shift ? 5 : 1); break; } Player.stop(); S.seek(Math.min(S.duration(), S.playhead + (shift ? 1 : fr))); break;
      case 'ArrowUp': { e.preventDefault(); const pts = S.editPoints().filter((p) => p < S.playhead - 0.001); if (pts.length) S.seek(pts[pts.length - 1]); break; }
      case 'ArrowDown': { e.preventDefault(); const pts = S.editPoints().filter((p) => p > S.playhead + 0.001); if (pts.length) S.seek(pts[0]); break; }
      case 'Home': e.preventDefault(); Player.stop(); S.seek(0); break;
      case 'End': e.preventDefault(); Player.stop(); S.seek(S.duration()); break;
      case 'Delete': case 'Backspace': if (S.sel.size) { e.preventDefault(); S.deleteClips(Array.from(S.sel), shift); } break;
      case 'v': case 'V': Timeline.setTool('select'); break;
      case 'c': case 'C': Timeline.setTool('razor'); break;
      case 's': case 'S': S.snap = !S.snap; Timeline.syncToolbar(); break;
      case 'm': case 'M': S.addMarker(); break;
      case 'q': case 'Q': rippleTrim('prev'); break;
      case 'w': case 'W': rippleTrim('next'); break;
      case ';': rangeOp(false); break;
      case "'": rangeOp(true); break;
      case 'i': case 'I': S.setWorkIn(); break;
      case 'o': case 'O': S.setWorkOut(); break;
      case 'x': case 'X': if (e.altKey) S.clearWork(); break;
      case '=': case '+': Timeline.zoomBy(1.4); break;
      case '-': case '_': Timeline.zoomBy(1 / 1.4); break;
      case '\\': Timeline.fit(); break;
      case 'Escape': S.setSelection([]); break;
      default: break;
    }
  });
  document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('button'); if (b) b.blur(); });
  document.addEventListener('change', (e) => { if (e.target.type === 'range' || e.target.type === 'checkbox') e.target.blur(); });

  // ------------------------------------------------------------ drag & drop of files from the OS
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('#dropOverlay').classList.remove('hidden'); } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').classList.add('hidden'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('#dropOverlay').classList.add('hidden');
    const paths = Array.from(e.dataTransfer.files).map((f) => api.pathFor(f)).filter(Boolean);
    if (!paths.length) return;
    if (paths.length === 1 && paths[0].toLowerCase().endsWith('.dpro')) { openFile(paths[0]); return; }
    if (paths.length === 1 && /\.(edl|fcpxml|prproj)$/i.test(paths[0])) { importProjectFrom(paths[0]); return; }
    toast('Importing…', null, 1200);
    handleImportResult(await api.probe(paths));
  });

  // ------------------------------------------------------------ timeline splitter
  (function splitter() {
    const sp = $('#vsplit'), app = $('#app');
    let d = null;
    sp.addEventListener('pointerdown', (e) => { d = { y: e.clientY, h: $('#timelinePanel').getBoundingClientRect().height }; sp.setPointerCapture(e.pointerId); });
    sp.addEventListener('pointermove', (e) => {
      if (!d) return;
      const h = DS.clamp(d.h - (e.clientY - d.y), 170, Math.round(innerHeight * 0.7));
      app.style.setProperty('--tl-h', h + 'px');
    });
    const end = () => { d = null; Player.resize(); };
    sp.addEventListener('pointerup', end); sp.addEventListener('pointercancel', end);
  })();

  // ------------------------------------------------------------ lifecycle
  $('#btnExport').addEventListener('click', () => Dialogs.exportDialog());
  api.on('app:request-close', async () => {
    Player.stop();
    if (S.dirty) {
      const r = await askSave(S.project.name);
      if (r === 'cancel') return;
      if (r === 'yes' && !(await save(false))) return;
    }
    await api.autosaveWrite('');
    api.confirmClose();
  });
  api.on('app:open-path', (p) => openFile(p));
  window.addEventListener('beforeunload', () => { Player.stop(); });

  // crash-recovery autosave
  setInterval(() => { if (S.dirty && (S.project.clips.length || S.project.media.length)) api.autosaveWrite(S.serialize()); }, 20000);

  async function start() {
    buildMenus();
    S.analysis = DS.analyze(S.project);
    S.emit('load');
    Timeline.fit();
    const f = await api.takeStartupFile();
    if (f) { await openFile(f); return; }
    const auto = await api.autosaveRead();
    if (auto) {
      try {
        const obj = JSON.parse(auto);
        if (obj.clips && (obj.clips.length || (obj.media && obj.media.length))) {
          const yes = await confirmDialog('Restore unsaved work?', 'Ditto Pro found work from a previous session that was not saved ("' + (obj.name || 'Untitled') + '"). Restore it?', 'Restore');
          if (yes) { S.load(sanitiseLoaded(obj), null); await reconnectMedia(); S.dirty = true; updateTitle(); }
          else api.autosaveWrite('');
        }
      } catch (e) { api.autosaveWrite(''); }
    }
  }

  return { collectFiles, reconnectMedia, importMedia, importSequence, addMediaToTimeline, relink, updateTitle, save, openFile, newProject, start, registerMedia, importProjectFrom };
})();

window.addEventListener('error', (e) => { console.error(e.error || e.message); });
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); });
App.start();
