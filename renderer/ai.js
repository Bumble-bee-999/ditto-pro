'use strict';
/* Ditto Pro — offline "smart" tools. Everything runs locally; nothing is uploaded. */
const AI = (() => {
  function pickMediaClips() {
    const cs = S.selClips().filter((c) => c.type === 'media');
    return cs.filter((c) => { const m = S.media(c.media); return m && !m.missing && m.kind !== 'image'; });
  }
  function needSelection(what) {
    toast('Select ' + what + ' on the timeline first.', 'err');
  }
  function numInput(value, min, max, step) { return el('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: String(step), style: 'width:90px' }); }
  const field = (label, input, hint) => el('div', { class: 'row', style: 'grid-template-columns:200px 1fr' }, [el('label', { text: label }), el('div', { class: 'ctl' }, [input, hint ? el('span', { class: 'dim', text: ' ' + hint }) : null])]);

  function removeSilence() {
    const clips = pickMediaClips().filter((c) => S.media(c.media).hasAudio);
    if (!clips.length) return needSelection('one or more clips that have audio');
    const th = numInput(-35, -80, -5, 1), md = numInput(0.5, 0.1, 10, 0.1);
    modal({
      title: 'Remove silences',
      width: 460,
      body: [
        el('p', { class: 'dim', text: 'Finds quiet stretches in the selected clips and cuts them out, closing the gaps. Works offline. Undo restores everything.' }),
        field('Silence below (dB)', th, 'lower = only very quiet parts'),
        field('Minimum length (s)', md, 'shorter pauses are kept')
      ],
      buttons: [{ label: 'Cancel' }, { label: 'Remove silences', primary: true, keepOpen: true, onClick: async ({ close, btn }) => {
        btn.disabled = true; btn.textContent = 'Analysing…';
        try {
          const cache = new Map(), plan = [];
          for (const c of clips) {
            const m = S.media(c.media);
            const key = [m.path, c.in, c.dur * c.speed].join('|');
            if (!cache.has(key)) {
              const r = await window.ditto.analyzeSilence({ file: m.path, opts: { noiseDb: +th.value, minDur: +md.value, from: c.in, to: c.in + c.dur * c.speed } });
              if (!r.ok) throw new Error(r.error);
              cache.set(key, r.silences);
            }
            plan.push({ id: c.id, silences: cache.get(key) });
          }
          const removed = S.applySilenceCuts(plan);
          close();
          toast(removed > 0.01 ? 'Removed ' + removed.toFixed(1) + ' s of silence.' : 'No silences found with these settings.', removed > 0.01 ? 'ok' : undefined);
        } catch (e) { btn.disabled = false; btn.textContent = 'Remove silences'; toast('Analysis failed: ' + e.message, 'err'); }
      } }]
    });
  }

  // Auto-duck: the selected clips (the music) are turned down while any other clip with sound is not silent
  function autoDuck() {
    const music = pickMediaClips().filter((c) => S.media(c.media).hasAudio);
    if (!music.length) return needSelection('the music clip (or clips) to turn down');
    const ids = new Set(music.map((c) => c.id));
    const speech = S.project.clips.filter((c) => { if (c.type !== 'media' || ids.has(c.id) || c.disabled) return false; const m = S.media(c.media), tr = S.track(c.track); return m && !m.missing && m.hasAudio && m.kind !== 'image' && tr && !tr.mute; });
    if (!speech.length) { toast('There is no other clip with sound to duck under.', 'err'); return; }
    const amt = numInput(12, 1, 40, 1), fd = numInput(0.4, 0.05, 3, 0.05), th = numInput(-35, -80, -5, 1), md = numInput(0.6, 0.1, 10, 0.1);
    modal({
      title: 'Auto-duck music under speech',
      width: 480,
      body: [
        el('p', { class: 'dim', text: 'Turns the selected clips down whenever another clip on the timeline has sound, as volume keyframes you can edit afterwards. Works offline. Undo restores the old volume.' }),
        field('Turn down by (dB)', amt), field('Fade time (s)', fd), field('Speech is louder than (dB)', th, 'lower = quieter sounds count'), field('Ignore pauses shorter than (s)', md)
      ],
      buttons: [{ label: 'Cancel' }, { label: 'Duck', primary: true, keepOpen: true, onClick: async ({ close, btn }) => {
        btn.disabled = true; btn.textContent = 'Analysing…';
        try {
          const cache = new Map(); let spans = [];
          for (const c of speech) {
            const m = S.media(c.media);
            const key = [m.path, c.in, c.dur * c.speed].join('|');
            if (!cache.has(key)) {
              const r = await window.ditto.analyzeSilence({ file: m.path, opts: { noiseDb: +th.value, minDur: +md.value, from: c.in, to: c.in + c.dur * c.speed } });
              if (!r.ok) throw new Error(r.error);
              cache.set(key, r.silences);
            }
            spans = spans.concat(DS.speechSpans(c, cache.get(key)));
          }
          const n = applyDuck(music, spans, { amount: +amt.value, fade: +fd.value });
          close();
          toast(n ? 'Ducked ' + n + ' clip' + (n > 1 ? 's' : '') + '. The volume keyframes are in the Inspector.' : 'No speech overlaps the selected clips.', n ? 'ok' : undefined);
        } catch (e) { btn.disabled = false; btn.textContent = 'Duck'; toast('Analysis failed: ' + e.message, 'err'); }
      } }]
    });
  }
  // sets the selected clips' volume so their loudest moment sits at the chosen peak level
  async function normalizeClips(target) {
    target = target == null ? -1 : target;
    const clips = pickMediaClips().filter((c) => S.media(c.media).hasAudio);
    if (!clips.length) return needSelection('one or more clips that have audio');
    toast('Measuring…', undefined, 1500);
    try {
      const plan = [];
      for (const c of clips) {
        const m = S.media(c.media);
        const r = await window.ditto.analyzePeak({ file: m.path, opts: { from: c.in, to: c.in + c.dur * c.speed } });
        if (!r.ok) throw new Error(r.error);
        if (r.level && Number.isFinite(r.level.peak)) plan.push({ c, vol: DS.clamp(Math.round((target - r.level.peak) * 10) / 10, DS.VOLRANGE[0], DS.VOLRANGE[1]) });
      }
      if (!plan.length) { toast('No sound was found in the selection.', 'err'); return 0; }
      S.checkpoint();
      plan.forEach(({ c, vol }) => { c.vol = vol; c.kf.vol = []; });
      S.change(true);
      toast('Normalised ' + plan.length + ' clip' + (plan.length > 1 ? 's' : '') + ' to ' + target + ' dB peak.', 'ok');
      return plan.length;
    } catch (e) { toast('Could not measure the sound: ' + e.message, 'err'); return 0; }
  }
  function applyDuck(music, spans, o) {
    const plan = music.map((c) => ({ c, kf: DS.duckKeyframes(c, spans, o) })).filter((x) => x.kf.length);
    if (!plan.length) return 0;
    S.checkpoint();
    plan.forEach(({ c, kf }) => { c.kf.vol = kf; });
    S.change(true);
    return plan.length;
  }

  function detectScenes() {
    const clips = pickMediaClips().filter((c) => S.media(c.media).kind === 'video');
    if (!clips.length) return needSelection('a video clip');
    const th = numInput(30, 5, 90, 1);
    modal({
      title: 'Split at scene changes',
      width: 460,
      body: [
        el('p', { class: 'dim', text: 'Looks for hard cuts inside the selected video clips and splits them there.' }),
        field('Sensitivity (%)', th, 'lower finds more cuts')
      ],
      buttons: [{ label: 'Cancel' }, { label: 'Split', primary: true, keepOpen: true, onClick: async ({ close, btn }) => {
        btn.disabled = true; btn.textContent = 'Analysing…';
        try {
          let total = 0;
          for (const c of clips) {
            const m = S.media(c.media);
            const r = await window.ditto.analyzeScenes({ file: m.path, opts: { threshold: +th.value / 100 } });
            if (!r.ok) throw new Error(r.error);
            total += S.splitAtSourceTimes(c.id, r.times);
          }
          close();
          toast(total ? 'Split into ' + total + ' extra clip' + (total > 1 ? 's' : '') + '.' : 'No scene changes found.', total ? 'ok' : undefined);
        } catch (e) { btn.disabled = false; btn.textContent = 'Split'; toast('Analysis failed: ' + e.message, 'err'); }
      } }]
    });
  }

  // ---------------------------------------------------------------- speed ramps
  function curveSvg(curve, from, to) {
    const f = DS.RAMP_CURVES[curve] || DS.RAMP_CURVES.linear, W = 220, H = 70, pts = [];
    const lo = Math.min(from, to, 100), hi = Math.max(from, to, 100);
    for (let i = 0; i <= 40; i++) { const u = i / 40, sp = from + (to - from) * f(u); pts.push((6 + u * (W - 12)).toFixed(1) + ',' + (H - 8 - (sp - lo) / Math.max(1, hi - lo) * (H - 16)).toFixed(1)); }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" style="background:var(--bg2,#1b1d22);border-radius:6px"><polyline fill="none" stroke="currentColor" stroke-width="2" points="' + pts.join(' ') + '"/></svg>';
  }
  function speedRamp() {
    const c = S.selClips().find((x) => x.type === 'media' && S.media(x.media) && S.media(x.media).kind !== 'image');
    if (!c) return needSelection('a video or audio clip');
    const inRamp = !!c.ramp;
    const from = numInput(100, 10, 800, 1), to = numInput(25, 10, 800, 1);
    const curve = el('select', null, Object.keys(DS.RAMP_LABELS).map((k) => el('option', { value: k, text: DS.RAMP_LABELS[k] })));
    curve.value = 'ease';
    const rip = el('input', { type: 'checkbox' }); rip.checked = true;
    const prev = el('div', { style: 'margin:6px 0 2px 200px;color:var(--accent,#7aa7ff)' });
    const info = el('div', { class: 'dim', style: 'margin:4px 0 0 200px' });
    const upd = () => {
      prev.innerHTML = curveSvg(curve.value, +from.value || 100, +to.value || 100);
      const segs = DS.rampSegments({ srcIn: c.in, srcLen: c.dur * c.speed, fps: S.project.fps, from: (+from.value || 100) / 100, to: (+to.value || 100) / 100, curve: curve.value });
      const total = segs.reduce((a, x) => a + x.dur, 0);
      info.textContent = 'Clip length ' + fmtSecs(c.dur) + ' s → ' + fmtSecs(total) + ' s, built from ' + segs.length + ' short pieces.';
    };
    [from, to, curve].forEach((x) => x.addEventListener('input', upd));
    const body = [
      el('p', { class: 'dim', text: 'Changes the speed smoothly along the clip (for example normal speed easing into slow motion). The clip is split into many short pieces whose speed follows the curve, so what you see in the preview is exactly what exports.' }),
      field('Speed at the start (%)', from), field('Speed at the end (%)', to), field('Curve', curve),
      prev, info,
      el('label', { class: 'chk', style: 'margin:10px 0 0 200px' }, [rip, el('span', { text: 'Move later clips on this track to close / open the gap' })])
    ];
    const buttons = [{ label: 'Cancel' }];
    if (inRamp) buttons.push({ label: 'Back to constant speed', onClick: () => { S.speedRampRestore(c.ramp.g); toast('Restored a single clip at constant speed.'); } });
    buttons.push({ label: 'Apply ramp', primary: true, onClick: () => {
      const a = DS.clamp((+from.value || 100) / 100, 0.1, 8), b = DS.clamp((+to.value || 100) / 100, 0.1, 8);
      const target = c.ramp ? (S.speedRampRestore(c.ramp.g), S.selClips()[0]) : c;
      const r = S.speedRamp(target.id, { from: a, to: b, curve: curve.value, ripple: rip.checked });
      if (r) toast('Speed ramp applied (' + r.pieces + ' pieces).', 'ok'); else toast('Could not apply the ramp to this clip.', 'err');
    } });
    modal({ title: 'Speed ramp', width: 560, body, buttons });
    upd();
  }

  // ---------------------------------------------------------------- stabilisation
  function origOf(c) { return c.stab ? { media: S.media(c.stab.media), in: c.stab.in } : { media: S.media(c.media), in: c.in }; }
  function stabilize() {
    const clips = pickMediaClips().filter((c) => S.media(c.media).kind === 'video' && !S.media(c.media).alpha);
    if (!clips.length) return needSelection('one or more video clips (without transparency)');
    const sm = numInput(40, 0, 100, 1);
    const method = el('select', null, [el('option', { value: 'smooth', text: 'Smooth motion (keeps intentional moves)' }), el('option', { value: 'locked', text: 'Lock off (hold the picture still)' })]);
    const fill = el('select', null, [el('option', { value: 'zoom', text: 'Zoom in slightly to hide the edges' }), el('option', { value: 'edges', text: 'Keep the full frame (edges stretch)' })]);
    const rot = el('input', { type: 'checkbox' }); rot.checked = true;
    const bar = el('div', { class: 'pbarwrap', style: 'height:8px;background:var(--bg2,#1b1d22);border-radius:4px;overflow:hidden;margin-top:12px;display:none' }, [el('div', { style: 'height:100%;width:0;background:var(--accent,#7aa7ff)' })]);
    const msg = el('div', { class: 'dim', style: 'margin-top:6px;min-height:18px' });
    let running = false, off = null;
    const m = modal({
      title: 'Stabilize', width: 540, dismissable: false,
      body: [
        el('p', { class: 'dim', text: 'Measures how the camera moved and renders a steadier copy of the part of the clip you are using. Runs on this computer; long clips take a while. The original stays in the project, and you can switch back any time.' }),
        field('Smoothness', sm, '0 = light, 100 = very steady'), field('Method', method), field('Edges', fill),
        el('label', { class: 'chk', style: 'margin:8px 0 0 200px' }, [rot, el('span', { text: 'Also correct rolling and zoom wobble' })]),
        bar, msg
      ],
      buttons: [
        { label: 'Close', onClick: () => { if (running) { window.ditto.cancelStabilize(); } if (off) off(); } },
        { label: 'Stabilize ' + clips.length + ' clip' + (clips.length > 1 ? 's' : ''), primary: true, keepOpen: true, onClick: async ({ close, btn }) => {
          running = true; btn.disabled = true; bar.style.display = '';
          let done = 0; const failures = [];
          try {
            for (const c of clips) {
              const o = origOf(c), om = o.media;
              const id = DS.uid('stab');
              if (off) off();
              off = window.ditto.on('stabilize:progress', (p) => { if (p.id === id) { bar.firstChild.style.width = Math.round(((done + p.pct) / clips.length) * 100) + '%'; } });
              msg.textContent = 'Stabilizing "' + om.name + '"' + (clips.length > 1 ? ' (' + (done + 1) + ' of ' + clips.length + ')' : '') + '…';
              const res = await window.ditto.stabilize({ id, path: om.path, from: o.in, span: c.dur * c.speed, fps: om.fps || S.project.fps, w: om.w, h: om.h, smoothness: +sm.value, method: method.value, fill: fill.value, rotation: rot.checked });
              if (!res.ok) { if (/Cancelled/.test(res.error)) break; failures.push(om.name + ': ' + res.error); done++; continue; }
              let nm = S.project.media.find((x) => x.path === res.media.path);
              if (!nm) { nm = res.media; nm.name = om.name + ' (stabilized)'; S.project.media.push(nm); S.rtFor(nm.id); }
              S.checkpoint();
              c.stab = c.stab || { media: c.media, in: c.in };
              c.media = nm.id; c.in = 0;
              S.emit('media'); S.change(true);
              Player.disposeClip(c);
              done++;
            }
          } catch (e) { failures.push(e.message); }
          running = false; if (off) off();
          close();
          if (failures.length) toast('Stabilizing failed: ' + failures[0], 'err', 9000);
          else if (done) toast('Stabilized ' + done + ' clip' + (done > 1 ? 's' : '') + '.', 'ok');
        } }
      ]
    });
  }
  function unstabilize() {
    const list = S.selClips().filter((c) => c.stab && S.media(c.stab.media));
    if (!list.length) return toast('None of the selected clips is stabilized.', 'err');
    S.checkpoint();
    list.forEach((c) => { c.media = c.stab.media; c.in = c.stab.in; delete c.stab; delete c.bgr; Player.disposeClip(c); });
    S.change(true);
    toast('Switched back to the original footage.');
  }

  // ---------------------------------------------------------------- background removal
  // gives a freshly made clip file something the preview can play (transparent clips go through a VP9-with-alpha copy)
  function ensurePreview(nm) {
    if (!nm.needsProxy) return;
    nm.previewUrl = null; nm.proxyState = 'working';
    window.ditto.makeProxy({ id: nm.id, path: nm.path, kind: nm.kind, alpha: !!nm.alpha }).then((res) => {
      if (!S.media(nm.id)) return;
      if (res.ok) { nm.previewUrl = res.url; nm.proxyState = 'ready'; } else { nm.proxyState = 'error'; toast('Could not prepare a preview of "' + nm.name + '". It can still be exported.', 'err'); }
      S.emit('proxy'); Player.requestRender();
    });
  }
  async function removeBackground() {
    const clips = S.selClips().filter((c) => { const m = c.type === 'media' && S.media(c.media); return m && !m.missing && !m.nest && (m.kind === 'video' || m.kind === 'image'); });
    if (!clips.length) return needSelection('one or more video clips or pictures');
    const models = await window.ditto.bgModels();
    if (!models.length) {
      modal({ title: 'Model not installed', width: 520, body: [el('p', { text: 'Background removal needs one of its offline models (they ship in the "models" folder of the installer). None was found.' }), el('p', { class: 'dim', text: 'Run build-windows.bat again with an internet connection (it runs "npm run fetch-models"), or see "Background removal" in the README.' })], buttons: [{ label: 'OK', primary: true }] });
      return;
    }
    const best = models.find((m) => m.id === 'isnet') || models[0];
    const model = el('select', null, models.map((m) => el('option', { value: m.id, text: m.label, selected: m.id === best.id })));
    model.value = best.id;
    const note = el('div', { class: 'dim', style: 'margin:2px 0 8px 200px', text: best.note });
    model.addEventListener('change', () => { const m = models.find((x) => x.id === model.value); note.textContent = m ? m.note : ''; });
    const speed = el('select', null, [['1', 'Every frame (best)'], ['2', 'Every 2nd frame (about 2× faster)'], ['4', 'Every 4th frame (about 4× faster)']].map(([v, l]) => el('option', { value: v, text: l })));
    const edge = numInput(35, 0, 100, 1), shift = numInput(0, -100, 100, 1), temporal = numInput(30, 0, 90, 5);
    const dev = el('select', null, [el('option', { value: 'auto', text: 'Automatic (graphics card when available)' }), el('option', { value: 'cpu', text: 'Processor only' })]);
    const bar = el('div', { class: 'pbarwrap', style: 'height:8px;background:var(--bg2,#1b1d22);border-radius:4px;overflow:hidden;margin-top:12px;display:none' }, [el('div', { style: 'height:100%;width:0;background:var(--accent,#7aa7ff)' })]);
    const msg = el('div', { class: 'dim', style: 'margin-top:6px;min-height:18px' });
    const frames = clips.reduce((a, c) => a + (S.media(c.media).kind === 'image' ? 1 : Math.round(c.dur * S.project.fps)), 0);
    let running = false, off = null;
    modal({
      title: 'Remove background', width: 580, dismissable: false,
      body: [
        el('p', { class: 'dim', text: 'Cuts out the main subject with an offline AI model and keeps only the part of the clip you are using, as a copy with transparency. The picture underneath shows through, on the timeline and in the export. Nothing is uploaded. The original stays in the project and you can restore it any time.' }),
        field('Model', model), note, field('Run the AI on', speed), field('Edge softness', edge, '0 = hard, 100 = very soft'),
        field('Grow / shrink', shift, '− tighter, + wider'), field('Smooth over time (%)', temporal, 'less flicker; lower for fast motion'), field('Processing on', dev),
        el('div', { class: 'dim', style: 'margin:8px 0 0 200px', text: 'About ' + frames + ' frame' + (frames === 1 ? '' : 's') + ' to process. Best quality on a processor alone can take several seconds per frame; the faster options or a graphics card shorten that.' }),
        bar, msg
      ],
      buttons: [
        { label: 'Close', onClick: () => { if (running) window.ditto.cancelBackground(); if (off) off(); } },
        { label: 'Remove background', primary: true, keepOpen: true, onClick: async ({ close, btn }) => {
          running = true; btn.disabled = true; bar.style.display = '';
          let done = 0; const failures = [];
          try {
            for (const c of clips) {
              const om = S.media(c.media), id = DS.uid('bg');
              if (off) off();
              off = window.ditto.on('bg:progress', (p) => { if (p.id === id) bar.firstChild.style.width = Math.round(((done + p.pct) / clips.length) * 100) + '%'; });
              msg.textContent = 'Removing the background of "' + om.name + '"' + (clips.length > 1 ? ' (' + (done + 1) + ' of ' + clips.length + ')' : '') + '…';
              const res = await window.ditto.removeBackground({ id, path: om.path, kind: om.kind, from: c.in, span: c.dur * c.speed, fps: om.fps || S.project.fps, w: om.w, h: om.h, model: model.value, step: +speed.value, edge: +edge.value, shift: +shift.value, temporal: +temporal.value, device: dev.value });
              if (!res.ok) { if (/Cancelled/.test(res.error)) break; failures.push(om.name + ': ' + res.error); done++; continue; }
              let nm = S.project.media.find((x) => x.path === res.media.path);
              if (!nm) { nm = res.media; nm.name = om.name + ' (cutout)'; S.project.media.push(nm); S.rtFor(nm.id); ensurePreview(nm); }
              S.checkpoint();
              c.bgr = c.bgr || { media: c.media, in: c.in };
              c.media = nm.id; c.in = 0;
              S.emit('media'); S.change(true);
              Player.disposeClip(c);
              done++;
            }
          } catch (e) { failures.push(e.message); }
          running = false; if (off) off();
          close();
          if (failures.length) toast('Background removal failed: ' + failures[0], 'err', 9000);
          else if (done) toast('Removed the background from ' + done + ' clip' + (done > 1 ? 's' : '') + '.', 'ok');
        } }
      ]
    });
  }
  function restoreBackground() {
    const list = S.selClips().filter((c) => c.bgr && S.media(c.bgr.media));
    if (!list.length) return toast('None of the selected clips has its background removed.', 'err');
    S.checkpoint();
    list.forEach((c) => { c.media = c.bgr.media; c.in = c.bgr.in; delete c.bgr; Player.disposeClip(c); });
    S.change(true);
    toast('Brought the background back.');
  }
  // ---------------------------------------------------------------- captions
  const LANGS = [['auto', 'Detect automatically'], ['en', 'English'], ['es', 'Spanish'], ['de', 'German'], ['fr', 'French'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['zh', 'Chinese'], ['ar', 'Arabic'], ['ru', 'Russian']];
  async function generateCaptions() {
    const clips = pickMediaClips().filter((c) => S.media(c.media).hasAudio);
    if (!clips.length) return needSelection('one or more clips that have speech');
    const eng = await window.ditto.captionsEngine();
    if (!eng.ok) {
      modal({ title: 'Speech engine not installed', width: 520, body: [el('p', { text: 'Caption generation uses the offline whisper.cpp engine and a speech model, which are bundled when the installer is built (' + (eng.bin ? 'engine found' : 'engine missing') + ', ' + (eng.model ? 'model found' : 'model missing') + ').' }), el('p', { class: 'dim', text: 'Run build-windows.bat again with an internet connection, or see "Captions" in the README. You can still import an existing .srt file from the Captions menu.' })], buttons: [{ label: 'OK', primary: true }] });
      return;
    }
    const lang = el('select', null, LANGS.map(([v, l]) => el('option', { value: v, text: l })));
    modal({
      title: 'Generate captions',
      width: 480,
      body: [
        el('p', { class: 'dim', text: 'Transcribes the speech in the selected clips on this computer (model: ' + eng.model_name + ') and adds the result as caption clips on a new track. Long clips take a while.' }),
        field('Language', lang)
      ],
      buttons: [{ label: 'Cancel' }, { label: 'Generate', primary: true, keepOpen: true, onClick: async ({ close, btn }) => {
        btn.disabled = true; btn.textContent = 'Transcribing…';
        try {
          const all = [];
          for (const c of clips) {
            const m = S.media(c.media), sp = c.speed || 1;
            const from = c.in, to = c.in + c.dur * sp;
            const r = await window.ditto.generateCaptions({ file: m.path, from, to, language: lang.value });
            if (!r.ok) throw new Error(r.error);
            r.cues.forEach((q) => {
              const s0 = c.start + (q.start - from) / sp, e0 = c.start + (q.end - from) / sp;
              const start = Math.max(c.start, s0), end = Math.min(DS.clipEnd(c), e0);
              if (end - start > 0.1) {
                const words = (q.words || []).map((w) => ({ start: Math.max(start, c.start + (w.start - from) / sp), end: Math.min(end, c.start + (w.end - from) / sp), text: w.text })).filter((w) => w.end > w.start);
                all.push({ start, end, text: q.text, words });
              }
            });
          }
          all.sort((a, b) => a.start - b.start);
          const n = S.addCaptions(all);
          close();
          toast(n ? 'Added ' + n + ' captions.' : 'No speech was found.', n ? 'ok' : undefined);
        } catch (e) { btn.disabled = false; btn.textContent = 'Generate'; toast('Transcription failed: ' + e.message, 'err', 8000); }
      } }]
    });
  }
  async function importCaptions() {
    const r = await window.ditto.openSrt();
    if (!r) return;
    if (!r.ok) { toast('Could not read captions: ' + r.error, 'err'); return; }
    const n = S.addCaptions(r.cues);
    toast(n ? 'Imported ' + n + ' captions from ' + r.name + '.' : 'No captions found in that file.', n ? 'ok' : 'err');
  }
  async function exportCaptions() {
    const caps = S.captionClips();
    if (!caps.length) { toast('There are no captions on the timeline.', 'err'); return; }
    const r = await window.ditto.saveSrt({ cues: caps.map((c) => ({ start: c.start, end: DS.clipEnd(c), text: c.title.text })), name: S.project.name });
    if (r && r.ok) toast('Saved captions.', 'ok');
  }
  function removeCaptions() { const n = S.removeCaptions(); toast(n ? 'Removed ' + n + ' captions.' : 'There are no captions to remove.'); }
  // ---------------------------------------------------------------- multicam
  async function createMulticam() {
    const clips = S.selClips().filter((c) => c.type === 'media' && S.media(c.media) && S.media(c.media).kind === 'video' && S.media(c.media).hasAudio && !S.media(c.media).missing);
    if (clips.length < 2) return toast('Select two or more video clips (one per camera, each with audio) first.', 'err');
    const ordered = clips.slice().sort((a, b) => a.start - b.start || S.project.tracks.findIndex((t) => t.id === a.track) - S.project.tracks.findIndex((t) => t.id === b.track));
    toast('Synchronising cameras by their audio…', undefined, 2500);
    const r = await window.ditto.syncMulticam({ items: ordered.map((c) => ({ file: S.media(c.media).path, from: c.in })) });
    if (!r.ok) return toast('Sync failed: ' + r.error, 'err', 7000);
    const weak = r.results.map((x, i) => (i && x.confidence < 6 ? i + 1 : 0)).filter(Boolean);
    const lags = r.results.map((x, i) => (i && x.confidence < 6 ? 0 : x.lag));
    const g = S.multicamCreate(ordered, lags);
    if (!g) return;
    toast('Created a ' + ordered.length + '-camera multicam. Press 1–' + Math.min(9, ordered.length) + ' while playing to cut between cameras.' + (weak.length ? ' Camera ' + weak.join(', ') + ' could not be matched by sound and was left unshifted.' : ''), weak.length ? 'err' : 'ok', 7000);
  }
  const MC = (() => {
    const bar = $('#mcBar');
    function group() { const g = S.multicamGroups(); return g.length ? g[g.length - 1] : null; }
    function render() {
      const g = group();
      bar.classList.toggle('hidden', !g);
      if (!g) return;
      const n = Math.max.apply(null, Array.from(g.angles));
      const cur = S.multicamAngleAt(g.id, S.playhead);
      bar.innerHTML = '';
      bar.appendChild(el('span', { class: 'dim', text: 'Multicam angle' }));
      for (let i = 1; i <= n; i++) bar.appendChild(el('button', { class: 'btn' + (i === cur ? ' on' : ''), text: String(i), title: 'Cut to camera ' + i + ' (key ' + i + ')', onclick: () => switchTo(i) }));
      bar.appendChild(el('button', { class: 'btn' + (typeof MCGrid !== 'undefined' && MCGrid.isOn() ? ' on' : ''), text: 'Grid', style: 'margin-left:10px', title: 'Show every camera at once', onclick: () => MCGrid.toggle() }));
    }
    function switchTo(angle) {
      const g = group();
      if (!g) return false;
      const res = S.multicamSwitch(g.id, angle, S.playhead);
      if (!res.ok) toast(res.reason, 'err');
      return true;
    }
    S.on('change', render); S.on('time', render); S.on('load', render);
    return { render, switchTo, active: () => !!group() };
  })();
  return { MC, createMulticam, speedRamp, stabilize, unstabilize, removeBackground, restoreBackground, removeSilence, autoDuck, applyDuck, normalizeClips, detectScenes, generateCaptions, importCaptions, exportCaptions, removeCaptions };
})();
