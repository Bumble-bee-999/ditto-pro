'use strict';
/* Ditto Pro — live multicam grid: every camera angle in its own tile, the live one outlined; click a tile to cut to it. */
const MCGrid = (() => {
  const host = $('#mcGrid');
  let on = false;
  const tiles = new Map(); // angle -> { wrap, canvas, ctx, video, url, label }

  const group = () => { const g = S.multicamGroups(); return g.length ? g[g.length - 1] : null; };
  const clipFor = (g, angle, t) => g.clips.find((c) => c.mc.angle === angle && t >= c.start - 1e-6 && t < DS.clipEnd(c) - 1e-6) || null;

  function makeTile(angle) {
    const canvas = el('canvas', { width: 320, height: 180 });
    const label = el('div', { class: 'mclabel', text: String(angle) });
    const wrap = el('div', { class: 'mctile', title: 'Cut to camera ' + angle + ' (key ' + angle + ')' }, [canvas, label]);
    wrap.addEventListener('click', () => { if (typeof AI !== 'undefined') AI.MC.switchTo(angle); });
    const t = { wrap, canvas, ctx: canvas.getContext('2d'), video: null, url: null, label };
    host.appendChild(wrap);
    return t;
  }
  function dropTile(angle) {
    const t = tiles.get(angle); if (!t) return;
    if (t.video) { try { t.video.pause(); t.video.removeAttribute('src'); t.video.load(); } catch (e) { /* ignore */ } }
    t.wrap.remove(); tiles.delete(angle);
  }
  function ensure(g) {
    const angles = Array.from(g.angles).sort((a, b) => a - b);
    for (const a of Array.from(tiles.keys())) if (!angles.includes(a)) dropTile(a);
    angles.forEach((a) => { if (!tiles.has(a)) tiles.set(a, makeTile(a)); });
    // keep DOM order = angle order
    angles.forEach((a) => host.appendChild(tiles.get(a).wrap));
    return angles;
  }

  function videoFor(t, m) {
    const url = m && m.previewUrl;
    if (!url) return null;
    if (!t.video || t.url !== url) {
      if (t.video) { try { t.video.pause(); t.video.removeAttribute('src'); t.video.load(); } catch (e) { /* ignore */ } }
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.playsInline = true; v.crossOrigin = 'anonymous'; v.src = url;
      v.addEventListener('seeked', () => update()); v.addEventListener('loadeddata', () => update());
      t.video = v; t.url = url;
    }
    return t.video;
  }

  function update() {
    if (!on) return;
    const g = group();
    if (!g) { host.classList.add('hidden'); return; }
    host.classList.remove('hidden');
    const angles = ensure(g);
    const now = S.playhead, live = S.multicamAngleAt(g.id, now);
    angles.forEach((a) => {
      const t = tiles.get(a);
      t.wrap.classList.toggle('live', a === live);
      const c = clipFor(g, a, now), m = c && S.media(c.media);
      const ctx = t.ctx, W = t.canvas.width, H = t.canvas.height;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      if (!c || !m || m.missing) { t.label.textContent = a + (c ? '' : ' — no footage here'); return; }
      t.label.textContent = String(a);
      const v = videoFor(t, m);
      if (!v) return;
      const want = DS.clamp(c.in + (now - c.start) * (c.speed || 1), 0, Math.max(0, m.duration - 0.04));
      if (S.playing) {
        v.playbackRate = DS.clamp(c.speed || 1, 0.0625, 16);
        if (v.paused) { try { v.currentTime = want; } catch (e) { /* ignore */ } v.play().catch(() => {}); }
        else if (Math.abs(v.currentTime - want) > 0.3) { try { v.currentTime = want; } catch (e) { /* ignore */ } }
      } else {
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - want) > S.frame() * 0.45) { try { v.currentTime = want; } catch (e) { /* ignore */ } }
      }
      if (v.readyState >= 2 && v.videoWidth) {
        const k = Math.min(W / v.videoWidth, H / v.videoHeight), w = v.videoWidth * k, h = v.videoHeight * k;
        ctx.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
      }
    });
  }
  function pauseAll() { tiles.forEach((t) => { if (t.video && !t.video.paused) t.video.pause(); }); }
  function setOn(v) {
    on = !!v;
    host.classList.toggle('hidden', !on || !group());
    if (!on) { pauseAll(); Array.from(tiles.keys()).forEach(dropTile); }
    else update();
    if (typeof AI !== 'undefined') AI.MC.render();
  }

  S.on('time', update); S.on('change', update); S.on('load', () => { Array.from(tiles.keys()).forEach(dropTile); update(); });
  S.on('transport', () => { if (!S.playing) pauseAll(); update(); });
  return { toggle: () => setOn(!on), isOn: () => on, setOn, update, tileCount: () => tiles.size };
})();
