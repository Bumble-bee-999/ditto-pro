'use strict';
/* Ditto Pro — transcript panel: read the speech as text, click a word to jump there, and delete words to cut that
   moment out of the picture and sound together (text-based editing). Works on the caption clips on the timeline. */
const Transcript = (() => {
  const root = $('#tab-tx');
  let sel = new Set();          // word keys "clipId:index"
  let anchor = null;            // last clicked key (for shift-select)
  let query = '', hits = [], hitPos = -1;
  let editing = null;
  const FILLER = /^(u+m+|u+h+|e+r+m*|a+h+|h+m+|m+h*m+|uh+m+)[.,!?;:]*$/i;

  // ---- model: flat list of lines, each with words in timeline time
  function lines() {
    return S.captionClips().map((c) => {
      const words = (c.words && c.words.length ? c.words : [{ s: 0, e: c.dur, w: c.title.text }]).map((w, i) => ({ key: c.id + ':' + i, i, t0: c.start + w.s, t1: c.start + w.e, text: w.w, clip: c }));
      return { clip: c, words };
    });
  }
  const allWords = () => lines().reduce((a, l) => a.concat(l.words), []);

  function render() {
    if (root.classList.contains('hidden') && !arguments[0]) return;
    root.innerHTML = '';
    const L = lines();
    const bar = el('div', { class: 'txbar' }, [
      el('button', { class: 'btn', text: 'Transcribe…', title: 'Turn the speech in the selected clips into text', onclick: () => AI.generateCaptions() }),
      el('button', { class: 'btn', text: 'Import captions', onclick: () => AI.importCaptions() }),
      el('button', { class: 'btn', text: 'Export .srt', disabled: !L.length, onclick: () => AI.exportCaptions() }),
      el('button', { class: 'btn', text: 'Copy text', disabled: !L.length, onclick: copyText })
    ]);
    root.appendChild(bar);
    if (!L.length) {
      root.appendChild(el('div', { class: 'bin-empty' }, [
        el('b', { text: 'No transcript yet' }),
        el('div', { text: 'Select clips that contain speech and click Transcribe (it runs on this computer), or import an .srt file. Then edit the video by deleting words here.' })
      ]));
      return;
    }
    const bar2 = el('div', { class: 'txbar' });
    const search = el('input', { type: 'search', placeholder: 'Find in transcript…', value: query, style: 'flex:1;min-width:0' });
    search.addEventListener('input', () => { query = search.value; updateHits(); markHits(); });
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nextHit(e.shiftKey ? -1 : 1); } e.stopPropagation(); });
    bar2.appendChild(search);
    bar2.appendChild(el('button', { class: 'btn', text: 'Select um / uh', title: 'Select every filler sound', onclick: selectFillers }));
    root.appendChild(bar2);
    const act = el('div', { class: 'txbar' }, [
      el('button', { class: 'primary', id: 'txCut', text: 'Cut selected from video', disabled: !sel.size, title: 'Removes the selected words, closing the gap on every track (Delete)', onclick: cutSelected }),
      el('span', { class: 'dim', id: 'txCount', text: sel.size ? sel.size + ' word' + (sel.size > 1 ? 's' : '') + ' selected' : 'Click a word to jump · Shift-click to select a range' })
    ]);
    root.appendChild(act);
    const body = el('div', { class: 'txbody', tabindex: '0' });
    body.addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size && !editing) { e.preventDefault(); e.stopPropagation(); cutSelected(); }
      if (e.key === 'Escape') { sel.clear(); refreshSel(); }
    });
    L.forEach((ln) => {
      const row = el('div', { class: 'txline', 'data-clip': ln.clip.id });
      row.appendChild(el('span', { class: 'txtime', text: DS.fmtTC(ln.clip.start, S.project.fps).slice(3, 8), title: 'Jump here', onclick: () => { Player.stop(); S.seek(ln.clip.start); } }));
      const txt = el('span', { class: 'txwords' });
      ln.words.forEach((w) => {
        const sp = el('span', { class: 'txw', 'data-key': w.key, text: w.text });
        sp.addEventListener('click', (e) => onWord(e, w));
        txt.appendChild(sp); txt.appendChild(document.createTextNode(' '));
      });
      row.appendChild(txt);
      row.appendChild(el('button', { class: 'ibtn txedit', title: 'Fix the wording', html: '✎', onclick: () => editLine(ln, row) }));
      body.appendChild(row);
    });
    root.appendChild(body);
    refreshSel(); markHits(); follow(true);
  }

  function onWord(e, w) {
    const flat = allWords();
    if (e.shiftKey && anchor) {
      const a = flat.findIndex((x) => x.key === anchor), b = flat.findIndex((x) => x.key === w.key);
      if (a >= 0 && b >= 0) { sel.clear(); flat.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => sel.add(x.key)); }
    } else if (e.ctrlKey || e.metaKey) {
      if (sel.has(w.key)) sel.delete(w.key); else sel.add(w.key);
      anchor = w.key;
    } else {
      sel.clear(); sel.add(w.key); anchor = w.key;
      Player.stop(); S.seek(w.t0);
    }
    refreshSel();
  }
  function refreshSel() {
    $$('.txw', root).forEach((n) => n.classList.toggle('sel', sel.has(n.dataset.key)));
    const cut = $('#txCut', root), cnt = $('#txCount', root);
    if (cut) cut.disabled = !sel.size;
    if (cnt) cnt.textContent = sel.size ? sel.size + ' word' + (sel.size > 1 ? 's' : '') + ' selected' : 'Click a word to jump · Shift-click to select a range';
  }

  // ---- cutting
  // selected words -> timeline ranges (neighbouring words are merged; a little air is kept so the cut doesn't clip speech)
  function rangesFor(keys) {
    const flat = allWords().sort((a, b) => a.t0 - b.t0);
    const picked = flat.filter((w) => keys.has(w.key));
    const out = [];
    picked.forEach((w) => {
      const idx = flat.indexOf(w);
      const prev = flat[idx - 1], next = flat[idx + 1];
      const t0 = Math.max(w.t0 - 0.02, prev && !keys.has(prev.key) ? prev.t1 : 0);
      const t1 = next && !keys.has(next.key) ? Math.min(w.t1 + 0.12, Math.max(w.t1, next.t0)) : w.t1 + 0.05;
      const last = out[out.length - 1];
      if (last && t0 <= last.t1 + 0.35) last.t1 = Math.max(last.t1, t1); else out.push({ t0, t1 });
    });
    return out;
  }
  function cutSelected() {
    if (!sel.size) return;
    Player.stop();
    const ranges = rangesFor(sel);
    const removed = S.extractRanges(ranges);
    sel.clear(); anchor = null;
    toast(removed > 0 ? 'Cut ' + removed.toFixed(1) + ' s from the timeline (Ctrl+Z undoes it).' : 'Nothing to cut.', removed > 0 ? 'ok' : undefined);
  }
  function selectFillers() {
    sel.clear();
    allWords().forEach((w) => { if (FILLER.test(w.text.trim())) sel.add(w.key); });
    refreshSel();
    toast(sel.size ? 'Selected ' + sel.size + ' filler word' + (sel.size > 1 ? 's' : '') + '. Press Delete (or "Cut selected") to remove them.' : 'No um / uh found.');
  }

  // ---- fixing wording
  function editLine(ln, row) {
    if (editing) return;
    editing = ln;
    const c = ln.clip;
    const inp = el('input', { type: 'text', value: c.title.text, style: 'flex:1;min-width:0' });
    const holder = el('span', { class: 'txwords' }, [inp]);
    const old = row.querySelector('.txwords');
    row.replaceChild(holder, old);
    inp.focus(); inp.select();
    const done = (save) => {
      if (!editing) return;
      editing = null;
      const v = inp.value.replace(/\s+/g, ' ').trim();
      if (save && v && v !== c.title.text) {
        S.checkpoint();
        const toks = v.split(' ');
        if (c.words && c.words.length === toks.length) c.words.forEach((w, i) => { w.w = toks[i]; });
        else if (c.words && c.words.length) { // wording changed length: spread the words evenly over the line
          const n = toks.length, d = c.dur / n; c.words = toks.map((t, i) => ({ s: i * d, e: (i + 1) * d, w: t }));
        }
        c.title.text = v; c.label = v.slice(0, 40);
        S.change();
      }
      render(true);
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
  }

  // ---- search
  function updateHits() {
    hits = []; hitPos = -1;
    const q = query.trim().toLowerCase();
    if (q) allWords().forEach((w) => { if (w.text.toLowerCase().includes(q)) hits.push(w.key); });
  }
  function markHits() {
    const set = new Set(hits);
    $$('.txw', root).forEach((n) => n.classList.toggle('hit', set.has(n.dataset.key)));
  }
  function nextHit(dir) {
    if (!hits.length) return;
    hitPos = (hitPos + dir + hits.length) % hits.length;
    const w = allWords().find((x) => x.key === hits[hitPos]);
    if (w) { Player.stop(); S.seek(w.t0); const n = root.querySelector('[data-key="' + CSS.escape(w.key) + '"]'); if (n) n.scrollIntoView({ block: 'center' }); }
  }

  function copyText() {
    const text = lines().map((l) => l.clip.title.text).join('\n');
    const ta = el('textarea', { style: 'position:fixed;left:-9999px' }); ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
    toast(ok ? 'Transcript copied.' : 'Could not copy.', ok ? 'ok' : 'err');
  }

  // ---- follow the playhead
  let lastCur = null;
  function follow(force) {
    if (root.classList.contains('hidden')) return;
    const t = S.playhead;
    const w = allWords().find((x) => t >= x.t0 - 1e-3 && t < x.t1 + 1e-3);
    const key = w ? w.key : null;
    if (key === lastCur && !force) return;
    lastCur = key;
    $$('.txw.cur', root).forEach((n) => n.classList.remove('cur'));
    if (key) {
      const n = root.querySelector('[data-key="' + CSS.escape(key) + '"]');
      if (n) { n.classList.add('cur'); if (S.playing) n.scrollIntoView({ block: 'nearest' }); }
    }
  }

  S.on('change', (structural) => { if (structural && !editing) render(); else if (!editing) follow(); });
  S.on('load', () => { sel.clear(); anchor = null; render(); });
  S.on('time', () => follow());
  render(true);
  return { render, selectFillers, cutSelected, rangesFor, lines, state: () => ({ sel, hits }) };
})();
