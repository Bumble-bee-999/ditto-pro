'use strict';
/*
 * Ditto Pro — hardware video encoders (NVIDIA NVENC, Intel Quick Sync, AMD AMF).
 * The bundled FFmpeg contains all three; whether one WORKS depends on the computer's graphics hardware and driver.
 * So nothing is assumed: probe() runs a real test encode with exactly the arguments an export would use, and only the
 * encoders that pass are offered. If a hardware export still fails midway, runWithFallback() redoes it in software.
 * Software x264 / x265 stays the default because it gives the best quality for a given file size.
 */
const { spawn } = require('child_process');

const HW = {
  h264_nvenc: { family: 'h264', vendor: 'NVIDIA NVENC' },
  hevc_nvenc: { family: 'hevc', vendor: 'NVIDIA NVENC' },
  h264_qsv: { family: 'h264', vendor: 'Intel Quick Sync' },
  hevc_qsv: { family: 'hevc', vendor: 'Intel Quick Sync' },
  h264_amf: { family: 'h264', vendor: 'AMD AMF' },
  hevc_amf: { family: 'hevc', vendor: 'AMD AMF' }
};
const FAMILY_OF_FORMAT = { 'mp4-h264': 'h264', 'mp4-h265': 'hevc' };
const isHw = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(HW, id);
const familyOf = (format) => FAMILY_OF_FORMAT[format] || null;
/** The hardware encoder to use for this export, or null (software). Unknown ids and codec mismatches fall back to software. */
const pick = (id, format) => (isHw(id) && familyOf(format) === HW[id].family ? id : null);
const label = (id) => HW[id].vendor + ' — ' + (HW[id].family === 'h264' ? 'H.264' : 'H.265 / HEVC');

/** Video-only arguments for a hardware encoder. quality 0-100 (same scale as the software encoders). */
function videoArgs(id, quality) {
  const q = Math.max(0, Math.min(100, quality == null ? 60 : quality));
  const qp = Math.round(34 - q * 0.17);                       // 100 -> 17, 0 -> 34 (roughly equals the software CRF)
  const hevc = HW[id].family === 'hevc';
  const tag = hevc ? ['-tag:v', 'hvc1'] : [];
  if (/_nvenc$/.test(id)) return ['-c:v', id, '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(qp), '-b:v', '0', '-spatial-aq', '1', '-pix_fmt', 'yuv420p'].concat(tag);
  if (/_qsv$/.test(id)) return ['-c:v', id, '-preset', 'slow', '-global_quality', String(qp), '-pix_fmt', 'nv12'].concat(tag);
  return ['-c:v', id, '-usage', 'transcoding', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(qp), '-qp_p', String(qp + 2), '-qp_b', String(qp + 4), '-pix_fmt', 'nv12'].concat(tag); // amf
}

function run(ffmpeg, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const p = spawn(ffmpeg, args, { windowsHide: true });
    const fin = (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code, out, err }); } };
    const t = setTimeout(() => { try { p.kill(); } catch (e) { /* ignore */ } fin(-1); }, timeoutMs || 15000);
    p.stdout.on('data', (d) => { out += d; if (out.length > 2e5) out = out.slice(-1e5); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 2e5) err = err.slice(-1e5); });
    p.on('error', () => fin(-2));
    p.on('close', (c) => fin(c));
  });
}

/** Encoders that exist in this FFmpeg AND really encode on this computer. Never throws. */
async function probe(ffmpeg, timeoutMs) {
  const list = await run(ffmpeg, ['-hide_banner', '-encoders'], 10000);
  if (list.code !== 0) return [];
  const present = Object.keys(HW).filter((id) => new RegExp('\\s' + id + '\\s').test(list.out));
  const results = await Promise.all(present.map(async (id) => {
    const r = await run(ffmpeg, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=gray:s=640x360:r=30:d=0.5', '-frames:v', '8'].concat(videoArgs(id, 60), ['-f', 'null', '-']), timeoutMs || 15000);
    return r.code === 0 ? id : null;
  }));
  return results.filter(Boolean).map((id) => ({ id, family: HW[id].family, label: label(id) }));
}

/** Runs an export with the chosen encoder; if a hardware encoder fails, runs it again in software and says so. */
async function runWithFallback(runOnce, opts) {
  let r = await runOnce(opts);
  if (!r.ok && !r.cancelled && pick(opts.encoder, opts.format)) {
    const hwError = r.error;
    r = await runOnce(Object.assign({}, opts, { encoder: 'software' }));
    r.fellBack = true; r.hwError = hwError;
  }
  return r;
}

module.exports = { HW, isHw, familyOf, pick, label, videoArgs, probe, runWithFallback };
