// Draws the Chrome Web Store small promo tile (440 x 280) into store/promo-440x280.png, using the same mark as the icons.
// Run:  CANVAS_FROM=/path/to/a/project/with/@napi-rs/canvas/package.json node tools/make-store-assets.mjs
// Screenshots are not made here: take them from the real panel (see CHROMEWEBSTORE.md).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(process.env.CANVAS_FROM || import.meta.url);
const { createCanvas, Path2D } = require('@napi-rs/canvas');
globalThis.Path2D = Path2D;
await import('../src/mark.js');
const { drawMark, COLORS } = globalThis.PeekMark;

const W = 440;
const H = 280;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

ctx.fillStyle = '#fbf3ea';
ctx.fillRect(0, 0, W, H);

// The mark, drawn at 4x and scaled down for a smooth edge. It carries its own transparent padding.
const big = createCanvas(512, 512);
drawMark(big.getContext('2d'), 512, 0);
ctx.drawImage(big, 28, 56, 168, 168);

ctx.fillStyle = '#2a1d14';
ctx.font = '700 60px "Segoe UI", Arial, sans-serif';
ctx.textBaseline = 'alphabetic';
ctx.fillText('Lens', 204, 148);

ctx.fillStyle = '#6b5646';
ctx.font = '400 19px "Segoe UI", Arial, sans-serif';
ctx.fillText('See inside a Pega', 206, 182);
ctx.fillText('Constellation app', 206, 207);

ctx.fillStyle = COLORS.ink;
ctx.fillRect(206, 224, 44, 4);

const out = path.join(root, 'store');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'promo-440x280.png'), canvas.toBuffer('image/png'));
console.log('store/promo-440x280.png');
