'use strict';
/* Ditto Pro — image sequences (frame0001.png, frame0002.png, …). Pure: works out which files make up the sequence and the
   FFmpeg arguments that turn it into one video file the editor can use like any other clip. */
const path = require('path');

const SEQ_EXT = ['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp', '.dpx'];
const WITH_ALPHA = ['.png', '.tif', '.tiff', '.webp'];   // these may carry transparency, so they become a ProRes 4444 .mov
const MAX_FRAMES = 200000;

/**
 * file: the path of any frame. names: the file names in its folder.
 * Returns { dir, prefix, suffix, ext, digits (0 = variable width), start, end, count, gaps, pattern, first } or null when the file has no frame number.
 */
function detectSequence(file, names) {
  const dir = path.dirname(file), base = path.basename(file);
  const m = base.match(/^(.*?)(\d+)(\.[A-Za-z0-9]+)$/);
  if (!m || !SEQ_EXT.includes(m[3].toLowerCase())) return null;
  const prefix = m[1], ext = m[3], here = parseInt(m[2], 10), len = m[2].length;
  const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)' + ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  const padded = m[2].length > 1 && m[2][0] === '0';
  const nums = new Set();
  for (const n of names) { const x = n.match(re); if (x && (!padded || x[1].length === len)) nums.add(parseInt(x[1], 10)); }
  if (!nums.has(here)) nums.add(here);
  // the run of consecutive numbers that contains this frame
  let lo = here, hi = here;
  while (nums.has(lo - 1)) lo--;
  while (nums.has(hi + 1)) hi++;
  const total = nums.size, count = hi - lo + 1;
  const first = (padded ? String(lo).padStart(len, '0') : String(lo));
  return { dir, prefix, suffix: ext, ext, digits: padded ? len : 0, start: lo, end: hi, count, outsideRun: total - count, first: prefix + first + ext, pattern: path.join(dir, prefix + (padded ? '%0' + len + 'd' : '%d') + ext) };
}

/** FFmpeg arguments: seq from detectSequence, fps for the result, out = the file to write */
function sequenceArgs(seq, fps, out) {
  if (seq.count < 1 || seq.count > MAX_FRAMES) throw new Error('The sequence has ' + seq.count + ' frames; between 1 and ' + MAX_FRAMES + ' are supported.');
  if (/%/.test(seq.dir + seq.prefix)) throw new Error('A "%" in the folder or file name cannot be used for an image sequence. Rename the folder or files and try again.');
  const alpha = WITH_ALPHA.includes(seq.ext.toLowerCase());
  fps = Math.max(1, Math.min(240, +fps || 24));
  const a = ['-y', '-hide_banner', '-v', 'error', '-framerate', String(fps), '-start_number', String(seq.start), '-i', seq.pattern, '-frames:v', String(seq.count)];
  if (alpha) a.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuva444p10le', '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-an', out);
  else a.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-crf', '12', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-an', out);
  return { args: a, ext: alpha ? '.mov' : '.mp4', alpha };
}
module.exports = { detectSequence, sequenceArgs, SEQ_EXT, MAX_FRAMES };
