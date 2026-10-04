/*
 * Ditto Pro — export engine.
 * Turns a project (see shared.js) into an FFmpeg command line + filter graph.
 * Pure Node, no Electron, so it can be unit-tested against a real ffmpeg.
 */
'use strict';
const DS = require('./shared');
const DG = require('./grade');
const num = DS.num;
const dB = (v) => String(Math.round(Math.max(-90, Math.min(40, +v || 0)) * 1000) / 1000);   // plain number (num() would wrap negatives in brackets)

function fxChain(fx, enable, lutName, gradeName, kfp) {
  const out = [];
  if (!fx) return out;
  const E = enable ? ":enable='" + enable + "'" : '';
  if (fx.lut && lutName) out.push('lut3d=file=' + lutName + ':interp=trilinear' + E);
  if (gradeName) out.push('lut3d=file=' + gradeName + ':interp=trilinear' + E);   // the colour grade, baked to a LUT (grade.js)
  // animated values (clip keyframes): FFmpeg expressions of the clip-local time kfp.tv, evaluated every frame
  const K = kfp && kfp.kf;
  const anim = (p) => !!(K && K[p] && K[p].length > 1);
  const val = (p, d) => (K && K[p] && K[p].length === 1 ? K[p][0].v : fx[p] == null ? d : fx[p]);
  const ex = (p) => 'clip(' + DS.kfExpr(K[p], fx[p] == null ? 0 : fx[p], kfp.tv) + ',' + DS.FXRANGE[p][0] + ',' + DS.FXRANGE[p][1] + ')';
  const b = val('brightness', 0), c = val('contrast', 0), s = val('saturation', 100);
  if (b || c || s !== 100 || anim('brightness') || anim('contrast') || anim('saturation')) {
    const bb = anim('brightness') ? "'" + ex('brightness') + "/200'" : (b / 200).toFixed(4);
    const cc = anim('contrast') ? "'1+" + ex('contrast') + "/100'" : (1 + c / 100).toFixed(4);
    const ss = anim('saturation') ? "'" + ex('saturation') + "/100'" : (s / 100).toFixed(4);
    out.push('eq=brightness=' + bb + ':contrast=' + cc + ':saturation=' + ss + (anim('brightness') || anim('contrast') || anim('saturation') ? ':eval=frame' : '') + E);
  }
  if (anim('hue')) out.push("hue=h='" + ex('hue') + "'" + E);
  else if (val('hue', 0)) out.push('hue=h=' + val('hue', 0) + E);
  if (fx.gray) out.push('hue=s=0' + E);
  if (fx.sepia) out.push('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131' + E);
  // creative effects. invert / posterize / threshold are exact per-pixel maps (the preview uses the same formulas)
  if (fx.invert) out.push("lutrgb=r='negval':g='negval':b='negval'" + E);
  if (fx.posterize >= 2) { const L = fx.posterize - 1; const e = "'round(val/255*" + L + ")/" + L + "*255'"; out.push('lutrgb=r=' + e + ':g=' + e + ':b=' + e + E); }
  if (fx.threshold > 0) { const t = (fx.threshold / 100).toFixed(4), t2 = Math.min(1, fx.threshold / 100 + 0.002).toFixed(4); out.push('hue=s=0' + E, "curves=all='0/0 " + t + '/0 ' + t2 + "/1 1/1':interp=pchip" + E); }
  if (fx.mosaic >= 2) out.push('pixelize=w=' + Math.round(fx.mosaic) + ':h=' + Math.round(fx.mosaic) + ':mode=avg' + E);
  if (fx.rgbsplit > 0) out.push('format=gbrp', 'rgbashift=rh=-' + Math.round(fx.rgbsplit) + ':bh=' + Math.round(fx.rgbsplit) + E);
  // relief / edge detection on the brightness only (chroma held at neutral): a 3x3 kernel, same one the preview uses
  const zero = '0 0 0 0 0 0 0 0 0';
  const kern = (m, rdiv, bias) => 'convolution=0m=\'' + m + '\':0rdiv=' + rdiv + ':0bias=' + bias + ':1m=\'' + zero + '\':1rdiv=1:1bias=128:2m=\'' + zero + '\':2rdiv=1:2bias=128' + E;
  if (fx.emboss || fx.edges) {
    if (!enable) out.push('format=yuv420p');
    if (fx.emboss) out.push(kern('-2 -1 0 -1 0 1 0 1 2', 1, 128));
    if (fx.edges) out.push(kern('-1 -1 -1 -1 8 -1 -1 -1 -1', 0.5, 0));
  }
  if (fx.blur > 0) out.push('gblur=sigma=' + fx.blur + E);
  if (fx.sharpen > 0) out.push('unsharp=5:5:' + (fx.sharpen / 50).toFixed(2) + ':5:5:0' + E);
  if (anim('vignette')) out.push("vignette=angle='" + ex('vignette') + "/100*PI/3':eval=frame" + E);
  else if (val('vignette', 0) > 0) out.push('vignette=angle=' + (val('vignette', 0) / 100 * Math.PI / 3).toFixed(3) + E);
  if (fx.grain > 0) out.push('noise=alls=' + Math.round(fx.grain * GRAIN_K) + ':allf=t+u' + E);
  return out;
}
// film grain: FFmpeg's strength number that gives the same visible grain as the preview's 0..100 slider
const GRAIN_K = require('./creative').GRAIN_K;

/** glow = bright parts, blurred, screened back over the picture. Returns graph lines and the new label. */
function glowGraph(inLabel, fx, srcW, enable, uid) {
  const g = fx.glow;
  if (!g || !(g.amount > 0)) return null;
  const T = g.threshold / 100 * 255, sigma = Math.max(0.5, g.size / 100 * srcW * 0.25);
  const bp = "clip((val-" + T.toFixed(3) + ")*255/" + (255 - T).toFixed(3) + ",0,255)";
  const E = enable ? ":enable='" + enable + "'" : '';
  const a = 'ga' + uid, b = 'gb' + uid, c = 'gc' + uid, o = 'go' + uid;
  return {
    lines: [
      '[' + inLabel + ']split[' + a + '][' + b + ']',
      '[' + b + "]lutrgb=r='" + bp + "':g='" + bp + "':b='" + bp + "',gblur=sigma=" + sigma.toFixed(3) + '[' + c + ']',
      '[' + a + '][' + c + ']blend=all_mode=screen:all_opacity=' + (g.amount / 100).toFixed(4) + E + '[' + o + ']'
    ],
    out: o
  };
}

const HWENC = require('./hwenc');
function encoderArgs(opts) {
  const kbps = opts.audioKbps || (opts.surround ? 384 : 192);
  const q = Math.max(0, Math.min(100, opts.quality == null ? 60 : opts.quality));
  const crf = Math.round(32 - q * 0.16); // 100 -> 16, 0 -> 32
  switch (opts.format) {
    case 'mp4-h264':
    case 'mp4-h265':
      if (HWENC.pick(opts.encoder, opts.format)) return HWENC.videoArgs(opts.encoder, opts.quality).concat(['-c:a', 'aac', '-b:a', kbps + 'k', '-movflags', '+faststart']);
      if (opts.format === 'mp4-h265') return ['-c:v', 'libx265', '-preset', opts.preset || 'medium', '-crf', String(crf + 2), '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-c:a', 'aac', '-b:a', kbps + 'k', '-movflags', '+faststart'];
      return ['-c:v', 'libx264', '-preset', opts.preset || 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', kbps + 'k', '-movflags', '+faststart'];
    case 'mov-prores':
      return ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le'];
    case 'webm-vp9':
      return ['-c:v', 'libvpx-vp9', '-crf', String(crf + 4), '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', (opts.surround ? '320k' : '160k')];
    case 'nest-prores':
      return ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-c:a', 'pcm_s16le'];
    case 'gif':
      return ['-loop', '0'];
    case 'png-seq':
      return [];
    case 'frame-png': return ['-frames:v', '1', '-update', '1'];
    case 'frame-jpg': return ['-frames:v', '1', '-update', '1', '-q:v', '2'];
    case 'wav': return ['-vn', '-c:a', 'pcm_s16le'];
    case 'mp3': return ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'];
    case 'm4a': return ['-vn', '-c:a', 'aac', '-b:a', kbps + 'k'];
    default: throw new Error('Unknown export format: ' + opts.format);
  }
}

/**
 * @param project  project object
 * @param opts     { format, quality, width, height, rangeStart, rangeEnd, normalize, outPath, scriptPath, newFilterFlag }
 * @param env      { titleFiles: {clipId: pngPath} }
 * @returns { args, script, duration }
 */
function buildExport(project, opts, env) {
  env = env || {};
  const fmt = DS.FORMATS.find((f) => f.id === opts.format);
  if (!fmt) throw new Error('Unknown export format: ' + opts.format);
  const W = project.width, H = project.height, FPS = project.fps;
  const media = {};
  project.media.forEach((m) => { media[m.id] = m; });
  const trackById = {};
  project.tracks.forEach((t) => { trackById[t.id] = t; });

  const total = DS.projectDuration(project);
  if (total <= 0) throw new Error('The timeline is empty — add some clips first.');
  const rs = Math.max(0, opts.rangeStart || 0);
  const re = Math.min(total, opts.rangeEnd == null ? total : opts.rangeEnd);
  const len = re - rs;
  if (len <= 0.01) throw new Error('The export range is empty.');

  const gradeFile = (c) => (env.gradeFiles && c.fx && c.fx.color && DG.active(c.fx.color) ? env.gradeFiles[DG.key(c.fx.color)] : null);
  // every effect value is turned into a plain number in range before it reaches the filter script
  project.clips.forEach((c) => { c.fx = DS.cleanFx(c.fx); if (c.fx.color != null) c.fx.color = DG.active(c.fx.color) ? DG.normalize(c.fx.color) : null; });
  const { ext, fades } = DS.analyze(project);
  const inputs = [];
  const inputIndexOf = {};
  const addInput = (args) => { inputs.push(args); return inputs.length - 1; };
  const graph = [];
  let fc = 0; // counter for labels

  // ---------- inputs for every clip that is actually used -----------------
  const clips = project.clips.slice().sort((a, b) => a.start - b.start);
  for (const c of clips) {
    const tr = trackById[c.track];
    if (!tr || c.disabled) continue;
    if (c.type === 'media') {
      const m = media[c.media];
      if (!m) throw new Error('A clip refers to media that is missing from the project.');
      if (m.missing) throw new Error('Media file is offline (not found): ' + m.path);
      const srcDur = c.dur * (c.speed || 1);
      if (m.kind === 'image') {
        inputIndexOf[c.id] = addInput(['-loop', '1', '-framerate', String(FPS), '-t', num(c.dur + (ext[c.id] || 0)), '-i', m.path]);
      } else {
        inputIndexOf[c.id] = addInput(['-ss', String(Math.max(0, c.in)), '-t', num(srcDur + (c.ramp ? 0.15 : 0)), '-i', m.path]);
      }
    } else if (c.type === 'title') {
      const png = env.titleFiles && env.titleFiles[c.id];
      if (!png) throw new Error('Title image missing for clip ' + c.id);
      inputIndexOf[c.id] = addInput(['-loop', '1', '-framerate', String(FPS), '-t', num(c.dur + (ext[c.id] || 0)), '-i', png]);
    }
  }

  // ---------- video ------------------------------------------------------------
  let vLabel = null;
  if (fmt.video) {
    const alpha = opts.format === 'nest-prores';
    graph.push((alpha ? 'color=c=black@0:s=' : 'color=c=black:s=') + W + 'x' + H + ':r=' + FPS + ':d=' + num(total) + (alpha ? ',format=rgba[base0]' : ',format=yuv420p[base0]'));
    let cur = 'base0';
    const vtracks = project.tracks.filter((t) => t.type === 'video' && !t.hidden);
    for (const t of vtracks) {
      for (const c of DS.activeTrackClips(project, t.id)) {
        const S = c.start, e = ext[c.id] || 0;
        if (c.type === 'adjust') {
          const chain = fxChain(c.fx, 'between(t,' + num(S) + ',' + num(DS.clipEnd(c)) + ')', env.lutFiles && c.fx && c.fx.lut && env.lutFiles[c.fx.lut.path], gradeFile(c), { kf: c.kf, tv: '(t-' + num(S) + ')' });
          const win = 'between(t,' + num(S) + ',' + num(DS.clipEnd(c)) + ')';
          const gg = c.fx.glow && c.fx.glow.amount > 0 ? glowGraph(chain.length ? 'adjx' + (fc) : cur, c.fx, W, win, fc++) : null;
          if (!chain.length && !gg) continue;
          if (chain.length) {
            const nl = 'adj' + (fc++);
            graph.push('[' + cur + ']' + chain.join(',') + '[' + (gg ? gg.lines[0].match(/^\[(\w+)\]/)[1] : nl) + ']');
            cur = gg ? gg.out : nl;
          }
          if (gg) { gg.lines.forEach((ln) => graph.push(ln)); cur = gg.out; }
          continue;
        }
        const idx = inputIndexOf[c.id];
        if (idx == null) continue;
        let f = [];
        let cl = idx + ':v';
        const flush = () => {
          if (!f.length) return;
          const nl = 'v' + (fc++);
          graph.push('[' + cl + ']' + f.join(',') + '[' + nl + ']');
          cl = nl; f = [];
        };
        const isTitle = c.type === 'title';
        const m = isTitle ? null : media[c.media];
        const sp = c.speed || 1;
        if (c.reverse && !isTitle && m.kind !== 'image') f.push('reverse');
        f.push('setpts=' + (isTitle || m.kind === 'image' ? 'PTS-STARTPTS' : '(PTS-STARTPTS)/' + sp));
        f.push('fps=' + FPS);
        // (speed-ramp pieces read ~0.15 s past their end, see the input above: that spare footage keeps the rate conversion
        // from dropping a piece's final frame, and `enable` below hides it again)
        if (!isTitle) {
          const cr = c.fx && c.fx.crop;
          if (cr && (cr.l || cr.t || cr.r || cr.b)) {
            const k = (v) => num(Math.max(0, Math.min(95, v)) / 100);
            f.push("crop=w='trunc(iw*(1-" + k(cr.l) + "-" + k(cr.r) + ")/2)*2':h='trunc(ih*(1-" + k(cr.t) + "-" + k(cr.b) + ")/2)*2':x='trunc(iw*" + k(cr.l) + "/2)*2':y='trunc(ih*" + k(cr.t) + "/2)*2'");
          }
          if (c.fx && c.fx.flipH) f.push('hflip');
          if (c.fx && c.fx.flipV) f.push('vflip');
          f.push.apply(f, fxChain(c.fx, null, env.lutFiles && c.fx && c.fx.lut && env.lutFiles[c.fx.lut.path], gradeFile(c), { kf: c.kf, tv: 't' }));
          const gg = c.fx.glow && c.fx.glow.amount > 0 ? glowGraph('@', c.fx, (m.w || W) * (1 - (c.fx.crop.l + c.fx.crop.r) / 100), null, fc++) : null;
          if (gg) {
            flush();
            gg.lines[0] = gg.lines[0].replace('[@]', '[' + cl + ']');
            gg.lines.forEach((ln) => graph.push(ln));
            cl = gg.out;
          }
          f.push('scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease', 'setsar=1');
        }
        // a rolling title's picture is taller than the frame (its real height comes from the PNG the app drew): TH
        const rollH = isTitle && c.title && c.title.roll === true && env.titleSizes && env.titleSizes[c.id] ? Math.round(Math.max(H, Math.min(DS.ROLL_MAX_H, +env.titleSizes[c.id].h || H)) / 2) * 2 : 0;
        const TH = rollH || H;
        if (isTitle) f.push('scale=' + W + ':' + TH);
        f.push('format=rgba');
        if (!isTitle && c.fx && c.fx.lumakey && c.fx.lumakey.on) {
          const k = c.fx.lumakey;
          f.push('format=yuva420p', 'lumakey=threshold=' + (k.threshold / 100).toFixed(4) + ':tolerance=' + (k.tolerance / 100).toFixed(4) + ':softness=' + (k.softness / 100).toFixed(4), 'format=rgba');
        }
        if (!isTitle && c.fx && c.fx.chroma && c.fx.chroma.on) {
          const ch = c.fx.chroma;
          f.push('colorkey=0x' + String(ch.color || '#00ff00').replace('#', '') + ':' + (ch.sim / 100).toFixed(3) + ':' + (ch.blend / 100).toFixed(3));
        }
        // shape mask: a white image whose alpha is the mask, multiplied into the layer's alpha. A fixed mask is drawn once
        // at full size and repeated; a tracked (moving) mask is drawn per frame at reduced size and scaled up.
        const wipeOn = DS.isWipe(c.tr), shapeOn = !isTitle && DS.maskOn(c.fx);
        if (!isTitle && (shapeOn || wipeOn)) {
          const mk = c.fx.mask, animated = wipeOn || !!DS.maskNorm(mk).path;
          flush();
          const g = 'k' + (fc++);
          const MW = animated ? 640 : W, MH = animated ? Math.max(2, Math.round(640 * H / W)) : H;
          const aExpr = [shapeOn ? DS.maskExpr(mk, 'T') : null, wipeOn ? DS.wipeExpr(c.tr.type, 'T', Math.min(c.tr.dur, c.dur)) : null].filter(Boolean).join('*');
          graph.push('color=c=white:s=' + MW + 'x' + MH + ':r=' + FPS + ',format=rgba,geq=r=\'r(X,Y)\':g=\'g(X,Y)\':b=\'b(X,Y)\':a=\'255*(' + aExpr + ')\'' + (animated ? '' : ',trim=end_frame=1,loop=loop=-1:size=1:start=0') + '[' + g + 'm]');
          graph.push('[' + g + 'm][' + cl + ']scale2ref=flags=bicubic[' + g + 's][' + g + 'l]');
          graph.push('[' + g + 'l][' + g + 's]blend=all_mode=multiply:shortest=1[' + g + 'out]');
          cl = g + 'out';
          f.push('format=rgba');   // the multiply blend leaves a planar format that the overlay would misread (shifted colours)
        }
        // opacity. Keyframed opacity = a tiny time-varying gain image, scaled up and multiplied into the
        // alpha channel with the (native, fast) multiply blend. The layer is padded to full frame so the
        // gain image always has exactly the same size.
        const opKf0 = c.kf && c.kf.opacity;
        if (opKf0 && opKf0.length > 1) {
          if (!isTitle) f.push('pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2:color=black@0');
          flush();
          const g = 'o' + (fc++);
          graph.push('color=c=white:s=16x16:r=' + FPS + ':d=' + num(c.dur + e + 1) + ',format=rgba,geq=r=\'r(X,Y)\':g=\'g(X,Y)\':b=\'b(X,Y)\':a=\'255*clip((' + DS.kfExpr(opKf0, (c.tf || DS.DEFAULT_TF).opacity, 'T') + ')/100,0,1)\',scale=' + W + ':' + TH + '[' + g + 'g]');
          graph.push('[' + cl + '][' + g + 'g]blend=all_mode=multiply:shortest=1[' + g + 'out]');
          cl = g + 'out';
          f.push('format=rgba');
        } else {
          const o = opKf0 && opKf0.length === 1 ? opKf0[0].v : (c.tf || DS.DEFAULT_TF).opacity;
          if (o < 99.99) f.push('colorchannelmixer=aa=' + (Math.max(0, o) / 100).toFixed(4));
        }
        // geometry
        const kf = c.kf || {};
        const tfv = c.tf || DS.DEFAULT_TF;
        const scaleKf = kf.scale && kf.scale.length > 1;
        if (scaleKf) {
          const ex = DS.kfExpr(kf.scale, tfv.scale, 't');
          f.push("scale=w='max(2,iw*(" + ex + ")/100)':h='max(2,ih*(" + ex + ")/100)':eval=frame");
        } else {
          const s = kf.scale && kf.scale.length === 1 ? kf.scale[0].v : tfv.scale;
          if (Math.abs(s - 100) > 0.01) f.push("scale=w='max(2,iw*" + num(s) + "/100)':h='max(2,ih*" + num(s) + "/100)'");
        }
        const rotKf = kf.rot && kf.rot.length > 1;
        const rotStatic = kf.rot && kf.rot.length === 1 ? kf.rot[0].v : tfv.rot;
        if (rotKf) {
          f.push("rotate=a='(" + DS.kfExpr(kf.rot, tfv.rot, 't') + ")*PI/180':ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=none");
        } else if (Math.abs(rotStatic) > 0.01) {
          f.push("rotate=a='" + num(rotStatic) + "*PI/180':ow='rotw(a)':oh='roth(a)':c=none");
        }
        // fades (alpha)
        const fd = fades[c.id];
        if (fd.in > 0) f.push('fade=t=in:st=0:d=' + num(fd.in) + ':alpha=1');
        if (fd.out > 0) f.push('fade=t=out:st=' + num(Math.max(0, c.dur - fd.out)) + ':d=' + num(fd.out) + ':alpha=1');
        if (e > 0 && !(!isTitle && m.kind === 'image')) f.push('tpad=stop_mode=clone:stop_duration=' + num(e));
        // start a hair early: printing S rounded up (e.g. 35/30 s as 1.16667) would make the clip's first frame arrive
        // after the frame it should replace and flash the layer below for one frame
        const Sv = S > 0 ? S - 1e-4 : S;
        f.push('setpts=PTS+' + num(S) + '/TB');
        flush();
        const lab = cl;
        // position
        const tv = '(t-' + num(S) + ')';
        const xe = DS.kfExpr(kf.x, tfv.x, tv), ye = DS.kfExpr(kf.y, tfv.y, tv) + (rollH ? '+' + DS.rollExpr(H, rollH, tv, c.dur) : '');
        const sl = DS.slideExpr(c.tr, W, H, tv);
        const nl = 'cmp' + (fc++);
        const place = 'x=\'(main_w-overlay_w)/2+(' + xe + ')+(' + sl.x + ')\':y=\'(main_h-overlay_h)/2+(' + ye + ')+(' + sl.y + ')\'';
        const win = 'enable=\'between(t,' + num(Sv) + ',' + num(S + c.dur + e - (c.ramp ? 1e-4 : 0)) + ')\'';
        const bm = DS.cleanBlend(c.blend);
        if (bm !== 'normal') {
          // blend mode: the layer is placed on a transparent full frame, its colour is mixed with the picture beneath by the
          // blend formula (in RGB, backdrop first), and the result goes back over the untouched picture through the layer's alpha
          const g = 'bm' + (fc++);
          graph.push('color=c=black@0:s=' + W + 'x' + H + ':r=' + FPS + ':d=' + num(total) + ',format=rgba[' + g + 'c]');
          graph.push('[' + g + 'c][' + lab + ']overlay=' + place + ':eof_action=pass:format=auto:' + win + ',format=rgba,split[' + g + 'lc][' + g + 'la]');
          graph.push('[' + g + 'la]alphaextract[' + g + 'am]');
          graph.push('[' + g + 'lc]format=gbrp[' + g + 'lr]');
          graph.push('[' + cur + ']split[' + g + 'b1][' + g + 'b2]');
          graph.push('[' + g + 'b1]format=gbrp[' + g + 'br]');
          graph.push('[' + g + 'br][' + g + 'lr]blend=all_mode=' + DS.BLEND_FF[bm] + ':shortest=1[' + g + 'bl]');
          graph.push('[' + g + 'bl][' + g + 'am]alphamerge[' + g + 'ba]');
          graph.push('[' + g + 'b2][' + g + 'ba]overlay=eof_action=pass' + (alpha ? ':format=auto' : '') + ':' + win + '[' + nl + ']');
        } else {
          graph.push('[' + cur + '][' + lab + ']overlay=' + place + ':eof_action=pass' + (alpha ? ':format=auto' : '') + ':' + win + '[' + nl + ']');
        }
        cur = nl;
      }
    }
    // final geometry / format
    const post = [];
    const outW = opts.width || W, outH = opts.height || H;
    if (outW !== W || outH !== H) post.push('scale=' + outW + ':' + outH + ':flags=lanczos');
    if (opts.format === 'gif') {
      post.push('fps=' + (opts.gifFps || 15));
      graph.push('[' + cur + ']' + post.concat(['split[ga][gb]']).join(','));
      graph.push('[ga]palettegen=stats_mode=diff[gp]');
      graph.push('[gb][gp]paletteuse=dither=bayer:bayer_scale=5[vout]');
    } else {
      post.push('format=' + (alpha ? 'yuva444p10le' : opts.format === 'mov-prores' ? 'yuv422p10le' : opts.format === 'png-seq' || opts.format === 'frame-png' ? 'rgb24' : opts.format === 'frame-jpg' ? 'yuvj420p' : 'yuv420p'));
      graph.push('[' + cur + ']' + post.join(',') + '[vout]');
    }
    vLabel = 'vout';
  }

  // ---------- audio -------------------------------------------------------------
  // Clips -> (per track: sum, fader and effect rack) -> master. A project in 5.1 mode places each clip in the six
  // channels (DS.surroundMix) and everything after that works on six channels.
  let aLabel = null;
  const SURR = DS.layoutOf(project) === '5.1' && (opts.audioLayout ? opts.audioLayout === '5.1' : true) && !['mp3', 'nest-prores'].includes(opts.format);
  if (fmt.audio) {
    const perTrack = new Map();
    for (const c of clips) {
      const tr = trackById[c.track];
      if (!tr || tr.mute || c.disabled) continue;
      if (c.type !== 'media') continue;
      const m = media[c.media];
      if (!m || !m.hasAudio || m.kind === 'image' || c.mute === true) continue;
      const idx = inputIndexOf[c.id];
      const sp = c.speed || 1;
      const f = ['asetpts=PTS-STARTPTS'];
      if (c.reverse) f.push('areverse');
      if (Math.abs(sp - 1) > 1e-4) f.push.apply(f, DS.atempoChain(sp));
      f.push('aformat=sample_rates=48000:channel_layouts=stereo');
      f.push('atrim=duration=' + num(c.dur), 'asetpts=PTS-STARTPTS');
      const vk = c.kf && c.kf.vol;
      if (vk && vk.length > 1) {
        // animated volume: 10 ms audio frames so the per-frame gain moves smoothly; the expression is in dB over clip time
        f.push('asetnsamples=n=480:p=0', "volume=volume='pow(10,clip(" + DS.kfExpr(vk, c.vol || 0, 't') + ",-90,40)/20)':eval=frame");
      } else {
        const v = vk && vk.length === 1 ? vk[0].v : c.vol;
        if (+v) f.push('volume=' + dB(v) + 'dB');
      }
      f.push.apply(f, DS.aeFilters(SURR ? Object.assign({}, c.ae, { pan: 0 }) : c.ae));
      // pieces of a speed ramp get a 4 ms fade at their joins so the sound doesn't click
      const fi = Math.max(c.fadeIn || 0, c.ramp && c.ramp.i > 0 ? 0.004 : 0), fo = Math.max(c.fadeOut || 0, c.ramp && c.ramp.i < c.ramp.n - 1 ? 0.004 : 0);
      if (fi > 0) f.push('afade=t=in:st=0:d=' + num(fi));
      if (fo > 0) f.push('afade=t=out:st=' + num(Math.max(0, c.dur - fo)) + ':d=' + num(fo));
      if (SURR) { f.push(DS.surroundPanExpr(c.ae)); if (c.ae && c.ae.slfe > 0) f.push('lowpass=f=120:channels=LFE'); }
      const ms = Math.round(c.start * 1000);
      if (ms > 0) f.push('adelay=' + ms + ':all=1');
      const lab = 'a' + (fc++);
      graph.push('[' + idx + ':a]' + f.join(',') + '[' + lab + ']');
      if (!perTrack.has(c.track)) perTrack.set(c.track, []);
      perTrack.get(c.track).push(lab);
    }
    // a track with a rack gets its clips summed and run through the fader and effects; others go straight to the master
    const labels = [];
    for (const [tid, list] of perTrack) {
      const tr = trackById[tid];
      if (!DS.rackActive(tr)) { list.forEach((l) => labels.push(l)); continue; }
      let cur = list[0];
      if (list.length > 1) { cur = 'tb' + (fc++); graph.push(list.map((l) => '[' + l + ']').join('') + 'amix=inputs=' + list.length + ':normalize=0:duration=longest[' + cur + ']'); }
      const rf = [];
      if (+tr.vol) rf.push('volume=' + dB(tr.vol) + 'dB');
      rf.push.apply(rf, DS.aeFilters(SURR ? Object.assign({}, tr.ae, { pan: 0 }) : tr.ae));
      const out = 'tr' + (fc++);
      graph.push('[' + cur + ']' + rf.join(',') + '[' + out + ']');
      labels.push(out);
    }
    if (labels.length) {
      const tail = [];
      if (opts.normalize) tail.push('loudnorm=I=-16:TP=-1.5:LRA=11');
      tail.push('alimiter=limit=0.97');
      if (SURR) tail.push('aformat=sample_rates=48000:channel_layouts=5.1');
      if (labels.length === 1) graph.push('[' + labels[0] + ']' + tail.join(',') + '[aout]');
      else graph.push(labels.map((l) => '[' + l + ']').join('') + 'amix=inputs=' + labels.length + ':normalize=0:duration=longest,' + tail.join(',') + '[aout]');
      aLabel = 'aout';
    } else if (!fmt.video) {
      throw new Error('There is no audio on the timeline to export.');
    } else if (opts.format === 'nest-prores') {
      // nested sequences always carry an audio track (silent if there is no sound) so they behave like any other media
      graph.push('anullsrc=r=48000:cl=stereo,atrim=duration=' + num(total) + '[aout]');
      aLabel = 'aout';
    }
  }

  // ---------- assemble args --------------------------------------------------------
  const args = ['-y', '-hide_banner', '-nostdin', '-progress', 'pipe:1', '-nostats'];
  const metadata = opts.chapters && opts.metaPath && CHAPTER_FORMATS.includes(opts.format) ? chaptersText(project.markers, total) : null;
  if (metadata) inputs.push(['-f', 'ffmetadata', '-i', opts.metaPath]);
  inputs.forEach((a) => args.push.apply(args, a));
  args.push(opts.newFilterFlag ? '-/filter_complex' : '-filter_complex_script', opts.scriptPath || 'filter.txt');
  if (vLabel) args.push('-map', '[' + vLabel + ']');
  if (aLabel) args.push('-map', '[' + aLabel + ']');
  if (vLabel && !aLabel) args.push('-an');
  if (vLabel) args.push('-r', String(FPS));
  if (metadata) args.push('-map_chapters', String(inputs.length - 1));
  args.push.apply(args, encoderArgs(Object.assign({}, opts, { surround: !!(aLabel && SURR) })));
  if (rs > 0) args.push('-ss', num(rs).replace(/[()]/g, ''));
  args.push('-t', num(len).replace(/[()]/g, ''));
  args.push(opts.outPath || 'out');
  return { args, script: graph.join(';\n') + '\n', duration: len, metadata };
}

// ---- chapters: timeline markers become MP4 / MOV / M4A chapters (FFmpeg "ffmetadata" file)
const CHAPTER_FORMATS = ['mp4-h264', 'mp4-h265', 'mov-prores', 'm4a'];
const metaEsc = (t) => String(t).replace(/[\r\n]+/g, ' ').replace(/[=;#\\]/g, (c) => '\\' + c);
// Times are on the whole timeline: FFmpeg itself shifts and trims chapters for a range export (-ss / -t).
function chaptersText(markers, total) {
  const list = (Array.isArray(markers) ? markers : []).map((m, i) => {
    const t = +(m && m.t);
    const first = m && Array.isArray(m.comments) && m.comments[0] && m.comments[0].text;
    const name = String((m && m.name) || first || 'Marker ' + (i + 1)).slice(0, 120);
    return { t, name };
  }).filter((m) => Number.isFinite(m.t) && m.t >= 0 && m.t < total - 0.05).sort((a, b) => a.t - b.t).slice(0, 500);
  if (!list.length) return null;
  const pts = [];
  if (list[0].t > 0.05) pts.push({ ms: 0, name: 'Start' });
  list.forEach((m) => { const ms = Math.round(m.t * 1000); if (!pts.length || ms - pts[pts.length - 1].ms >= 50) pts.push({ ms, name: m.name }); });
  const endMs = Math.round(total * 1000);
  let out = ';FFMETADATA1\n';
  pts.forEach((p, i) => { out += '[CHAPTER]\nTIMEBASE=1/1000\nSTART=' + p.ms + '\nEND=' + (i + 1 < pts.length ? pts[i + 1].ms : endMs) + '\ntitle=' + metaEsc(p.name) + '\n'; });
  return out;
}

module.exports = { buildExport, fxChain, encoderArgs, chaptersText };
