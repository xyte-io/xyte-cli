#!/usr/bin/env node
// Convert docs media PNGs to display-size WebP. Requires `cwebp` on PATH
// (Homebrew: `brew install webp`). Re-run after adding new PNG art under
// docs/**/media, then update the referencing HTML to point at the .webp file.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const QUALITY = '80';
const MAX_WIDTH = '1440'; // images render <= ~720px CSS; 1440 covers 2x displays
const DIRS = ['docs/guides/media', 'docs/reference/media'];

if (spawnSync('cwebp', ['-version'], { encoding: 'utf8' }).status !== 0) {
  console.error('cwebp not found. Install it (macOS: `brew install webp`).');
  process.exit(1);
}

let converted = 0;
for (const dir of DIRS) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (extname(name).toLowerCase() !== '.png') continue;
    const src = join(dir, name);
    const out = src.replace(/\.png$/i, '.webp');
    const before = statSync(src).size;
    const res = spawnSync('cwebp', ['-quiet', '-q', QUALITY, '-resize', MAX_WIDTH, '0', src, '-o', out], {
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      console.error(`Failed: ${src}\n${res.stderr || res.stdout}`);
      process.exit(1);
    }
    const after = statSync(out).size;
    converted += 1;
    console.log(`${src} ${(before / 1024).toFixed(0)}KB -> ${out} ${(after / 1024).toFixed(0)}KB`);
  }
}
console.log(`\nConverted ${converted} image(s). Remember to update <img>/thumbnail src refs to .webp and remove the source .png files.`);
