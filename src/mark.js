/* Constellation Lens: the mark.
 *
 * A violet tile with a magnifier lens; inside the lens, a small constellation (two dots, one amber star).
 * One drawing, used three ways:
 *   - the toolbar icon, animated from the service worker with OffscreenCanvas,
 *   - the PNG icons (tools/make-icons.mjs),
 *   - the geometry the panel's inline SVG copies (panel.html).
 * `t` is the animation phase: 0 is at rest, 0..1 plays one pulse (a ring ripples out of the lens and the star twinkles).
 * No DOM here, only the 2D canvas API, so it runs in a service worker and in Node.
 */
(function (root) {
  'use strict';

  const COLORS = { tileFrom: '#9a86ff', tileTo: '#5b4bff', glass: '#ffffff', star: '#ffb84d' };
  const ease = (x) => 1 - (1 - x) * (1 - x);

  // The constellation, in the 32-unit grid.
  const A = [10.3, 17];
  const STAR = [14.2, 11.6];
  const B = [19.2, 15.4];

  /** A four-point star centred on (0,0) in the current transform. */
  function star(ctx, r, inner) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI / 4) * i - Math.PI / 2;
      const rad = i % 2 === 0 ? r : inner;
      const x = Math.cos(a) * rad;
      const y = Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  /** Draws the mark into a size x size square. `opts.star` overrides the star colour (the toolbar uses red for a failure). */
  function drawMark(ctx, size, t = 0, opts = {}) {
    const starColor = opts.star || COLORS.star;
    const small = size <= 20;
    const k = size / 32;
    ctx.save();
    ctx.scale(k, k);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // The tile.
    const g = ctx.createLinearGradient(0, 0, 32, 32);
    g.addColorStop(0, COLORS.tileFrom);
    g.addColorStop(1, COLORS.tileTo);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(0, 0, 32, 32, 7.5);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(0, 0, 32, 32, 7.5);
    ctx.clip();

    // The ripple: one ring leaving the lens and fading as it grows. Clipped to the tile.
    if (t > 0 && t < 1) {
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.strokeStyle = starColor;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(14.5, 14.5, 8.6 + ease(t) * 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // The lens and its handle.
    ctx.strokeStyle = COLORS.glass;
    ctx.lineWidth = small ? 3.2 : 2.8;
    ctx.beginPath();
    ctx.arc(14.5, 14.5, 8.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(21, 21);
    ctx.lineTo(26.5, 26.5);
    ctx.stroke();

    // The constellation: two dots and the star, joined.
    ctx.strokeStyle = 'rgba(255,255,255,0.88)';
    ctx.lineWidth = small ? 2 : 1.5;
    ctx.beginPath();
    ctx.moveTo(A[0], A[1]);
    ctx.lineTo(STAR[0], STAR[1]);
    ctx.lineTo(B[0], B[1]);
    ctx.stroke();
    ctx.fillStyle = COLORS.glass;
    for (const [x, y] of [A, B]) {
      ctx.beginPath();
      ctx.arc(x, y, small ? 2.1 : 1.7, 0, Math.PI * 2);
      ctx.fill();
    }

    // The star twinkles (grows and turns an eighth of a turn) during the pulse.
    const grow = t > 0 && t < 1 ? 1 + 0.7 * Math.sin(Math.PI * t) : 1;
    const turn = t > 0 && t < 1 ? (Math.PI / 4) * ease(t) : 0;
    ctx.translate(STAR[0], STAR[1]);
    ctx.rotate(turn);
    ctx.scale(grow, grow);
    ctx.fillStyle = starColor;
    star(ctx, small ? 4 : 3.2, small ? 1.4 : 1.1);
    ctx.fill();

    ctx.restore();
    ctx.restore();
  }

  const api = { COLORS, drawMark };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PeekMark = api; // the global keeps its first name so background.js and the tools need no change
})(typeof globalThis !== 'undefined' ? globalThis : this);
