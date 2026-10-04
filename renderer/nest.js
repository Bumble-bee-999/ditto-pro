'use strict';
/* Ditto Pro — nested sequences. A nest is rendered (ProRes 4444 with alpha) to a cache file, which the editor then
   treats like any other media file: that gives nests full transform / effect / keyframe support and exact export parity. */
const Nest = (() => {
  const state = {};   // nestId -> { hash, path, proxyHash }
  const jobs = {};    // nestId -> Promise

  function fnv(str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 + c, 2246822519) >>> 0; h2 = (h2 ^ (h2 >>> 13)) >>> 0; }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }
  const root = () => S.rootProject();
  const nestOf = (id) => root().nests[id];
  const innerNests = (n) => Array.from(new Set(n.clips.filter((c) => c.type === 'media').map((c) => (root().media.find((m) => m.id === c.media) || {}).nest).filter(Boolean)));

  function hashOf(id) {
    const r = root(), n = nestOf(id);
    const media = r.media;
    const parts = n.clips.map((c) => {
      const m = c.type === 'media' ? media.find((x) => x.id === c.media) : null;
      return JSON.stringify(c) + '|' + (m ? (m.nest ? 'nest:' + hashOf(m.nest) : m.path) : '');
    });
    return fnv(JSON.stringify({ w: r.width, h: r.height, f: r.fps, t: n.tracks.map((t) => [t.id, t.type, t.mute, t.hidden]) }) + parts.join('\n'));
  }

  function payloadFor(id) {
    const r = root(), n = nestOf(id);
    const payload = DS.clone({ v: 1, name: n.name, width: r.width, height: r.height, fps: r.fps, tracks: n.tracks, clips: n.clips, markers: [], workArea: {} });
    payload.media = r.media.map((m) => ({ id: m.id, path: m.nest ? ((state[m.nest] && state[m.nest].path) || '') : m.path, name: m.name, kind: m.kind, duration: m.duration, hasAudio: m.hasAudio, missing: !!m.missing }));
    const titles = {};
    n.clips.filter((c) => c.type === 'title').forEach((c) => { titles[c.id] = Player.titleCanvas(c).toDataURL('image/png'); });
    return { payload, titles };
  }

  // Renders (or reuses) the full-quality cache for a nest; resolves when m.path points at a fresh file.
  function render(id) {
    if (jobs[id]) return jobs[id];
    const job = (async () => {
      const n = nestOf(id);
      if (!n) throw new Error('Nested sequence not found.');
      for (const inner of innerNests(n)) await render(inner);
      const hash = hashOf(id);
      const m = S.nestMedia(id);
      const st = state[id] || (state[id] = {});
      if (st.hash === hash && st.path) { if (m) m.path = st.path; return st; }
      const { payload, titles } = payloadFor(id);
      const res = await window.ditto.renderNest({ hash, payload, titles });
      if (!res.ok) throw new Error(res.error || 'Could not render the nested sequence.');
      st.hash = hash; st.path = res.path;
      if (m) m.path = res.path;
      return st;
    })().finally(() => { delete jobs[id]; });
    jobs[id] = job;
    return job;
  }

  // Makes sure the preview has a (small, alpha-capable) copy of the nest
  const pending = {};
  async function refresh(id) {
    const m = S.nestMedia(id);
    if (!m || !nestOf(id)) return;
    if (pending[id]) { pending[id].again = true; return; }
    pending[id] = { again: false };
    try {
      const hashNow = hashOf(id);
      const st = state[id] || (state[id] = {});
      if (st.proxyHash === hashNow && m.previewUrl) return;
      m.previewUrl = null; m.proxyState = 'working'; S.emit('proxy'); Player.requestRender();
      const r = await render(id);
      const px = await window.ditto.nestProxy({ hash: r.hash, path: r.path });
      if (px.ok) { m.previewUrl = px.url; m.proxyState = 'ready'; st.proxyHash = r.hash; }
      else { m.proxyState = 'error'; toast('Could not prepare a preview of "' + m.name + '": ' + (px.error || '').split('\n').pop(), 'err'); }
      S.rootProject().clips.concat(Object.values(root().nests).reduce((a, n) => a.concat(n.clips), [])).filter((c) => c.media === m.id).forEach((c) => Player.disposeClip(c));
      S.emit('proxy'); Player.requestRender();
    } catch (e) {
      m.proxyState = 'error'; m.proxyError = e.message; console.warn('nest refresh failed: ' + e.message); S.emit('proxy');
      toast('Nested sequence failed: ' + e.message, 'err', 8000);
    } finally {
      const again = pending[id] && pending[id].again;
      delete pending[id];
      if (again) refresh(id);
    }
  }

  // every nest the root project uses (directly or through other nests)
  function usedNests() {
    const r = root(), out = new Set();
    const visit = (clips) => clips.forEach((c) => { const m = c.type === 'media' ? r.media.find((x) => x.id === c.media) : null; if (m && m.nest && !out.has(m.nest)) { out.add(m.nest); const n = r.nests[m.nest]; if (n) visit(n.clips); } });
    visit(r.clips);
    return Array.from(out);
  }
  async function ensureAll() {
    S.commitNest();
    const ids = usedNests();
    for (const id of ids) await render(id);
    return ids.length;
  }

  S.on('nest', (id) => { refresh(id); });
  // previews of every nest that has none yet. After a project file is opened this waits until the app has looked for the
  // media (S.mediaChecked): a moved project's files are relinked first, so a nest is never rendered from stale paths.
  function refreshAll() { if (S.nestStack.length || S.mediaChecked === false) return; Object.keys(root().nests || {}).forEach((id) => { if (S.nestMedia(id) && !S.nestMedia(id).previewUrl) refresh(id); }); }
  S.on('load', refreshAll);

  // ---- navigation bar
  const bar = $('#nestBar');
  function renderBar() {
    bar.classList.toggle('hidden', !S.nestStack.length);
    if (!S.nestStack.length) return;
    bar.innerHTML = '';
    bar.appendChild(el('button', { class: 'btn', text: '◀ Back to ' + S.nestStack[S.nestStack.length - 1].project.name, onclick: () => S.exitNest() }));
    bar.appendChild(el('span', { class: 'dim', text: 'Editing nested sequence: ' + S.project.name }));
  }
  S.on('nestnav', renderBar);

  function nestSelected() {
    const sel = S.selClips();
    if (!sel.length) return toast('Select the clips you want to nest first.', 'err');
    const id = S.nestSelection();
    if (id) toast('Nested ' + sel.length + ' clip' + (sel.length > 1 ? 's' : '') + '. Double-click it (or right-click → Open nested sequence) to edit inside.', 'ok', 4500);
  }
  function openSelected() {
    const c = S.selClips()[0];
    const m = c && c.type === 'media' ? S.media(c.media) : null;
    if (!m || !m.nest) return toast('Select a nested sequence clip first.', 'err');
    S.enterNest(m.nest);
  }
  return { render, refresh, refreshAll, ensureAll, hashOf, nestSelected, openSelected, usedNests };
})();
