/*
 * Ditto Pro — shared model helpers.
 * Loaded by the renderer (as window.DS) and required by the exporter (Node).
 * Everything here is pure: no DOM, no Node APIs, except drawTitle() which
 * takes a canvas 2D context supplied by the caller.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PROPS = ['x', 'y', 'scale', 'rot', 'opacity'];
  // effect values that can be animated (the others have no time-varying FFmpeg filter): keyframes live in c.kf like the transform's
  const FXPROPS = ['brightness', 'contrast', 'saturation', 'hue', 'vignette'];
  // the clip's volume (dB) can be animated too ("rubber band")
  const AUDIOPROPS = ['vol'];
  const ALLPROPS = PROPS.concat(FXPROPS, AUDIOPROPS);
  const baseOf = (c, p) => (p === 'vol' ? (c.vol || 0) : PROPS.includes(p) ? c.tf[p] : c.fx[p]);
  const setBase = (c, p, v) => { if (p === 'vol') c.vol = v; else if (PROPS.includes(p)) c.tf[p] = v; else c.fx[p] = v; };
  const VOLRANGE = [-60, 24];
  /** the clip's volume in dB at clip-local time lt */
  const volAt = (c, lt) => (c.kf && c.kf.vol && c.kf.vol.length ? Math.max(VOLRANGE[0], Math.min(VOLRANGE[1], kfEval(c.kf.vol, lt, c.vol || 0))) : (c.vol || 0));
  const FXRANGE = { brightness: [-100, 100], contrast: [-100, 100], saturation: [0, 400], hue: [-360, 360], vignette: [0, 100] };
  /** the effect values of a clip at clip-local time lt (the stored fx when nothing is animated) */
  function fxAt(c, lt) {
    if (!c.kf || !FXPROPS.some((p) => c.kf[p] && c.kf[p].length)) return c.fx;
    const o = Object.assign({}, c.fx);
    for (const p of FXPROPS) if (c.kf[p] && c.kf[p].length) o[p] = Math.max(FXRANGE[p][0], Math.min(FXRANGE[p][1], kfEval(c.kf[p], lt, c.fx[p])));
    return o;
  }
  /** keyframes of an untrusted clip: only known properties, finite numbers, sorted, capped */
  function cleanKf(kf) {
    const out = {};
    for (const p of ALLPROPS) {
      const l = kf && Array.isArray(kf[p]) ? kf[p] : [];
      out[p] = l.filter((k) => k && Number.isFinite(+k.t) && Number.isFinite(+k.v)).slice(0, 2000).map((k) => ({ t: +k.t, v: +k.v, e: k.e === 'ease' || k.e === 'hold' ? k.e : 'lin' })).sort((a, b) => a.t - b.t);
    }
    return out;
  }
  const DEFAULT_TF = { x: 0, y: 0, scale: 100, rot: 0, opacity: 100 };
  const DEFAULT_FX = {
    brightness: 0, contrast: 0, saturation: 100, hue: 0, blur: 0,
    sharpen: 0, vignette: 0, gray: false, sepia: false,
    flipH: false, flipV: false, lut: null,
    color: null,   // colour grade (see grade.js); null = untouched
    // creative effects (all 0 / false = off)
    invert: false, posterize: 0, threshold: 0, mosaic: 0, grain: 0, emboss: false, edges: false, rgbsplit: 0,
    lumakey: { on: false, threshold: 0, tolerance: 20, softness: 10 },   // keys out the luma band threshold ± tolerance (percent)
    glow: { amount: 0, size: 4, threshold: 60 },
    crop: { l: 0, t: 0, r: 0, b: 0 },
    chroma: { on: false, color: '#00ff00', sim: 30, blend: 10 },
    // shape mask on the clip's own picture (percent of the picture, after cropping); `path` = tracked centre, clip time
    mask: { on: false, shape: 'ellipse', cx: 50, cy: 50, w: 50, h: 50, feather: 10, invert: false, path: null }
  };

  // ---- effect values from untrusted places (project files, imports, the page) -> plain numbers in range.
  // The export puts these numbers into an FFmpeg filter script, so a string like "0:enable=…" must never get through.
  const cn = (v, lo, hi, d) => { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const cb = (v) => v === true || v === 1 || v === 'true';
  function cleanFx(fx) {
    fx = fx && typeof fx === 'object' ? fx : {};
    const D = DEFAULT_FX, o = {};
    o.brightness = cn(fx.brightness, -100, 100, 0); o.contrast = cn(fx.contrast, -100, 100, 0); o.saturation = cn(fx.saturation, 0, 400, 100);
    o.hue = cn(fx.hue, -360, 360, 0); o.blur = cn(fx.blur, 0, 100, 0); o.sharpen = cn(fx.sharpen, 0, 100, 0); o.vignette = cn(fx.vignette, 0, 100, 0);
    o.gray = cb(fx.gray); o.sepia = cb(fx.sepia); o.flipH = cb(fx.flipH); o.flipV = cb(fx.flipV);
    o.invert = cb(fx.invert); o.emboss = cb(fx.emboss); o.edges = o.emboss ? false : cb(fx.edges);   // relief and edge detection are alternatives
    const pz = Math.round(cn(fx.posterize, 0, 32, 0)); o.posterize = pz < 2 ? 0 : pz;
    o.threshold = cn(fx.threshold, 0, 100, 0); o.mosaic = Math.round(cn(fx.mosaic, 0, 200, 0)); o.grain = cn(fx.grain, 0, 100, 0);
    o.rgbsplit = Math.round(cn(fx.rgbsplit, 0, 60, 0));
    const lk = fx.lumakey && typeof fx.lumakey === 'object' ? fx.lumakey : {};
    o.lumakey = { on: cb(lk.on), threshold: cn(lk.threshold, 0, 100, 0), tolerance: cn(lk.tolerance, 0, 100, 20), softness: cn(lk.softness, 0, 100, 10) };
    const g = fx.glow && typeof fx.glow === 'object' ? fx.glow : {};
    o.glow = { amount: cn(g.amount, 0, 100, 0), size: cn(g.size, 1, 20, 4), threshold: cn(g.threshold, 0, 99, 60) };
    const l = fx.lut && typeof fx.lut === 'object' && typeof fx.lut.path === 'string' ? fx.lut : null;
    o.lut = l ? { path: l.path, name: typeof l.name === 'string' ? l.name.slice(0, 200) : '' } : null;
    const cr = fx.crop && typeof fx.crop === 'object' ? fx.crop : {};
    o.crop = { l: cn(cr.l, 0, 95, 0), t: cn(cr.t, 0, 95, 0), r: cn(cr.r, 0, 95, 0), b: cn(cr.b, 0, 95, 0) };
    const ch = fx.chroma && typeof fx.chroma === 'object' ? fx.chroma : {};
    o.chroma = { on: cb(ch.on), color: typeof ch.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(ch.color) ? ch.color : D.chroma.color, sim: cn(ch.sim, 0, 100, D.chroma.sim), blend: cn(ch.blend, 0, 100, D.chroma.blend) };
    const mk = fx.mask && typeof fx.mask === 'object' ? fx.mask : {};
    const n = maskNorm(mk);
    o.mask = { on: cb(mk.on), shape: n.shape, cx: n.cx, cy: n.cy, w: n.w, h: n.h, feather: n.feather, invert: n.invert, path: n.path };
    o.color = fx.color != null ? fx.color : null;   // validated by grade.js
    return o;
  }

  // ---- wipe-style transitions: the incoming clip is revealed through a moving mask, in the clip's own picture
  // coordinates (u, v = 0..1 across the picture, p = eased progress 0..1). wipeCover is the reference; wipeExpr is the
  // same function as an FFmpeg geq expression (X, Y, W, H are geq's own), and the GPU preview has a GLSL copy.
  const WIPE_SOFT = 0.03;
  const WIPES = {
    'wipe-lr': 'Wipe (left to right)', 'wipe-rl': 'Wipe (right to left)', 'wipe-tb': 'Wipe (top to bottom)', 'wipe-bt': 'Wipe (bottom to top)',
    iris: 'Iris (circle)', 'iris-box': 'Iris (box)', clock: 'Clock wipe', 'split-h': 'Barn doors (horizontal)', 'split-v': 'Barn doors (vertical)', blinds: 'Blinds',
    'blinds-v': 'Vertical blinds', diag: 'Diagonal wipe', 'diag-2': 'Diagonal wipe (other way)', diamond: 'Diamond', plus: 'Plus / cross', wave: 'Wave wipe', checker: 'Checkerboard', blocks: 'Random blocks', spiral: 'Spiral'
  };
  const WIPE_IDS = Object.keys(WIPES);
  const isWipe = (tr) => !!(tr && WIPES[tr.type] && tr.dur > 0);
  const wipeProgress = (tr, lt) => (lt >= tr.dur ? 1 : ease('ease', Math.max(0, lt) / tr.dur));
  function wipeCover(type, u, v, p) {
    const s = WIPE_SOFT;
    let d;
    switch (type) {
      case 'wipe-lr': d = u; break;
      case 'wipe-rl': d = 1 - u; break;
      case 'wipe-tb': d = v; break;
      case 'wipe-bt': d = 1 - v; break;
      case 'iris': d = Math.hypot(u - 0.5, v - 0.5) / 0.70710678; break;
      case 'iris-box': d = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2; break;
      case 'clock': { const a = Math.atan2(u - 0.5, -(v - 0.5)) / (2 * Math.PI); d = a - Math.floor(a); break; }
      case 'split-h': d = Math.abs(u - 0.5) * 2; break;
      case 'split-v': d = Math.abs(v - 0.5) * 2; break;
      case 'blinds': { const f = v * 8; d = f - Math.floor(f); break; }
      case 'blinds-v': { const f = u * 8; d = f - Math.floor(f); break; }
      case 'diag': d = (u + v) / 2; break;
      case 'diag-2': d = (u + 1 - v) / 2; break;
      case 'diamond': d = Math.min(1, Math.abs(u - 0.5) + Math.abs(v - 0.5)) ; break;
      case 'plus': d = Math.min(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2; break;
      case 'wave': d = 0.9 * u + 0.05 + 0.05 * Math.sin(v * 25.132741); break;
      case 'checker': { const par = (Math.floor(u * 8) + Math.floor(v * 8)) % 2; d = par * 0.5 + 0.5 * (u * 8 - Math.floor(u * 8)); break; }
      case 'blocks': { const x = (Math.floor(u * 12) * 0.7548776662 + Math.floor(v * 8) * 0.569840291); d = x - Math.floor(x); break; }
      case 'spiral': { const a = Math.atan2(u - 0.5, -(v - 0.5)) / (2 * Math.PI); const x = a - Math.floor(a) + Math.hypot(u - 0.5, v - 0.5) * 1.5; d = x - Math.floor(x); break; }
      default: return 1;
    }
    return Math.max(0, Math.min(1, (p * (1 + s) - d) / s));
  }
  // geq expression (0..1). tv = the time variable of the mask source, dur = transition length in seconds
  function wipeExpr(type, tv, dur) {
    const s = num(WIPE_SOFT), u = '((X+0.5)/W)', v = '((Y+0.5)/H)';
    const ut = '(min(' + tv + '/' + num(dur) + ',1))';
    const p = '(' + ut + '*' + ut + '*(3-2*' + ut + '))';
    let d;
    switch (type) {
      case 'wipe-lr': d = u; break;
      case 'wipe-rl': d = '(1-' + u + ')'; break;
      case 'wipe-tb': d = v; break;
      case 'wipe-bt': d = '(1-' + v + ')'; break;
      case 'iris': d = 'hypot(' + u + '-0.5,' + v + '-0.5)/0.70710678'; break;
      case 'iris-box': d = 'max(abs(' + u + '-0.5),abs(' + v + '-0.5))*2'; break;
      case 'clock': d = 'mod(atan2(' + u + '-0.5,0.5-' + v + ')/(2*PI)+1,1)'; break;
      case 'split-h': d = 'abs(' + u + '-0.5)*2'; break;
      case 'split-v': d = 'abs(' + v + '-0.5)*2'; break;
      case 'blinds': d = 'mod(' + v + '*8,1)'; break;
      case 'blinds-v': d = 'mod(' + u + '*8,1)'; break;
      case 'diag': d = '(' + u + '+' + v + ')/2'; break;
      case 'diag-2': d = '(' + u + '+1-' + v + ')/2'; break;
      case 'diamond': d = 'min(1,abs(' + u + '-0.5)+abs(' + v + '-0.5))'; break;
      case 'plus': d = 'min(abs(' + u + '-0.5),abs(' + v + '-0.5))*2'; break;
      case 'wave': d = '(0.9*' + u + '+0.05+0.05*sin(' + v + '*25.132741))'; break;
      case 'checker': d = '(mod(floor(' + u + '*8)+floor(' + v + '*8),2)*0.5+0.5*mod(' + u + '*8,1))'; break;
      case 'blocks': d = 'mod(floor(' + u + '*12)*0.7548776662+floor(' + v + '*8)*0.569840291,1)'; break;
      case 'spiral': d = 'mod(mod(atan2(' + u + '-0.5,0.5-' + v + ')/(2*PI)+1,1)+hypot(' + u + '-0.5,' + v + '-0.5)*1.5,1)'; break;
      default: return '1';
    }
    return 'clip((' + p + '*' + num(1 + WIPE_SOFT) + '-(' + d + '))/' + s + ',0,1)';
  }

  // ---- masks
  const maskOn = (fx) => !!(fx && fx.mask && fx.mask.on);
  const num0 = (v, d) => (Number.isFinite(+v) ? +v : d);
  function maskNorm(m) {
    return {
      shape: m.shape === 'rect' ? 'rect' : 'ellipse',
      cx: num0(m.cx, 50), cy: num0(m.cy, 50), w: Math.max(0.5, Math.min(400, num0(m.w, 50))), h: Math.max(0.5, Math.min(400, num0(m.h, 50))),
      feather: Math.max(0, Math.min(100, num0(m.feather, 0))), invert: !!m.invert,
      path: Array.isArray(m.path) && m.path.length > 1 ? m.path.filter((k) => Number.isFinite(+k.t) && Number.isFinite(+k.x) && Number.isFinite(+k.y)).map((k) => ({ t: +k.t, x: +k.x, y: +k.y })) : null
    };
  }
  // centre of the mask at clip time lt (percent)
  function maskCentre(m, lt) {
    const n = maskNorm(m);
    if (!n.path || n.path.length < 2) return { cx: n.cx, cy: n.cy };
    return { cx: kfEval(n.path.map((k) => ({ t: k.t, v: k.x, e: 'lin' })), lt, n.cx), cy: kfEval(n.path.map((k) => ({ t: k.t, v: k.y, e: 'lin' })), lt, n.cy) };
  }
  // coverage 0..1 of a point (u,v in 0..1 of the picture) — the reference both preview and export follow
  function maskCover(m, u, v, lt) {
    const n = maskNorm(m), c = maskCentre(m, lt);
    const dx = Math.abs(u * 100 - c.cx) / (n.w / 2), dy = Math.abs(v * 100 - c.cy) / (n.h / 2);
    const d = n.shape === 'rect' ? Math.max(dx, dy) : Math.hypot(dx, dy);
    const ft = Math.max(0.002, n.feather / 100);
    const a = Math.max(0, Math.min(1, (1 - d) / ft + 0.5));
    return n.invert ? 1 - a : a;
  }
  // the same thing as an FFmpeg geq expression (X, Y, W, H are geq's own; tv is the time variable)
  function maskExpr(m, tv) {
    const n = maskNorm(m);
    const cx = n.path ? kfExpr(n.path.map((k) => ({ t: k.t, v: k.x, e: 'lin' })), n.cx, tv) : num(n.cx);
    const cy = n.path ? kfExpr(n.path.map((k) => ({ t: k.t, v: k.y, e: 'lin' })), n.cy, tv) : num(n.cy);
    const dx = 'abs(X/W*100-(' + cx + '))/' + num(n.w / 2), dy = 'abs(Y/H*100-(' + cy + '))/' + num(n.h / 2);
    const d = n.shape === 'rect' ? 'max(' + dx + ',' + dy + ')' : 'hypot(' + dx + ',' + dy + ')';
    const a = 'clip((1-' + d + ')/' + num(Math.max(0.002, n.feather / 100)) + '+0.5,0,1)';
    return n.invert ? '(1-' + a + ')' : a;
  }
  // Audio effects. Neutral values mean "off" so old projects load unchanged.
  const DEFAULT_AE = {
    hp: 0, lp: 20000, low: 0, mid: 0, high: 0, pan: 0, denoise: 0,
    // 5.1 placement (used only when the project's audio layout is 5.1): left-right, front-back, centre send, LFE send — all 0..100 / -100..100
    sx: 0, sy: 0, sc: 0, slfe: 0,
    comp: { on: false, thresh: -18, ratio: 3, attack: 20, release: 250, makeup: 0 },
    echo: { on: false, delay: 250, decay: 40 }    // three repeats, `delay` ms apart, each `decay` percent of the one before
  };
  /** the echo's repeats: [{ ms, gain }] (empty = off). The export's aecho and the preview's delay lines both use exactly these. */
  function echoTaps(ae) {
    const e = ae && ae.echo;
    if (!e || e.on !== true) return [];
    const ms = Math.round(Math.max(20, Math.min(1000, +e.delay || 250))), d = Math.max(0.01, Math.min(0.9, (+e.decay || 40) / 100));
    return [1, 2, 3].map((k) => ({ ms: ms * k, gain: Math.round(Math.pow(d, k) * 10000) / 10000 })).filter((t) => t.gain >= 0.001);
  }
  // ---- 5.1 surround placement. A stereo clip is spread over FL FR FC LFE BL BR; the same maths drives the export
  // (FFmpeg pan) and the stereo preview downmix, so what you hear while editing is what the 5.1 file contains.
  const layoutOf = (p) => (p && p.audioLayout === '5.1' ? '5.1' : 'stereo');
  function surroundMix(ae) {
    ae = ae || {};
    const cl = (v, a, b) => Math.min(b, Math.max(a, Number.isFinite(+v) ? +v : 0));
    const sx = cl(ae.sx, -100, 100) / 100, sy = cl(ae.sy, 0, 100) / 100, cen = cl(ae.sc, 0, 100) / 100, lfe = cl(ae.slfe, 0, 100) / 100;
    const th = (sx + 1) / 2 * Math.PI / 2, balL = Math.cos(th) * Math.SQRT2, balR = Math.sin(th) * Math.SQRT2;
    const ph = sy * Math.PI / 2, fr = Math.cos(ph), bk = Math.sin(ph);
    const bc = (balL + balR) / 2;
    // each row = [gain from left input, gain from right input]
    return {
      FL: [fr * (1 - cen) * balL, 0], FR: [0, fr * (1 - cen) * balR], FC: [fr * cen * 0.5 * bc, fr * cen * 0.5 * bc],
      LFE: [lfe * 0.5, lfe * 0.5], BL: [bk * balL, 0], BR: [0, bk * balR]
    };
  }
  const surroundDefault = (ae) => !ae || (!ae.sx && !ae.sy && !ae.sc && !ae.slfe);
  // what a stereo speaker pair plays of that 5.1 placement (ITU downmix: centre and surrounds at -3 dB, LFE dropped)
  function surroundDownmix(ae) {
    const m = surroundMix(ae), k = Math.SQRT1_2;
    return { LL: m.FL[0] + k * m.FC[0] + k * m.BL[0], RL: m.FL[1] + k * m.FC[1] + k * m.BL[1], LR: m.FR[0] + k * m.FC[0] + k * m.BR[0], RR: m.FR[1] + k * m.FC[1] + k * m.BR[1] };
  }
  function surroundPanExpr(ae) {
    const m = surroundMix(ae), r4 = (v) => String(Math.round(v * 10000) / 10000);
    const term = (row) => [row[0] > 1e-5 ? r4(row[0]) + '*c0' : '', row[1] > 1e-5 ? r4(row[1]) + '*c1' : ''].filter(Boolean).join('+');
    const parts = ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'].map((n) => { const t = term(m[n]); return t ? n + '=' + t : ''; }).filter(Boolean);
    return 'pan=5.1|' + (parts.length ? parts.join('|') : 'FL=0*c0');
  }
  // a track's own rack (fader + the same effects as a clip) is "on" when it changes anything
  const rackActive = (t) => !!t && (!!(+t.vol) || aeActive(t.ae));
  function aeActive(ae) {
    if (!ae) return false;
    return ae.hp > 0 || ae.lp < 20000 || !!ae.low || !!ae.mid || !!ae.high || !!ae.pan || ae.denoise > 0 || !!(ae.comp && ae.comp.on) || !!(ae.echo && ae.echo.on === true);
  }
  // pan law shared by preview and export: equal power, unity gain at centre
  function panGains(pan) {
    const a = (Math.max(-100, Math.min(100, pan)) / 100 + 1) * Math.PI / 4;
    return { l: Math.cos(a) * Math.SQRT2, r: Math.sin(a) * Math.SQRT2 };
  }
  // FFmpeg filter list for the same chain the preview builds with Web Audio
  function aeFilters(ae) {
    const f = [];
    if (!aeActive(ae)) return f;
    const n = (v) => String(Math.round(v * 1000) / 1000);
    if (ae.denoise > 0) f.push('afftdn=nr=' + n(Math.min(97, Math.max(0.01, ae.denoise))) + ':nf=-40');
    if (ae.hp > 0) f.push('highpass=f=' + n(ae.hp));
    if (ae.lp < 20000) f.push('lowpass=f=' + n(Math.max(20, ae.lp)));
    if (ae.low) f.push('bass=g=' + n(ae.low) + ':f=150:t=s:w=1');
    if (ae.mid) f.push('equalizer=f=1000:t=q:w=1:g=' + n(ae.mid));
    if (ae.high) f.push('treble=g=' + n(ae.high) + ':f=6000:t=s:w=1');
    const c = ae.comp;
    if (c && c.on) {
      const th = Math.min(1, Math.max(0.00098, Math.pow(10, c.thresh / 20)));
      const mk = Math.min(64, Math.max(1, Math.pow(10, (c.makeup || 0) / 20)));
      f.push('acompressor=threshold=' + n(th) + ':ratio=' + n(c.ratio) + ':attack=' + n(c.attack) + ':release=' + n(c.release) + ':makeup=' + n(mk));
    }
    const taps = echoTaps(ae);
    if (taps.length) f.push('aecho=in_gain=1:out_gain=1:delays=' + taps.map((t) => t.ms).join('|') + ':decays=' + taps.map((t) => n(t.gain)).join('|'));
    if (ae.pan) { const g = panGains(ae.pan); f.push('pan=stereo|c0=' + n(g.l) + '*c0|c1=' + n(g.r) + '*c1'); }
    return f;
  }
  // Which parts of a clip survive once `silences` (source seconds) are removed.
  // Returns [{ in, dur }] in source seconds; `pad` keeps a little air around speech.
  function keepSegments(c, silences, pad, minKeep) {
    pad = pad == null ? 0.06 : pad; minKeep = minKeep == null ? 0.12 : minKeep;
    const a = c.in, b = c.in + c.dur * (c.speed || 1);
    const cuts = silences.map((s) => ({ start: s.start + pad, end: s.end - pad })).filter((s) => s.end - s.start > 0.02)
      .map((s) => ({ start: Math.max(a, s.start), end: Math.min(b, s.end) })).filter((s) => s.end > s.start).sort((x, y) => x.start - y.start);
    const out = []; let cur = a;
    for (const s of cuts) { if (s.start - cur >= minKeep) out.push({ in: cur, dur: s.start - cur }); cur = Math.max(cur, s.end); }
    if (b - cur >= minKeep) out.push({ in: cur, dur: b - cur });
    return out;
  }
  // ---- auto-duck: volume keyframes that pull a music clip down while speech plays elsewhere on the timeline
  /** the stretches of a clip that are not silent, in timeline seconds (silences are in source seconds) */
  function speechSpans(c, silences) {
    const sp = c.speed || 1;
    return keepSegments(c, silences || [], 0, 0.05).map((s) => ({ t0: c.start + (s.in - c.in) / sp, t1: c.start + (s.in + s.dur - c.in) / sp }));
  }
  function mergeSpans(spans, gap) {
    const l = spans.filter((s) => s.t1 > s.t0).map((s) => ({ t0: s.t0, t1: s.t1 })).sort((a, b) => a.t0 - b.t0), out = [];
    for (const s of l) { const last = out[out.length - 1]; if (last && s.t0 - last.t1 <= gap) last.t1 = Math.max(last.t1, s.t1); else out.push(s); }
    return out;
  }
  /** volume keyframes (clip-local) for clip c: `amount` dB down during the spans, moving over `fade` seconds. [] = nothing to duck */
  function duckKeyframes(c, spans, o) {
    o = o || {};
    const fade = Math.max(0.02, o.fade == null ? 0.4 : +o.fade), base = c.vol || 0, low = Math.max(VOLRANGE[0], base - Math.abs(o.amount == null ? 12 : +o.amount));
    const end = c.start + c.dur;
    const list = mergeSpans(spans, 2 * fade + 0.05).filter((s) => s.t1 + fade > c.start && s.t0 - fade < end);
    if (!list.length) return [];
    const pts = [];
    list.forEach((s) => { const a = s.t0 - c.start, b = s.t1 - c.start; pts.push({ t: a - fade, v: base, e: 'lin' }, { t: a, v: low, e: 'lin' }, { t: b, v: low, e: 'lin' }, { t: b + fade, v: base, e: 'lin' }); });
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const out = [{ t: 0, v: r3(kfEval(pts, 0, base)), e: 'lin' }];
    pts.forEach((p) => { if (p.t > 1e-3 && p.t < c.dur - 1e-3) out.push({ t: r3(p.t), v: p.v, e: 'lin' }); });
    out.push({ t: r3(c.dur), v: r3(kfEval(pts, c.dur, base)), e: 'lin' });
    return out;
  }

  const TRANSITIONS = {
    dissolve: 'Cross Dissolve',
    dip: 'Dip to Black',
    'slide-left': 'Slide In (from right)',
    'slide-right': 'Slide In (from left)',
    'slide-up': 'Slide In (from bottom)',
    'slide-down': 'Slide In (from top)'
  };
  Object.keys(WIPES).forEach((k) => { TRANSITIONS[k] = WIPES[k]; });
  // ---- blend modes: how a clip's picture mixes with what lies beneath (b = backdrop, s = this clip, both 0..1).
  // The same formulas run in the export (FFmpeg blend, backdrop as first input), the GPU preview and the reference below.
  const BLEND_MODES = { normal: 'Normal', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken', lighten: 'Lighten', add: 'Add (linear dodge)', difference: 'Difference', exclusion: 'Exclusion', hardlight: 'Hard light' };
  const BLEND_IDS = Object.keys(BLEND_MODES);
  const BLEND_FF = { multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', add: 'addition', difference: 'difference', exclusion: 'exclusion', hardlight: 'hardlight' };
  const BLEND_CANVAS = { multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', add: 'lighter', difference: 'difference', exclusion: 'exclusion', hardlight: 'hard-light' };
  // clip label colours (a strip on the clip in the timeline; organisational only, never exported)
  const LABELS = { '': 'None', '#a78bfa': 'Violet', '#60a5fa': 'Blue', '#2dd4bf': 'Teal', '#4ade80': 'Green', '#facc15': 'Yellow', '#fb923c': 'Orange', '#f87171': 'Red', '#f472b6': 'Pink' };
  const cleanLabel = (v) => (typeof v === 'string' && v && Object.prototype.hasOwnProperty.call(LABELS, v) ? v : '');
  const cleanBlend = (v) => (typeof v === 'string' && BLEND_IDS.indexOf(v) > 0 ? v : 'normal');
  function blendPx(mode, b, s) {
    switch (mode) {
      case 'multiply': return b * s;
      case 'screen': return 1 - (1 - b) * (1 - s);
      case 'overlay': return b < 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
      case 'darken': return Math.min(b, s);
      case 'lighten': return Math.max(b, s);
      case 'add': return Math.min(1, b + s);
      case 'difference': return Math.abs(b - s);
      case 'exclusion': return b + s - 2 * b * s;
      case 'hardlight': return s < 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
      default: return s;
    }
  }

  const FORMATS = [
    { id: 'mp4-h264', label: 'MP4 — H.264 + AAC (best compatibility)', ext: 'mp4', video: true, audio: true },
    { id: 'mp4-h265', label: 'MP4 — H.265 / HEVC + AAC (smaller files)', ext: 'mp4', video: true, audio: true },
    { id: 'mov-prores', label: 'MOV — Apple ProRes 422 HQ (editing master)', ext: 'mov', video: true, audio: true },
    { id: 'webm-vp9', label: 'WebM — VP9 + Opus', ext: 'webm', video: true, audio: true },
    { id: 'gif', label: 'Animated GIF', ext: 'gif', video: true, audio: false },
    { id: 'png-seq', label: 'PNG image sequence', ext: 'png', video: true, audio: false },
    { id: 'wav', label: 'WAV — audio only', ext: 'wav', video: false, audio: true },
    { id: 'mp3', label: 'MP3 — audio only', ext: 'mp3', video: false, audio: true },
    { id: 'm4a', label: 'M4A (AAC) — audio only', ext: 'm4a', video: false, audio: true },
    { id: 'frame-png', label: 'Still frame (PNG)', ext: 'png', video: true, audio: false, hidden: true },
    { id: 'frame-jpg', label: 'Still frame (JPEG)', ext: 'jpg', video: true, audio: false, hidden: true },
    { id: 'nest-prores', label: 'Nested sequence render (internal)', ext: 'mov', video: true, audio: true, hidden: true }
  ];

  let _id = 0;
  const uid = (p) => (p || 'id') + '_' + Date.now().toString(36) + (++_id).toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const clipEnd = (c) => c.start + c.dur;
  const isVideoTrackId = (id) => /^V/.test(id);

  function newProject(opts) {
    opts = opts || {};
    return {
      v: 1,
      id: uid('prj'),
      name: opts.name || 'Untitled',
      width: opts.width || 1920,
      height: opts.height || 1080,
      fps: opts.fps || 30,
      media: [],
      tracks: [
        { id: 'V1', type: 'video', name: 'V1', mute: false, hidden: false, lock: false },
        { id: 'V2', type: 'video', name: 'V2', mute: false, hidden: false, lock: false },
        { id: 'V3', type: 'video', name: 'V3', mute: false, hidden: false, lock: false },
        { id: 'A1', type: 'audio', name: 'A1', mute: false, hidden: false, lock: false },
        { id: 'A2', type: 'audio', name: 'A2', mute: false, hidden: false, lock: false },
        { id: 'A3', type: 'audio', name: 'A3', mute: false, hidden: false, lock: false }
      ],
      clips: [],
      markers: [],
      nests: {},
      workArea: { in: null, out: null }
    };
  }

  function newClip(props) {
    return Object.assign({
      id: uid('clip'), track: 'V1', type: 'media', media: null,
      start: 0, in: 0, dur: 5, speed: 1, vol: 0, fadeIn: 0, fadeOut: 0,
      tf: Object.assign({}, DEFAULT_TF), kf: { x: [], y: [], scale: [], rot: [], opacity: [], brightness: [], contrast: [], saturation: [], hue: [], vignette: [], vol: [] },
      disabled: false, reverse: false, blend: 'normal', fx: clone(DEFAULT_FX), ae: clone(DEFAULT_AE), tr: null, title: null, label: ''
    }, props);
  }

  function newTitle(text) {
    return {
      text: text || 'Your title here', font: 'Segoe UI', size: 96, bold: true, italic: false,
      color: '#ffffff', align: 'center', strokeW: 0, stroke: '#000000',
      shadow: true, bg: false, bgColor: '#000000', bgAlpha: 60, lineH: 1.15,
      // a graphic drawn behind the text: 'matte' fills the frame, 'rect' / 'ellipse' are w x h percent of the frame, centred
      shape: { kind: 'none', w: 50, h: 30, color: '#1e88e5', alpha: 100, radius: 0, strokeW: 0, stroke: '#ffffff' },
      roll: false   // rolling credits: the text scrolls from below the frame to above it over the clip's length
    };
  }
  // ---- rolling credits. The title picture is as tall as its text (never shorter than the frame, capped for sanity);
  // it starts just below the frame and ends just above it, moving at a constant speed.
  const ROLL_MAX_H = 16000;
  function titleHeight(t, frameH) {
    if (!t || t.roll !== true) return frameH;
    const size = Math.max(8, Math.min(600, +t.size || 96)), lines = String(t.text || '').split('\n').length;
    return Math.min(ROLL_MAX_H, Math.max(frameH, Math.ceil((lines * size * (+t.lineH || 1.15) + size) / 2) * 2));
  }
  /** vertical offset of a rolling title's centre from the frame centre at clip time lt */
  const rollOffset = (frameH, th, lt, dur) => (frameH + th) / 2 - (frameH + th) * Math.max(0, Math.min(1, dur > 0 ? lt / dur : 0));
  /** the same as an FFmpeg expression in the time variable tv */
  const rollExpr = (frameH, th, tv, dur) => '(' + num((frameH + th) / 2) + '-' + num(frameH + th) + '*clip(' + tv + '/' + num(Math.max(0.01, dur)) + ',0,1))';

  function projectDuration(p) {
    let d = 0;
    for (const c of p.clips) d = Math.max(d, clipEnd(c));
    return d;
  }

  // ---- keyframes -------------------------------------------------------
  function ease(kind, u) {
    if (kind === 'hold') return 0;
    if (kind === 'ease') return u * u * (3 - 2 * u);
    return u;
  }

  function kfEval(list, t, base) {
    if (!list || !list.length) return base;
    if (t <= list[0].t) return list[0].v;
    const last = list[list.length - 1];
    if (t >= last.t) return last.v;
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      if (t >= a.t && t < b.t) return a.v + (b.v - a.v) * ease(a.e, (t - a.t) / (b.t - a.t));
    }
    return last.v;
  }

  // transform values for a clip at clip-local time lt (seconds on the timeline, i.e. after speed)
  function tfAt(c, lt) {
    const out = {};
    for (const p of PROPS) out[p] = kfEval(c.kf && c.kf[p], lt, c.tf[p]);
    return out;
  }

  function addKeyframe(c, prop, t, v, e) {
    const list = c.kf[prop] = c.kf[prop] || [];
    const hit = list.find((k) => Math.abs(k.t - t) < 1e-3);
    if (hit) { hit.v = v; return hit; }
    const k = { t, v, e: e || 'lin' };
    list.push(k);
    list.sort((a, b) => a.t - b.t);
    return k;
  }

  const num = (v) => {
    const s = String(Math.round(v * 100000) / 100000);
    return v < 0 ? '(' + s + ')' : s;
  };

  // ffmpeg expression for a keyframed property. tv = expression giving clip-local time.
  function kfExpr(list, base, tv) {
    if (!list || !list.length) return num(base);
    if (list.length === 1) return num(list[0].v);
    let expr = num(list[list.length - 1].v);
    for (let i = list.length - 2; i >= 0; i--) {
      const a = list[i], b = list[i + 1];
      const u = '((' + tv + '-' + num(a.t) + ')/' + num(b.t - a.t) + ')';
      const e = a.e === 'hold' ? '0' : a.e === 'ease' ? '(' + u + '*' + u + '*(3-2*' + u + '))' : u;
      const seg = num(a.v) + '+' + num(b.v - a.v) + '*' + e;
      expr = 'if(lt(' + tv + ',' + num(b.t) + '),' + seg + ',' + expr + ')';
    }
    return 'if(lt(' + tv + ',' + num(list[0].t) + '),' + num(list[0].v) + ',' + expr + ')';
  }

  // ---- transitions / fades ----------------------------------------------
  function videoTrackClips(p, trackId) {
    return p.clips.filter((c) => c.track === trackId).sort((a, b) => a.start - b.start);
  }

  // clips that actually render (a disabled clip stays on the timeline but is skipped, like Premiere's "Enable")
  function activeTrackClips(p, trackId) { return videoTrackClips(p, trackId).filter((c) => !c.disabled); }

  // For each clip: how long its picture is held past its end (so the next clip's
  // dissolve/slide has something underneath), and its effective fade lengths.
  function analyze(p) {
    const ext = {}, fades = {};
    const tol = 1.5 / p.fps;
    for (const c of p.clips) fades[c.id] = { in: c.fadeIn || 0, out: c.fadeOut || 0 };
    for (const t of p.tracks) {
      if (t.type !== 'video') continue;
      const list = activeTrackClips(p, t.id);
      list.forEach((c, i) => {
        const prev = list[i - 1], next = list[i + 1];
        if (c.tr && c.tr.dur > 0) {
          const d = Math.min(c.tr.dur, c.dur);
          if (c.tr.type === 'dissolve') fades[c.id].in = Math.max(fades[c.id].in, d);
          if (c.tr.type === 'dip') fades[c.id].in = Math.max(fades[c.id].in, d / 2);
        }
        if (next && next.tr && next.tr.dur > 0 && Math.abs(clipEnd(c) - next.start) <= tol) {
          const d = Math.min(next.tr.dur, next.dur);
          if (next.tr.type === 'dip') fades[c.id].out = Math.max(fades[c.id].out, d / 2);
          else ext[c.id] = d;
        }
      });
    }
    return { ext, fades };
  }

  // slide offset in project pixels at clip-local time lt
  function slideOffset(tr, W, H, lt) {
    if (!tr || !/^slide/.test(tr.type) || tr.dur <= 0 || lt >= tr.dur) return { x: 0, y: 0 };
    const k = 1 - ease('ease', Math.max(0, lt) / tr.dur);
    if (tr.type === 'slide-left') return { x: W * k, y: 0 };
    if (tr.type === 'slide-right') return { x: -W * k, y: 0 };
    if (tr.type === 'slide-up') return { x: 0, y: H * k };
    return { x: 0, y: -H * k };
  }

  // ffmpeg expression equivalents of slideOffset (tv = clip-local time expression)
  function slideExpr(tr, W, H, tv) {
    if (!tr || !/^slide/.test(tr.type) || !(tr.dur > 0)) return { x: '0', y: '0' };
    const u = '(' + tv + '/' + num(tr.dur) + ')';
    const k = 'if(lt(' + tv + ',' + num(tr.dur) + '),1-' + u + '*' + u + '*(3-2*' + u + '),0)';
    if (tr.type === 'slide-left') return { x: num(W) + '*' + k, y: '0' };
    if (tr.type === 'slide-right') return { x: '-' + num(W) + '*' + k, y: '0' };
    if (tr.type === 'slide-up') return { x: '0', y: num(H) + '*' + k };
    return { x: '0', y: '-' + num(H) + '*' + k };
  }

  // ---- speed ---------------------------------------------------------------
  function atempoChain(s) {
    const out = [];
    while (s > 2) { out.push(2); s /= 2; }
    while (s < 0.5) { out.push(0.5); s /= 0.5; }
    out.push(s);
    return out.map((v) => 'atempo=' + (Math.round(v * 1e6) / 1e6));
  }

  // ---- speed ramps -----------------------------------------------------------
  // A ramp is built from many short constant-speed pieces whose speed follows a curve. Pieces are cut on whole frames and
  // each one starts exactly where the previous one ended in the source, so playback is continuous and preview == export.
  const RAMP_CURVES = {
    linear: (u) => u,
    easeIn: (u) => u * u,
    easeOut: (u) => 1 - (1 - u) * (1 - u),
    ease: (u) => u * u * (3 - 2 * u),
    dip: (u) => Math.pow(Math.sin(Math.PI * u), 2)      // from → to → from (fast / slow / fast)
  };
  const RAMP_LABELS = { linear: 'Linear', easeIn: 'Ease in (gradual start)', easeOut: 'Ease out (gradual end)', ease: 'Ease in and out', dip: 'Dip (start → end speed → start)' };
  function rampSegments(o) {
    const fps = o.fps || 30, L = o.srcLen;
    const steps = Math.max(2, Math.min(60, o.steps || Math.ceil(L * 2.5)));
    const curve = RAMP_CURVES[o.curve] || RAMP_CURVES.linear;
    const out = []; let pos = o.srcIn, t = 0;
    for (let i = 0; i < steps; i++) {
      const w = L / steps;
      let s = o.from + (o.to - o.from) * curve((i + 0.5) / steps);
      s = clamp(s, 0.1, 8);
      const frames = Math.max(1, Math.round(w / s * fps));
      const dur = frames / fps;
      const span = i === steps - 1 ? (o.srcIn + L - pos) : w;
      out.push({ in: pos, dur, speed: span / dur, start: t, span });
      pos += span; t += dur;
    }
    return out;
  }

  // ---- titles ----------------------------------------------------------------
  // Draws the title centred in a w x h canvas. Used for preview AND for the PNGs
  // that the exporter overlays, so both look the same.
  function drawTitle(ctx, w, h, t) {
    ctx.clearRect(0, 0, w, h);
    const lines = String(t.text || '').split('\n');
    const size = t.size || 96;
    ctx.font = (t.italic ? 'italic ' : '') + (t.bold ? 'bold ' : '') + size + 'px "' + (t.font || 'Segoe UI') + '", sans-serif';
    ctx.textBaseline = 'middle';
    const lh = size * (t.lineH || 1.15);
    const widths = lines.map((l) => ctx.measureText(l).width);
    const maxW = Math.max.apply(null, widths.concat([1]));
    const totalH = lh * lines.length;
    const align = t.align || 'center';
    const left = align === 'left' ? w / 2 - maxW / 2 : align === 'right' ? w / 2 + maxW / 2 : w / 2;
    ctx.textAlign = align;
    const sh = t.shape;
    if (sh && (sh.kind === 'matte' || sh.kind === 'rect' || sh.kind === 'ellipse')) {
      const pc = (v, lo, d) => { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(100, v)) : d; };
      ctx.save();
      ctx.globalAlpha = pc(sh.alpha, 0, 100) / 100;
      ctx.fillStyle = sh.color || '#1e88e5';
      if (sh.kind === 'matte') ctx.fillRect(0, 0, w, h);
      else {
        const sw = w * pc(sh.w, 1, 50) / 100, s2 = h * pc(sh.h, 1, 30) / 100, x = (w - sw) / 2, y = (h - s2) / 2;
        ctx.beginPath();
        if (sh.kind === 'ellipse') ctx.ellipse(w / 2, h / 2, sw / 2, s2 / 2, 0, 0, Math.PI * 2);
        else {
          const r = Math.min(sw, s2) / 2 * pc(sh.radius, 0, 0) / 100;
          ctx.moveTo(x + r, y); ctx.arcTo(x + sw, y, x + sw, y + s2, r); ctx.arcTo(x + sw, y + s2, x, y + s2, r); ctx.arcTo(x, y + s2, x, y, r); ctx.arcTo(x, y, x + sw, y, r); ctx.closePath();
        }
        ctx.fill();
        const lw = Math.max(0, Math.min(200, +sh.strokeW || 0));
        if (lw > 0) { ctx.lineWidth = lw; ctx.strokeStyle = sh.stroke || '#fff'; ctx.stroke(); }
      }
      ctx.restore();
    }
    if (t.bg) {
      const pad = size * 0.35;
      ctx.fillStyle = t.bgColor || '#000';
      ctx.globalAlpha = (t.bgAlpha == null ? 60 : t.bgAlpha) / 100;
      ctx.fillRect(w / 2 - maxW / 2 - pad, h / 2 - totalH / 2 - pad * 0.6, maxW + pad * 2, totalH + pad * 1.2);
      ctx.globalAlpha = 1;
    }
    lines.forEach((l, i) => {
      const y = h / 2 - totalH / 2 + lh * (i + 0.5);
      if (t.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = size * 0.12; ctx.shadowOffsetY = size * 0.04; }
      if (t.strokeW > 0) {
        ctx.lineWidth = t.strokeW * 2; ctx.lineJoin = 'round'; ctx.strokeStyle = t.stroke || '#000';
        ctx.strokeText(l, left, y);
        ctx.shadowColor = 'transparent';
      }
      ctx.fillStyle = t.color || '#fff';
      ctx.fillText(l, left, y);
      ctx.shadowColor = 'transparent';
    });
  }

  const fmtTC = (t, fps) => {
    fps = Math.round(fps || 30);
    const f = Math.max(0, Math.round(t * fps));
    const ff = f % fps, s = Math.floor(f / fps), ss = s % 60, m = Math.floor(s / 60), mm = m % 60, hh = Math.floor(m / 60);
    const p = (n) => String(n).padStart(2, '0');
    return p(hh) + ':' + p(mm) + ':' + p(ss) + ':' + p(ff);
  };

  return {
    layoutOf, surroundMix, surroundDownmix, surroundPanExpr, surroundDefault, rackActive,
    maskOn, maskNorm, maskCentre, maskCover, maskExpr, cleanFx, WIPES, WIPE_IDS, isWipe, wipeProgress, wipeCover, wipeExpr, WIPE_SOFT,
    PROPS, FXPROPS, AUDIOPROPS, ALLPROPS, volAt, VOLRANGE, speechSpans, mergeSpans, duckKeyframes, baseOf, setBase, fxAt, cleanKf, FXRANGE, DEFAULT_TF, DEFAULT_FX, DEFAULT_AE, keepSegments, aeActive, aeFilters, echoTaps, panGains, TRANSITIONS, FORMATS, BLEND_MODES, BLEND_IDS, BLEND_FF, BLEND_CANVAS, cleanBlend, blendPx, LABELS, cleanLabel,
    uid, clone, clamp, clipEnd, isVideoTrackId, newProject, newClip, newTitle, projectDuration,
    ease, kfEval, tfAt, addKeyframe, num, kfExpr, videoTrackClips, activeTrackClips, analyze, slideOffset, slideExpr,
    atempoChain, drawTitle, titleHeight, rollOffset, rollExpr, ROLL_MAX_H, fmtTC, RAMP_CURVES, RAMP_LABELS, rampSegments
  };
});
