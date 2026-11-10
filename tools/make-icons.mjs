// Draws the Constellation Lens mark into the PNG icons Chrome needs (manifest icons cannot be SVG) and writes icons/lens.svg.
// Run:  CANVAS_FROM=/path/to/a/project/with/@napi-rs/canvas/package.json node tools/make-icons.mjs
// The PNGs and the SVG are committed, so nobody who just installs the extension needs to run this.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(process.env.CANVAS_FROM || import.meta.url);
const { createCanvas, Path2D } = require('@napi-rs/canvas');
globalThis.Path2D = Path2D; // src/mark.js draws from path strings
await import('../src/mark.js'); // a classic script: it registers itself on globalThis
const { drawMark, svgFile } = globalThis.PeekMark;

const out = path.join(root, 'icons');
fs.mkdirSync(out, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const canvas = createCanvas(size, size);
  drawMark(canvas.getContext('2d'), size, 0);
  fs.writeFileSync(path.join(out, `icon-${size}.png`), canvas.toBuffer('image/png'));
  console.log(`icons/icon-${size}.png`);
}
fs.writeFileSync(path.join(out, 'lens.svg'), svgFile());
console.log('icons/lens.svg');
