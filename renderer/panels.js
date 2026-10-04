'use strict';
/* Ditto Pro — project bin, effects tab, inspector and transport controls. */

// ===================================================================== project bin
const Bin = (() => {
  const root = $('#tab-bin');

  function mediaIcon(m) { return icon(m.kind === 'audio' ? 'music' : m.kind === 'image' ? 'image' : 'film'); }

  function render() {
    root.innerHTML = '';
    const bar = el('div', { class: 'binbar' }, [
      el('button', { class: 'btn', text: 'Import…', title: 'Import media (Ctrl+I)', onclick: () => App.importMedia() }),
      el('span', { class: 'count', text: S.project.media.length + ' item' + (S.project.media.length === 1 ? '' : 's') })
    ]);
    root.appendChild(bar);
    if (!S.project.media.length) {
      root.appendChild(el('div', { class: 'bin-empty' }, [
        el('b', { text: 'No media yet' }),
        el('div', { text: 'Drag video, audio or images here, or click Import. Then drag clips onto the timeline.' })
      ]));
      return;
    }
    const grid = el('div', { class: 'bingrid' });
    S.project.media.forEach((m) => {
      const rt = S.rt[m.id] || {};
      const th = el('div', { class: 'th', style: m.thumb ? 'background-image:url("' + m.thumb + '")' : '', html: m.thumb ? '' : mediaIcon(m) });
      if (m.kind !== 'image') th.appendChild(el('div', { class: 'dur', text: fmtDur(m.duration) }));
      if (m.missing) th.appendChild(el('div', { class: 'badge warn', text: 'OFFLINE' }));
      else if (m.needsProxy && !m.previewUrl && m.proxyState !== 'error') th.appendChild(el('div', { class: 'badge', text: 'Preparing preview…' }));
      else if (m.proxyState === 'error') th.appendChild(el('div', { class: 'badge warn', text: 'No preview' }));
      else if (m.needsProxy) th.appendChild(el('div', { class: 'badge', text: 'PROXY' }));
      if (rt.proxyPct != null && !m.previewUrl) th.appendChild(el('div', { class: 'pbar', style: 'width:' + Math.round(rt.proxyPct * 100) + '%' }));
      const item = el('div', { class: 'mitem' + (S.selMedia === m.id ? ' sel' : ''), draggable: 'true', title: m.path + '\n' + (m.w ? m.w + '×' + m.h + ' · ' : '') + (m.fps ? m.fps + ' fps · ' : '') + fmtDur(m.duration) }, [th, el('div', { class: 'nm', text: m.name })]);
      item.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-ditto-media', m.id); e.dataTransfer.effectAllowed = 'copy'; });
      item.addEventListener('click', () => { S.selMedia = m.id; render(); });
      item.addEventListener('dblclick', () => App.addMediaToTimeline(m.id));
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        popupMenu(e.clientX, e.clientY, [
          { label: 'Add to timeline at playhead', run: () => App.addMediaToTimeline(m.id) },
          { label: 'Insert at playhead (push everything later)', run: () => S.insertMedia(m.id) },
          m.missing ? { label: 'Locate file…', run: () => App.relink(m.id) } : { label: 'Reveal in folder', run: () => window.ditto.reveal(m.path) },
          '-',
          { label: 'Remove from project', run: async () => { const n = S.project.clips.filter((c) => c.media === m.id).length; if (!n || await confirmDialog('Remove media', '"' + m.name + '" is used by ' + n + ' clip(s) on the timeline. Removing it deletes those clips.', 'Remove', true)) S.removeMedia(m.id); } }
        ]);
      });
      grid.appendChild(item);
    });
    root.appendChild(grid);
  }
  S.on('media', render);
  S.on('load', render);
  S.on('proxy', render);
  return { render };
})();

// ===================================================================== effects tab
const FxTab = (() => {
  const root = $('#tab-fx');
  function render() {
    root.innerHTML = '';
    root.appendChild(el('div', { class: 'fxsec', text: 'Video transitions' }));
    const list = el('div', { class: 'fxlist' });
    Object.keys(DS.TRANSITIONS).forEach((k) => {
      const it = el('div', { class: 'fxitem', draggable: 'true', title: 'Drag onto a clip, or select a clip and click' }, [el('span', { html: icon('swap') }), el('span', { text: DS.TRANSITIONS[k] })]);
      it.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-ditto-transition', k); e.dataTransfer.effectAllowed = 'copy'; });
      it.addEventListener('click', () => {
        const c = S.selClips().find((x) => S.track(x.track).type === 'video');
        if (!c) { toast('Select a video clip first (or drag the transition onto one).', 'err'); return; }
        S.checkpoint(); c.tr = { type: k, dur: Math.min(1, c.dur) }; S.change(true);
      });
      list.appendChild(it);
    });
    root.appendChild(list);
    root.appendChild(el('div', { class: 'fxhint', text: 'A transition plays at the start of the clip it is applied to. Dissolve and slide hold the previous clip’s last frame underneath if the two clips touch.' }));
    root.appendChild(el('div', { class: 'fxsec', text: 'Generators & layers' }));
    const gen = el('div', { class: 'fxlist' });
    [['title', 'Title (text)', 'text'], ['adjust', 'Adjustment layer', 'layers'], ['matte', 'Colour matte (solid)', 'image'], ['rect', 'Rectangle shape', 'image'], ['ellipse', 'Ellipse shape', 'image']].forEach(([k, label, ic]) => {
      const it = el('div', { class: 'fxitem', draggable: 'true', title: 'Drag to the timeline, or click to add at the playhead' }, [el('span', { html: icon(ic) }), el('span', { text: label })]);
      it.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-ditto-special', k); e.dataTransfer.effectAllowed = 'copy'; });
      it.addEventListener('click', () => S.placeSpecial(k, S.playhead));
      gen.appendChild(it);
    });
    root.appendChild(gen);
    root.appendChild(el('div', { class: 'fxhint', text: 'An adjustment layer applies its colour effects to everything on the tracks below it for its duration.' }));
  }
  render();
  return { render };
})();

$$('#leftTabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#leftTabs button').forEach((x) => x.classList.toggle('active', x === b));
  ['bin', 'fx', 'tx', 'rv', 'co'].forEach((t) => $('#tab-' + t).classList.toggle('hidden', b.dataset.tab !== t));
  if (b.dataset.tab === 'tx' && typeof Transcript !== 'undefined') Transcript.render();
  if (b.dataset.tab === 'rv' && typeof Review !== 'undefined') Review.render(true);
  if (b.dataset.tab === 'co' && typeof Color !== 'undefined') Color.build(true);
}));

// ===================================================================== inspector
const Inspector = (() => {
  const root = $('#inspector');
  const title = $('#inspTitle');
  const FONTS = ['Segoe UI', 'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Consolas', 'Courier New', 'Franklin Gothic Medium', 'Georgia', 'Impact', 'Segoe Print', 'Segoe Script', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
  const closed = new Set();
  let syncs = [], builtKey = null, builtId = null;

  function section(name, rows, note) {
    const sec = el('div', { class: 'sec' + (closed.has(name) ? ' closed' : '') });
    const head = el('div', { class: 'sh' }, [el('span', { class: 'chev', html: icon('chevD') }), el('span', { text: name })]);
    head.addEventListener('click', () => { sec.classList.toggle('closed'); if (sec.classList.contains('closed')) closed.add(name); else closed.delete(name); });
    const body = el('div', { class: 'sb' }, rows);
    if (note) body.appendChild(el('div', { class: 'note', text: note }));
    sec.appendChild(head); sec.appendChild(body);
    return sec;
  }

  // generic numeric row (slider + number [+ keyframe controls])
  function numRow(c, label, cfg) {
    const num = el('input', { type: 'number', min: cfg.min, max: cfg.max, step: cfg.step || 1 });
    const rng = cfg.slider === false ? null : el('input', { type: 'range', min: cfg.smin != null ? cfg.smin : cfg.min, max: cfg.smax != null ? cfg.smax : cfg.max, step: cfg.step || 1 });
    const key = 'insp:' + c.id + ':' + label;
    const apply = (v) => {
      if (isNaN(v)) return;
      v = DS.clamp(v, cfg.min, cfg.max);
      S.checkpoint(key);
      cfg.set(v);
      S.change(cfg.structural);
    };
    num.addEventListener('input', () => apply(parseFloat(num.value)));
    num.addEventListener('change', () => { if (cfg.commit) cfg.commit(); });
    if (rng) {
      rng.addEventListener('input', () => { apply(parseFloat(rng.value)); num.value = fmtNum(parseFloat(rng.value), cfg); });
      rng.addEventListener('change', () => { if (cfg.commit) cfg.commit(); });
    }
    let kfBox = null, kPrev, kTog, kNext;
    if (cfg.prop) {
      kPrev = ibtn('chevL', 'Previous keyframe', () => S.kfNav(c, cfg.prop, -1));
      kTog = ibtn('diamond', 'Add/remove keyframe at playhead (right-click: remove all)', () => S.toggleKeyframe(c, cfg.prop));
      kTog.addEventListener('contextmenu', (e) => { e.preventDefault(); if (c.kf[cfg.prop].length) S.clearKeyframes(c, cfg.prop); });
      kNext = ibtn('chevR', 'Next keyframe', () => S.kfNav(c, cfg.prop, 1));
      kfBox = el('div', { class: 'kf' }, [kPrev, kTog, kNext]);
    }
    const row = el('div', { class: 'row' }, [el('label', { text: label, title: label }), el('div', { class: 'ctl' }, [rng, num].filter(Boolean)), kfBox || el('span')]);
    const sync = () => {
      const v = cfg.get();
      if (document.activeElement !== num) num.value = fmtNum(v, cfg);
      if (rng && document.activeElement !== rng) rng.value = v;
      if (cfg.prop) {
        const list = c.kf[cfg.prop] || [];
        const lt = S.playhead - c.start;
        const on = list.some((k) => Math.abs(k.t - lt) < S.frame() * 0.6);
        kTog.innerHTML = icon(on ? 'diamond-fill' : 'diamond');
        kTog.classList.toggle('kon', on || list.length > 0);
        kPrev.classList.toggle('disabled', !list.some((k) => k.t < lt - S.frame() * 0.5));
        kNext.classList.toggle('disabled', !list.some((k) => k.t > lt + S.frame() * 0.5));
      }
    };
    syncs.push(sync);
    return row;
  }
  const fmtNum = (v, cfg) => { const d = cfg.dec != null ? cfg.dec : (cfg.step && cfg.step < 1 ? 2 : 0); return (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toString(); };

  function checkRow(c, label, get, set, extra) {
    const cb = el('input', { type: 'checkbox' });
    cb.addEventListener('change', () => { S.checkpoint(); set(cb.checked); S.change(true); });
    const row = el('label', { class: 'chk' }, [cb, el('span', { text: label })]);
    if (extra) row.appendChild(extra);
    syncs.push(() => { cb.checked = !!get(); });
    return row;
  }
  function selectRow(c, label, options, get, set) {
    const sel = el('select', null, options.map(([v, l]) => el('option', { value: v, text: l })));
    sel.addEventListener('change', () => { S.checkpoint(); set(sel.value); S.change(true); });
    syncs.push(() => { if (document.activeElement !== sel) sel.value = get(); });
    return el('div', { class: 'row' }, [el('label', { text: label }), el('div', { class: 'ctl' }, [sel]), el('span')]);
  }
  function colorRow(c, label, get, set) {
    const inp = el('input', { type: 'color' });
    inp.addEventListener('input', () => { S.checkpoint('col:' + c.id + label); set(inp.value); S.change(); });
    syncs.push(() => { inp.value = get(); });
    return el('div', { class: 'row' }, [el('label', { text: label }), el('div', { class: 'ctl' }, [inp]), el('span')]);
  }

  function buildClip(c) {
    const m = c.type === 'media' ? S.media(c.media) : null;
    const track = S.track(c.track);
    const isVideoTrack = track.type === 'video';
    const hasPicture = c.type !== 'media' || (m && m.kind !== 'audio');
    const secs = [];
    const fx = c.fx;

    // ---- clip
    const clipRows = [];
    clipRows.push(numRow(c, 'Start (s)', { min: 0, max: 86400, step: 0.01, dec: 2, slider: false, get: () => c.start, set: (v) => { c.start = v; }, commit: () => { S.overwrite(c); S.change(true); } }));
    clipRows.push(numRow(c, 'Duration (s)', { min: 0.1, max: 86400, step: 0.01, dec: 2, slider: false, get: () => c.dur, set: (v) => { c.dur = Math.min(v, S.maxDur(c)); }, commit: () => { S.overwrite(c); S.change(true); } }));
    if (c.type === 'media' && m && m.kind !== 'image') {
      clipRows.push(checkRow(c, 'Reverse clip (preview steps frame by frame, no sound)', () => c.reverse, (v) => { c.reverse = v; }));
      clipRows.push(numRow(c, 'Speed (%)', { min: 10, max: 800, smin: 10, smax: 400, step: 1, get: () => c.speed * 100, set: (v) => S.setSpeed(c, v / 100), commit: () => S.change(true) }));
    }
    clipRows.push(checkRow(c, 'Enabled (untick to skip this clip)', () => !c.disabled, (v) => { c.disabled = !v; }));
    clipRows.push(selectRow(c, 'Label colour', Object.keys(DS.LABELS).map((k) => [k, DS.LABELS[k]]), () => DS.cleanLabel(c.color), (v) => { const col = DS.cleanLabel(v); S.selClips().forEach((x) => { x.color = col; }); c.color = col; }));
    secs.push(section('Clip', clipRows, m ? m.name : null));

    // ---- transform
    if (hasPicture && c.type !== 'adjust') {
      const tfRows = [
        numRow(c, 'Position X', { prop: 'x', min: -8000, max: 8000, smin: -S.project.width, smax: S.project.width, get: () => DS.tfAt(c, S.playhead - c.start).x, set: (v) => S.setTf(c, 'x', v) }),
        numRow(c, 'Position Y', { prop: 'y', min: -8000, max: 8000, smin: -S.project.height, smax: S.project.height, get: () => DS.tfAt(c, S.playhead - c.start).y, set: (v) => S.setTf(c, 'y', v) }),
        numRow(c, 'Scale (%)', { prop: 'scale', min: 1, max: 1000, smin: 1, smax: 400, get: () => DS.tfAt(c, S.playhead - c.start).scale, set: (v) => S.setTf(c, 'scale', v) }),
        numRow(c, 'Rotation (°)', { prop: 'rot', min: -3600, max: 3600, smin: -360, smax: 360, get: () => DS.tfAt(c, S.playhead - c.start).rot, set: (v) => S.setTf(c, 'rot', v) }),
        numRow(c, 'Opacity (%)', { prop: 'opacity', min: 0, max: 100, get: () => DS.tfAt(c, S.playhead - c.start).opacity, set: (v) => S.setTf(c, 'opacity', v) }),
        selectRow(c, 'Blend mode', DS.BLEND_IDS.map((k) => [k, DS.BLEND_MODES[k]]), () => DS.cleanBlend(c.blend), (v) => { c.blend = DS.cleanBlend(v); }),
        selectRow(c, 'Easing', [['lin', 'Linear'], ['ease', 'Ease in/out'], ['hold', 'Hold']], () => {
          const k = DS.ALLPROPS.map((p) => (c.kf[p] || []).find((q) => Math.abs(q.t - (S.playhead - c.start)) < S.frame() * 0.6)).find(Boolean);
          return k ? k.e || 'lin' : 'lin';
        }, (v) => { DS.ALLPROPS.forEach((p) => (c.kf[p] || []).forEach((k) => { if (Math.abs(k.t - (S.playhead - c.start)) < S.frame() * 0.6) k.e = v; })); }),
        el('div', { class: 'btnrow' }, [el('button', { class: 'btn', text: 'Reset transform', onclick: () => { S.checkpoint(); c.tf = Object.assign({}, DS.DEFAULT_TF); DS.PROPS.forEach((p) => { c.kf[p] = []; }); S.change(true); } })])
      ];
      secs.push(section('Transform', tfRows, 'Click ◆ to set a keyframe at the playhead, then change the value at another time to animate. You can also drag the clip in the program monitor.'));
    }

    // ---- transition
    if (isVideoTrack && c.type !== 'adjust') {
      const opts = [['', 'None']].concat(Object.keys(DS.TRANSITIONS).map((k) => [k, DS.TRANSITIONS[k]]));
      const rows = [
        selectRow(c, 'Type', opts, () => (c.tr ? c.tr.type : ''), (v) => { c.tr = v ? { type: v, dur: c.tr ? c.tr.dur : Math.min(1, c.dur) } : null; }),
        numRow(c, 'Length (s)', { min: 0.1, max: 10, step: 0.05, dec: 2, get: () => (c.tr ? c.tr.dur : 0), set: (v) => { if (c.tr) c.tr.dur = Math.min(v, c.dur); } })
      ];
      secs.push(section('Transition in', rows, 'Cross dissolve and slides hold the previous clip’s last frame beneath if the clips touch.'));
    }

    // ---- fades
    if (c.type !== 'adjust') {
      secs.push(section('Fades', [
        numRow(c, 'Fade in (s)', { min: 0, max: 30, step: 0.05, dec: 2, get: () => c.fadeIn, set: (v) => { c.fadeIn = Math.min(v, c.dur); } }),
        numRow(c, 'Fade out (s)', { min: 0, max: 30, step: 0.05, dec: 2, get: () => c.fadeOut, set: (v) => { c.fadeOut = Math.min(v, c.dur); } })
      ], 'Fades the picture to transparent and the sound to silence.'));
    }

    // ---- colour & effects
    if (hasPicture && c.type !== 'title') {
      const rows = [
        numRow(c, 'Brightness', { prop: 'brightness', min: -100, max: 100, get: () => DS.fxAt(c, S.playhead - c.start).brightness, set: (v) => S.setTf(c, 'brightness', v) }),
        numRow(c, 'Contrast', { prop: 'contrast', min: -100, max: 100, get: () => DS.fxAt(c, S.playhead - c.start).contrast, set: (v) => S.setTf(c, 'contrast', v) }),
        numRow(c, 'Saturation', { prop: 'saturation', min: 0, max: 300, smax: 200, get: () => DS.fxAt(c, S.playhead - c.start).saturation, set: (v) => S.setTf(c, 'saturation', v) }),
        numRow(c, 'Hue (°)', { prop: 'hue', min: -180, max: 180, get: () => DS.fxAt(c, S.playhead - c.start).hue, set: (v) => S.setTf(c, 'hue', v) }),
        numRow(c, 'Blur', { min: 0, max: 60, get: () => fx.blur, set: (v) => { fx.blur = v; } }),
        numRow(c, 'Sharpen', { min: 0, max: 100, get: () => fx.sharpen, set: (v) => { fx.sharpen = v; } }),
        numRow(c, 'Vignette', { prop: 'vignette', min: 0, max: 100, get: () => DS.fxAt(c, S.playhead - c.start).vignette, set: (v) => S.setTf(c, 'vignette', v) }),
        checkRow(c, 'Black & white', () => fx.gray, (v) => { fx.gray = v; }),
        checkRow(c, 'Sepia', () => fx.sepia, (v) => { fx.sepia = v; })
      ];
      if (c.type !== 'adjust') {
        rows.push(checkRow(c, 'Flip horizontal', () => fx.flipH, (v) => { fx.flipH = v; }));
        rows.push(checkRow(c, 'Flip vertical', () => fx.flipV, (v) => { fx.flipV = v; }));
        rows.push(el('div', { class: 'btnrow' }, [el('button', { class: 'btn', text: 'Reset effects', onclick: () => { S.checkpoint(); c.fx = DS.clone(DS.DEFAULT_FX); S.change(true); } })]));
      }
      secs.push(section('Colour & effects', rows));
      // ---- stylise: the creative effects (the preview and the export draw them from the same formulas)
      secs.push(section('Stylize', [
        checkRow(c, 'Invert', () => fx.invert, (v) => { fx.invert = v; }),
        numRow(c, 'Posterize (levels)', { min: 0, max: 32, get: () => fx.posterize, set: (v) => { fx.posterize = v < 2 ? 0 : Math.round(v); } }),
        numRow(c, 'Threshold', { min: 0, max: 100, get: () => fx.threshold, set: (v) => { fx.threshold = v; } }),
        numRow(c, 'Mosaic (block px)', { min: 0, max: 200, get: () => fx.mosaic, set: (v) => { fx.mosaic = v < 2 ? 0 : Math.round(v); } }),
        numRow(c, 'RGB split (px)', { min: 0, max: 60, get: () => fx.rgbsplit, set: (v) => { fx.rgbsplit = Math.round(v); } }),
        numRow(c, 'Film grain', { min: 0, max: 100, get: () => fx.grain, set: (v) => { fx.grain = v; } }),
        checkRow(c, 'Emboss', () => fx.emboss, (v) => { fx.emboss = v; if (v) fx.edges = false; }),
        checkRow(c, 'Find edges', () => fx.edges, (v) => { fx.edges = v; if (v) fx.emboss = false; }),
        numRow(c, 'Glow amount', { min: 0, max: 100, get: () => fx.glow.amount, set: (v) => { fx.glow.amount = v; } }),
        numRow(c, 'Glow size', { min: 1, max: 20, get: () => fx.glow.size, set: (v) => { fx.glow.size = v; } }),
        numRow(c, 'Glow threshold', { min: 0, max: 99, get: () => fx.glow.threshold, set: (v) => { fx.glow.threshold = v; } })
      ], 'Grain is random from frame to frame, so a preview frame and an exported frame match in strength, not pixel for pixel.'));
      // ---- LUT
      {
        const nm = el('span', { class: 'dim', text: '' });
        const upd = () => { nm.textContent = fx.lut ? fx.lut.name : 'None'; };
        syncs.push(upd);
        secs.push(section('Colour LUT (.cube)', [
          el('div', { class: 'btnrow' }, [
            el('button', { class: 'btn', text: 'Choose LUT…', onclick: async () => {
              const r = await window.ditto.chooseLut();
              if (!r) return;
              if (r.error) { toast(r.error, 'err'); return; }
              S.checkpoint(); fx.lut = { path: r.path, name: r.name }; S.change(true);
            } }),
            el('button', { class: 'btn', text: 'Remove', onclick: () => { S.checkpoint(); fx.lut = null; S.change(true); } }),
            nm
          ])
        ], 'Applied before the other colour effects, in the preview and on export.'));
        closedDefault('Colour LUT (.cube)');
      }
      if (c.type !== 'adjust') {
        secs.push(section('Crop', [
          numRow(c, 'Left (%)', { min: 0, max: 90, get: () => fx.crop.l, set: (v) => { fx.crop.l = v; } }),
          numRow(c, 'Top (%)', { min: 0, max: 90, get: () => fx.crop.t, set: (v) => { fx.crop.t = v; } }),
          numRow(c, 'Right (%)', { min: 0, max: 90, get: () => fx.crop.r, set: (v) => { fx.crop.r = v; } }),
          numRow(c, 'Bottom (%)', { min: 0, max: 90, get: () => fx.crop.b, set: (v) => { fx.crop.b = v; } })
        ]));
        closedDefault('Crop');
      }
      if (c.type !== 'adjust' && c.type !== 'title') {
        if (!fx.mask) fx.mask = DS.clone(DS.DEFAULT_FX.mask);
        const mk = fx.mask;
        secs.push(section('Mask', [
          checkRow(c, 'Enable mask', () => mk.on, (v) => { mk.on = v; }),
          selectRow(c, 'Shape', [['ellipse', 'Ellipse'], ['rect', 'Rectangle']], () => mk.shape, (v) => { mk.shape = v; }),
          numRow(c, 'Centre X (%)', { min: -100, max: 200, smin: 0, smax: 100, get: () => mk.cx, set: (v) => { mk.cx = v; mk.path = null; } }),
          numRow(c, 'Centre Y (%)', { min: -100, max: 200, smin: 0, smax: 100, get: () => mk.cy, set: (v) => { mk.cy = v; mk.path = null; } }),
          numRow(c, 'Width (%)', { min: 1, max: 400, smin: 1, smax: 200, get: () => mk.w, set: (v) => { mk.w = v; } }),
          numRow(c, 'Height (%)', { min: 1, max: 400, smin: 1, smax: 200, get: () => mk.h, set: (v) => { mk.h = v; } }),
          numRow(c, 'Feather', { min: 0, max: 100, get: () => mk.feather, set: (v) => { mk.feather = v; } }),
          checkRow(c, 'Invert (hide inside)', () => mk.invert, (v) => { mk.invert = v; }),
          el('div', { class: 'btnrow' }, [
            el('button', { class: 'btn', text: 'Track the mask…', title: 'Make the mask follow a moving object', onclick: () => Tracker.open(c, 'mask') }),
            el('button', { class: 'btn', text: 'Stop following', onclick: () => { S.checkpoint(); mk.path = null; S.change(true); } })
          ])
        ], 'Shows only the shape (or everything but it). Moving the centre by hand removes tracking.'));
        closedDefault('Mask');
      }
      if (c.type !== 'adjust') {
        secs.push(section('Luma key', [
          checkRow(c, 'Enable luma key', () => fx.lumakey.on, (v) => { fx.lumakey.on = v; }),
          numRow(c, 'Key level', { min: 0, max: 100, get: () => fx.lumakey.threshold, set: (v) => { fx.lumakey.threshold = v; } }),
          numRow(c, 'Range', { min: 0, max: 100, get: () => fx.lumakey.tolerance, set: (v) => { fx.lumakey.tolerance = v; } }),
          numRow(c, 'Softness', { min: 0, max: 100, get: () => fx.lumakey.softness, set: (v) => { fx.lumakey.softness = v; } })
        ], 'Makes a brightness band transparent: level 0 with a range keys out the darks, level 100 the brights.'));
        closedDefault('Luma key');
        secs.push(section('Chroma key', [
          checkRow(c, 'Enable green-screen key', () => fx.chroma.on, (v) => { fx.chroma.on = v; }),
          colorRow(c, 'Key colour', () => fx.chroma.color, (v) => { fx.chroma.color = v; }),
          numRow(c, 'Similarity', { min: 1, max: 100, get: () => fx.chroma.sim, set: (v) => { fx.chroma.sim = v; } }),
          numRow(c, 'Blend', { min: 0, max: 100, get: () => fx.chroma.blend, set: (v) => { fx.chroma.blend = v; } })
        ], 'Pick the background colour, then raise Similarity until it disappears. Blend softens the edge.'));
        closedDefault('Chroma key');
      }
    }

    // ---- audio
    if (c.type === 'media' && m && m.hasAudio && m.kind !== 'image') {
      secs.push(section('Audio', [
        numRow(c, 'Volume (dB)', { prop: 'vol', min: -60, max: 24, smin: -60, smax: 12, step: 0.5, dec: 1, get: () => DS.volAt(c, S.playhead - c.start), set: (v) => S.setTf(c, 'vol', v) })
        , checkRow(c, 'Mute this clip’s sound', () => c.mute, (v) => { c.mute = v; })
      ], 'Click ◆ to keyframe the volume, then change it at another time to fade or duck.'));
      const ae = c.ae;
      secs.push(section('Audio effects', [
        numRow(c, 'Noise reduction (dB, export only)', { min: 0, max: 40, step: 1, dec: 0, get: () => ae.denoise, set: (v) => { ae.denoise = v; } }),
        numRow(c, 'High-pass (Hz)', { min: 0, max: 2000, smax: 500, step: 5, dec: 0, get: () => ae.hp, set: (v) => { ae.hp = v; } }),
        numRow(c, 'Low-pass (Hz)', { min: 1000, max: 20000, step: 100, dec: 0, get: () => ae.lp, set: (v) => { ae.lp = v; } }),
        numRow(c, 'Bass (dB)', { min: -18, max: 18, step: 0.5, dec: 1, get: () => ae.low, set: (v) => { ae.low = v; } }),
        numRow(c, 'Mid (dB)', { min: -18, max: 18, step: 0.5, dec: 1, get: () => ae.mid, set: (v) => { ae.mid = v; } }),
        numRow(c, 'Treble (dB)', { min: -18, max: 18, step: 0.5, dec: 1, get: () => ae.high, set: (v) => { ae.high = v; } }),
        numRow(c, 'Pan (L–R)', { min: -100, max: 100, step: 1, dec: 0, get: () => ae.pan, set: (v) => { ae.pan = v; } }),
        checkRow(c, 'Compressor', () => ae.comp.on, (v) => { ae.comp.on = v; }),
        numRow(c, 'Threshold (dB)', { min: -60, max: 0, step: 1, dec: 0, get: () => ae.comp.thresh, set: (v) => { ae.comp.thresh = v; } }),
        numRow(c, 'Ratio', { min: 1, max: 20, step: 0.5, dec: 1, get: () => ae.comp.ratio, set: (v) => { ae.comp.ratio = v; } }),
        numRow(c, 'Attack (ms)', { min: 1, max: 200, step: 1, dec: 0, get: () => ae.comp.attack, set: (v) => { ae.comp.attack = v; } }),
        numRow(c, 'Release (ms)', { min: 10, max: 1000, step: 5, dec: 0, get: () => ae.comp.release, set: (v) => { ae.comp.release = v; } }),
        numRow(c, 'Make-up (dB)', { min: 0, max: 24, step: 0.5, dec: 1, get: () => ae.comp.makeup, set: (v) => { ae.comp.makeup = v; } }),
        checkRow(c, 'Echo', () => ae.echo.on, (v) => { ae.echo.on = v; }),
        numRow(c, 'Echo delay (ms)', { min: 20, max: 1000, step: 5, dec: 0, get: () => ae.echo.delay, set: (v) => { ae.echo.delay = v; } }),
        numRow(c, 'Echo strength (%)', { min: 1, max: 90, step: 1, dec: 0, get: () => ae.echo.decay, set: (v) => { ae.echo.decay = v; } }),
        el('div', { class: 'btnrow' }, [el('button', { class: 'btn', text: 'Reset audio effects', onclick: () => { S.checkpoint(); c.ae = DS.clone(DS.DEFAULT_AE); S.change(true); } })])
      ], 'Heard in the preview and applied on export.'));
      closedDefault('Audio effects');
      if (DS.layoutOf(S.rootProject()) === '5.1') {
        const pad = el('canvas', { width: 180, height: 150, style: 'display:block;margin:6px auto;cursor:crosshair;background:var(--bg2,#1b1d22);border-radius:6px' });
        const drawPad = () => {
          const x = pad.getContext('2d'), w = pad.width, h = pad.height;
          x.clearRect(0, 0, w, h); x.strokeStyle = 'rgba(255,255,255,.18)'; x.lineWidth = 1;
          x.strokeRect(14.5, 12.5, w - 29, h - 25);
          x.fillStyle = 'rgba(255,255,255,.55)'; x.font = '10px sans-serif'; x.textAlign = 'center';
          [['L', 14, 12], ['C', w / 2, 12], ['R', w - 14, 12], ['Ls', 14, h - 6], ['Rs', w - 14, h - 6]].forEach(([n, px, py]) => x.fillText(n, px, py + (py < 20 ? 9 : 0)));
          const px = 14 + ((ae.sx || 0) + 100) / 200 * (w - 28), py = 22 + (ae.sy || 0) / 100 * (h - 44);
          x.fillStyle = '#ffd34d'; x.beginPath(); x.arc(px, py, 7, 0, Math.PI * 2); x.fill();
        };
        const fromEvent = (e) => { const r = pad.getBoundingClientRect(); const u = (e.clientX - r.left) / r.width * pad.width, v = (e.clientY - r.top) / r.height * pad.height; return { sx: DS.clamp(Math.round(((u - 14) / (pad.width - 28)) * 200 - 100), -100, 100), sy: DS.clamp(Math.round(((v - 22) / (pad.height - 44)) * 100), 0, 100) }; };
        let drag = false;
        pad.addEventListener('pointerdown', (e) => { drag = true; try { pad.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or already released */ } S.checkpoint('pad:' + c.id); const p = fromEvent(e); ae.sx = p.sx; ae.sy = p.sy; S.change(); });
        pad.addEventListener('pointermove', (e) => { if (!drag) return; const p = fromEvent(e); ae.sx = p.sx; ae.sy = p.sy; S.change(); });
        pad.addEventListener('pointerup', () => { drag = false; });
        pad.addEventListener('dblclick', () => { S.checkpoint(); ae.sx = 0; ae.sy = 0; S.change(); });
        syncs.push(drawPad);
        secs.push(section('Surround (5.1)', [
          pad,
          numRow(c, 'Left – right', { min: -100, max: 100, get: () => ae.sx || 0, set: (v) => { ae.sx = v; } }),
          numRow(c, 'Front – back', { min: 0, max: 100, get: () => ae.sy || 0, set: (v) => { ae.sy = v; } }),
          numRow(c, 'Centre send (%)', { min: 0, max: 100, get: () => ae.sc || 0, set: (v) => { ae.sc = v; } }),
          numRow(c, 'Bass (LFE) send (%)', { min: 0, max: 100, get: () => ae.slfe || 0, set: (v) => { ae.slfe = v; } })
        ], 'Places this clip around the room. Drag the dot; double-click to centre. The preview plays a stereo mix-down of it; the export has all six channels.'));
      }
    }

    // ---- title text
    if (c.type === 'title') {
      const t = c.title;
      const text = el('textarea', { rows: 3 });
      text.addEventListener('input', () => { S.checkpoint('txt:' + c.id); t.text = text.value; S.change(); });
      syncs.push(() => { if (document.activeElement !== text) text.value = t.text; });
      const rows = [
        text,
        selectRow(c, 'Font', FONTS.map((f) => [f, f]), () => t.font, (v) => { t.font = v; }),
        numRow(c, 'Size', { min: 8, max: 600, smax: 300, get: () => t.size, set: (v) => { t.size = v; } }),
        colorRow(c, 'Colour', () => t.color, (v) => { t.color = v; }),
        selectRow(c, 'Align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], () => t.align, (v) => { t.align = v; }),
        checkRow(c, 'Bold', () => t.bold, (v) => { t.bold = v; }),
        checkRow(c, 'Italic', () => t.italic, (v) => { t.italic = v; }),
        numRow(c, 'Outline', { min: 0, max: 40, get: () => t.strokeW, set: (v) => { t.strokeW = v; } }),
        colorRow(c, 'Outline colour', () => t.stroke, (v) => { t.stroke = v; }),
        checkRow(c, 'Drop shadow', () => t.shadow, (v) => { t.shadow = v; }),
        checkRow(c, 'Background box', () => t.bg, (v) => { t.bg = v; }),
        colorRow(c, 'Box colour', () => t.bgColor, (v) => { t.bgColor = v; }),
        numRow(c, 'Box opacity', { min: 0, max: 100, get: () => t.bgAlpha, set: (v) => { t.bgAlpha = v; } }),
        numRow(c, 'Line spacing', { min: 0.8, max: 3, step: 0.05, dec: 2, get: () => t.lineH, set: (v) => { t.lineH = v; } }),
        checkRow(c, 'Rolling credits (scrolls bottom to top over the clip’s length)', () => t.roll, (v) => { t.roll = v; })
      ];
      const sh = t.shape;
      const shapeRows = [
        selectRow(c, 'Kind', [['none', 'None'], ['matte', 'Colour matte (whole frame)'], ['rect', 'Rectangle'], ['ellipse', 'Ellipse']], () => sh.kind, (v) => { sh.kind = v; }),
        colorRow(c, 'Fill colour', () => sh.color, (v) => { sh.color = v; }),
        numRow(c, 'Fill opacity', { min: 0, max: 100, get: () => sh.alpha, set: (v) => { sh.alpha = v; } }),
        numRow(c, 'Width (% of frame)', { min: 1, max: 100, get: () => sh.w, set: (v) => { sh.w = v; } }),
        numRow(c, 'Height (% of frame)', { min: 1, max: 100, get: () => sh.h, set: (v) => { sh.h = v; } }),
        numRow(c, 'Corner rounding', { min: 0, max: 100, get: () => sh.radius, set: (v) => { sh.radius = v; } }),
        numRow(c, 'Outline', { min: 0, max: 60, get: () => sh.strokeW, set: (v) => { sh.strokeW = v; } }),
        colorRow(c, 'Outline colour', () => sh.stroke, (v) => { sh.stroke = v; })
      ];
      secs.unshift(section('Shape', shapeRows, 'A shape is drawn behind the text. Move, scale, rotate and fade it with Transform; pick a blend mode there too.'));
      secs.unshift(section('Text', rows));
    }
    return secs;
  }
  function closedDefault(name) { if (!closedSeen.has(name)) { closedSeen.add(name); closed.add(name); } }
  const closedSeen = new Set();

  function build() {
    root.innerHTML = ''; syncs = [];
    builtKey = Array.from(S.sel).join(',');
    const list = S.selClips();
    builtId = list.length === 1 ? list[0].id : null;
    if (!list.length) {
      title.textContent = '';
      root.appendChild(el('div', { class: 'insp-empty' }, [
        el('div', { text: 'Select a clip on the timeline to edit its position, scale, effects, transitions and audio.' }),
        el('div', { style: 'margin-top:14px', class: 'dim', text: S.project.clips.length ? 'Tip: Ctrl+K splits at the playhead, C is the razor tool.' : 'Tip: drag media from the Project panel onto a track.' })
      ]));
      return;
    }
    if (list.length > 1) {
      title.textContent = list.length + ' clips';
      root.appendChild(el('div', { class: 'insp-empty' }, [
        el('div', { text: list.length + ' clips selected' }),
        el('div', { class: 'btnrow', style: 'justify-content:center;margin-top:14px' }, [
          el('button', { class: 'btn', text: 'Delete', onclick: () => S.deleteClips(Array.from(S.sel), false) }),
          el('button', { class: 'btn', text: 'Ripple delete', onclick: () => S.deleteClips(Array.from(S.sel), true) }),
          el('button', { class: 'btn', text: 'Duplicate', onclick: () => S.duplicate() })
        ])
      ]));
      return;
    }
    const c = list[0];
    const m = c.type === 'media' ? S.media(c.media) : null;
    title.textContent = c.type === 'title' ? 'Title' : c.type === 'adjust' ? 'Adjustment layer' : (m ? m.name : 'Clip');
    buildClip(c).forEach((s) => root.appendChild(s));
    refresh();
  }

  function refresh() { syncs.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }

  function onChange() {
    const key = Array.from(S.sel).join(',');
    if (key !== builtKey || (builtId && !S.clip(builtId))) build(); else refresh();
  }
  S.on('select', build);
  S.on('load', build);
  S.on('change', onChange);
  S.on('time', refresh);
  build();
  return { build, refresh };
})();

// ===================================================================== transport
const Transport = (() => {
  const bar = $('#tButtons');
  const play = ibtn('play', 'Play / Pause (Space)', () => Player.toggle(), 'big');
  [
    ibtn('skip-start', 'Go to start (Home)', () => { Player.stop(); S.seek(0); }),
    ibtn('step-back', 'Back one frame (←)', () => { Player.stop(); S.seek(S.playhead - S.frame()); }),
    play,
    ibtn('step-fwd', 'Forward one frame (→)', () => { Player.stop(); S.seek(Math.min(S.duration(), S.playhead + S.frame())); }),
    ibtn('skip-end', 'Go to end (End)', () => { Player.stop(); S.seek(S.duration()); })
  ].forEach((b) => bar.appendChild(b));
  const cur = $('#tcCur'), dur = $('#tcDur');
  const upd = () => {
    cur.textContent = DS.fmtTC(S.playhead, S.project.fps);
    dur.textContent = DS.fmtTC(S.duration(), S.project.fps);
  };
  const updBtn = () => { play.innerHTML = icon(S.playing ? 'pause' : 'play'); };
  S.on('time', upd); S.on('change', upd); S.on('load', () => { upd(); updBtn(); }); S.on('transport', updBtn);
  upd(); updBtn();
})();
