/* Constellation Lens: the mark.
 *
 * Hand-drawn: a teal-to-blue tile with a sketched magnifier lens; inside the lens a small constellation (two dots, one
 * amber sparkle). Nothing is a perfect circle or a straight line, on purpose: the ring overshoots where it closes, the
 * handle bends, the sparkle has curved sides.
 *
 * One drawing, used four ways, all from the path data below:
 *   - the toolbar icon, animated from the service worker with OffscreenCanvas (Path2D),
 *   - the PNG icons and icons/lens.svg (tools/make-icons.mjs),
 *   - the panel's and popup's inline SVG (copies of the same paths).
 * `t` is the animation phase: 0 is at rest, 0..1 plays one pulse (a ring ripples out of the lens and the sparkle twinkles).
 * No DOM here, only Path2D and the 2D canvas API, so it runs in a service worker and in Node.
 */
(function (root) {
  'use strict';

  const COLORS = { tileFrom: '#14c8d9', tileTo: '#2563eb', glass: '#ffffff', star: '#ffc13d' };
  const ease = (x) => 1 - (1 - x) * (1 - x);

  // The art, on a 32-unit grid.
  const PATHS = {
    tile: 'M7.9 .9C12.2 .3 20 1.3 24.5 .8C29.6 .4 31.5 2.7 31.2 7.7C30.8 12.1 31.6 20.1 31.1 24.5C30.8 29.5 28.6 31.4 24 31.1C19.4 30.8 12.6 31.5 7.6 31C2.8 30.7 .7 28.9 .9 24.2C1.2 19.5 .5 12.5 .9 7.7C1.2 3 3.3 1.1 7.9 .9Z',
    // The lens: starts at the top left, goes round, and overshoots a little past where it began.
    ring: 'M11.9 6.3C16.5 5 21.5 7.4 22.6 12C23.8 16.7 21.1 21.4 16.4 22.5C11.7 23.7 7 21.1 5.9 16.5C4.8 11.9 7.4 7.3 12.2 6.2C14 5.8 15.4 6 16.7 6.5',
    // A second, fainter pass over the ring: the sketchy double line.
    ringEcho: 'M12.6 7.2C16.4 6.3 20.7 8.2 21.6 12.2C22.6 16.2 20.4 20.2 16.5 21.2',
    handle: 'M21.2 21.4C22.9 23.2 24.6 25 27.3 27.6',
    links: 'M10.1 17.4C11.5 15.4 12.8 13.4 14.2 11.6C16 13 17.7 14.4 19.5 15.8',
    dotA: 'M10.1 15.8C11 15.7 11.8 16.5 11.8 17.4C11.8 18.3 11 19.1 10.1 19.1C9.2 19.1 8.4 18.3 8.4 17.4C8.4 16.5 9.2 15.8 10.1 15.8Z',
    dotB: 'M19.4 14.1C20.3 14.1 21.1 14.8 21.2 15.7C21.2 16.6 20.4 17.4 19.5 17.4C18.6 17.4 17.8 16.7 17.8 15.8C17.8 14.9 18.5 14.1 19.4 14.1Z',
    // The sparkle, curved inward on each side, centred on (14.3, 11.7).
    star: 'M14.3 8C14.8 9.8 15 10.8 17.6 11.7C15 12.5 14.7 13.7 14.3 15.4C13.9 13.7 13.5 12.5 11 11.7C13.6 10.8 13.8 9.7 14.3 8Z',
  };
  const STAR_AT = [14.3, 11.7];

  /** Draws the mark into a size x size square. `opts.star` overrides the sparkle colour (the toolbar uses red for a failure). */
  function drawMark(ctx, size, t = 0, opts = {}) {
    const starColor = opts.star || COLORS.star;
    const small = size <= 20;
    const k = size / 32;
    const P = (d) => new Path2D(d);
    ctx.save();
    ctx.scale(k, k);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // The tile.
    const g = ctx.createLinearGradient(0, 0, 32, 32);
    g.addColorStop(0, COLORS.tileFrom);
    g.addColorStop(1, COLORS.tileTo);
    ctx.fillStyle = g;
    const tile = P(PATHS.tile);
    ctx.fill(tile);

    ctx.save();
    ctx.clip(tile);

    // The ripple: one ring leaving the lens and fading as it grows. Clipped to the tile.
    if (t > 0 && t < 1) {
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.strokeStyle = starColor;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(14.3, 14.3, 8.4 + ease(t) * 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // The lens, its sketchy second pass (dropped at small sizes), and the handle.
    ctx.strokeStyle = COLORS.glass;
    ctx.lineWidth = small ? 3.1 : 2.7;
    ctx.stroke(P(PATHS.ring));
    if (!small) {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 1.3;
      ctx.stroke(P(PATHS.ringEcho));
      ctx.restore();
    }
    ctx.lineWidth = small ? 3.3 : 3;
    ctx.stroke(P(PATHS.handle));

    // The constellation: two dots joined to the sparkle.
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = small ? 2 : 1.5;
    ctx.stroke(P(PATHS.links));
    ctx.fillStyle = COLORS.glass;
    ctx.fill(P(PATHS.dotA));
    ctx.fill(P(PATHS.dotB));

    // The sparkle twinkles (grows and turns an eighth of a turn) during the pulse.
    const grow = t > 0 && t < 1 ? 1 + 0.7 * Math.sin(Math.PI * t) : 1;
    const turn = t > 0 && t < 1 ? (Math.PI / 4) * ease(t) : 0;
    ctx.translate(STAR_AT[0], STAR_AT[1]);
    ctx.rotate(turn);
    ctx.scale(grow * (small ? 1.2 : 1), grow * (small ? 1.2 : 1));
    ctx.translate(-STAR_AT[0], -STAR_AT[1]);
    ctx.fillStyle = starColor;
    ctx.fill(P(PATHS.star));

    ctx.restore();
    ctx.restore();
  }

  /** The same drawing as a standalone SVG file. */
  function svgFile(star = COLORS.star) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="128" height="128" role="img" aria-label="Constellation Lens">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${COLORS.tileFrom}"/><stop offset="1" stop-color="${COLORS.tileTo}"/></linearGradient></defs>
  <path d="${PATHS.tile}" fill="url(#g)"/>
  <g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">
    <path d="${PATHS.ring}" stroke-width="2.7"/>
    <path d="${PATHS.ringEcho}" stroke-width="1.3" stroke-opacity=".4"/>
    <path d="${PATHS.handle}" stroke-width="3"/>
    <path d="${PATHS.links}" stroke-width="1.5" stroke-opacity=".9"/>
  </g>
  <path d="${PATHS.dotA}" fill="#fff"/><path d="${PATHS.dotB}" fill="#fff"/>
  <path d="${PATHS.star}" fill="${star}"/>
</svg>
`;
  }

  const api = { COLORS, PATHS, drawMark, svgFile };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PeekMark = api; // the global keeps its first name so background.js and the tools need no change
})(typeof globalThis !== 'undefined' ? globalThis : this);
