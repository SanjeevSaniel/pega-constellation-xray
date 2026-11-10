// Draws the Peek mark into the PNG icons Chrome needs (manifest icons cannot be SVG).
// Run:  CANVAS_FROM=/path/to/a/project/with/@napi-rs/canvas/package.json node tools/make-icons.mjs
// The PNGs are committed, so nobody who just installs the extension needs to run this.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(process.env.CANVAS_FROM || import.meta.url);
const { createCanvas } = require('@napi-rs/canvas');
await import('../src/mark.js'); // a classic script: it registers itself on globalThis
const { drawMark } = globalThis.PeekMark;

const out = path.join(root, 'icons');
fs.mkdirSync(out, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const canvas = createCanvas(size, size);
  drawMark(canvas.getContext('2d'), size, 0);
  fs.writeFileSync(path.join(out, `icon-${size}.png`), canvas.toBuffer('image/png'));
  console.log(`icons/icon-${size}.png`);
}
