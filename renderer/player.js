'use strict';
/* Ditto Pro — preview engine: composites the timeline onto the program monitor canvas and plays audio. */
const Player = (() => {
  const canvas = $('#monitor');
  const ctx = canvas.getContext('2d', { alpha: false });
  const box = $('#canvasBox');
  const wrap = $('#monitorWrap');
  const selBox = $('#selBox');
  const pool = new Map();       // clipId -> { el, url }
  const imgs = new Map();       // mediaId -> HTMLImageElement
  const titles = new Map();     // clipId -> { key, canvas }
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d');
  let raf = 0, wall = 0, headStart = 0, renderQueued = false;
  let q = 1;                         // preview resolution factor (1, 0.5, 0.25): lighter on slow machines / 4K projects
  const cw = () => Math.max(2, Math.round(P().width * q)), ch = () => Math.max(2, Math.round(P().height * q));

  const P = () => S.project;

  // ------------------------------------------------------------ sizing
  function resize() {
    const p = P();
    if (canvas.width !== cw() || canvas.height !== ch()) { canvas.width = cw(); canvas.height = ch(); }
    const aw = Math.max(50, wrap.clientWidth - 20), ah = Math.max(50, wrap.clientHeight - 20);
    const k = Math.min(aw / p.width, ah / p.height);
    box.style.width = Math.floor(p.width * k) + 'px';
    box.style.height = Math.floor(p.height * k) + 'px';
    $('#monInfo').textContent = p.width + '×' + p.height + ' · ' + (Math.round(p.fps * 100) / 100) + ' fps · ' + (useGpu() ? 'GPU' : 'Canvas');
    requestRender();
  }

  // ------------------------------------------------------------ media elements
  function previewUrl(m) { return m && (m.previewUrl || null); }

  // the pieces of a speed ramp play one after another from the same source, so they share one media element
  const keyOf = (c) => (c.ramp ? 'r:' + c.ramp.g + ':' + c.media : c.id);
  function getEl(c) {
    const m = S.media(c.media);
    const url = previewUrl(m);
    if (!m || !url || m.missing) return null;
    const key = keyOf(c);
    let o = pool.get(key);
    if (o && o.url !== url) { dispose(key); o = null; }
    if (!o) {
      const el = document.createElement(m.kind === 'audio' ? 'audio' : 'video');
      el.crossOrigin = 'anonymous'; el.preload = 'auto'; el.playsInline = true; el.src = url;
      el.addEventListener('seeked', requestRender);
      el.addEventListener('loadeddata', requestRender);
      el.addEventListener('error', requestRender);
      o = { el, url };
      pool.set(key, o);
      try { el.currentTime = Math.max(0, c.in); } catch (e) { /* not ready yet */ }
    }
    return o;
  }
  function dispose(id) {
    const o = pool.get(id);
    if (!o) return;
    try { o.el.pause(); o.el.removeAttribute('src'); o.el.load(); } catch (e) { /* ignore */ }
    pool.delete(id);
  }
  function prune() {
    const byKey = new Map();
    P().clips.forEach((c) => { const k = keyOf(c); const b = byKey.get(k); if (!b) byKey.set(k, { first: c, last: c }); else { if (c.start < b.first.start) b.first = c; if (DS.clipEnd(c) > DS.clipEnd(b.last)) b.last = c; } });
    for (const id of Array.from(pool.keys())) if (!byKey.has(id)) dispose(id);
    if (pool.size > 18) {
      const t = S.playhead;
      for (const [id, o] of pool) {
        const b = byKey.get(id);
        if (b && o.el.paused && (b.first.start > t + 12 || DS.clipEnd(b.last) < t - 12)) dispose(id);
        if (pool.size <= 14) break;
      }
    }
  }
  function getImg(m) {
    let im = imgs.get(m.id);
    if (!im) { im = new Image(); im.crossOrigin = 'anonymous'; im.onload = requestRender; im.src = m.url; imgs.set(m.id, im); }
    return im;
  }
  function titleCanvas(c) {
    const p = P();
    const key = JSON.stringify(c.title) + p.width + 'x' + p.height;
    let t = titles.get(c.id);
    if (!t || t.key !== key) {
      const cv = t ? t.canvas : document.createElement('canvas');
      // rolling credits are drawn on a canvas as tall as the whole text; it then scrolls through the frame (DS.rollOffset)
      const th = DS.titleHeight(c.title, p.height);
      cv.width = p.width; cv.height = th;
      DS.drawTitle(cv.getContext('2d'), p.width, th, c.title);
      cv._k = key;
      t = { key, canvas: cv };
      titles.set(c.id, t);
    }
    return t.canvas;
  }

  // ------------------------------------------------------------ effects
  function filterFor(fx) {
    if (!fx) return 'none';
    const f = [];
    if (fx.brightness) f.push('brightness(' + (1 + fx.brightness / 100) + ')');
    if (fx.contrast) f.push('contrast(' + (1 + fx.contrast / 100) + ')');
    if (fx.saturation != null && fx.saturation !== 100) f.push('saturate(' + fx.saturation / 100 + ')');
    if (fx.hue) f.push('hue-rotate(' + fx.hue + 'deg)');
    if (fx.blur > 0) f.push('blur(' + (fx.blur * q) + 'px)');
    if (fx.gray) f.push('grayscale(1)');
    if (fx.sepia) f.push('sepia(1)');
    return f.length ? f.join(' ') : 'none';
  }


  // ---- colour grade (fx.color) baked to a 33-point LUT by DG; cached by its content
  const gradeCache = new Map();
  function gradeOf(fx) {
    if (!fx || !fx.color || !DG.active(fx.color)) return null;
    const key = DG.key(fx.color);
    let g = gradeCache.get(key);
    if (!g) {
      g = { key, size: 33, pixels: DG.texturePixels(fx.color, 33) };
      gradeCache.set(key, g);
      if (gradeCache.size > 32) gradeCache.delete(gradeCache.keys().next().value);
    }
    return g;
  }

  // ------------------------------------------------------------ GPU effects (sharpen, vignette, chroma key)
  const FxGL = (() => {
    let gl = null, prog = null, tex = null, cv = null, failed = false, loc = {};
    const gradeTexs = new Map();
    const VS = 'attribute vec2 p; varying vec2 vUv; void main(){ vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }';
    const FS = [
      'precision highp float; varying vec2 vUv; uniform sampler2D uTex; uniform vec2 uSize;',
      'uniform float uSharp, uVig, uKeyOn, uSim, uBlend, uLutOn, uLutN, uGradeOn, uGradeN; uniform vec3 uKey; uniform sampler2D uLut, uGrade;',
      'vec3 lutTap(sampler2D t, float N, float r, float g, float b){ return texture2D(t, vec2((b * N + r + 0.5) / (N * N), (g + 0.5) / N)).rgb; }',
      'vec3 lutB(sampler2D t, float N, float r, float g, float b, vec3 f){ float r1 = min(r + 1.0, N - 1.0), g1 = min(g + 1.0, N - 1.0);',
      '  vec3 c00 = mix(lutTap(t, N, r, g, b), lutTap(t, N, r1, g, b), f.r); vec3 c10 = mix(lutTap(t, N, r, g1, b), lutTap(t, N, r1, g1, b), f.r); return mix(c00, c10, f.g); }',
      'vec3 applyLut(sampler2D t, float N, vec3 c){ vec3 p = clamp(c, 0.0, 1.0) * (N - 1.0); vec3 i = floor(p); vec3 f = p - i; float b1 = min(i.b + 1.0, N - 1.0);',
      '  return mix(lutB(t, N, i.r, i.g, i.b, f), lutB(t, N, i.r, i.g, b1, f), f.b); }',
      'void main(){',
      '  vec4 c = texture2D(uTex, vUv);',
      '  if (uLutOn > 0.5) c.rgb = applyLut(uLut, uLutN, c.rgb);',
      '  if (uGradeOn > 0.5) c.rgb = applyLut(uGrade, uGradeN, c.rgb);',
      '  if (uSharp > 0.0) { vec2 px = 1.0 / uSize; vec3 sum = vec3(0.0);',
      '    for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) sum += texture2D(uTex, vUv + vec2(float(i), float(j)) * px).rgb;',
      '    c.rgb = c.rgb + uSharp * (c.rgb - sum / 25.0); }',
      '  if (uVig > 0.0) { float d = length((vUv - 0.5) * uSize) / (0.5 * length(uSize));',
      '    float f = pow(cos(min(uVig * d, 1.5707963)), 4.0); c.rgb *= f; }',
      '  float a = c.a;',
      '  if (uKeyOn > 0.5) { float d = distance(c.rgb, uKey) / 1.7320508; a = uBlend > 0.0 ? clamp((d - uSim) / uBlend, 0.0, 1.0) : step(uSim, d); }',
      '  c.rgb = clamp(c.rgb, 0.0, 1.0);',
      '  gl_FragColor = vec4(c.rgb * a, a);',
      '}'
    ].join('\n');
    function init() {
      if (gl || failed) return !!gl;
      try {
        cv = document.createElement('canvas');
        gl = cv.getContext('webgl', { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true, antialias: false });
        if (!gl) throw new Error('no webgl');
        const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
        prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        gl.useProgram(prog);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const a = gl.getAttribLocation(prog, 'p');
        gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
        ['uLut', 'uLutOn', 'uLutN', 'uGrade', 'uGradeOn', 'uGradeN', 'uTex', 'uSize', 'uSharp', 'uVig', 'uKeyOn', 'uSim', 'uBlend', 'uKey'].forEach((n) => { loc[n] = gl.getUniformLocation(prog, n); });
        tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        return true;
      } catch (e) { console.warn('GPU effects unavailable:', e.message); gl = null; failed = true; return false; }
    }
    // LUT textures: pixels are fetched from the main process once per file, then uploaded lazily
    const luts = new Map(); // path -> { state, size, pixels, tex }
    function lutState(path) {
      let l = luts.get(path);
      if (!l) {
        l = { state: 'loading' }; luts.set(path, l);
        window.ditto.lutData(path).then((r) => {
          if (!r || r.error) { l.state = 'error'; l.error = r && r.error; } else { l.state = 'ready'; l.size = r.size; l.pixels = r.pixels; }
          requestRender();
        }).catch(() => { l.state = 'error'; });
      }
      return l;
    }
    const lutReady = (fx) => !!(fx && fx.lut && fx.lut.path && lutState(fx.lut.path).state === 'ready');
    const needs = (fx) => !!fx && (fx.sharpen > 0 || fx.vignette > 0 || (fx.chroma && fx.chroma.on) || lutReady(fx) || !!gradeOf(fx));
    function hex(h) { const n = parseInt(String(h || '#00ff00').replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
    // returns a canvas holding the processed frame (same size as the source) or null
    function process(src, sw, sh, fx, allowKey) {
      if (!needs(fx) || !init()) return null;
      const w = Math.min(4096, Math.max(2, sw)), h = Math.min(4096, Math.max(2, sh));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      gl.viewport(0, 0, w, h);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); } catch (e) { return null; }
      const ch = fx.chroma || {};
      gl.uniform1i(loc.uTex, 0);
      gl.uniform2f(loc.uSize, w, h);
      gl.uniform1f(loc.uSharp, fx.sharpen > 0 ? fx.sharpen / 50 : 0);
      gl.uniform1f(loc.uVig, fx.vignette > 0 ? fx.vignette / 100 * Math.PI / 3 : 0);
      const key = allowKey && ch.on;
      gl.uniform1f(loc.uKeyOn, key ? 1 : 0);
      gl.uniform3fv(loc.uKey, hex(ch.color));
      gl.uniform1f(loc.uSim, (ch.sim || 30) / 100);
      gl.uniform1f(loc.uBlend, (ch.blend || 0) / 100);
      if (lutReady(fx)) {
        const l = luts.get(fx.lut.path);
        if (!l.tex) {
          l.tex = gl.createTexture();
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, l.tex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, l.size * l.size, l.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, l.pixels);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        }
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, l.tex);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(loc.uLut, 1); gl.uniform1f(loc.uLutN, l.size); gl.uniform1f(loc.uLutOn, 1);
      } else gl.uniform1f(loc.uLutOn, 0);
      const gr = gradeOf(fx);
      if (gr) {
        let gt = gradeTexs.get(gr.key);
        if (!gt) {
          gt = gl.createTexture(); gradeTexs.set(gr.key, gt);
          if (gradeTexs.size > 24) { const k = gradeTexs.keys().next().value; gl.deleteTexture(gradeTexs.get(k)); gradeTexs.delete(k); }
          gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, gt);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gr.size * gr.size, gr.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, gr.pixels);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        }
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, gt); gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(loc.uGrade, 2); gl.uniform1f(loc.uGradeN, gr.size); gl.uniform1f(loc.uGradeOn, 1);
      } else gl.uniform1f(loc.uGradeOn, 0);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return cv;
    }
    return { process, needs, available: () => init(), lutState, lutInfo: (path) => luts.get(path) || lutState(path) };
  })();

  // ------------------------------------------------------------ timeline queries
  function layersAt(t) {
    const p = P(), ext = S.analysis.ext, out = [];
    const tol = 1e-4;
    for (const tr of p.tracks) {
      if (tr.type !== 'video' || tr.hidden) continue;
      for (const c of S.trackClips(tr.id)) {
        if (c.disabled) continue;
        const end = DS.clipEnd(c) + (ext[c.id] || 0);
        if (t >= c.start - tol && t < end - tol) out.push(c);
      }
    }
    return out;
  }

  function fadeGain(c, lt) {
    let g = 1;
    if (c.fadeIn > 0) g = Math.min(g, lt / c.fadeIn);
    if (c.fadeOut > 0) g = Math.min(g, (c.dur - lt) / c.fadeOut);
    return DS.clamp(g, 0, 1);
  }

  // ------------------------------------------------------------ media sync (playback + scrubbing)
  function sync(playing) {
    const t = S.playhead, p = P();
    const wanted = new Set();
    const consider = (c) => {
      if (c.type !== 'media' || c.disabled) return;
      const m = S.media(c.media);
      if (!m || m.kind === 'image') return;
      const tr = S.track(c.track);
      const end = DS.clipEnd(c);
      const ext = S.analysis.ext[c.id] || 0;
      const inRange = t >= c.start - 1e-4 && t < end - 1e-4;
      const inHold = !inRange && ext > 0 && t >= end - 1e-4 && t < end + ext - 1e-4 && tr.type === 'video' && !tr.hidden;
      const near = !playing ? false : (c.start > t && c.start - t < 1.5);
      if (!inRange && !inHold && !near) return;
      if (c.ramp && !inRange && !(near && c.ramp.i === 0)) return; // later ramp pieces reuse the element that is already playing
      const o = getEl(c);
      if (!o) return;
      const el = o.el;
      wanted.add(keyOf(c));
      const lt = t - c.start;
      const ltc = Math.max(0, Math.min(lt, c.dur));
      // reversed clips cannot be played backwards by the browser: the preview steps through the mirrored frames
      const src = DS.clamp(c.in + (c.reverse ? Math.max(0, c.dur - ltc) : ltc) * c.speed, 0, Math.max(0, m.duration - 0.04));
      if (inRange) {
        const g = Math.pow(10, DS.volAt(c, ltc) / 20) * fadeGain(c, lt);
        const fx = o.fx || (o.fx = AudioFx.attach(el));
        const surr = DS.layoutOf(S.rootProject()) === '5.1';
        if (fx) { fx.update(c.ae, g, surr); AudioFx.route(fx, tr, surr); } else el.volume = DS.clamp(g, 0, 1);
        if (playing) AudioFx.resume();
        el.muted = !!(tr && tr.mute) || !m.hasAudio || !!c.mute;
        const rate = DS.clamp(c.speed, 0.0625, 16);
        if (el.playbackRate !== rate) el.playbackRate = rate;
        if (playing && c.reverse) {
          if (!el.paused) el.pause();
          el.muted = true;
          if (Math.abs(el.currentTime - src) > S.frame() * 0.5) setTime(el, src);
        } else if (playing) {
          if (el.paused) { setTime(el, src); el.play().catch(() => {}); }
          else if (Math.abs(el.currentTime - src) > 0.22) setTime(el, src);
        } else {
          if (!el.paused) el.pause();
          if (Math.abs(el.currentTime - src) > S.frame() * 0.45) setTime(el, src);
        }
      } else {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - src) > 0.05) setTime(el, src);
      }
    };
    p.clips.forEach(consider);
    for (const [id, o] of pool) if (!wanted.has(id) && !o.el.paused) o.el.pause();
  }
  function setTime(el, v) { try { el.currentTime = v; } catch (e) { /* ignore */ } }

  // ------------------------------------------------------------ drawing
  // adds the crop rectangle (in source pixels) on top of the raw source
  function sourceFor(c) {
    const s = sourceRaw(c);
    if (!s || s.msg) return s;
    s.rw = s.sw; s.rh = s.sh; s.sx = 0; s.sy = 0;
    const cr = c.type !== 'title' && c.fx && c.fx.crop;
    if (cr && (cr.l || cr.t || cr.r || cr.b)) {
      const k = (v) => DS.clamp(v, 0, 95) / 100;
      s.sx = s.rw * k(cr.l); s.sy = s.rh * k(cr.t);
      s.sw = Math.max(2, s.rw * (1 - k(cr.l) - k(cr.r))); s.sh = Math.max(2, s.rh * (1 - k(cr.t) - k(cr.b)));
    }
    return s;
  }
  function sourceRaw(c) {
    if (c.type === 'title') { const cv = titleCanvas(c); return { src: cv, sw: cv.width, sh: cv.height, fit: false }; }
    const m = S.media(c.media);
    if (!m) return null;
    if (m.missing) return { msg: 'Media offline: ' + m.name };
    if (m.kind === 'image') {
      const im = getImg(m);
      return im.complete && im.naturalWidth ? { src: im, sw: im.naturalWidth, sh: im.naturalHeight, fit: true } : null;
    }
    if (!previewUrl(m)) return { msg: m.proxyState === 'error' ? 'Preview unavailable' : 'Preparing preview…' };
    const o = getEl(c);
    if (!o || o.el.readyState < 2 || !o.el.videoWidth) return null;
    return { src: o.el, sw: o.el.videoWidth, sh: o.el.videoHeight, fit: true };
  }

  function placeholder(msg) {
    const p = P();
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.font = Math.round(p.height / 24) + 'px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(msg, p.width / 2, p.height / 2);
    ctx.restore();
  }

  function geometry(c, lt, s) {
    const p = P();
    const tf = DS.tfAt(c, lt);
    const fit = s.fit ? Math.min(p.width / s.sw, p.height / s.sh) : 1;
    const sl = DS.slideOffset(c.tr, p.width, p.height, lt);
    const roll = c.type === 'title' && c.title && c.title.roll ? DS.rollOffset(p.height, s.sh, lt, c.dur) : 0;
    return { tf, cx: p.width / 2 + tf.x + sl.x, cy: p.height / 2 + tf.y + sl.y + roll, sc: tf.scale / 100 * fit };
  }

  // a clip whose effect values are animated is drawn with the values at this moment
  const fxView = (c, lt) => { const f = DS.fxAt(c, lt); return f === c.fx ? c : Object.assign({}, c, { fx: f }); };
  function drawClip(c0, t) {
    const c = fxView(c0, t - c0.start);
    const lt = t - c.start;
    const s = sourceFor(c);
    if (!s) return;
    if (s.msg) { placeholder(s.msg); return; }
    const g = geometry(c, lt, s);
    const fd = S.analysis.fades[c.id] || { in: 0, out: 0 };
    let alpha = DS.clamp(g.tf.opacity / 100, 0, 1);
    if (fd.in > 0 && lt < fd.in) alpha *= Math.max(0, lt / fd.in);
    if (fd.out > 0 && lt > c.dur - fd.out) alpha *= Math.max(0, (c.dur - lt) / fd.out);
    if (alpha <= 0.001) return;
    const masked = c.type !== 'title' && DS.maskOn(c.fx);
    const wiped = DS.isWipe(c.tr), creative = c.type !== 'title' && Creative.active(c.fx);
    const layered = masked || wiped || creative;
    // a masked / wiped / stylised clip is painted on its own layer first, the effects and the mask work on that layer,
    // and the layer is then laid on the picture
    const X = layered ? layerCtx() : ctx;
    const bop = DS.BLEND_CANVAS[DS.cleanBlend(c.blend)] || 'source-over';
    X.save();
    X.globalAlpha = layered ? 1 : alpha;
    if (!layered) X.globalCompositeOperation = bop;
    X.filter = c.type === 'title' ? 'none' : filterFor(c.fx);
    X.translate(g.cx, g.cy);
    X.rotate(g.tf.rot * Math.PI / 180);
    X.scale(g.sc * (c.fx && c.fx.flipH ? -1 : 1), g.sc * (c.fx && c.fx.flipV ? -1 : 1));
    let drawSrc = s.src;
    if (c.type !== 'title') { const o = FxGL.process(s.src, s.rw, s.rh, c.fx, true); if (o) drawSrc = o; }
    let rect = [s.sx, s.sy, s.sw, s.sh];
    if (creative) {   // stylised on its own picture first (the export does it before scaling and placing), then placed like any clip
      const t = styleSource(drawSrc, s, c, g);
      if (t) { drawSrc = t; rect = [0, 0, t.width, t.height]; X.filter = 'none'; }
    }
    X.drawImage(drawSrc, rect[0], rect[1], rect[2], rect[3], -s.sw / 2, -s.sh / 2, s.sw, s.sh);
    X.restore();
    if (layered) {
      if (wiped) postLayer(c, g, s, lt, false, wiped);
      if (masked) cutMask(X, c, g, s, lt);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = bop;
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
    }
  }



  // the picture region of a clip, with its colour filters and creative effects baked in, at the size it will be shown at
  const styleCv = document.createElement('canvas');
  function styleSource(src, s, c, g) {
    const sc = g.sc * q, w = Math.min(4096, Math.max(2, Math.round(s.sw * sc))), h = Math.min(4096, Math.max(2, Math.round(s.sh * sc)));
    if (styleCv.width !== w || styleCv.height !== h) { styleCv.width = w; styleCv.height = h; }
    const x = styleCv.getContext('2d', { willReadFrequently: true });
    x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'copy'; x.globalAlpha = 1;
    x.filter = filterFor(c.fx);
    x.drawImage(src, s.sx, s.sy, s.sw, s.sh, 0, 0, w, h);
    x.filter = 'none';
    try { const id = x.getImageData(0, 0, w, h); Creative.process(id.data, w, h, c.fx, w / s.sw, s.sw); x.putImageData(id, 0, 0); } catch (e) { return null; }
    return styleCv;
  }

  // the 2D fallback's version of the GPU shader's creative effects and wipe: plain pixel code (src/creative.js, DS.wipeCover)
  function postLayer(c, g, s, lt, creative, wiped) {
    lctx.save(); lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.filter = 'none';
    const w = layer.width, h = layer.height;
    let id;
    try { id = lctx.getImageData(0, 0, w, h); } catch (e) { lctx.restore(); return; }
    const d = id.data;
    if (creative) Creative.process(d, w, h, c.fx, g.sc * q, s.sw);
    if (wiped) {
      const wp = DS.WIPE_IDS.indexOf(c.tr.type), type = c.tr.type, pr = DS.wipeProgress({ dur: Math.min(c.tr.dur, c.dur) }, lt);
      const rot = g.tf.rot * Math.PI / 180, cs = Math.cos(rot), sn = Math.sin(rot), sc = g.sc * q, cx = g.cx * q, cy = g.cy * q;
      const fh = c.fx && c.fx.flipH ? -1 : 1, fv = c.fx && c.fx.flipV ? -1 : 1;
      if (wp >= 0) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4 + 3;
        if (!d[i]) continue;
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const lx = (dx * cs + dy * sn) / sc * fh, ly = (-dx * sn + dy * cs) / sc * fv;
        d[i] = d[i] * DS.wipeCover(type, lx / s.sw + 0.5, ly / s.sh + 0.5, pr);
      }
    }
    lctx.putImageData(id, 0, 0);
    lctx.restore();
  }

  // ---- masks: the layer canvas holds the clip, cutMask keeps (or, inverted, removes) the soft-edged shape
  const layer = document.createElement('canvas');
  const lctx = layer.getContext('2d');
  function layerCtx() {
    if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height; }
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = 'source-over'; lctx.globalAlpha = 1; lctx.filter = 'none';
    lctx.clearRect(0, 0, layer.width, layer.height);
    lctx.setTransform(q, 0, 0, q, 0, 0);
    return lctx;
  }
  function cutMask(X, c, g, s, lt) {
    const n = DS.maskNorm(c.fx.mask), ce = DS.maskCentre(c.fx.mask, lt);
    const ex = n.w / 200 * s.sw, ey = n.h / 200 * s.sh;                 // half extents in source pixels
    const ox = (ce.cx - 50) / 100 * s.sw, oy = (ce.cy - 50) / 100 * s.sh;
    X.save();
    X.globalCompositeOperation = n.invert ? 'destination-out' : 'destination-in';
    if (n.invert === false) { /* keep only the shape: everything else is cleared by destination-in */ }
    X.translate(g.cx, g.cy); X.rotate(g.tf.rot * Math.PI / 180); X.scale(g.sc, g.sc);   // (flips are already baked into the picture)
    const ft = Math.max(0.002, n.feather / 100);
    // a linear ramp of width ft (in units of the half extent) is matched by a blur of about 0.4 x that width
    const sig = 0.4 * ft * Math.min(ex, ey) * g.sc * q;
    X.filter = n.feather > 0 && sig > 0.3 ? 'blur(' + sig.toFixed(2) + 'px)' : 'none';
    X.fillStyle = '#000';
    X.beginPath();
    if (n.shape === 'rect') X.rect(ox - ex, oy - ey, ex * 2, ey * 2); else X.ellipse(ox, oy, ex, ey, 0, 0, Math.PI * 2);
    X.fill();
    X.restore();
  }

  function applyAdjust(c) {
    const f = filterFor(c.fx);
    const cr = Creative.active(c.fx);
    if (f === 'none' && !FxGL.needs(c.fx) && !cr) return;
    if (scratch.width !== canvas.width || scratch.height !== canvas.height) { scratch.width = canvas.width; scratch.height = canvas.height; }
    sctx.globalCompositeOperation = 'copy';
    sctx.drawImage(canvas, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.filter = f;
    ctx.drawImage(FxGL.process(scratch, canvas.width, canvas.height, c.fx, false) || scratch, 0, 0, canvas.width, canvas.height);
    if (cr) {
      try { const id = ctx.getImageData(0, 0, canvas.width, canvas.height); Creative.process(id.data, canvas.width, canvas.height, c.fx, q, P().width, null, { noKey: true }); ctx.putImageData(id, 0, 0); } catch (e) { /* tainted or unavailable */ }
    }
    ctx.restore();
  }

  // ---- compositor choice: the WebGL2 compositor (gpu.js) when it can run, otherwise the 2D canvas path above
  let engine = 'auto', gpuFailedFrames = 0;
  try { const e = localStorage.getItem('dittoEngine'); if (e === 'gpu' || e === '2d' || e === 'auto') engine = e; } catch (e) { /* storage unavailable */ }
  function useGpu() { return engine !== '2d' && gpuFailedFrames < 3 && typeof GpuComp !== 'undefined' && GpuComp.available(); }
  function setEngine(k) {
    engine = k === '2d' || k === 'gpu' ? k : 'auto'; gpuFailedFrames = 0;
    try { localStorage.setItem('dittoEngine', engine); } catch (e) { /* ignore */ }
    resize();
  }

  // Works out what to draw for one clip (same rules as drawClip) and hands it to the GPU compositor as a layer description.
  function gpuLayer(c0, t, notes) {
    const c = fxView(c0, t - c0.start);
    const lt = t - c.start;
    const s = sourceFor(c);
    if (!s) return null;
    if (s.msg) { notes.push(s.msg); return null; }
    const g = geometry(c, lt, s);
    const fd = S.analysis.fades[c.id] || { in: 0, out: 0 };
    let alpha = DS.clamp(g.tf.opacity / 100, 0, 1);
    if (fd.in > 0 && lt < fd.in) alpha *= Math.max(0, lt / fd.in);
    if (fd.out > 0 && lt > c.dur - fd.out) alpha *= Math.max(0, (c.dur - lt) / fd.out);
    if (alpha <= 0.001) return null;
    const title = c.type === 'title';
    const masked = !title && DS.maskOn(c.fx);
    const wipe = DS.isWipe(c.tr) ? DS.WIPE_IDS.indexOf(c.tr.type) + 1 : 0;
    return { s, g, q, alpha, blend: DS.BLEND_IDS.indexOf(DS.cleanBlend(c.blend)), fx: title ? null : c.fx, grade: title ? null : gradeOf(c.fx), flipH: !!(c.fx && c.fx.flipH), flipV: !!(c.fx && c.fx.flipV),
      wipe, wipeP: wipe ? DS.wipeProgress({ dur: Math.min(c.tr.dur, c.dur) }, lt) : 0,
      mask: masked ? { n: DS.maskNorm(c.fx.mask), ce: DS.maskCentre(c.fx.mask, lt) } : null };
  }
  function renderGpu(t) {
    const notes = [], list = [];
    for (const c0 of layersAt(t)) {
      const c = c0.type === 'adjust' ? fxView(c0, t - c0.start) : c0;
      if (c.type === 'adjust') { if (filterFor(c.fx) !== 'none' || FxGL.needs(c.fx) || Creative.active(c.fx)) list.push({ adjust: true, q, fx: c.fx, grade: gradeOf(c.fx), blur: c.fx && c.fx.blur > 0 ? c.fx.blur * q : 0 }); continue; }
      const d = gpuLayer(c, t, notes);
      if (d) list.push(d);
    }
    const out = GpuComp.render(canvas.width, canvas.height, list, FxGL.lutInfo);
    if (!out) return false;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none';
    ctx.drawImage(out, 0, 0);
    ctx.setTransform(q, 0, 0, q, 0, 0);
    notes.forEach(placeholder);
    return true;
  }
  function render2d(t) {
    const p = P();
    ctx.setTransform(q, 0, 0, q, 0, 0);
    ctx.globalAlpha = 1; ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, p.width, p.height);
    layersAt(t).forEach((c) => { if (c.type === 'adjust') applyAdjust(fxView(c, t - c.start)); else drawClip(c, t); });
  }
  function render() {
    renderQueued = false;
    if (canvas.width !== cw() || canvas.height !== ch()) resize();
    const t = S.playhead;
    let done = false;
    if (useGpu()) {
      try { done = renderGpu(t); if (!done) gpuFailedFrames++; else gpuFailedFrames = 0; } catch (e) { console.warn('GPU compositor failed, using the canvas path:', e.message); gpuFailedFrames++; done = false; }
    }
    if (!done) render2d(t);
    updateSelBox();
    canvas.dispatchEvent(new Event('framerendered'));
  }
  // render the current frame n times with one compositor and wait for the work to finish: milliseconds per frame
  async function benchmark(n, which) {
    const keep = engine; engine = which === 'gpu' ? 'gpu' : '2d'; gpuFailedFrames = 0;
    try {
      const t = S.playhead; render2d(t);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { if (engine === 'gpu') { if (!renderGpu(t)) return null; } else render2d(t); }
      ctx.getImageData(0, 0, 1, 1);
      return (performance.now() - t0) / n;
    } finally { engine = keep; }
  }
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  // outline of the selected clip over the monitor
  function updateSelBox() {
    const c = S.sel.size === 1 ? S.clip(Array.from(S.sel)[0]) : null;
    const t = S.playhead;
    if (!c || c.type === 'adjust' || t < c.start || t >= DS.clipEnd(c) || (S.track(c.track) || {}).hidden) { selBox.classList.add('hidden'); return; }
    const s = sourceFor(c);
    if (!s || s.msg) { selBox.classList.add('hidden'); return; }
    const g = geometry(c, t - c.start, s);
    const k = box.clientWidth / P().width;
    const w = s.sw * g.sc * k, h = s.sh * g.sc * k;
    selBox.classList.remove('hidden');
    selBox.style.width = w + 'px'; selBox.style.height = h + 'px';
    selBox.style.left = (g.cx * k - w / 2) + 'px'; selBox.style.top = (g.cy * k - h / 2) + 'px';
    selBox.style.transform = 'rotate(' + g.tf.rot + 'deg)';
  }

  // drag selected clip around in the monitor
  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || S.sel.size !== 1) return;
    const c = S.clip(Array.from(S.sel)[0]);
    const t = S.playhead;
    if (!c || c.type === 'adjust' || t < c.start || t >= DS.clipEnd(c) || (S.track(c.track) || {}).lock) return;
    const lt = t - c.start, tf = DS.tfAt(c, lt);
    drag = { c, sx: e.clientX, sy: e.clientY, x0: tf.x, y0: tf.y, moved: false };
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const k = P().width / box.clientWidth;
    if (!drag.moved) { if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 3) return; drag.moved = true; S.checkpoint('mon-' + drag.c.id); }
    let nx = drag.x0 + (e.clientX - drag.sx) * k, ny = drag.y0 + (e.clientY - drag.sy) * k;
    if (e.shiftKey) { if (Math.abs(nx - drag.x0) > Math.abs(ny - drag.y0)) ny = drag.y0; else nx = drag.x0; }
    S.setTf(drag.c, 'x', Math.round(nx)); S.setTf(drag.c, 'y', Math.round(ny));
    S.change();
  });
  const endDrag = () => { drag = null; };
  box.addEventListener('pointerup', endDrag);
  box.addEventListener('pointercancel', endDrag);

  // ------------------------------------------------------------ transport
  function loop(now) {
    if (!S.playing) return;
    const total = S.duration();
    let t = headStart + (now - wall) / 1000;
    if (t >= total) {
      S.playhead = total; stop(); S.emit('time'); return;
    }
    S.playhead = t;
    sync(true);
    render();
    S.emit('time', 'play');
    raf = requestAnimationFrame(loop);
  }
  function play() {
    if (S.playing) return;
    const total = S.duration();
    if (total <= 0) return;
    if (S.playhead >= total - 0.02) S.playhead = 0;
    S.playing = true; headStart = S.playhead; wall = performance.now();
    S.emit('transport');
    raf = requestAnimationFrame(loop);
  }
  function stop() {
    if (!S.playing) return;
    S.playing = false;
    cancelAnimationFrame(raf);
    sync(false);
    S.emit('transport');
    requestRender();
  }
  function toggle() { if (S.playing) stop(); else play(); }

  // ------------------------------------------------------------ wiring
  S.on('time', (src) => { if (src === 'play') return; sync(S.playing); requestRender(); });
  S.on('change', (structural) => { if (structural) prune(); sync(S.playing); requestRender(); });
  S.on('select', requestRender);
  S.on('load', () => { for (const id of Array.from(pool.keys())) dispose(id); titles.clear(); imgs.clear(); resize(); });
  S.on('media', requestRender);
  new ResizeObserver(resize).observe(wrap);

  function setQuality(k) { q = k; resize(); requestRender(); }
  const qSel = $('#monQ');
  if (qSel) qSel.addEventListener('change', () => setQuality(parseFloat(qSel.value) || 1));
  const gChk = $('#monGuides');
  if (gChk) {
    try { gChk.checked = localStorage.getItem('ditto.guides') === '1'; } catch (e) { /* ignore */ }
    const upd = () => { $('#guides').classList.toggle('hidden', !gChk.checked); try { localStorage.setItem('ditto.guides', gChk.checked ? '1' : '0'); } catch (e) { /* ignore */ } };
    gChk.addEventListener('change', upd); upd();
  }
  // output level meter: the loudest sample of each channel, falling back slowly so short peaks can be seen
  const vu = $('#vu');
  if (vu) {
    const bars = vu.querySelectorAll('i'), hold = [-60, -60];
    const tick = () => {
      const lv = AudioFx.levels();
      for (let i = 0; i < 2; i++) {
        const d = Math.max(-60, Math.min(0, lv[i]));
        hold[i] = Math.max(d, hold[i] - 1.2);
        const w = ((hold[i] + 60) / 60 * 100).toFixed(1) + '%';
        if (bars[i].style.width !== w) bars[i].style.width = w;
        bars[i].classList.toggle('hot', lv[i] > -0.3);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  const engSel = $('#monEngine');
  if (engSel) { engSel.value = engine; engSel.addEventListener('change', () => setEngine(engSel.value)); }
  return { setEngine, engine: () => (useGpu() ? 'gpu' : '2d'), benchmark, render2d, renderGpu, GpuComp, resize, render, requestRender, play, stop, toggle, titleCanvas, sync, dispose, disposeClip: (c) => dispose(keyOf(c)), filterFor, FxGL, setQuality };
})();
