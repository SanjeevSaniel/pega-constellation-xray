/* Peek: the mark.
 *
 * An eye (the peek) with a four-point star for a pupil (the constellation). One drawing, used three ways:
 *   - the toolbar icon, animated from the service worker with OffscreenCanvas,
 *   - the PNG icons (tools/make-icons.mjs),
 *   - the geometry the panel's inline SVG copies (panel.html).
 * `t` is the animation phase: 0 is at rest, 0..1 plays one pulse (the star twinkles and a ring ripples out of the iris).
 * No DOM here, only the 2D canvas API, so it runs in a service worker and in Node.
 */
(function (root) {
  'use strict';

  const COLORS = { line: '#7a6bff', star: '#ffb84d' };
  const ease = (x) => 1 - (1 - x) * (1 - x);

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

  /** Draws the mark into a size x size square. `opts.line` and `opts.star` override the colours. */
  function drawMark(ctx, size, t = 0, opts = {}) {
    const line = opts.line || COLORS.line;
    const starColor = opts.star || COLORS.star;
    const k = size / 32;
    ctx.save();
    ctx.scale(k, k);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // The eye: an almond outline.
    ctx.strokeStyle = line;
    ctx.lineWidth = size <= 20 ? 3 : 2.4;
    ctx.beginPath();
    ctx.moveTo(3, 16);
    ctx.bezierCurveTo(8, 7.5, 24, 7.5, 29, 16);
    ctx.bezierCurveTo(24, 24.5, 8, 24.5, 3, 16);
    ctx.closePath();
    ctx.stroke();

    // The iris ring is dropped at the smallest sizes, where it only adds noise.
    if (size > 20) {
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(16, 16, 5.6, 0, Math.PI * 2);
      ctx.stroke();
    }

    // The ripple: one ring leaving the iris and fading as it grows.
    if (t > 0 && t < 1) {
      const e = ease(t);
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.85;
      ctx.strokeStyle = starColor;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(16, 16, 5.6 + e * 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // The pupil: a star that twinkles (grows and turns a quarter) during the pulse.
    const grow = t > 0 && t < 1 ? 1 + 0.55 * Math.sin(Math.PI * t) : 1;
    const turn = t > 0 && t < 1 ? (Math.PI / 4) * ease(t) : 0;
    ctx.translate(16, 16);
    ctx.rotate(turn);
    ctx.scale(grow, grow);
    ctx.fillStyle = starColor;
    star(ctx, size <= 20 ? 6 : 4.6, size <= 20 ? 1.9 : 1.5);
    ctx.fill();
    ctx.restore();
  }

  const api = { COLORS, drawMark };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PeekMark = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
