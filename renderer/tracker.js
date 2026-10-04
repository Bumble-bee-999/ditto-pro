'use strict';
/* Ditto Pro — motion tracking (click an object, it follows it) and auto-reframe (re-frame the sequence for another shape
   of screen, keeping the action in view). Both run on this computer. */
const Tracker = (() => {
  const field = (label, input, hint) => el('div', { class: 'row', style: 'grid-template-columns:190px 1fr' }, [el('label', { text: label }), el('div', { class: 'ctl' }, [input, hint ? el('span', { class: 'dim', text: ' ' + hint }) : null])]);
  const once = (target, ev, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('Timed out reading the picture.')), ms || 8000); target.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true }); });

  // ---- pictures
  // one frame of a clip's own picture (before any effect or transform), source time `srcT` seconds into the file
  async function grabFrame(m, srcT, maxW) {
    const url = m && m.previewUrl;
    if (!url) throw new Error('The preview of this clip is not ready yet.');
    const cv = document.createElement('canvas');
    let w, h, drawFrom;
    if (m.kind === 'image') {
      const im = new Image(); im.src = url; await once(im, 'load'); w = im.naturalWidth; h = im.naturalHeight; drawFrom = im;
    } else {
      const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = url;
      await once(v, 'loadeddata'); v.currentTime = Math.max(0, Math.min(srcT, (v.duration || srcT) - 0.05)); await once(v, 'seeked');
      w = v.videoWidth; h = v.videoHeight; drawFrom = v;
    }
    const k = Math.min(1, (maxW || 640) / w);
    cv.width = Math.round(w * k); cv.height = Math.round(h * k);
    cv.getContext('2d').drawImage(drawFrom, 0, 0, cv.width, cv.height);
    return cv;
  }

  // how the clip's picture sits in the program: size on screen of the whole raw source, in program pixels
  function displaySize(c, m) {
    const p = S.project, cr = (c.fx && c.fx.crop) || { l: 0, t: 0, r: 0, b: 0 };
    const k = (v) => DS.clamp(v, 0, 95) / 100;
    const rw = m.w || p.width, rh = m.h || p.height;
    const cw = Math.max(2, rw * (1 - k(cr.l) - k(cr.r))), ch = Math.max(2, rh * (1 - k(cr.t) - k(cr.b)));
    const fit = Math.min(p.width / cw, p.height / ch);
    const sc = (c.tf.scale || 100) / 100;
    return { w: rw * fit * sc, h: rh * fit * sc, rw, rh, cr: { l: k(cr.l), t: k(cr.t), r: k(cr.r), b: k(cr.b) } };
  }

  // ---- the dialog
  // mode: 'mask' (a mask follows the point) | undefined (choose: move another clip, or lock this clip's picture)
  async function open(c, mode) {
    if (!c || c.type !== 'media') return toast('Select a video clip first.', 'err');
    const m = S.media(c.media);
    if (!m || m.kind === 'image' || m.missing) return toast('Motion tracking needs a video clip.', 'err');
    if (c.reverse) return toast('Tracking a reversed clip is not supported. Un-reverse it first.', 'err');
    const lt = DS.clamp(S.playhead - c.start, 0, c.dur - 1e-3);
    const srcT = c.in + lt * c.speed;
    let frame;
    try { frame = await grabFrame(m, srcT, 640); } catch (e) { return toast(e.message, 'err'); }
    let pt = { x: 0.5, y: 0.5 };
    const view = el('canvas', { width: frame.width, height: frame.height, style: 'width:100%;max-width:640px;display:block;cursor:crosshair;border-radius:4px' });
    const size = el('input', { type: 'range', min: '2', max: '20', step: '1', value: '6', style: 'width:200px' });
    const dir = el('select', null, [['both', 'Both ways from this frame'], ['forward', 'Forward only'], ['backward', 'Backward only']].map(([v, l]) => el('option', { value: v, text: l })));
    const others = S.project.clips.filter((x) => x !== c && !x.disabled && x.type !== 'adjust' && x.start < DS.clipEnd(c) && DS.clipEnd(x) > c.start);
    const modeSel = el('select', null, [el('option', { value: 'move', text: 'Make another clip follow it' }), el('option', { value: 'lock', text: 'Hold this clip steady on it (stabilise to the point)' })]);
    const target = el('select', null, others.map((x) => el('option', { value: x.id, text: x.track + ' · ' + (x.label || (x.title && x.title.text) || (S.media(x.media) || {}).name || x.type) })));
    const msg = el('div', { class: 'dim', style: 'margin-top:8px;min-height:18px' });
    const bar = el('div', { style: 'height:8px;background:var(--bg2,#1b1d22);border-radius:4px;overflow:hidden;margin-top:10px;display:none' }, [el('div', { style: 'height:100%;width:0;background:var(--accent,#7aa7ff)' })]);
    const draw = () => {
      const x = view.getContext('2d');
      x.drawImage(frame, 0, 0);
      const half = (+size.value / 100) * view.width;
      const px = pt.x * view.width, py = pt.y * view.height;
      x.lineWidth = 2; x.strokeStyle = '#ffd34d'; x.strokeRect(px - half, py - half, half * 2, half * 2);
      x.beginPath(); x.moveTo(px - 8, py); x.lineTo(px + 8, py); x.moveTo(px, py - 8); x.lineTo(px, py + 8); x.stroke();
    };
    view.addEventListener('click', (e) => { const r = view.getBoundingClientRect(); pt = { x: DS.clamp((e.clientX - r.left) / r.width, 0, 1), y: DS.clamp((e.clientY - r.top) / r.height, 0, 1) }; draw(); });
    size.addEventListener('input', draw);
    draw();
    let running = false, off = null;
    const body = [
      el('p', { class: 'dim', text: 'Click the thing to follow (pick a spot with some detail: an edge, a logo, a corner). The box is the patch Ditto Pro will follow from frame to frame.' }),
      view,
      field('Patch size', size, 'bigger is steadier, smaller is more exact'),
      field('Track', dir)
    ];
    if (mode !== 'mask') { body.push(field('Use the movement to', modeSel)); body.push(field('Other clip', target, others.length ? '' : 'none overlaps this clip')); }
    body.push(bar, msg);
    modal({
      title: mode === 'mask' ? 'Track the mask' : 'Track motion', width: 700, dismissable: false, body,
      buttons: [
        { label: 'Close', onClick: () => { if (running) window.ditto.cancelTrack(); if (off) off(); } },
        { label: 'Start tracking', primary: true, keepOpen: true, onClick: async ({ close, btn }) => {
          const kind = mode === 'mask' ? 'mask' : modeSel.value;
          if (kind === 'move' && !target.value) { msg.textContent = 'There is no other clip over this one to move.'; return; }
          running = true; btn.disabled = true; bar.style.display = ''; msg.textContent = 'Following the patch…';
          const id = DS.uid('trk');
          off = window.ditto.on('track:progress', (p) => { if (p.id === id) bar.firstChild.style.width = Math.round(p.pct * 100) + '%'; });
          const res = await window.ditto.trackPoint({ id, path: m.path, from: c.in, span: c.dur * c.speed, fps: m.fps || S.project.fps, w: m.w, h: m.h, pointT: lt * c.speed, x: pt.x, y: pt.y, size: +size.value / 100, direction: dir.value });
          running = false; if (off) off();
          if (!res.ok) { btn.disabled = false; bar.style.display = 'none'; msg.textContent = /Cancelled/.test(res.error) ? 'Cancelled.' : 'Tracking failed: ' + res.error; return; }
          close();
          const note = apply(kind, c, m, res, target.value, lt);
          toast(note, res.lost > res.full * 0.2 ? 'err' : 'ok', 7000);
        } }
      ]
    });
  }

  // ---- using the result. samples: [{t (source seconds into the clip's span), x, y (0..1 of the raw picture)}]
  function apply(kind, c, m, res, targetId, ltPoint) {
    const sp = c.speed || 1;
    const pts = res.samples.map((s) => ({ t: s.t / sp, x: s.x, y: s.y })).filter((s) => s.t <= c.dur + 1e-6);
    if (pts.length < 2) return 'Tracking found too little to use.';
    const ref = pts.reduce((b, s) => (Math.abs(s.t - ltPoint) < Math.abs(b.t - ltPoint) ? s : b), pts[0]);   // where the point was clicked
    const d = displaySize(c, m);
    const lostNote = res.lost ? ' ' + res.lost + ' frame' + (res.lost > 1 ? 's' : '') + ' lost the patch and held the last position.' : '';
    S.checkpoint();
    if (kind === 'mask') {
      const cw = 1 - d.cr.l - d.cr.r, chh = 1 - d.cr.t - d.cr.b;
      c.fx.mask = c.fx.mask || DS.clone(DS.DEFAULT_FX.mask);
      c.fx.mask.on = true;
      c.fx.mask.path = pts.map((s) => ({ t: s.t, x: ((s.x - d.cr.l) / cw) * 100, y: ((s.y - d.cr.t) / chh) * 100 }));
      c.fx.mask.cx = c.fx.mask.path[0].x; c.fx.mask.cy = c.fx.mask.path[0].y;
      S.change(true);
      return 'The mask now follows the object (' + pts.length + ' keyframes).' + lostNote;
    }
    if (kind === 'lock') {
      const dxs = pts.map((s) => (s.x - ref.x) * d.rw * (d.w / d.rw)), dys = pts.map((s) => (s.y - ref.y) * d.h);
      const kx = (v) => v, base = { x: c.tf.x, y: c.tf.y };
      c.kf.x = pts.map((s, i) => ({ t: s.t, v: base.x - kx(dxs[i]), e: 'lin' }));
      c.kf.y = pts.map((s, i) => ({ t: s.t, v: base.y - dys[i], e: 'lin' }));
      // enlarge a little so the moving edges stay outside the frame
      const need = 1 + 2 * Math.max(Math.max.apply(null, dxs.map(Math.abs)) / S.project.width, Math.max.apply(null, dys.map(Math.abs)) / S.project.height);
      if (!(c.kf.scale && c.kf.scale.length)) c.tf.scale = Math.min(300, c.tf.scale * need);
      S.change(true);
      return 'The picture is now held steady on that spot (zoomed ' + Math.round((need - 1) * 100) + '% to hide the edges).' + lostNote;
    }
    // move another clip: it keeps its present place relative to the object and follows it from there
    const tg = S.clip(targetId);
    if (!tg) return 'The other clip is gone.';
    const here = DS.tfAt(tg, S.playhead - tg.start);
    const kxs = [], kys = [];
    pts.forEach((s) => {
      const tt = c.start + s.t - tg.start;
      if (tt < -1e-6 || tt > tg.dur + 1e-6) return;
      kxs.push({ t: Math.max(0, Math.min(tg.dur, tt)), v: here.x + (s.x - ref.x) * d.w, e: 'lin' });
      kys.push({ t: Math.max(0, Math.min(tg.dur, tt)), v: here.y + (s.y - ref.y) * d.h, e: 'lin' });
    });
    if (kxs.length < 2) return 'The other clip does not overlap the tracked part.';
    tg.kf.x = kxs; tg.kf.y = kys;
    S.change(true);
    return 'The other clip now follows the object (' + kxs.length + ' keyframes).' + lostNote;
  }

  // ---------------------------------------------------------------- auto-reframe
  const ASPECTS = [['9:16', 'Vertical 9:16 (Reels, Shorts, TikTok)', 9 / 16], ['4:5', 'Portrait 4:5 (feed posts)', 4 / 5], ['1:1', 'Square 1:1', 1], ['16:9', 'Widescreen 16:9', 16 / 9], ['4:3', 'Classic 4:3', 4 / 3], ['21:9', 'Cinema 21:9', 21 / 9]];
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  function sizeFor(aspect, p) {
    const short = Math.min(p.width, p.height);
    if (aspect < 1) return { w: even(short), h: even(short / aspect) };
    if (aspect === 1) return { w: even(short), h: even(short) };
    return { w: even(short * aspect), h: even(short) };
  }

  // pan keyframes (clip time) that keep the subject path in view: pure function, tested
  function panFor(path, speed, dur, disp, view, zoom) {
    const Wd = disp.w * zoom, Hd = disp.h * zoom;
    const mx = Math.max(0, (Wd - view.w) / 2), my = Math.max(0, (Hd - view.h) / 2);
    const out = path.map((s) => ({ t: s.t / speed, x: s.x, y: s.y })).filter((s) => s.t <= dur + 1e-6);
    return {
      x: out.map((s) => ({ t: s.t, v: DS.clamp((0.5 - s.x) * Wd, -mx, mx), e: 'lin' })),
      y: out.map((s) => ({ t: s.t, v: DS.clamp((0.5 - s.y) * Hd, -my, my), e: 'lin' }))
    };
  }
  function thin(list, tol) {
    if (list.length < 3) return list;
    const keep = new Uint8Array(list.length); keep[0] = keep[list.length - 1] = 1;
    const st = [[0, list.length - 1]];
    while (st.length) {
      const [a, b] = st.pop(); let w = 0, wi = -1;
      for (let i = a + 1; i < b; i++) { const u = (list[i].t - list[a].t) / ((list[b].t - list[a].t) || 1); const e = Math.abs(list[a].v + (list[b].v - list[a].v) * u - list[i].v); if (e > w) { w = e; wi = i; } }
      if (w > tol && wi > 0) { keep[wi] = 1; st.push([a, wi], [wi, b]); }
    }
    return list.filter((_, i) => keep[i]);
  }

  async function reframe() {
    const sel = S.selClips().filter((c) => c.type === 'media');
    const all = S.project.clips.filter((c) => c.type === 'media' && S.track(c.track) && S.track(c.track).type === 'video');
    const aspSel = el('select', null, ASPECTS.map(([v, l]) => el('option', { value: v, text: l })));
    const smooth = el('input', { type: 'range', min: '3', max: '30', step: '1', value: '9', style: 'width:200px' });
    const zoomIn = el('input', { type: 'number', value: '0', min: '0', max: '100', step: '5', style: 'width:80px' });
    const scope = el('select', null, [el('option', { value: 'all', text: 'Every video clip on the timeline (' + all.length + ')' }), el('option', { value: 'sel', text: 'Only the selected clips (' + sel.length + ')' })]);
    if (sel.length) scope.value = 'sel';
    const resize = el('input', { type: 'checkbox' }); resize.checked = true;
    const msg = el('div', { class: 'dim', style: 'margin-top:8px;min-height:18px' });
    const bar = el('div', { style: 'height:8px;background:var(--bg2,#1b1d22);border-radius:4px;overflow:hidden;margin-top:10px;display:none' }, [el('div', { style: 'height:100%;width:0;background:var(--accent,#7aa7ff)' })]);
    let running = false, off = null;
    modal({
      title: 'Auto reframe', width: 580, dismissable: false,
      body: [
        el('p', { class: 'dim', text: 'Changes the shape of the picture (for example 16:9 to vertical) and pans each clip to keep the action in view. It follows movement; clips with nothing moving stay centred. Runs on this computer — it does not recognise faces, so check the result and adjust the keyframes where needed.' }),
        field('New shape', aspSel), field('Apply to', scope), field('Camera smoothness', smooth, 'higher = slower, calmer pans'), field('Zoom in extra (%)', zoomIn, 'gives more room to pan'),
        el('label', { class: 'chk', style: 'margin:8px 0 0 190px' }, [resize, el('span', { text: 'Change the sequence size to match' })]),
        bar, msg
      ],
      buttons: [
        { label: 'Close', onClick: () => { if (running) window.ditto.cancelTrack(); if (off) off(); } },
        { label: 'Reframe', primary: true, keepOpen: true, onClick: async ({ close, btn }) => {
          const list = scope.value === 'sel' ? sel : all;
          if (!list.length) { msg.textContent = 'There are no clips to reframe.'; return; }
          running = true; btn.disabled = true; bar.style.display = '';
          const asp = ASPECTS.find((a) => a[0] === aspSel.value)[2];
          const size = sizeFor(asp, S.project);
          S.checkpoint();
          if (resize.checked) { S.project.width = size.w; S.project.height = size.h; Player.resize(); }
          const view = { w: S.project.width, h: S.project.height };
          let done = 0, still = 0; const fails = [];
          for (const c of list) {
            const m = S.media(c.media);
            msg.textContent = 'Reframing ' + (done + 1) + ' of ' + list.length + '…';
            try {
              const d0 = displaySize(Object.assign({}, c, { tf: Object.assign({}, c.tf, { scale: 100 }) }), m);
              const cw = d0.rw * (1 - d0.cr.l - d0.cr.r), ch = d0.rh * (1 - d0.cr.t - d0.cr.b);
              const fill = Math.max(view.w / cw, view.h / ch), fit = Math.min(view.w / cw, view.h / ch);
              const zoom = 1 + (+zoomIn.value || 0) / 100;
              const disp = { w: d0.rw * fill, h: d0.rh * fill };
              let path = [{ t: 0, x: 0.5, y: 0.5 }, { t: c.dur * c.speed, x: 0.5, y: 0.5 }];
              if (m.kind === 'video' && m.path && !m.nest) {
                const id = DS.uid('rf');
                if (off) off();
                off = window.ditto.on('track:progress', (p) => { if (p.id === id) bar.firstChild.style.width = Math.round(((done + p.pct) / list.length) * 100) + '%'; });
                const r = await window.ditto.analyzeSubject({ id, path: m.path, from: c.in, span: c.dur * c.speed, fps: m.fps || S.project.fps, w: m.w, h: m.h, smooth: +smooth.value / 10 });
                if (!r.ok) { if (/Cancelled/.test(r.error)) break; throw new Error(r.error); }
                if (r.confidence < 0.05) still++;
                path = r.path;
              }
              const pan = panFor(path, c.speed || 1, c.dur, disp, view, zoom);
              c.tf.scale = Math.round(fill / fit * zoom * 1000) / 10;
              c.kf.scale = [];
              c.kf.x = thin(pan.x, 1.5); c.kf.y = thin(pan.y, 1.5);
              if (c.kf.x.length < 2 || c.kf.x.every((k) => Math.abs(k.v - c.kf.x[0].v) < 0.5)) { c.tf.x = c.kf.x.length ? c.kf.x[0].v : 0; c.kf.x = []; }
              if (c.kf.y.length < 2 || c.kf.y.every((k) => Math.abs(k.v - c.kf.y[0].v) < 0.5)) { c.tf.y = c.kf.y.length ? c.kf.y[0].v : 0; c.kf.y = []; }
              if (!c.kf.x.length) c.tf.x = c.tf.x || 0;
              done++;
            } catch (e) { fails.push((m && m.name || 'clip') + ': ' + e.message); }
            if (!running) break;
          }
          running = false; if (off) off();
          S.change(true); Player.requestRender();
          close();
          if (fails.length) toast('Reframed ' + done + ', but ' + fails.length + ' failed: ' + fails[0], 'err', 9000);
          else toast('Reframed ' + done + ' clip' + (done > 1 ? 's' : '') + ' to ' + aspSel.value + (still ? ' (' + still + ' had no movement and stay centred)' : '') + '. Ctrl+Z undoes it.', 'ok', 7000);
        } }
      ]
    });
  }

  return { open, reframe, apply, panFor, sizeFor, displaySize, grabFrame, thin };
})();
