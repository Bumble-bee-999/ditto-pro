'use strict';
/*
 * Ditto Pro — GPU compositor (WebGL2).
 *
 * The preview used to draw every layer with the 2D canvas. This module draws the whole frame on the graphics card instead:
 * each layer is one pass that samples the video / picture texture through its transform and crop, runs the colour work
 * (LUT, sharpen, vignette, chroma key, brightness, contrast, saturation, hue, grey, sepia), cuts the mask, applies opacity and
 * is blended onto the frame. Blur is a separable Gaussian. Adjustment layers are full-frame passes. Nothing is read back
 * to the CPU. Video is decoded by Chromium's hardware decoder (D3D11 / VAAPI) and its frames go straight to textures.
 *
 * Player (player.js) works out WHAT to draw (geometry, fades, transitions, keyframes); this file only draws it.
 * If WebGL2 is missing or a frame cannot be drawn here, Player falls back to the 2D canvas path, which stays in the app
 * and is the reference the tests compare this against.
 */
const GpuComp = (() => {
  let gl = null, cv = null, failed = false, lost = false;
  let W = 0, H = 0;
  const P = {};                       // programs
  const texCache = new Map();         // source element -> { tex, key, mip, used }
  const lutTex = new Map();           // lut path -> texture
  let frames = [null, null], layerT = null, tmpT = null, glowT = null, blendT = null, cur = 0, frameNo = 0, maxTex = 4096;
  const uni = new WeakMap();

  const VS = '#version 300 es\nvoid main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }';

  // colour work shared by the layer pass and the adjustment pass; the caller defines  vec4 fetchS(vec2 uv)  (straight alpha)
  const COMMON = [
    'uniform vec2 uFxSize; uniform float uSharp, uVig, uKeyOn, uSim, uBlend, uLutOn, uLutN, uGradeOn, uGradeN; uniform vec3 uKey; uniform sampler2D uLut, uGrade;',
    'uniform float uBr, uCt, uSat, uHueOn, uGray, uSepia; uniform mat3 uHue;',
    'uniform float uInvert, uPoster, uThresh, uMosaic, uRelief, uGrain, uSeed, uSplit, uLumaOn, uLumaT, uLumaTol, uLumaSoft; uniform vec2 uFxOrg; uniform vec3 uGrainA;',
    'uvec3 pcg3d(uvec3 v){ v = v * 1664525u + 1013904223u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; v ^= v >> 16u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; return v; }',
    'vec3 lutTap(sampler2D t, float N, float r, float g, float b){ return texture(t, vec2((b * N + r + 0.5) / (N * N), (g + 0.5) / N)).rgb; }',
    'vec3 lutB(sampler2D t, float N, float r, float g, float b, vec3 f){ float r1 = min(r + 1.0, N - 1.0), g1 = min(g + 1.0, N - 1.0);',
    '  vec3 c00 = mix(lutTap(t, N, r, g, b), lutTap(t, N, r1, g, b), f.r); vec3 c10 = mix(lutTap(t, N, r, g1, b), lutTap(t, N, r1, g1, b), f.r); return mix(c00, c10, f.g); }',
    'vec3 applyLut(sampler2D t, float N, vec3 c){ vec3 p = clamp(c, 0.0, 1.0) * (N - 1.0); vec3 i = floor(p); vec3 f = p - i; float b1 = min(i.b + 1.0, N - 1.0);',
    '  return mix(lutB(t, N, i.r, i.g, i.b, f), lutB(t, N, i.r, i.g, b1, f), f.b); }',
    // the CSS filter functions, in the order the 2D path applies them, each clamped like a colour-matrix filter
    'vec3 cssFilters(vec3 c){',
    '  if (uBr != 1.0) c = clamp(c * uBr, 0.0, 1.0);',
    '  if (uCt != 1.0) c = clamp((c - 0.5) * uCt + 0.5, 0.0, 1.0);',
    '  if (uSat != 1.0) { float s = uSat; c = clamp(mat3(0.213 + 0.787 * s, 0.213 - 0.213 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.715 + 0.285 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.072 - 0.072 * s, 0.072 + 0.928 * s) * c, 0.0, 1.0); }',
    '  if (uHueOn > 0.5) c = clamp(uHue * c, 0.0, 1.0);',
    '  if (uGray > 0.5) c = vec3(dot(c, vec3(0.2126, 0.7152, 0.0722)));',
    '  if (uSepia > 0.5) c = clamp(mat3(0.393, 0.349, 0.272, 0.769, 0.686, 0.534, 0.189, 0.168, 0.131) * c, 0.0, 1.0);',
    '  return c; }',
    'vec4 fxPoint(vec2 uv, bool allowKey){',
    '  vec4 c = fetchS(uv);',
    '  if (uLutOn > 0.5) c.rgb = applyLut(uLut, uLutN, c.rgb);',
    '  if (uGradeOn > 0.5) c.rgb = applyLut(uGrade, uGradeN, c.rgb);',
    '#ifdef F_SHARP',
    '  if (uSharp > 0.0) { vec2 px = 1.0 / uFxSize; vec3 sum = vec3(0.0);',
    '    for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) sum += fetchS(uv + vec2(float(i), float(j)) * px).rgb;',
    '    c.rgb = c.rgb + uSharp * (c.rgb - sum / 25.0); }',
    '#endif',
    '  if (uVig > 0.0) { float d = length((uv - 0.5) * uFxSize) / (0.5 * length(uFxSize));',
    '    float f = pow(cos(min(uVig * d, 1.5707963)), 4.0); c.rgb *= f; }',
    '  float a = c.a;',
    '  if (allowKey && uKeyOn > 0.5) { float d = distance(c.rgb, uKey) / 1.7320508; a = uBlend > 0.0 ? clamp((d - uSim) / uBlend, 0.0, 1.0) : step(uSim, d); }',
    '  c.rgb = cssFilters(clamp(c.rgb, 0.0, 1.0));',
    // creative per-pixel effects, the export's order and formulas (invert, posterize, threshold)
    '  if (uInvert > 0.5) c.rgb = 1.0 - c.rgb;',
    '  if (uPoster >= 2.0) { float L = uPoster - 1.0; c.rgb = floor(c.rgb * L + 0.5) / L; }',
    '  if (uThresh > 0.0) { float y = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)); c.rgb = vec3(clamp((y - uThresh) / 0.002, 0.0, 1.0)); }',
    '  return vec4(c.rgb, a); }',
    // mosaic: the average of the block's colour (6 x 6 taps across the block)
    'vec4 fxBase0(vec2 uv, bool allowKey){',
    '#ifdef F_MOSAIC',
    '  if (uMosaic >= 2.0) { vec2 b = floor((uv * uFxSize - uFxOrg) / uMosaic) * uMosaic + uFxOrg; vec4 acc = vec4(0.0);',
    '    for (int i = 0; i < MOS_N; i++) for (int j = 0; j < MOS_N; j++) { vec2 pp = min((b + (vec2(float(i), float(j)) + 0.5) / float(MOS_N) * uMosaic) / uFxSize, vec2(1.0)); acc += fxPoint(pp, allowKey); }',
    '    return acc / float(MOS_N * MOS_N); }',
    '#endif',
    '  return fxPoint(uv, allowKey); }',
    // RGB split: red looks right of the pixel, blue left (the export's rgbashift rh=-n:bh=n)
    'vec4 fxBase(vec2 uv, bool allowKey){',
    '#ifdef F_SPLIT',
    '  if (uSplit > 0.0) {',
    '  vec2 d = vec2(uSplit / uFxSize.x, 0.0); vec4 c = fxBase0(uv, allowKey);',
    '  c.r = fxBase0(uv + d, allowKey).r; c.b = fxBase0(uv - d, allowKey).b; return c; }',
    '#endif',
    '  return fxBase0(uv, allowKey); }',
    'float lumaAt(vec2 uv, bool k){ return dot(fxBase(uv, k).rgb, vec3(0.2126, 0.7152, 0.0722)); }',
    'vec4 fxRun(vec2 uv, bool allowKey){',
    '  vec4 c = fxBase(uv, allowKey);',
    '#ifdef F_RELIEF',
    '  if (uRelief > 0.5) {',
    '    vec2 px = 1.0 / uFxSize; float s;',
    '    if (uRelief < 1.5) s = -2.0 * lumaAt(uv + vec2(-1.0, -1.0) * px, allowKey) - lumaAt(uv + vec2(0.0, -1.0) * px, allowKey) - lumaAt(uv + vec2(-1.0, 0.0) * px, allowKey)',
    '        + lumaAt(uv + vec2(1.0, 0.0) * px, allowKey) + lumaAt(uv + vec2(0.0, 1.0) * px, allowKey) + 2.0 * lumaAt(uv + vec2(1.0, 1.0) * px, allowKey);',
    '    else { s = 8.0 * lumaAt(uv, allowKey); for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) if (i != 0 || j != 0) s -= lumaAt(uv + vec2(float(i), float(j)) * px, allowKey); }',
    '    c.rgb = vec3(uRelief < 1.5 ? 0.5114 + s : 2.0 * s - 0.0731); }',
    '#endif',
    '  if (uGrain > 0.5) { vec3 h = vec3(pcg3d(uvec3(uvec2(gl_FragCoord.xy), uint(uSeed)))) * (1.0 / 4294967295.0); c.rgb += (h * 2.0 - 1.0) * uGrainA; }',
    '  c.rgb = clamp(c.rgb, 0.0, 1.0);',
    '  if (uLumaOn > 0.5) { float y = (16.0 + 219.0 * dot(c.rgb, vec3(0.299, 0.587, 0.114))) / 255.0; float e = abs(y - uLumaT) - uLumaTol;',
    '    c.a *= uLumaSoft > 0.0 ? clamp(e / uLumaSoft, 0.0, 1.0) : (e > 0.0 ? 1.0 : 0.0); }',
    '  return c; }'
  ].join('\n');

  const FS_LAYER = [
    '#version 300 es', 'precision highp float; precision highp int;', 'out vec4 o;',
    'uniform sampler2D uSrc, uPost; uniform vec2 uOut; uniform int uMode;',
    'uniform vec2 uC, uFlip, uSrcSize; uniform float uCos, uSin, uSc, uOpacity; uniform vec4 uCrop;',
    'uniform int uMaskOn, uMaskRect, uMaskInv, uWipe; uniform vec2 uMaskC, uMaskWH; uniform float uFt, uWipeP;',
    // the wipe transitions: GLSL copy of DS.wipeCover (type 1..10 in DS.WIPE_IDS order)
    'float wipeCover(int t, vec2 q, float p){ float d = 0.0;',
    '  if (t == 1) d = q.x; else if (t == 2) d = 1.0 - q.x; else if (t == 3) d = q.y; else if (t == 4) d = 1.0 - q.y;',
    '  else if (t == 5) d = length(q - 0.5) / 0.70710678; else if (t == 6) d = max(abs(q.x - 0.5), abs(q.y - 0.5)) * 2.0;',
    '  else if (t == 7) { float a = atan(q.x - 0.5, 0.5 - q.y) / 6.2831853; d = a - floor(a); }',
    '  else if (t == 8) d = abs(q.x - 0.5) * 2.0; else if (t == 9) d = abs(q.y - 0.5) * 2.0;',
    '  else if (t == 10) { float f = q.y * 8.0; d = f - floor(f); }',
    '  else if (t == 11) { float f = q.x * 8.0; d = f - floor(f); } else if (t == 12) d = (q.x + q.y) * 0.5; else if (t == 13) d = (q.x + 1.0 - q.y) * 0.5;',
    '  else if (t == 14) d = min(1.0, abs(q.x - 0.5) + abs(q.y - 0.5)); else if (t == 15) d = min(abs(q.x - 0.5), abs(q.y - 0.5)) * 2.0;',
    '  else if (t == 16) d = 0.9 * q.x + 0.05 + 0.05 * sin(q.y * 25.132741);',
    '  else if (t == 17) d = mod(floor(q.x * 8.0) + floor(q.y * 8.0), 2.0) * 0.5 + 0.5 * fract(q.x * 8.0);',
    '  else if (t == 18) d = fract(floor(q.x * 12.0) * 0.7548776662 + floor(q.y * 8.0) * 0.569840291);',
    '  else if (t == 19) { float a = atan(q.x - 0.5, 0.5 - q.y) / 6.2831853; d = fract(a - floor(a) + length(q - 0.5) * 1.5); } else return 1.0;',
    '  return clamp((p * 1.03 - d) / 0.03, 0.0, 1.0); }',
    'vec4 fetchS(vec2 uv){ vec4 t = texture(uSrc, uv); return t.a > 0.0 ? vec4(t.rgb / t.a, t.a) : vec4(0.0); }',
    COMMON,
    'void main(){',
    '  vec2 p = vec2(gl_FragCoord.x, uOut.y - gl_FragCoord.y);',
    '  vec2 d = p - uC;',
    '  vec2 l = vec2(d.x * uCos + d.y * uSin, -d.x * uSin + d.y * uCos) / uSc;',   // picture pixels, centred, before flips
    '  float m = 1.0;',
    '  vec2 uvm = (l * uFlip) / uCrop.zw + 0.5;',                                  // picture coordinates after the flips, as the export masks them
    '  if (uWipe > 0) m *= wipeCover(uWipe, uvm, uWipeP);',
    '  if (uMaskOn == 1) {',                                                       // the same reference as DS.maskCover / the export
    '    vec2 q = abs(uvm * 100.0 - uMaskC) / (uMaskWH * 0.5);',
    '    float dd = uMaskRect == 1 ? max(q.x, q.y) : length(q);',
    '    float mk = clamp((1.0 - dd) / uFt + 0.5, 0.0, 1.0);',
    '    m *= uMaskInv == 1 ? 1.0 - mk : mk; }',
    '  if (uMode == 1) { o = texture(uPost, gl_FragCoord.xy / uOut) * (m * uOpacity); return; }',
    '  vec2 lf = l * uFlip; vec2 hf = uCrop.zw * 0.5;',
    '  vec2 e = (hf - abs(lf)) * uSc + 0.5;',
    '  float cov = clamp(e.x, 0.0, 1.0) * clamp(e.y, 0.0, 1.0);',
    '  if (cov <= 0.0) { o = vec4(0.0); return; }',
    '  vec2 uv = (uCrop.xy + hf + lf) / uSrcSize;',
    '  vec4 c = fxRun(uv, true);',
    '  o = vec4(c.rgb * c.a, c.a) * (cov * m * uOpacity);',
    '}'
  ].join('\n');

  const FS_ADJUST = [
    '#version 300 es', 'precision highp float; precision highp int;', 'out vec4 o;',
    'uniform sampler2D uSrc; uniform vec2 uOut;',
    'vec4 fetchS(vec2 uv){ return vec4(texture(uSrc, uv).rgb, 1.0); }',
    COMMON,
    'void main(){ vec4 c = fxRun(gl_FragCoord.xy / uOut, false); o = vec4(c.rgb, 1.0); }'
  ].join('\n');

  const FS_BLUR = [
    '#version 300 es', 'precision highp float; precision highp int;', 'out vec4 o;',
    'uniform sampler2D uSrc; uniform vec2 uOut, uDir; uniform float uSigma, uStride, uBright, uThr; uniform int uRad;',
    'void main(){',
    '  vec2 uv = gl_FragCoord.xy / uOut; vec4 sum = vec4(0.0); float ws = 0.0;',
    '  for (int i = -uRad; i <= uRad; i++) { float x = float(i) * uStride; float w = exp(-0.5 * x * x / (uSigma * uSigma));',
    '    vec4 t = texture(uSrc, uv + uDir * x / uOut);',
    '    if (uBright > 0.5) t.rgb = clamp((t.rgb - uThr * t.a) / (1.0 - uThr), 0.0, 1.0);',     // glow: only the bright part (premultiplied)
    '    sum += t * w; ws += w; }',
    '  o = sum / ws;',
    '}'
  ].join('\n');

  // glow: the picture screened with its own blurred bright parts (never outside the picture's own alpha)
  const FS_SCREEN = [
    '#version 300 es', 'precision highp float; precision highp int;', 'out vec4 o;',
    'uniform sampler2D uSrc, uGlow; uniform vec2 uOut; uniform float uAmt, uOpaque;',
    'void main(){ vec2 uv = gl_FragCoord.xy / uOut; vec4 a = texture(uSrc, uv); vec3 g = texture(uGlow, uv).rgb * uAmt;',
    '  vec3 r = 1.0 - (1.0 - a.rgb) * (1.0 - g); o = vec4(min(r, vec3(uOpaque > 0.5 ? 1.0 : a.a)), a.a); }'
  ].join('\n');

  // blend modes: the layer (premultiplied, in uLayer) is mixed with the frame so far by DS.blendPx's formulas
  const FS_BLEND = [
    '#version 300 es', 'precision highp float; precision highp int;', 'out vec4 o;',
    'uniform sampler2D uBase, uLayer; uniform vec2 uOut; uniform int uBMode;',
    'vec3 bl(vec3 b, vec3 s){',
    '  if (uBMode == 1) return b * s; if (uBMode == 2) return 1.0 - (1.0 - b) * (1.0 - s);',
    '  if (uBMode == 3) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));',
    '  if (uBMode == 4) return min(b, s); if (uBMode == 5) return max(b, s); if (uBMode == 6) return min(vec3(1.0), b + s);',
    '  if (uBMode == 7) return abs(b - s); if (uBMode == 8) return b + s - 2.0 * b * s;',
    '  if (uBMode == 9) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, s));',
    '  return s; }',
    'void main(){ vec2 uv = gl_FragCoord.xy / uOut; vec4 B = texture(uBase, uv); vec4 L = texture(uLayer, uv);',
    '  if (L.a <= 0.0) { o = B; return; }',
    '  vec3 s = clamp(L.rgb / L.a, 0.0, 1.0); o = vec4(mix(B.rgb, bl(B.rgb, s), L.a), B.a); }'
  ].join('\n');

  function compile(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  // Shader variants: the nested effect loops (mosaic taps x RGB-split x relief taps x sharpen) multiply, so each program is built
  // with only the features the layer uses; the mosaic tap grid shrinks when several multipliers stack (keeps compile time and size sane).
  const variants = new Map();
  function flagsOf(fx) { fx = fx || {}; return (fx.mosaic >= 2 ? 1 : 0) | (fx.rgbsplit > 0 ? 2 : 0) | (fx.emboss || fx.edges ? 4 : 0) | (fx.sharpen > 0 ? 8 : 0); }
  function variant(kind, fx) {
    const f = flagsOf(fx), key = kind + f;
    let p = variants.get(key);
    if (!p) {
      const inst = (f & 4 ? 9 : 1) * (f & 2 ? 3 : 1) * (f & 8 ? 8 : 1);
      let n = 6; while (n > 2 && inst * n * n > 330) n--;
      const defs = [f & 1 ? '#define F_MOSAIC' : '', f & 2 ? '#define F_SPLIT' : '', f & 4 ? '#define F_RELIEF' : '', f & 8 ? '#define F_SHARP' : '', '#define MOS_N ' + n].join('\n');
      p = program((kind === 'layer' ? FS_LAYER : FS_ADJUST).replace('#version 300 es\n', '#version 300 es\n' + defs + '\n'));
      variants.set(key, p);
    }
    return p;
  }
  function program(fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    uni.set(p, {});
    return p;
  }
  function U(p, n) { const m = uni.get(p); if (!(n in m)) m[n] = gl.getUniformLocation(p, n); return m[n]; }
  const u1f = (p, n, v) => gl.uniform1f(U(p, n), v);
  const u1i = (p, n, v) => gl.uniform1i(U(p, n), v);
  const u2f = (p, n, a, b) => gl.uniform2f(U(p, n), a, b);

  function target(w, h) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete');
    return { tex: t, fbo: f };
  }
  function freeTargets() {
    [frames[0], frames[1], layerT, tmpT, glowT, blendT].forEach((t) => { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); } });
    frames = [null, null]; layerT = tmpT = glowT = blendT = null;
  }
  function size(w, h) {
    if (w === W && h === H && frames[0]) return;
    freeTargets();
    W = w; H = h; cv.width = w; cv.height = h;
    frames = [target(w, h), target(w, h)]; layerT = target(w, h); tmpT = target(w, h); glowT = target(w, h); blendT = null;
  }

  function init() {
    if (lost || failed) return false;
    if (gl) return true;
    try {
      cv = cv || document.createElement('canvas');
      gl = cv.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
      if (!gl) throw new Error('WebGL2 is not available');
      variants.clear(); variant('layer', null); variant('adjust', null); P.blur = program(FS_BLUR); P.screen = program(FS_SCREEN); P.blend = program(FS_BLEND);
      maxTex = Math.min(16384, gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096);
      cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; texCache.clear(); lutTex.clear(); gradeTex.clear(); frames = [null, null]; layerT = tmpT = glowT = blendT = null; W = H = 0; }, false);
      cv.addEventListener('webglcontextrestored', () => { lost = false; try { variants.clear(); variant('layer', null); variant('adjust', null); P.blur = program(FS_BLUR); P.screen = program(FS_SCREEN); P.blend = program(FS_BLEND); } catch (e) { failed = true; } if (global.Player) global.Player.requestRender(); }, false);
      return true;
    } catch (e) { console.warn('GPU compositor unavailable:', e.message); gl = null; failed = true; return false; }
  }
  const global = typeof window !== 'undefined' ? window : {};

  // ---- source textures (one per video / picture / title canvas; uploaded only when the picture changed)
  function srcKey(src) {
    if (src instanceof HTMLVideoElement) {
      let n = 0; try { n = src.getVideoPlaybackQuality().totalVideoFrames; } catch (e) { n = Math.random(); }
      return src.currentTime + '|' + n + '|' + src.videoWidth + '|' + src.readyState;
    }
    if (src instanceof HTMLImageElement) return src.src + '|' + src.naturalWidth;
    return (src._k || '') + '|' + src.width + 'x' + src.height;
  }
  function texFor(src, wantMip) {
    let e = texCache.get(src);
    if (!e) {
      e = { tex: gl.createTexture(), key: null, mip: false, used: 0 };
      gl.bindTexture(gl.TEXTURE_2D, e.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      texCache.set(src, e);
    }
    e.used = frameNo;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, e.tex);
    const key = srcKey(src);
    let fresh = false;
    if (e.key !== key) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
      e.key = key; fresh = true;
    }
    if (wantMip && (fresh || !e.mip)) { gl.generateMipmap(gl.TEXTURE_2D); e.mip = true; }
    if (!wantMip && e.mip && fresh) e.mip = false;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, wantMip && e.mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    return e;
  }
  function lutFor(path, info) {
    let t = lutTex.get(path);
    if (!t) {
      t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, info.size * info.size, info.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, info.pixels);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      lutTex.set(path, t);
    }
    return t;
  }
  function sweep() {
    if (texCache.size <= 40) return;
    for (const [k, e] of texCache) if (e.used < frameNo - 200) { gl.deleteTexture(e.tex); texCache.delete(k); }
  }

  // ---- colour uniforms (shared by the layer and adjust programs)
  const hueMat = (deg) => {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const r = [[0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
      [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
      [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]];
    return new Float32Array([r[0][0], r[1][0], r[2][0], r[0][1], r[1][1], r[2][1], r[0][2], r[1][2], r[2][2]]);   // column-major
  };
  const hexRgb = (h) => { const n = parseInt(String(h || '#00ff00').replace('#', ''), 16) || 0; return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
  function colourUniforms(p, fx, fxW, fxH, allowKey, lutInfo, grade, mscale, org) {
    fx = fx || {};
    u2f(p, 'uFxSize', fxW, fxH);
    u1f(p, 'uSharp', fx.sharpen > 0 ? fx.sharpen / 50 : 0);
    u1f(p, 'uVig', fx.vignette > 0 ? fx.vignette / 100 * Math.PI / 3 : 0);
    const ch = fx.chroma || {};
    u1f(p, 'uKeyOn', allowKey && ch.on ? 1 : 0);
    gl.uniform3fv(U(p, 'uKey'), hexRgb(ch.color));
    u1f(p, 'uSim', (ch.sim || 30) / 100); u1f(p, 'uBlend', (ch.blend || 0) / 100);
    u1f(p, 'uBr', fx.brightness ? 1 + fx.brightness / 100 : 1);
    u1f(p, 'uCt', fx.contrast ? 1 + fx.contrast / 100 : 1);
    u1f(p, 'uSat', fx.saturation != null && fx.saturation !== 100 ? fx.saturation / 100 : 1);
    u1f(p, 'uHueOn', fx.hue ? 1 : 0);
    if (fx.hue) gl.uniformMatrix3fv(U(p, 'uHue'), false, hueMat(fx.hue));
    u1f(p, 'uGray', fx.gray ? 1 : 0); u1f(p, 'uSepia', fx.sepia ? 1 : 0);
    u1f(p, 'uInvert', fx.invert ? 1 : 0); u1f(p, 'uPoster', fx.posterize >= 2 ? fx.posterize : 0);
    u1f(p, 'uThresh', fx.threshold > 0 ? fx.threshold / 100 : 0);
    u1f(p, 'uMosaic', fx.mosaic >= 2 ? fx.mosaic * (mscale || 1) : 0);
    u2f(p, 'uFxOrg', org ? org[0] : 0, org ? org[1] : 0);
    u1f(p, 'uRelief', fx.emboss ? 1 : fx.edges ? 2 : 0);
    u1f(p, 'uSplit', fx.rgbsplit > 0 ? fx.rgbsplit * (mscale || 1) : 0);
    const lk = fx.lumakey; const lkOn = allowKey && lk && lk.on;
    u1f(p, 'uLumaOn', lkOn ? 1 : 0); u1f(p, 'uLumaT', lkOn ? lk.threshold / 100 : 0); u1f(p, 'uLumaTol', lkOn ? lk.tolerance / 100 : 0); u1f(p, 'uLumaSoft', lkOn ? lk.softness / 100 : 0);
    u1f(p, 'uGrain', fx.grain > 0 ? 1 : 0); u1f(p, 'uSeed', frameNo);
    gl.uniform3f(U(p, 'uGrainA'), Creative.grainAmp(fx.grain || 0, 0), Creative.grainAmp(fx.grain || 0, 1), Creative.grainAmp(fx.grain || 0, 2));
    if (lutInfo) {
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, lutFor(fx.lut.path, lutInfo)); gl.activeTexture(gl.TEXTURE0);
      u1i(p, 'uLut', 1); u1f(p, 'uLutN', lutInfo.size); u1f(p, 'uLutOn', 1);
    } else { u1i(p, 'uLut', 1); u1f(p, 'uLutOn', 0); }
    if (grade) {
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, gradeFor(grade)); gl.activeTexture(gl.TEXTURE0);
      u1i(p, 'uGrade', 3); u1f(p, 'uGradeN', grade.size); u1f(p, 'uGradeOn', 1);
    } else { u1i(p, 'uGrade', 3); u1f(p, 'uGradeOn', 0); }
  }
  // grade textures (baked by DG): one per distinct grade, kept while in use
  const gradeTex = new Map();
  function gradeFor(g) {
    let e = gradeTex.get(g.key);
    if (!e) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, g.size * g.size, g.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, g.pixels);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      e = { t, used: frameNo }; gradeTex.set(g.key, e);
      if (gradeTex.size > 24) for (const [k, v] of gradeTex) if (v.used < frameNo - 50) { gl.deleteTexture(v.t); gradeTex.delete(k); }
    }
    e.used = frameNo;
    return e.t;
  }

  let curSc = [0, 0, 1, 1];
  function scissor(x0, y0, x1, y1) {   // top-left origin box in output pixels
    const a = Math.max(0, Math.floor(x0)), b = Math.max(0, Math.floor(y0)), c = Math.min(W, Math.ceil(x1)), d = Math.min(H, Math.ceil(y1));
    if (c <= a || d <= b) return false;
    gl.enable(gl.SCISSOR_TEST); gl.scissor(a, H - d, c - a, d - b); curSc = [a, H - d, c - a, d - b];
    return true;
  }
  const bind = (t) => { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.viewport(0, 0, W, H); };
  const tri = () => gl.drawArrays(gl.TRIANGLES, 0, 3);


  // one Gaussian pass (dir = 1,0 or 0,1) from srcTex into dst; bright = also keep only the part above thr (the glow's bright pass)
  function blurPass(srcTex, dst, dx, dy, sigma, bright, thr) {
    const b = P.blur; gl.useProgram(b);
    const stride = Math.max(1, Math.ceil(sigma * 3 / 40)), rad = Math.min(48, Math.ceil(sigma * 3 / stride));
    u1i(b, 'uSrc', 0); u2f(b, 'uOut', W, H); u1f(b, 'uSigma', sigma); u1f(b, 'uStride', stride); u1i(b, 'uRad', rad);
    u1f(b, 'uBright', bright ? 1 : 0); u1f(b, 'uThr', thr || 0); u2f(b, 'uDir', dx, dy);
    bind(dst); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex); tri();
  }
  const clearFull = (t) => { gl.disable(gl.SCISSOR_TEST); bind(t); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); if (curSc[2] < W || curSc[3] < H || true) { gl.enable(gl.SCISSOR_TEST); gl.scissor(curSc[0], curSc[1], curSc[2], curSc[3]); } };
  /** glow of the picture in srcT: bright parts -> blur -> screen. Result lands in dstT (srcT and dstT must differ, tmpT and glowT are scratch). */
  function glowInto(srcT, dstT, g, sigma) {
    blurPass(srcT.tex, tmpT, 1, 0, sigma, true, g.threshold / 100);
    blurPass(tmpT.tex, glowT, 0, 1, sigma, false, 0);
    const sp = P.screen; gl.useProgram(sp);
    u1i(sp, 'uSrc', 0); u1i(sp, 'uGlow', 1); u2f(sp, 'uOut', W, H); u1f(sp, 'uAmt', g.amount / 100); u1f(sp, 'uOpaque', 0);
    bind(dstT); gl.disable(gl.BLEND); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcT.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, glowT.tex);
    tri();
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null); gl.activeTexture(gl.TEXTURE0);
  }

  function drawLayer(d, lutOf) {
    const p = variant('layer', d.fx), s = d.s, g = d.g, q = d.q;
    const sc = g.sc * q, cx = g.cx * q, cy = g.cy * q;
    const rot = g.tf.rot * Math.PI / 180, cs = Math.cos(rot), sn = Math.sin(rot);
    const hw = s.sw / 2 * sc, hh = s.sh / 2 * sc;
    const ex = Math.abs(hw * cs) + Math.abs(hh * sn), ey = Math.abs(hw * sn) + Math.abs(hh * cs);
    const blur = d.fx && d.fx.blur > 0 ? d.fx.blur * q : 0;
    const gl_ = d.fx && d.fx.glow && d.fx.glow.amount > 0 ? d.fx.glow : null;
    const gSigma = gl_ ? Math.max(0.5, gl_.size / 100 * s.sw * 0.25) * sc : 0;
    const pad = 2 + (blur > 0 ? Math.ceil(blur * 3) : 0) + (gl_ ? Math.ceil(gSigma * 3) : 0);
    if (!scissor(cx - ex - pad, cy - ey - pad, cx + ex + pad, cy + ey + pad)) { gl.disable(gl.SCISSOR_TEST); return; }
    const bmode = d.blend > 0 ? d.blend : 0;
    if (bmode && !blendT) blendT = target(W, H);
    // where the finished layer goes: straight onto the frame, or (blend mode) alone onto its own transparent target
    const toDst = () => {
      if (bmode) { clearFull(blendT); gl.disable(gl.BLEND); }
      else { bind(frames[cur]); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
    };
    const mip = sc < 0.6;
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, null);   // never leave the blur result bound while a pass can render into it
    gl.activeTexture(gl.TEXTURE0);
    texFor(s.src, mip);
    gl.useProgram(p);
    u1i(p, 'uSrc', 0); u1i(p, 'uPost', 2);
    u2f(p, 'uOut', W, H);
    u2f(p, 'uC', cx, cy); u1f(p, 'uCos', cs); u1f(p, 'uSin', sn); u1f(p, 'uSc', sc);
    u2f(p, 'uFlip', d.flipH ? -1 : 1, d.flipV ? -1 : 1);
    gl.uniform4f(U(p, 'uCrop'), s.sx, s.sy, s.sw, s.sh);
    u2f(p, 'uSrcSize', s.rw, s.rh);
    const fx = d.fx;
    const lutInfo = fx && fx.lut && fx.lut.path ? lutOf(fx.lut.path) : null;
    colourUniforms(p, fx, s.rw, s.rh, true, lutInfo && lutInfo.state === 'ready' ? lutInfo : null, d.grade, 1, [s.sx, s.sy]);
    const mk = d.mask;
    u1i(p, 'uMaskOn', mk ? 1 : 0);
    if (mk) {
      u1i(p, 'uMaskRect', mk.n.shape === 'rect' ? 1 : 0); u1i(p, 'uMaskInv', mk.n.invert ? 1 : 0);
      u2f(p, 'uMaskC', mk.ce.cx, mk.ce.cy); u2f(p, 'uMaskWH', mk.n.w, mk.n.h);
      u1f(p, 'uFt', Math.max(0.002, mk.n.feather / 100));
    }
    const wp = d.wipe || 0;
    u1i(p, 'uWipe', wp); u1f(p, 'uWipeP', d.wipeP || 0);
    if (blur > 0 || gl_) {
      // 1: the layer alone (no mask / wipe / opacity) -> 2: Gaussian blur -> 3: glow -> 4: mask, wipe and opacity onto the frame
      clearFull(layerT);
      gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 0);
      u1i(p, 'uMode', 0); u1f(p, 'uOpacity', 1); u1i(p, 'uMaskOn', 0); u1i(p, 'uWipe', 0);
      gl.activeTexture(gl.TEXTURE0); texFor(s.src, mip);
      tri();
      let res = layerT;
      if (blur > 0) {
        blurPass(layerT.tex, tmpT, 1, 0, blur, false, 0);
        blurPass(tmpT.tex, layerT, 0, 1, blur, false, 0);
      }
      if (gl_) { clearFull(tmpT); clearFull(glowT); glowInto(layerT, tmpT, gl_, gSigma); res = tmpT; }
      gl.useProgram(p); u1i(p, 'uMaskOn', mk ? 1 : 0); u1i(p, 'uWipe', wp);
      toDst();
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, res.tex); gl.activeTexture(gl.TEXTURE0);
      u1i(p, 'uMode', 1); u1f(p, 'uOpacity', d.alpha);
      tri();
    } else {
      toDst();
      u1i(p, 'uMode', 0); u1f(p, 'uOpacity', d.alpha);
      tri();
    }
    gl.disable(gl.SCISSOR_TEST);
    if (bmode) {   // whole-frame pass: frame so far + this layer -> the other frame
      const bp = P.blend; gl.useProgram(bp); gl.disable(gl.BLEND);
      bind(frames[1 - cur]);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, frames[cur].tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, blendT.tex);
      u1i(bp, 'uBase', 0); u1i(bp, 'uLayer', 1); u2f(bp, 'uOut', W, H); u1i(bp, 'uBMode', bmode);
      tri();
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null); gl.activeTexture(gl.TEXTURE0);
      cur = 1 - cur;
    }
  }

  function drawAdjust(d, lutOf) {
    const p = variant('adjust', d.fx), from = frames[cur], to = frames[1 - cur];
    bind(to); gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, from.tex);
    u1i(p, 'uSrc', 0); u2f(p, 'uOut', W, H);
    const lutInfo = d.fx && d.fx.lut && d.fx.lut.path ? lutOf(d.fx.lut.path) : null;
    colourUniforms(p, d.fx, W, H, false, lutInfo && lutInfo.state === 'ready' ? lutInfo : null, d.grade, d.q || 1, null);
    tri();
    cur = 1 - cur;
    const blur = d.blur > 0 ? d.blur : 0;
    if (blur > 0) {   // whole-frame Gaussian, same two passes as a layer's blur
      blurPass(frames[cur].tex, tmpT, 1, 0, blur, false, 0);
      blurPass(tmpT.tex, frames[cur], 0, 1, blur, false, 0);
    }
    const gw = d.fx && d.fx.glow && d.fx.glow.amount > 0 ? d.fx.glow : null;
    if (gw) {
      glowInto(frames[cur], frames[1 - cur], gw, Math.max(0.5, gw.size / 100 * W * 0.25));
      cur = 1 - cur;
    }
  }

  /**
   * layers: [{ adjust:true, fx } | { s, g, q, alpha, fx, flipH, flipV, mask:{ n, ce } | null }] in drawing order (bottom first).
   * Returns the WebGL canvas holding the finished frame (W x H), or null when this frame cannot be drawn here.
   */
  function render(w, h, layers, lutOf) {
    if (!init() || lost) return null;
    for (const d of layers) if (!d.adjust && (d.s.rw > maxTex || d.s.rh > maxTex || d.s.sw > maxTex)) return null;
    size(w, h);
    frameNo++;
    cur = 0;
    gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND);
    bind(frames[0]); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    for (const d of layers) { if (d.adjust) drawAdjust(d, lutOf); else drawLayer(d, lutOf); }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, frames[cur].fbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    sweep();
    return cv;
  }
  const info = () => (gl ? { renderer: (() => { try { const x = gl.getExtension('WEBGL_debug_renderer_info'); return x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch (e) { return ''; } })(), maxTexture: maxTex } : null);
  return { init, render, available: () => init() && !lost, info };
})();
