'use strict';
/* Ditto Pro — per-track effect racks: a fader and the same effects a clip has (EQ, filters, compressor, noise reduction),
   applied to everything on the track after its clips are mixed together. */
const Rack = (() => {
  const row = (label, input, readout) => el('div', { class: 'row', style: 'grid-template-columns:170px 1fr 60px;align-items:center' }, [el('label', { text: label }), el('div', { class: 'ctl' }, [input]), readout]);
  function open(trackId) {
    const t = S.track(trackId);
    if (!t) return;
    if (!t.ae) t.ae = DS.clone(DS.DEFAULT_AE);
    if (!t.ae.echo) t.ae.echo = DS.clone(DS.DEFAULT_AE.echo);
    if (t.vol == null) t.vol = 0;
    const surround = DS.layoutOf(S.rootProject()) === '5.1';
    const syncs = [];
    const slider = (label, min, max, step, dec, get, set) => {
      const rng = el('input', { type: 'range', min, max, step }), num = el('span', { class: 'dim', style: 'text-align:right' });
      const show = () => { rng.value = get(); num.textContent = (+get()).toFixed(dec); };
      rng.addEventListener('input', () => { S.checkpoint('rack:' + trackId + label); set(parseFloat(rng.value)); show(); S.change(); });
      rng.addEventListener('dblclick', () => { S.checkpoint(); set(+min <= 0 && +max >= 0 ? 0 : get()); show(); S.change(); });
      syncs.push(show); show();
      return row(label, rng, num);
    };
    const check = (label, get, set) => {
      const cb = el('input', { type: 'checkbox' }); cb.checked = !!get();
      cb.addEventListener('change', () => { S.checkpoint(); set(cb.checked); S.change(true); });
      return el('label', { class: 'chk', style: 'margin:6px 0 0 170px' }, [cb, el('span', { text: label })]);
    };
    const ae = t.ae;
    const body = [
      el('p', { class: 'dim', text: 'Everything on ' + t.name + ' is mixed together first, then goes through this fader and these effects — in the preview and on export. Double-click a slider to reset it.' }),
      slider('Fader (dB)', -60, 12, 0.5, 1, () => t.vol, (v) => { t.vol = v; }),
      slider('Noise reduction (dB, export only)', 0, 40, 1, 0, () => ae.denoise, (v) => { ae.denoise = v; }),
      slider('High-pass (Hz)', 0, 1000, 5, 0, () => ae.hp, (v) => { ae.hp = v; }),
      slider('Low-pass (Hz)', 1000, 20000, 100, 0, () => ae.lp, (v) => { ae.lp = v; }),
      slider('Bass (dB)', -18, 18, 0.5, 1, () => ae.low, (v) => { ae.low = v; }),
      slider('Mid (dB)', -18, 18, 0.5, 1, () => ae.mid, (v) => { ae.mid = v; }),
      slider('Treble (dB)', -18, 18, 0.5, 1, () => ae.high, (v) => { ae.high = v; })
    ];
    if (!surround) body.push(slider('Pan (L–R)', -100, 100, 1, 0, () => ae.pan, (v) => { ae.pan = v; }));
    body.push(
      check('Compressor', () => ae.comp.on, (v) => { ae.comp.on = v; }),
      slider('Threshold (dB)', -60, 0, 1, 0, () => ae.comp.thresh, (v) => { ae.comp.thresh = v; }),
      slider('Ratio', 1, 20, 0.5, 1, () => ae.comp.ratio, (v) => { ae.comp.ratio = v; }),
      slider('Attack (ms)', 1, 200, 1, 0, () => ae.comp.attack, (v) => { ae.comp.attack = v; }),
      slider('Release (ms)', 10, 1000, 5, 0, () => ae.comp.release, (v) => { ae.comp.release = v; }),
      slider('Make-up (dB)', 0, 24, 0.5, 1, () => ae.comp.makeup, (v) => { ae.comp.makeup = v; }),
      check('Echo', () => ae.echo.on, (v) => { ae.echo.on = v; }),
      slider('Echo delay (ms)', 20, 1000, 5, 0, () => ae.echo.delay, (v) => { ae.echo.delay = v; }),
      slider('Echo strength (%)', 1, 90, 1, 0, () => ae.echo.decay, (v) => { ae.echo.decay = v; })
    );
    modal({
      title: 'Track mixer — ' + t.name, width: 560, body,
      buttons: [
        { label: 'Reset', onClick: () => { S.checkpoint(); t.vol = 0; t.ae = DS.clone(DS.DEFAULT_AE); S.change(true); open(trackId); return true; } },
        { label: 'Done', primary: true, onClick: () => { S.change(true); } }
      ]
    });
  }
  return { open };
})();
