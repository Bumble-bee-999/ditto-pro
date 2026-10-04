'use strict';
/* Downloads the best-quality background-removal model (IS-Net, ~170 MB, Apache-2.0) into ../models so the installer can
   bundle it. The small fast model (U²-Netp) is already in the repository. Safe to re-run; verifies a SHA-256 checksum.
   A failure only means "Best quality" is unavailable in the app; it never stops the build. */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const dest = path.join(__dirname, '..', 'models');
const FILES = [{
  name: 'isnet-general-use.onnx',
  url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
  sha256: '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a'
}];

function sha256(file) { return new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); }); }
function get(url, out, hops) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'ditto-pro-build' } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && hops < 6) { r.resume(); return resolve(get(new URL(r.headers.location, url).href, out, hops + 1)); }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const f = fs.createWriteStream(out);
      r.pipe(f); f.on('finish', () => f.close(resolve)); f.on('error', reject); r.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of FILES) {
    const target = path.join(dest, f.name);
    try {
      if (fs.existsSync(target) && (await sha256(target)) === f.sha256) { console.log(f.name + ' is already present.'); continue; }
      console.log('Downloading ' + f.name + ' ...');
      const part = target + '.part';
      await get(f.url, part, 0);
      const got = await sha256(part);
      if (got !== f.sha256) { fs.unlinkSync(part); throw new Error('checksum mismatch (' + got + ')'); }
      fs.renameSync(part, target);
      console.log(f.name + ' ready.');
    } catch (e) {
      console.warn('Could not fetch ' + f.name + ': ' + e.message + '. The app will still build; only "Best quality" background removal will be missing.');
    }
  }
})();
