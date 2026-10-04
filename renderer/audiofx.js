'use strict';
/* Ditto Pro — Web Audio chain for the preview. Mirrors DS.aeFilters (the FFmpeg export chain). */
const AudioFx = (() => {
  let shared = null;
  function context() {
    if (!shared) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) shared = new AC({ latencyHint: 'interactive' }); }
    return shared;
  }

  // Builds   input -> hp -> lp -> low -> mid -> high -> compressor -> echo -> pan -> gain -> output
  // `ctx` may be an AudioContext or an OfflineAudioContext. Returns { input, output, update(ae, linearGain) }.
  function build(ctx) {
    const mk = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q != null) b.Q.value = q; return b; };
    // biquad Q for highpass/lowpass is in dB in Web Audio: -3.01 dB = Butterworth (Q 0.707), as FFmpeg uses
    const hp = mk('highpass', 20, -3.0103), lp = mk('lowpass', 20000, -3.0103);
    const low = mk('lowshelf', 150), mid = mk('peaking', 1000, 1), high = mk('highshelf', 6000);
    const comp = ctx.createDynamicsCompressor();
    const undoAuto = ctx.createGain();       // Chromium adds automatic make-up gain to its compressor; cancel it
    const makeup = ctx.createGain();
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    // 2x2 mixing matrix after the effects: normally plain left/right pan gains, in a 5.1 project the stereo downmix of the placement
    const gLL = ctx.createGain(), gRL = ctx.createGain(), gLR = ctx.createGain(), gRR = ctx.createGain();
    const out = ctx.createGain();
    const input = ctx.createGain();
    input.channelCount = 2; input.channelCountMode = 'explicit'; input.channelInterpretation = 'speakers';
    input.connect(hp); hp.connect(lp); lp.connect(low); low.connect(mid); mid.connect(high); high.connect(comp);
    // echo: the dry sound plus three delayed repeats (feed-forward, exactly what the export's aecho does)
    const echoSum = ctx.createGain();
    const taps = [0, 1, 2].map(() => { const d = ctx.createDelay(3.2), g = ctx.createGain(); g.gain.value = 0; makeup.connect(d); d.connect(g); g.connect(echoSum); return { d, g }; });
    comp.connect(undoAuto); undoAuto.connect(makeup); makeup.connect(echoSum); echoSum.connect(split);
    split.connect(gLL, 0); split.connect(gLR, 0); split.connect(gRL, 1); split.connect(gRR, 1);
    gLL.connect(merge, 0, 0); gRL.connect(merge, 0, 0); gLR.connect(merge, 0, 1); gRR.connect(merge, 0, 1);
    merge.connect(out);
    comp.knee.value = 3;

    function update(ae, gain, surround) {
      ae = ae || DS.DEFAULT_AE;
      const c = ae.comp || DS.DEFAULT_AE.comp;
      const set = (p, v) => { if (p.value !== v) p.value = v; };
      set(hp.frequency, ae.hp > 20 ? ae.hp : 10);          // 10 Hz highpass is inaudible = off
      set(lp.frequency, Math.min(ae.lp || 20000, ctx.sampleRate / 2 - 100));
      set(low.gain, ae.low || 0); set(mid.gain, ae.mid || 0); set(high.gain, ae.high || 0);
      if (c.on) {
        set(comp.threshold, DS.clamp(c.thresh, -100, 0)); set(comp.ratio, DS.clamp(c.ratio, 1, 20));
        set(comp.attack, DS.clamp(c.attack / 1000, 0, 1)); set(comp.release, DS.clamp(c.release / 1000, 0, 1));
        const T = DS.clamp(c.thresh, -100, 0), R = DS.clamp(c.ratio, 1, 20);
        const full = Math.pow(10, (T - T / R) / 20);          // compressor output at 0 dBFS
        set(undoAuto.gain, Math.pow(full, 0.6));
        set(makeup.gain, Math.pow(10, (c.makeup || 0) / 20));
      } else {
        set(comp.threshold, 0); set(comp.ratio, 1); set(undoAuto.gain, 1); set(makeup.gain, 1);
      }
      const et = DS.echoTaps(ae);
      taps.forEach((t, i) => { const e = et[i]; set(t.g.gain, e ? e.gain : 0); if (e) set(t.d.delayTime, e.ms / 1000); });
      if (surround) { const d = DS.surroundDownmix(ae); set(gLL.gain, d.LL); set(gRL.gain, d.RL); set(gLR.gain, d.LR); set(gRR.gain, d.RR); }
      else { const g = DS.panGains(ae.pan || 0); set(gLL.gain, g.l); set(gRL.gain, 0); set(gLR.gain, 0); set(gRR.gain, g.r); }
      set(out.gain, gain);
    }
    return { input, output: out, update };
  }

  // ---- master: everything the preview plays passes through here on its way to the speakers, so it can be metered
  let mst = null;
  function master() {
    const ctx = context();
    if (!ctx) return null;
    if (!mst) {
      const g = ctx.createGain(), split = ctx.createChannelSplitter(2);
      g.channelCount = 2; g.channelCountMode = 'explicit';
      const an = [0, 1].map((i) => { const a = ctx.createAnalyser(); a.fftSize = 1024; split.connect(a, i); return a; });
      g.connect(ctx.destination); g.connect(split);
      mst = { g, an, buf: new Float32Array(1024) };
    }
    return mst.g;
  }
  /** peak level of the left and right channel right now, in dBFS (−Infinity when silent or before anything has played) */
  function levels() {
    if (!mst) return [-Infinity, -Infinity];
    return mst.an.map((a) => { a.getFloatTimeDomainData(mst.buf); let p = 0; for (let i = 0; i < mst.buf.length; i++) { const v = Math.abs(mst.buf[i]); if (v > p) p = v; } return p > 0 ? 20 * Math.log10(p) : -Infinity; });
  }

  // Attach a chain to a media element (once per element — the browser allows only one source node per element).
  function attach(el) {
    const ctx = context();
    if (!ctx || el._dittoFx) return el._dittoFx || null;
    try {
      const src = ctx.createMediaElementSource(el);
      const fx = build(ctx);
      src.connect(fx.input); fx.output.connect(master());
      el._dittoFx = fx;
      el.volume = 1;
      return fx;
    } catch (e) { return null; }
  }
  // ---- track racks: a clip's sound goes through its track's own chain (fader + effects) when that track has one
  const buses = new Map();
  function bus(id) {
    const ctx = context();
    if (!ctx) return null;
    let b = buses.get(id);
    if (!b) { b = build(ctx); b.output.connect(master()); buses.set(id, b); }
    return b;
  }
  function route(fx, track, surround) {
    const ctx = context();
    if (!fx || !ctx) return;
    const want = track && DS.rackActive(track) ? bus(track.id) : null;
    if (fx._dest !== want) {
      try { fx.output.disconnect(); } catch (e) { /* not connected yet */ }
      fx.output.connect(want ? want.input : master());
      fx._dest = want;
    }
    if (want) want.update(track.ae, Math.pow(10, (track.vol || 0) / 20), surround);
  }
  function resume() { const c = shared; if (c && c.state === 'suspended') c.resume().catch(() => {}); }

  return { context, build, attach, resume, route, bus, master, levels };
})();
