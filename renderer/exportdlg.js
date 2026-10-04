'use strict';
/* Ditto Pro — export dialog, export progress and project (sequence) settings. */
const Dialogs = (() => {
  const RES = [['3840x2160', 'UHD 4K · 3840×2160'], ['2560x1440', 'QHD · 2560×1440'], ['1920x1080', 'Full HD · 1920×1080'], ['1280x720', 'HD · 1280×720'], ['1080x1920', 'Vertical · 1080×1920'], ['1080x1080', 'Square · 1080×1080'], ['854x480', 'SD · 854×480']];
  const FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const safeName = (s) => (s || 'Untitled').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Untitled';

  // ------------------------------------------------------------ project settings
  function projectSettings(opts) {
    opts = opts || {};
    const p = S.project;
    const name = el('input', { type: 'text', value: opts.isNew ? 'Untitled' : p.name });
    const preset = el('select', null, RES.map(([v, l]) => el('option', { value: v, text: l })).concat([el('option', { value: 'custom', text: 'Custom…' })]));
    const w = el('input', { type: 'number', min: 16, max: 8192, value: p.width, step: 2 });
    const h = el('input', { type: 'number', min: 16, max: 8192, value: p.height, step: 2 });
    const fps = el('select', null, FPS.map((f) => el('option', { value: f, text: f + ' fps' })));
    const layout = el('select', null, [el('option', { value: 'stereo', text: 'Stereo' }), el('option', { value: '5.1', text: '5.1 surround (place clips with the Surround controls)' })]);
    layout.value = DS.layoutOf(p);
    const match = RES.find(([v]) => v === p.width + 'x' + p.height);
    preset.value = match ? match[0] : 'custom';
    fps.value = FPS.includes(p.fps) ? p.fps : 30;
    preset.addEventListener('change', () => { if (preset.value !== 'custom') { const [a, b] = preset.value.split('x'); w.value = a; h.value = b; } });
    const custom = () => { preset.value = 'custom'; };
    w.addEventListener('input', custom); h.addEventListener('input', custom);
    const body = [
      el('div', { class: 'mrow' }, [el('label', { text: 'Project name' }), name]),
      el('div', { class: 'mrow' }, [el('label', { text: 'Frame size' }), preset]),
      el('div', { class: 'mrow' }, [el('label', { text: 'Width × height' }), el('div', { style: 'display:flex;gap:8px;align-items:center' }, [w, el('span', { text: '×' }), h])]),
      el('div', { class: 'mrow' }, [el('label', { text: 'Frame rate' }), fps]),
      el('div', { class: 'mrow' }, [el('label', { text: 'Audio layout' }), layout]),
      el('div', { class: 'dim', style: 'font-size:11.5px', text: 'Clips are fitted inside the frame. Tip: importing your first video sets this automatically to match it.' })
    ];
    modal({
      title: opts.isNew ? 'New project' : 'Sequence settings', body, width: 520,
      buttons: [
        { label: 'Cancel' },
        { label: opts.isNew ? 'Create' : 'Apply', primary: true, onClick: () => {
          const nw = even(parseInt(w.value, 10) || 1920), nh = even(parseInt(h.value, 10) || 1080), nf = parseFloat(fps.value) || 30;
          if (opts.isNew) { S.newProject({ name: name.value || 'Untitled', width: nw, height: nh, fps: nf }); S.project.audioLayout = layout.value; }
          else { S.checkpoint(); S.project.name = name.value || 'Untitled'; S.project.width = nw; S.project.height = nh; S.project.fps = nf; S.project.audioLayout = layout.value; S.change(true); Player.resize(); }
          App.updateTitle();
        } }
      ]
    });
  }

  // ------------------------------------------------------------ export
  function exportDialog() {
    const p = S.project;
    if (!p.clips.length) { toast('Nothing to export yet — add some clips to the timeline.', 'err'); return; }
    Player.stop();
    const fmt = el('select', null, DS.FORMATS.filter((f) => !f.hidden).map((f) => el('option', { value: f.id, text: f.label })));
    const sizes = [[p.width + 'x' + p.height, 'Same as sequence · ' + p.width + '×' + p.height]];
    [2160, 1440, 1080, 720, 480].forEach((hh) => {
      if (hh === p.height) return;
      const ww = even(hh * p.width / p.height);
      sizes.push([ww + 'x' + hh, ww + '×' + hh + (hh > p.height ? ' (upscaled)' : '')]);
    });
    const res = el('select', null, sizes.map(([v, l]) => el('option', { value: v, text: l })));
    const q = el('input', { type: 'range', min: 0, max: 100, value: 65, style: 'width:100%' });
    const qLabel = el('span', { class: 'dim', text: 'High' });
    q.addEventListener('input', () => { qLabel.textContent = q.value > 80 ? 'Very high (large file)' : q.value > 55 ? 'High' : q.value > 30 ? 'Medium' : 'Small file'; });
    const gifFps = el('select', null, [10, 15, 24].map((f) => el('option', { value: f, text: f + ' fps' })));
    gifFps.value = 15;
    const wa = p.workArea;
    const hasWA = wa.in != null || wa.out != null;
    const rangeSel = el('select', null, [el('option', { value: 'all', text: 'Entire sequence · ' + DS.fmtTC(S.duration(), p.fps) }), hasWA ? el('option', { value: 'work', text: 'Work area · ' + DS.fmtTC(wa.in != null ? wa.in : 0, p.fps) + ' → ' + DS.fmtTC(wa.out != null ? wa.out : S.duration(), p.fps) }) : null].filter(Boolean));
    if (hasWA) rangeSel.value = 'work';
    const norm = el('input', { type: 'checkbox' });
    const chan = el('select', null, [el('option', { value: '5.1', text: '5.1 surround (six channels)' }), el('option', { value: 'stereo', text: 'Stereo mix-down' })]);
    const is51 = DS.layoutOf(p) === '5.1';
    // video encoder: software by default (best quality for the size); working hardware encoders are listed once they have been tested
    const enc = el('select', null, [el('option', { value: 'software', text: 'Software (best quality for the size)' })]);
    const encNote = el('div', { class: 'dim', style: 'font-size:11.5px;margin-top:2px', text: 'Checking for graphics-card encoders…' });
    let hwList = [];
    window.ditto.exportEncoders().then((l) => {
      hwList = l || [];
      hwList.forEach((h) => enc.appendChild(el('option', { value: h.id, text: h.label + ' (fast)' })));
      encNote.textContent = hwList.length ? 'A graphics-card encoder is several times faster; the file is a little larger for the same look.' : 'No graphics-card encoder was found on this computer, so the software encoder is used.';
      upd();
    }).catch(() => { encNote.textContent = ''; });
    const rows = {
      chan: el('div', { class: 'mrow' }, [el('label', { text: 'Audio channels' }), chan]),
      res: el('div', { class: 'mrow' }, [el('label', { text: 'Frame size' }), res]),
      q: el('div', { class: 'mrow' }, [el('label', { text: 'Quality' }), el('div', { style: 'display:grid;gap:2px' }, [q, qLabel])]),
      enc: el('div', { class: 'mrow' }, [el('label', { text: 'Video encoder' }), el('div', { style: 'display:grid' }, [enc, encNote])]),
      gif: el('div', { class: 'mrow' }, [el('label', { text: 'GIF frame rate' }), gifFps]),
      norm: el('div', { class: 'mrow' }, [el('label', { text: 'Audio' }), el('label', { class: 'chk' }, [norm, el('span', { text: 'Normalise loudness (−16 LUFS)' })])])
    };
    const info = el('div', { class: 'dim', style: 'font-size:11.5px' });
    const upd = () => {
      const f = DS.FORMATS.filter((f) => !f.hidden).find((x) => x.id === fmt.value);
      rows.res.classList.toggle('hidden', !f.video);
      rows.q.classList.toggle('hidden', !['mp4-h264', 'mp4-h265', 'webm-vp9'].includes(f.id));
      rows.gif.classList.toggle('hidden', f.id !== 'gif');
      rows.enc.classList.toggle('hidden', !['mp4-h264', 'mp4-h265'].includes(f.id));
      Array.from(enc.options).forEach((o) => { const h = hwList.find((x) => x.id === o.value); o.hidden = !!h && h.family !== (f.id === 'mp4-h265' ? 'hevc' : 'h264'); if (o.hidden && enc.value === o.value) enc.value = 'software'; });
      rows.norm.classList.toggle('hidden', !f.audio);
      rows.chan.classList.toggle('hidden', !f.audio || !is51 || f.id === 'mp3');
      info.textContent = f.id === 'mov-prores' ? 'ProRes files are very large — best for handing off to other editors.' : f.id === 'png-seq' ? 'You will pick a folder; one numbered PNG is written per frame.' : f.id === 'gif' ? 'GIFs have no sound and are best kept short and small.' : '';
    };
    fmt.addEventListener('change', upd); upd();
    // one-click presets: each sets format / frame size / quality (frame height capped to the sequence aspect)
    const PRESETS = [
      ['', 'Custom'],
      ['yt', 'YouTube 1080p — H.264, high quality', { f: 'mp4-h264', h: 1080, q: 75 }],
      ['yt4k', 'YouTube 4K — H.264, very high quality', { f: 'mp4-h264', h: 2160, q: 85 }],
      ['ig', 'Instagram / TikTok vertical — 1080×1920 H.264', { f: 'mp4-h264', w: 1080, h: 1920, q: 70 }],
      ['sq', 'Square post — 1080×1080 H.264', { f: 'mp4-h264', w: 1080, h: 1080, q: 70 }],
      ['web', 'Small web file — 720p H.265', { f: 'mp4-h265', h: 720, q: 40 }],
      ['master', 'Editing master — ProRes 422 HQ, same size', { f: 'mov-prores' }],
      ['gif', 'Short GIF — 480p, 15 fps', { f: 'gif', h: 480, g: 15 }],
      ['pod', 'Podcast audio — MP3', { f: 'mp3' }]
    ];
    const preset = el('select', null, PRESETS.map(([v, l]) => el('option', { value: v, text: l })));
    preset.addEventListener('change', () => {
      const pr = PRESETS.find((x) => x[0] === preset.value);
      if (!pr || !pr[2]) return;
      const o = pr[2];
      fmt.value = o.f; upd();
      if (o.w && o.h) { const k = o.w + 'x' + o.h; if (!Array.from(res.options).some((x) => x.value === k)) res.appendChild(el('option', { value: k, text: o.w + '×' + o.h })); res.value = k; }
      else if (o.h) { const ww = even(o.h * p.width / p.height), k = ww + 'x' + o.h; if (!Array.from(res.options).some((x) => x.value === k)) res.appendChild(el('option', { value: k, text: ww + '×' + o.h })); res.value = k; }
      else res.value = p.width + 'x' + p.height;
      if (o.q != null) { q.value = o.q; q.dispatchEvent(new Event('input')); }
      if (o.g) gifFps.value = o.g;
    });
    const body = [
      el('div', { class: 'mrow' }, [el('label', { text: 'Preset' }), preset]),
      el('div', { class: 'mrow' }, [el('label', { text: 'Format' }), fmt]), rows.res, rows.q, rows.enc, rows.gif,
      el('div', { class: 'mrow' }, [el('label', { text: 'Range' }), rangeSel]), rows.norm, rows.chan, info
    ];
    modal({
      title: 'Export', body, width: 560,
      buttons: [
        { label: 'Cancel' },
        { label: 'Add to queue…', onClick: () => {
          const f = DS.FORMATS.filter((f) => !f.hidden).find((x) => x.id === fmt.value);
          const [ow, oh] = res.value.split('x').map(Number);
          const opts = { format: f.id, quality: +q.value, width: ow, height: oh, gifFps: +gifFps.value, normalize: norm.checked, audioLayout: is51 ? chan.value : 'stereo', encoder: enc.value };
          if (rangeSel.value === 'work') { opts.rangeStart = wa.in != null ? wa.in : 0; opts.rangeEnd = wa.out != null ? wa.out : S.duration(); }
          setTimeout(() => addToQueue(f, opts), 0);
        } },
        { label: 'Export…', primary: true, onClick: () => {
          const f = DS.FORMATS.filter((f) => !f.hidden).find((x) => x.id === fmt.value);
          const [ow, oh] = res.value.split('x').map(Number);
          const opts = { format: f.id, quality: +q.value, width: ow, height: oh, gifFps: +gifFps.value, normalize: norm.checked, audioLayout: is51 ? chan.value : 'stereo', encoder: enc.value };
          if (rangeSel.value === 'work') { opts.rangeStart = wa.in != null ? wa.in : 0; opts.rangeEnd = wa.out != null ? wa.out : S.duration(); }
          setTimeout(() => runExport(f, opts), 0);
        } }
      ]
    });
  }

  // prepares a render job: renders nests, checks media, asks for the output file, snapshots the sequence
  async function prepareJob(f, opts) {
    S.exitAllNests();
    if (Nest.usedNests().length) {
      toast('Rendering nested sequences…', undefined, 5000);
      try { await Nest.ensureAll(); } catch (e) { toast('A nested sequence could not be rendered: ' + e.message, 'err', 8000); return null; }
    }
    const p = S.project;
    const used = new Set(p.clips.filter((c) => c.type === 'media').map((c) => c.media));
    const missing = p.media.filter((m) => used.has(m.id) && m.missing);
    if (missing.length) { toast('Some media is offline: ' + missing.map((m) => m.name).join(', ') + '. Right-click it in the Project panel to locate it.', 'err'); return null; }
    const choice = await window.ditto.chooseExport({ ext: f.ext, defaultName: safeName(p.name), isSequence: f.id === 'png-seq' });
    if (!choice) return null;
    opts.outPath = choice.path;
    const titles = {};
    p.clips.filter((c) => c.type === 'title').forEach((c) => { titles[c.id] = Player.titleCanvas(c).toDataURL('image/png'); });
    const payload = DS.clone({ v: 1, name: p.name, width: p.width, height: p.height, fps: p.fps, audioLayout: DS.layoutOf(p), tracks: p.tracks, clips: p.clips, markers: [], workArea: {} });
    payload.media = p.media.map((m) => ({ id: m.id, path: m.path, name: m.name, kind: m.kind, duration: m.duration, hasAudio: m.hasAudio, missing: !!m.missing }));
    return { f, opts, payload, titles, label: p.name + ' → ' + baseName(opts.outPath) };
  }

  async function runExport(f, opts) {
    const job = await prepareJob(f, opts);
    if (job) await executeJob(job, true);
  }

  // ---- render queue: jobs are snapshots, so the project can be edited (or another project opened) while they wait
  const queue = [];
  async function addToQueue(f, opts) {
    const job = await prepareJob(f, opts);
    if (job) { queue.push(job); toast('Added to the render queue (' + queue.length + ' waiting). File → Render queue… to start.'); }
  }
  function queueDialog() {
    const list = el('div', { style: 'display:grid;gap:6px;max-height:300px;overflow:auto' });
    const draw = () => {
      list.replaceChildren();
      if (!queue.length) list.appendChild(el('div', { class: 'dim', text: 'The queue is empty. In the Export dialog choose "Add to queue" instead of Export.' }));
      queue.forEach((j, i) => list.appendChild(el('div', { style: 'display:flex;gap:8px;align-items:center' }, [el('span', { style: 'flex:1', text: (i + 1) + '. ' + j.label }), el('button', { class: 'btn', text: 'Remove', onclick: () => { queue.splice(i, 1); draw(); } })])));
    };
    draw();
    modal({
      title: 'Render queue', width: 560, body: [list],
      buttons: [{ label: 'Close' }, { label: 'Render all', primary: true, onClick: () => { if (queue.length) setTimeout(runQueue, 0); } }]
    });
  }
  async function runQueue() {
    let ok = 0, failed = 0;
    while (queue.length) {
      const job = queue.shift();
      const r = await executeJob(job, false);
      if (r && r.ok) ok++; else if (!(r && r.cancelled)) failed++; else { toast('Queue stopped.'); return; }
    }
    toast('Render queue finished: ' + ok + ' done' + (failed ? ', ' + failed + ' failed' : '') + '.', failed ? 'err' : undefined, 8000);
  }

  async function executeJob(job, showDone) {
    const { f, opts, payload, titles } = job;
    const bar = el('i');
    const status = el('div', { text: 'Starting…' });
    const started = Date.now();
    const dlg = modal({
      title: 'Exporting', dismissable: false, width: 480,
      body: [el('div', { class: 'dim', text: baseName(opts.outPath) }), el('div', { class: 'progress' }, [bar]), status],
      buttons: [{ label: 'Cancel export', danger: true, keepOpen: true, onClick: () => { window.ditto.cancelExport(); status.textContent = 'Cancelling…'; return false; } }]
    });
    const off = window.ditto.on('export:progress', (pr) => {
      bar.style.width = Math.round(pr.pct * 100) + '%';
      const el1 = (Date.now() - started) / 1000;
      const eta = pr.pct > 0.03 ? el1 / pr.pct * (1 - pr.pct) : null;
      status.textContent = Math.round(pr.pct * 100) + '%' + (pr.speed ? ' · ' + pr.speed.toFixed(1) + '× real time' : '') + (eta != null ? ' · about ' + (eta < 90 ? Math.ceil(eta) + ' s' : Math.ceil(eta / 60) + ' min') + ' left' : '');
    });
    let res;
    try { res = await window.ditto.startExport({ project: payload, opts, titles }); }
    catch (e) { res = { ok: false, error: String(e.message || e) }; }
    off(); dlg.close();
    if (res.ok && res.fellBack) toast('The graphics-card encoder could not do this export, so it was redone with the software encoder.', 'err', 8000);
    if (res.ok && !showDone) return res;
    if (res.ok) {
      modal({
        title: 'Export complete', width: 480,
        body: [el('div', { text: 'Rendered in ' + (res.seconds < 90 ? Math.round(res.seconds) + ' seconds' : (res.seconds / 60).toFixed(1) + ' minutes') + '.' }), el('div', { class: 'dim', text: res.outPath })],
        buttons: [{ label: 'Close' }, { label: 'Show in folder', primary: true, onClick: () => window.ditto.reveal(res.outPath.replace('%05d', '00001')) }]
      });
    } else if (res.cancelled) {
      toast('Export cancelled.');
    } else if (!showDone) {
      toast('Export failed: ' + (res.error || 'unknown error').slice(0, 200), 'err', 8000);
    } else {
      modal({
        title: 'Export failed', width: 560,
        body: [el('div', { text: 'Ditto Pro could not finish the export.' }), el('div', { class: 'errbox', text: res.error || 'Unknown error' })],
        buttons: [{ label: 'Close', primary: true }]
      });
    }
    return res;
  }

  return { exportDialog, projectSettings, queueDialog };
})();
