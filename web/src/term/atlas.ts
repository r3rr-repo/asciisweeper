/*
 * Glyph atlas.
 *
 * Only printable ASCII 32..126 is ever drawn (the game is strictly 7-bit: box
 * drawing is literal +, -, | and there are no ACS_* or wide characters), so the
 * atlas is 95 tiles per weight, two weights, in a 16-column grid:
 *
 *   rows  0..5   regular   (95 glyphs, 6 rows of 16)
 *   rows  6..11  bold
 *
 * Tiles are rasterised at EXACTLY the on-screen device-pixel cell size and
 * sampled with NEAREST, so there is no resampling anywhere in the pipeline and
 * glyphs stay crisp. That means the atlas must be rebuilt whenever the integer
 * cell size or the device pixel ratio changes.
 *
 * Glyphs are drawn white on transparent; the alpha channel is coverage and the
 * shader tints it. That keeps one atlas usable for all 16 palette colours.
 */

export const ATLAS_COLS = 16;
export const ATLAS_ROWS_PER_WEIGHT = 6;
export const ATLAS_ROWS = ATLAS_ROWS_PER_WEIGHT * 2;
const FIRST_GLYPH = 32;
const LAST_GLYPH = 126;

export interface AtlasSpec {
  /** Device-pixel size of one cell; also the tile size. */
  cellW: number;
  cellH: number;
  /** CSS font family list. */
  fontFamily: string;
  /** Fraction of cellH used as the font pixel size. */
  fontScale: number;
}

export interface Atlas {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  spec: AtlasSpec;
}

export function sameSpec(a: AtlasSpec | null, b: AtlasSpec): boolean {
  return (
    !!a && a.cellW === b.cellW && a.cellH === b.cellH &&
    a.fontFamily === b.fontFamily && a.fontScale === b.fontScale
  );
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export function buildAtlas(spec: AtlasSpec): Atlas {
  const { cellW, cellH, fontFamily, fontScale } = spec;
  const canvas = makeCanvas(ATLAS_COLS * cellW, ATLAS_ROWS * cellH);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";

  const px = Math.max(1, Math.round(cellH * fontScale));
  for (let weight = 0; weight < 2; weight++) {
    ctx.font = `${weight ? "bold " : ""}${px}px ${fontFamily}`;
    for (let code = FIRST_GLYPH; code <= LAST_GLYPH; code++) {
      const tile = code - FIRST_GLYPH;
      const tx = tile % ATLAS_COLS;
      const ty = Math.floor(tile / ATLAS_COLS) + weight * ATLAS_ROWS_PER_WEIGHT;
      // Centre within the tile. Rounding to whole device pixels keeps stems from
      // landing on half-pixel boundaries, which is what makes NEAREST look sharp.
      const cx = Math.round(tx * cellW + cellW / 2);
      const cy = Math.round(ty * cellH + cellH / 2);
      ctx.fillText(String.fromCharCode(code), cx, cy);
    }
  }
  return { canvas, spec };
}

/**
 * Measures the natural width:height of a monospace cell for a font, used only as
 * a starting suggestion. The actual cell size is a configured constant: deriving
 * it from font metrics is how the board's proportions drift away from the
 * terminal's, because the board's "glyph + trailing space" trick relies on the
 * cell being roughly 1:2.
 */
export function suggestAspect(fontFamily: string): number {
  const c = makeCanvas(8, 8);
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.font = `100px ${fontFamily}`;
  const w = ctx.measureText("M").width;
  return w > 0 ? w / 100 : 0.5;
}
