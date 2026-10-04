'use strict';
/* Ditto Pro — Color tab: video scopes (waveform, RGB parade, vectorscope, histogram) and a Lumetri-style grade for the
   selected clip or adjustment layer: basic correction, curves, colour wheels. The grade is stored as clip.fx.color and baked
   into one LUT by grade.js, which the GPU preview and the FFmpeg export both read. */
const Color = (() => {
  const root = $('#tab-co');
  const mon = $('#monitor');
  let mode = 'wave', chan = 'm', lastKey = null, syncs = [], lastScope = 0, scopeQueued = false;
  try { const m = localStorage.getItem('dittoScope'); if (['wave', 'parade', 'vec', 'hist'].includes(m)) mode = m; } catch (e) { /* ignore */ }
  const small = document.createElement('canvas');
  const sctx = small.getContext('2d', { willReadFrequently: true });
  let scopeCv = null, last = null;

  // ---------------------------------------------------------------- the clip we are grading
  function target() {
    if (S.sel.size !== 1) return null;
    const c = S.clip(Array.from(S.sel)[0]);
    if (!c || c.type === 'title') return null;
    if (c.type === 'media') { const m = S.media(c.media); if (!m || m.kind === 'audio') return null; }
    return c;
  }
  const col = (c) => c.fx.color || (c.fx.color = DG.fresh());
  const touch = (c, key, fn) => { S.checkpoint('col:' + c.id + ':' + key); fn(col(c)); if (!DG.active(c.fx.color)) c.fx.color = null; S.change(); };

  // ---------------------------------------------------------------- scopes
  const SIZE = { w: 300, h: 170 };
  function grab() {
    const w = mon.width, h = mon.height;
    if (!w || !h) return null;
    const sw = 320, sh = Math.max(8, Math.round(320 * h / w));
    if (small.width !== sw || small.height !== sh) { small.width = sw; small.height = sh; }
    sctx.drawImage(mon, 0, 0, sw, sh);
    return DSC.analyze(sctx.getImageData(0, 0, sw, sh).data, sw, sh, { cols: SIZE.w });
  }
  function drawScope(A) {
    if (!scopeCv) return;
    const X = scopeCv.getContext('2d'), W = SIZE.w, H = SIZE.h;
    X.fillStyle = '#0b0b0d'; X.fillRect(0, 0, W, H);
    if (!A) return;
    const guides = () => {
      X.strokeStyle = 'rgba(255,255,255,.13)'; X.lineWidth = 1; X.fillStyle = 'rgba(255,255,255,.4)'; X.font = '9px sans-serif';
      for (let i = 0; i <= 4; i++) { const y = Math.round(8 + (H - 16) * i / 4) + .5; X.beginPath(); X.moveTo(0, y); X.lineTo(W, y); X.stroke(); X.fillText(String(100 - i * 25), 2, y - 2); }
    };
    if (mode === 'wave' || mode === 'parade') {
      guides();
      const img = X.getImageData(0, 0, W, H), d = img.data;
      const plot = (arr, x0, cw, rgb, perCol) => {
        for (let c = 0; c < cw; c++) {
          const base = Math.min(A.wave.cols - 1, Math.floor(c * A.wave.cols / cw)) * 256;
          for (let v = 0; v < 256; v++) {
            const n = arr[base + v]; if (!n) continue;
            const a = Math.min(1, Math.sqrt(n / perCol * 14));
            const y = 8 + Math.round((255 - v) / 255 * (H - 17)), i = (y * W + x0 + c) * 4;
            d[i] = Math.min(255, d[i] + rgb[0] * a); d[i + 1] = Math.min(255, d[i + 1] + rgb[1] * a); d[i + 2] = Math.min(255, d[i + 2] + rgb[2] * a);
          }
        }
      };
      const per = Math.max(1, A.wave.rows * (small.width / A.wave.cols));
      if (mode === 'wave') plot(A.wave.l, 0, W, [90, 255, 130], per);
      else {
        const pw = Math.floor(W / 3);
        // a parade column holds the picture's columns squeezed into pw pixels
        const per3 = Math.max(1, A.wave.rows * (small.width / pw));
        const cols3 = (arr) => { const o = new Uint32Array(pw * 256); for (let c = 0; c < A.wave.cols; c++) { const t = Math.min(pw - 1, Math.floor(c * pw / A.wave.cols)); for (let v = 0; v < 256; v++) o[t * 256 + v] += arr[c * 256 + v]; } return o; };
        const plot3 = (arr, x0, rgb) => { const g = cols3(arr); for (let c = 0; c < pw; c++) for (let v = 0; v < 256; v++) { const n = g[c * 256 + v]; if (!n) continue; const a = Math.min(1, Math.sqrt(n / per3 * 14)); const y = 8 + Math.round((255 - v) / 255 * (H - 17)), i = (y * W + x0 + c) * 4; d[i] = Math.min(255, d[i] + rgb[0] * a); d[i + 1] = Math.min(255, d[i + 1] + rgb[1] * a); d[i + 2] = Math.min(255, d[i + 2] + rgb[2] * a); } };
        plot3(A.wave.r, 0, [255, 70, 70]); plot3(A.wave.g, pw, [70, 255, 90]); plot3(A.wave.b, pw * 2, [90, 130, 255]);
      }
      X.putImageData(img, 0, 0);
    } else if (mode === 'vec') {
      const R = Math.min(W, H) - 6, ox = (W - R) / 2, oy = 3, sc = R / (DSC.VEC - 1);
      X.strokeStyle = 'rgba(255,255,255,.18)'; X.lineWidth = 1;
      X.beginPath(); X.arc(W / 2, H / 2, R / 2, 0, Math.PI * 2); X.stroke();
      X.beginPath(); X.arc(W / 2, H / 2, R / 4, 0, Math.PI * 2); X.stroke();
      X.beginPath(); X.moveTo(ox, H / 2); X.lineTo(ox + R, H / 2); X.moveTo(W / 2, oy); X.lineTo(W / 2, oy + R); X.stroke();
      // skin-tone line (about 123° from +Cb towards +Cr)
      X.strokeStyle = 'rgba(255,200,120,.45)'; X.beginPath(); X.moveTo(W / 2, H / 2); const a = 123 * Math.PI / 180; X.lineTo(W / 2 + Math.cos(a) * R / 2, H / 2 - Math.sin(a) * R / 2); X.stroke();
      const img = X.getImageData(0, 0, W, H), d = img.data, V = A.vec;
      let mx = 1; for (let i = 0; i < V.d.length; i++) if (V.d[i] > mx) mx = V.d[i];
      for (let y = 0; y < V.size; y++) for (let x = 0; x < V.size; x++) {
        const n = V.d[y * V.size + x]; if (!n) continue;
        const a2 = Math.min(1, Math.log(1 + n) / Math.log(1 + mx) * 1.4);
        const px = Math.round(ox + x * sc), py = Math.round(oy + y * sc), i = (py * W + px) * 4;
        d[i] = Math.min(255, d[i] + 120 * a2 + 20); d[i + 1] = Math.min(255, d[i + 1] + 255 * a2); d[i + 2] = Math.min(255, d[i + 2] + 150 * a2 + 20);
      }
      X.putImageData(img, 0, 0);
      [['R', 255, 0, 0], ['Y', 255, 255, 0], ['G', 0, 255, 0], ['C', 0, 255, 255], ['B', 0, 0, 255], ['M', 255, 0, 255]].forEach(([t, r, g, b]) => {
        const p = DSC.vecPoint(r, g, b, DSC.VEC); const x = ox + p.x * sc, y = oy + p.y * sc;
        X.strokeStyle = 'rgba(255,255,255,.55)'; X.strokeRect(x - 4, y - 4, 8, 8); X.fillStyle = 'rgba(255,255,255,.7)'; X.font = '9px sans-serif'; X.fillText(t, x + 6, y + 3);
      });
    } else {
      guides();
      const H0 = A.hist; let mx = 1;
      for (let i = 1; i < 255; i++) mx = Math.max(mx, H0.r[i], H0.g[i], H0.b[i]);
      const draw = (arr, style) => {
        X.fillStyle = style; X.beginPath(); X.moveTo(0, H - 8);
        for (let x = 0; x < W; x++) { const v = arr[Math.min(255, Math.floor(x * 256 / W))]; X.lineTo(x, H - 8 - Math.min(1, v / (mx * 1.1)) * (H - 16)); }
        X.lineTo(W, H - 8); X.closePath(); X.fill();
      };
      X.globalCompositeOperation = 'lighter';
      draw(H0.r, 'rgba(255,60,60,.55)'); draw(H0.g, 'rgba(60,255,80,.55)'); draw(H0.b, 'rgba(80,120,255,.6)');
      X.globalCompositeOperation = 'source-over';
    }
  }
  function refreshScope(force) {
    if (!scopeCv || root.classList.contains('hidden')) return;
    const now = performance.now();
    if (!force && S.playing && now - lastScope < 110) return;
    lastScope = now;
    last = grab();
    drawScope(last);
  }
  mon.addEventListener('framerendered', () => {
    if (root.classList.contains('hidden') || scopeQueued) return;
    scopeQueued = true;
    requestAnimationFrame(() => { scopeQueued = false; refreshScope(false); });
  });

  // ---------------------------------------------------------------- controls
  function slider(c, label, key, lo, hi, tip) {
    const num = el('input', { type: 'number', min: lo, max: hi, step: 1, style: 'width:54px' });
    const rng = el('input', { type: 'range', min: lo, max: hi, step: 1 });
    const apply = (v) => { if (isNaN(v)) return; v = DS.clamp(v, lo, hi); touch(c, key, (g) => { g[key] = v; }); };
    num.addEventListener('input', () => apply(parseFloat(num.value)));
    rng.addEventListener('input', () => { apply(parseFloat(rng.value)); num.value = rng.value; });
    num.addEventListener('keydown', (e) => e.stopPropagation());
    const lab = el('label', { text: label, title: (tip || label) + ' — double-click to reset' });
    lab.addEventListener('dblclick', () => apply(0));
    syncs.push(() => { const v = c.fx.color ? c.fx.color[key] : 0; if (document.activeElement !== num) num.value = Math.round(v); if (document.activeElement !== rng) rng.value = v; });
    return el('div', { class: 'row', style: 'grid-template-columns:78px 1fr' }, [lab, el('div', { class: 'ctl' }, [rng, num])]);
  }
  function sec(name, rows, open) {
    const s = el('div', { class: 'sec' + (open === false ? ' closed' : '') });
    const head = el('div', { class: 'sh' }, [el('span', { class: 'chev', html: icon('chevD') }), el('span', { text: name })]);
    head.addEventListener('click', () => s.classList.toggle('closed'));
    s.appendChild(head); s.appendChild(el('div', { class: 'sb' }, rows));
    return s;
  }

  // ---- curves editor
  const CS = 232;
  function curvesEditor(c) {
    const cv = el('canvas', { width: CS, height: CS, class: 'curvecv', title: 'Click to add a point · drag to move · double-click a point to remove it' });
    const X = cv.getContext('2d');
    const pts = () => { const g = c.fx.color; const p = g && g.curves[chan]; return p && p.length ? p : [[0, 0], [1, 1]]; };
    const toXY = (p) => [p[0] * (CS - 12) + 6, (1 - p[1]) * (CS - 12) + 6];
    const fromXY = (x, y) => [DS.clamp((x - 6) / (CS - 12), 0, 1), DS.clamp(1 - (y - 6) / (CS - 12), 0, 1)];
    const colr = { m: '#e8e8ee', r: '#ff5a5a', g: '#5aff7a', b: '#6a8cff' }[chan];
    function draw() {
      X.fillStyle = '#0b0b0d'; X.fillRect(0, 0, CS, CS);
      X.strokeStyle = 'rgba(255,255,255,.12)'; X.lineWidth = 1;
      for (let i = 0; i <= 4; i++) { const v = 6 + (CS - 12) * i / 4 + .5; X.beginPath(); X.moveTo(v, 6); X.lineTo(v, CS - 6); X.moveTo(6, v); X.lineTo(CS - 6, v); X.stroke(); }
      X.strokeStyle = 'rgba(255,255,255,.25)'; X.beginPath(); X.moveTo(6, CS - 6); X.lineTo(CS - 6, 6); X.stroke();
      const p = pts(), f = DG.curveFn(p);
      X.strokeStyle = colr; X.lineWidth = 2; X.beginPath();
      for (let i = 0; i <= 120; i++) { const x = i / 120, q = toXY([x, f(x)]); if (i) X.lineTo(q[0], q[1]); else X.moveTo(q[0], q[1]); }
      X.stroke();
      p.forEach((pt) => { const q = toXY(pt); X.fillStyle = '#0b0b0d'; X.strokeStyle = colr; X.lineWidth = 2; X.beginPath(); X.arc(q[0], q[1], 4.5, 0, 7); X.fill(); X.stroke(); });
    }
    let drag = -1;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * CS / r.width, (e.clientY - r.top) * CS / r.height]; };
    const hit = (x, y) => { const p = pts(); let best = -1, bd = 100; p.forEach((pt, i) => { const q = toXY(pt); const d = Math.hypot(q[0] - x, q[1] - y); if (d < 10 && d < bd) { bd = d; best = i; } }); return best; };
    const write = (list) => touch(c, 'curve' + chan, (g) => { g.curves[chan] = list; });
    cv.addEventListener('pointerdown', (e) => {
      const [x, y] = pos(e); let i = hit(x, y);
      S.checkpoint('col:' + c.id + ':curvedrag');
      let list = pts().map((p) => p.slice());
      if (i < 0) { list.push(fromXY(x, y)); list.sort((a, b) => a[0] - b[0]); i = list.findIndex((p) => Math.abs(p[0] - fromXY(x, y)[0]) < 1e-9); write(list); }
      drag = i; try { cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ } draw();
    });
    cv.addEventListener('pointermove', (e) => {
      if (drag < 0) return;
      const [x, y] = pos(e); const list = pts().map((p) => p.slice()); const n = fromXY(x, y);
      const lo = drag > 0 ? list[drag - 1][0] + 0.01 : 0, hi = drag < list.length - 1 ? list[drag + 1][0] - 0.01 : 1;
      list[drag] = [DS.clamp(n[0], lo, hi), n[1]];
      write(list); draw();
    });
    const up = () => { drag = -1; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('dblclick', (e) => {
      const [x, y] = pos(e), i = hit(x, y); if (i < 0) return;
      const list = pts().map((p) => p.slice()); list.splice(i, 1);
      S.checkpoint('col:' + c.id + ':curveremove'); write(list.length >= 2 ? list : null); draw();
    });
    syncs.push(draw);
    draw();
    const tabs = el('div', { class: 'curvetabs' }, [['m', 'RGB'], ['r', 'R'], ['g', 'G'], ['b', 'B']].map(([k, t]) => {
      const b = el('button', { class: 'btn' + (chan === k ? ' on' : ''), text: t, onclick: () => { chan = k; build(true); } });
      return b;
    }));
    const reset = el('button', { class: 'btn', text: 'Reset curve', onclick: () => { touch(c, 'curvereset', (g) => { g.curves[chan] = null; }); draw(); } });
    return [el('div', { class: 'row', style: 'grid-template-columns:1fr auto' }, [tabs, reset]), cv];
  }

  // ---- colour wheels
  let wheelBg = null;
  function wheelImage(S2) {
    if (wheelBg && wheelBg.width === S2) return wheelBg;
    const cv = document.createElement('canvas'); cv.width = cv.height = S2;
    const X = cv.getContext('2d'), img = X.createImageData(S2, S2), r0 = S2 / 2 - 1;
    for (let y = 0; y < S2; y++) for (let x = 0; x < S2; x++) {
      const dx = x - S2 / 2 + .5, dy = y - S2 / 2 + .5, d = Math.hypot(dx, dy), i = (y * S2 + x) * 4;
      if (d > r0) continue;
      const h = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360, s = d / r0;
      // the colour shown at an angle is exactly the tint that angle applies (the same cosine vector grade.js uses)
      const k = (a) => 0.5 + Math.cos(a) * 2 / 3 * s * 0.75, rad = h * Math.PI / 180;
      img.data[i] = k(rad) * 255; img.data[i + 1] = k(rad - 2.0943951) * 255; img.data[i + 2] = k(rad + 2.0943951) * 255; img.data[i + 3] = 255;
    }
    X.putImageData(img, 0, 0);
    wheelBg = cv; return cv;
  }
  function wheel(c, key, label) {
    const S2 = 92;
    const cv = el('canvas', { width: S2, height: S2, class: 'wheelcv', title: label + ' — drag to tint · double-click to reset' });
    const X = cv.getContext('2d');
    const get = () => (c.fx.color ? c.fx.color.wheels[key] : { h: 0, s: 0, l: 0 });
    function draw() {
      X.clearRect(0, 0, S2, S2); X.drawImage(wheelImage(S2), 0, 0);
      const w = get(), r = (S2 / 2 - 1) * w.s / 100, a = w.h * Math.PI / 180;
      X.strokeStyle = 'rgba(0,0,0,.55)'; X.beginPath(); X.arc(S2 / 2, S2 / 2, S2 / 2 - 1, 0, 7); X.stroke();
      X.fillStyle = '#fff'; X.strokeStyle = '#000'; X.lineWidth = 1.5; X.beginPath(); X.arc(S2 / 2 + Math.cos(a) * r, S2 / 2 - Math.sin(a) * r, 5, 0, 7); X.fill(); X.stroke();
    }
    const setFrom = (e) => {
      const rc = cv.getBoundingClientRect(), x = (e.clientX - rc.left) * S2 / rc.width - S2 / 2, y = (e.clientY - rc.top) * S2 / rc.height - S2 / 2;
      const s = Math.min(100, Math.hypot(x, y) / (S2 / 2 - 1) * 100), h = (Math.atan2(-y, x) * 180 / Math.PI + 360) % 360;
      touch(c, 'wheel' + key, (g) => { g.wheels[key].h = Math.round(h); g.wheels[key].s = Math.round(s); });
      draw();
    };
    let on = false;
    cv.addEventListener('pointerdown', (e) => { on = true; try { cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ } S.checkpoint('col:' + c.id + ':wheeldrag' + key); setFrom(e); });
    cv.addEventListener('pointermove', (e) => { if (on) setFrom(e); });
    cv.addEventListener('pointerup', () => { on = false; }); cv.addEventListener('pointercancel', () => { on = false; });
    cv.addEventListener('dblclick', () => { touch(c, 'wheelreset' + key, (g) => { g.wheels[key] = { h: 0, s: 0, l: 0 }; }); draw(); });
    const lum = el('input', { type: 'range', min: -100, max: 100, step: 1, title: label + ' brightness', style: 'width:100%' });
    lum.addEventListener('input', () => touch(c, 'wheell' + key, (g) => { g.wheels[key].l = parseFloat(lum.value); }));
    syncs.push(() => { draw(); if (document.activeElement !== lum) lum.value = get().l; });
    draw();
    return el('div', { class: 'wheel' }, [el('div', { class: 'dim', text: label }), cv, lum]);
  }

  // ---- auto tone: measure the picture WITHOUT the grade, then set blacks / whites / exposure
  function autoTone(c) {
    const keep = c.fx.color; c.fx.color = null;
    try { Player.render(); } catch (e) { /* ignore */ }
    const A = grab();
    c.fx.color = keep;
    if (!A) { Player.render(); return; }
    const t = DSC.autoTone(A.hist.l);
    touch(c, 'auto', (g) => { g.blacks = t.blacks; g.whites = t.whites; g.exposure = t.exposure; });
    build(true);
    toast('Auto tone set: exposure ' + t.exposure + ', whites ' + t.whites + ', blacks ' + t.blacks + '.');
  }

  function build(force) {
    const c = target();
    const key = c ? c.id + ':' + chan : 'none';
    if (!force && key === lastKey) { syncs.forEach((f) => f()); return; }
    lastKey = key; syncs = [];
    root.innerHTML = '';
    // scopes
    const sel = el('select', null, [['wave', 'Waveform'], ['parade', 'RGB parade'], ['vec', 'Vectorscope'], ['hist', 'Histogram']].map(([v, l]) => el('option', { value: v, text: l })));
    sel.value = mode;
    sel.addEventListener('change', () => { mode = sel.value; try { localStorage.setItem('dittoScope', mode); } catch (e) { /* ignore */ } refreshScope(true); });
    scopeCv = el('canvas', { width: SIZE.w, height: SIZE.h, class: 'scopecv' });
    root.appendChild(el('div', { class: 'scopebox' }, [el('div', { class: 'txbar' }, [el('span', { class: 'dim', text: 'Scopes (program output)' }), sel]), scopeCv]));
    if (!c) {
      root.appendChild(el('div', { class: 'bin-empty' }, [el('b', { text: 'Nothing to grade' }), el('div', { text: 'Select one video clip, picture or adjustment layer in the timeline to colour-correct it. Put the grade on an adjustment layer to colour everything below it.' })]));
      refreshScope(true);
      return;
    }
    const top = el('div', { class: 'txbar' }, [
      el('button', { class: 'btn', text: 'Auto tone', title: 'Sets exposure, whites and blacks from the picture\'s own histogram', onclick: () => autoTone(c) }),
      el('button', { class: 'btn', text: 'Reset grade', onclick: () => { S.checkpoint(); c.fx.color = null; S.change(true); build(true); } }),
      el('span', { class: 'dim', text: c.type === 'adjust' ? 'adjustment layer' : (S.media(c.media) || {}).name || '' })
    ]);
    root.appendChild(top);
    root.appendChild(sec('Basic correction', [
      slider(c, 'Exposure', 'exposure', -100, 100, 'Exposure (±100 = ±2 stops)'),
      slider(c, 'Temperature', 'temp', -100, 100, 'Cool ← → warm'),
      slider(c, 'Tint', 'tint', -100, 100, 'Green ← → magenta'),
      slider(c, 'Highlights', 'highlights', -100, 100),
      slider(c, 'Shadows', 'shadows', -100, 100),
      slider(c, 'Whites', 'whites', -100, 100),
      slider(c, 'Blacks', 'blacks', -100, 100),
      slider(c, 'Vibrance', 'vibrance', -100, 100, 'Boosts muted colours more than strong ones'),
      el('div', { class: 'note', text: 'Contrast, saturation and hue are in the Inspector under “Colour & effects”.' })
    ]));
    root.appendChild(sec('Curves', curvesEditor(c)));
    root.appendChild(sec('Colour wheels', [el('div', { class: 'wheels' }, [wheel(c, 'sh', 'Shadows'), wheel(c, 'mid', 'Midtones'), wheel(c, 'hi', 'Highlights')])]));
    syncs.forEach((f) => f());
    refreshScope(true);
  }

  S.on('select', () => { if (!root.classList.contains('hidden')) build(false); });
  S.on('change', () => { if (!root.classList.contains('hidden')) build(false); });
  S.on('load', () => { lastKey = null; if (!root.classList.contains('hidden')) build(true); });
  return { build, refreshScope, target, setMode: (m) => { mode = m; }, analysis: () => last };
})();
