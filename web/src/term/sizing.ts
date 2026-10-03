/*
 * Choosing the grid.
 *
 * The earlier version picked the largest integer SCALE at which the minimum
 * 40x20 grid still fit, which is backwards: a bigger screen then meant bigger
 * cells and FEWER rows, so the multiplayer chat fell off the bottom on every
 * normal display and survived only in a small window.
 *
 * Integer scale steps were never needed anyway. The atlas is rasterised at
 * runtime at the exact device-pixel cell size, so what crispness requires is
 * integer CELL DIMENSIONS, not an integer scale factor - only a fixed bitmap
 * atlas would need the latter. Sizing straight from a target row count gives
 * fine-grained control and stays just as sharp.
 */

/** Below this the game refuses to run; matches main.c:1143-1149's check. */
export const MIN_COLS = 40;
export const MIN_ROWS = 20;
/** Keeps a very large display from producing an absurd grid. */
export const MAX_COLS = 120;
export const MAX_ROWS = 48;

/**
 * Columns we try to fit. The multiplayer layout is 16*2+2 + 2*(12+2) = 62
 * columns wide, so this leaves margin without letting cells get tiny.
 */
export const DESIRED_COLS = 80;

/**
 * Rows targeted by default, and the range the zoom control may reach.
 *
 * The lower bound is not cosmetic. The multiplayer screen needs 31 rows for its
 * block (16 board + 8 chrome + 7 reserved for the end-of-match result, chat log
 * and composer), so allowing a smaller target would let someone zoom straight
 * back into the clipped-chat bug this sizing exists to fix. Zooming in is capped
 * there rather than letting the layout break quietly.
 */
export const DEFAULT_TARGET_ROWS = 32;
export const MIN_TARGET_ROWS = 31;
export const MAX_TARGET_ROWS = 48;

/** Never shrink a cell below this many device pixels; glyphs stop being legible. */
const MIN_CELL_H = 8;

export interface Grid {
  /** Device pixels. Always integers - that is the crispness requirement. */
  cellW: number;
  cellH: number;
  cols: number;
  rows: number;
}

export interface GridOpts {
  /** Cell aspect, as width / height. The terminal convention is about 1:2. */
  aspect?: number;
  desiredCols?: number;
  maxCols?: number;
  maxRows?: number;
}

export function clampTargetRows(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TARGET_ROWS;
  return Math.min(MAX_TARGET_ROWS, Math.max(MIN_TARGET_ROWS, Math.round(n)));
}

/**
 * `backW`/`backH` are the canvas backing store in DEVICE pixels, so they already
 * include devicePixelRatio. It cancels out of the column and row counts, which
 * is correct: a higher DPR should make the same grid sharper, not smaller.
 */
export function chooseGrid(
  backW: number, backH: number, targetRows: number, opts: GridOpts = {},
): Grid {
  const aspect = opts.aspect ?? 0.5;
  const desiredCols = opts.desiredCols ?? DESIRED_COLS;
  const maxCols = opts.maxCols ?? MAX_COLS;
  const maxRows = opts.maxRows ?? MAX_ROWS;
  const target = clampTargetRows(targetRows);

  // Height that gives the wanted rows, and height that gives the wanted columns.
  // The smaller wins, so both constraints are satisfied.
  const byRows = Math.floor(backH / target);
  const byCols = Math.floor((backW / desiredCols) / aspect);
  const cellH = Math.max(MIN_CELL_H, Math.min(byRows, byCols));
  const cellW = Math.max(Math.round(MIN_CELL_H * aspect), Math.round(cellH * aspect));

  return {
    cellW,
    cellH,
    cols: Math.min(Math.max(Math.floor(backW / cellW), 1), maxCols),
    rows: Math.min(Math.max(Math.floor(backH / cellH), 1), maxRows),
  };
}

/**
 * Largest font size whose glyphs fit inside a cell, both ways.
 *
 * The width half matters because the font is a STACK: whichever family the
 * system actually resolves decides the advance, and a glyph wider than the cell
 * bleeds into the neighbouring atlas tile, which reads on screen as ghosting
 * rather than as an obvious error.
 *
 * `advanceRatio` is the advance width per pixel of font size, measured from the
 * resolved font rather than assumed.
 */
export function fitFontSize(
  cellW: number, cellH: number, advanceRatio: number, heightScale: number,
): number {
  const byWidth = advanceRatio > 0 ? Math.floor(cellW / advanceRatio) : Infinity;
  const byHeight = Math.floor(cellH * heightScale);
  return Math.max(1, Math.min(byWidth, byHeight));
}
