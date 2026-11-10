/* Lens: the mark.
 *
 * An orange glyph on a transparent background: a solid lens disc with a handle, and white touches on the glass (a small
 * glare and a burst of rounded rays). One orange, one white, round caps, no tile, no gradient, so it stays legible at
 * 16 px and the white always sits on orange, never on the page, whether the toolbar is light or dark. It is deliberately a lens, not a copy of anyone else's logo.
 *
 * One drawing, used four ways, all from the path data below:
 *   - the toolbar icon, animated from the service worker with OffscreenCanvas (Path2D),
 *   - the PNG icons and icons/lens.svg (tools/make-icons.mjs),
 *   - the panel's and popup's inline SVG (copies of the same paths).
 * `t` is the animation phase: 0 is at rest, 0..1 plays one pulse (a ring ripples out of the lens and the burst twinkles).
 * No DOM here, only Path2D and the 2D canvas API, so it runs in a service worker and in Node.
 *
 * Fit: the art is drawn on a 32-unit grid, then scaled by FIT and centred so it spans about 24 of the 32 units. At
 * 128 px that is 96 px of artwork inside 16 px of transparent padding, which is what the Chrome Web Store recommends.
 */
(function (root) {
  'use strict';

  const COLORS = { ink: '#d4572f', bad: '#d12d3f', white: '#ffffff' };
  const ease = (x) => 1 - (1 - x) * (1 - x);

  // The art, on a 32-unit grid, the lens centred on (13.6, 13.6). Its box is about x 6..27.7, y 6..27.7.
  const PATHS = {
    ring: 'M21.2 13.6A7.6 7.6 0 1 1 6 13.6A7.6 7.6 0 1 1 21.2 13.6Z',
    handle: 'M19.3 19.3L25.9 25.9',
    // Eight short rays: four long (up, down, left, right) and four short (the diagonals).
    burst:
      'M13.6 9.3V12.3M13.6 14.9V17.9M9.3 13.6H12.3M14.9 13.6H17.9' +
      'M14.52 12.68L15.86 11.34M12.68 12.68L11.34 11.34M14.52 14.52L15.86 15.86M12.68 14.52L11.34 15.86',
    // The same burst with only the four long rays, for 16 px, where eight rays blur together.
    burstSmall: 'M13.6 9.3V12.3M13.6 14.9V17.9M9.3 13.6H12.3M14.9 13.6H17.9',
    // A short glare on the upper left of the glass (an arc of radius 5 around the lens centre). Dropped at 16 px.
    glare: 'M9.07 11.49A5 5 0 0 1 11.49 9.07',
  };
  const CENTRE = [13.6, 13.6]; // the burst, and the ripple's origin
  const BOX_CENTRE = 16.85; // the middle of the art's box
  const FIT = 1.1; // scales the art to about 24 grid units
  const STROKE = { ring: 3.1, handle: 3.6, burst: 1.6 };

  /** Draws the mark into a size x size square. `opts.ink` recolours it (the toolbar uses red for a failure). */
  function drawMark(ctx, size, t = 0, opts = {}) {
    const ink = opts.ink || COLORS.ink;
    const small = size <= 20; // thicker strokes so it holds up at 16 px
    const boost = small ? 1.15 : 1;
    const P = (d) => new Path2D(d);
    ctx.save();
    ctx.scale(size / 32, size / 32);
    ctx.translate(16, 16);
    ctx.scale(FIT, FIT);
    ctx.translate(-BOX_CENTRE, -BOX_CENTRE);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = ink;

    // The ripple: one ring leaving the lens and fading as it grows (kept small enough to stay inside the square).
    if (t > 0 && t < 1) {
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.8;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(CENTRE[0], CENTRE[1], 8.6 + ease(t) * 4.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // The lens (a solid disc, so the white details below read on any background) and its handle.
    ctx.fillStyle = ink;
    ctx.fill(P(PATHS.ring));
    ctx.lineWidth = STROKE.ring * boost;
    ctx.stroke(P(PATHS.ring));
    ctx.lineWidth = STROKE.handle * boost;
    ctx.stroke(P(PATHS.handle));

    // White touches: a glare on the glass, and the burst. The ink colour is kept for the failure state (the whole lens turns red).
    ctx.strokeStyle = COLORS.white;
    if (!small) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.2;
      ctx.stroke(P(PATHS.glare));
      ctx.restore();
    }

    // The burst twinkles (grows and turns an eighth of a turn) during the pulse.
    const grow = t > 0 && t < 1 ? 1 + 0.45 * Math.sin(Math.PI * t) : 1;
    const turn = t > 0 && t < 1 ? (Math.PI / 4) * ease(t) : 0;
    ctx.translate(CENTRE[0], CENTRE[1]);
    ctx.rotate(turn);
    ctx.scale(grow, grow);
    ctx.translate(-CENTRE[0], -CENTRE[1]);
    ctx.lineWidth = STROKE.burst * boost;
    ctx.stroke(P(small ? PATHS.burstSmall : PATHS.burst));

    ctx.restore();
  }

  /** The same drawing as a standalone SVG file: transparent background, one colour. */
  function svgFile(ink = COLORS.ink) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="128" height="128" role="img" aria-label="Lens">
  <g transform="translate(16 16) scale(${FIT}) translate(-${BOX_CENTRE} -${BOX_CENTRE})" fill="none" stroke="${ink}" stroke-linecap="round" stroke-linejoin="round">
    <path d="${PATHS.ring}" fill="${ink}" stroke-width="${STROKE.ring}"/>
    <path d="${PATHS.handle}" stroke-width="${STROKE.handle}"/>
    <path d="${PATHS.glare}" stroke="${COLORS.white}" stroke-width="1.2" stroke-opacity=".85"/>
    <path d="${PATHS.burst}" stroke="${COLORS.white}" stroke-width="${STROKE.burst}"/>
  </g>
</svg>
`;
  }

  const api = { COLORS, PATHS, STROKE, FIT, BOX_CENTRE, drawMark, svgFile };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PeekMark = api; // the global keeps its first name so background.js and the tools need no change
})(typeof globalThis !== 'undefined' ? globalThis : this);
