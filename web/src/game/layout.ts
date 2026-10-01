/*
 * Port of game_init()'s layout arithmetic, src/main.c:84-104.
 *
 * Kept as its own module because both the single-player and multiplayer screens
 * use it, and because it is the part most likely to be compared against the C
 * line by line when the centring looks off.
 */

/** src/avatar.h - 6 pixels wide, each drawn as 2 characters. */
export const AVATAR_ROWS = 6;
export const AVATAR_COLS = 6;
export const AVATAR_WIDTH_CHARS = AVATAR_COLS * 2;
export const AVATAR_HEIGHT_CHARS = AVATAR_ROWS;
/** src/main.c:82 */
export const AVATAR_GUTTER = 2;

export interface Layout {
  top: number;
  left: number;
  sidePanelsFit: boolean;
}

export function computeLayout(
  w: number, h: number, cols: number, rows: number, wantSidePanels: boolean,
): Layout {
  // src/main.c:93 - title, blank, hud, border*2, board rows, blank, footer*2
  const blockH = h + 8;
  const boardBlockW = w * 2 + 2;
  const panelExtra = 2 * (AVATAR_WIDTH_CHARS + AVATAR_GUTTER);
  const sidePanelsFit = wantSidePanels && cols >= boardBlockW + panelExtra;
  const blockW = boardBlockW + (sidePanelsFit ? panelExtra : 0);

  let originY = Math.floor((rows - blockH) / 2);
  let originX = Math.floor((cols - blockW) / 2);
  if (originY < 0) originY = 0;
  if (originX < 0) originX = 0;

  return {
    top: originY + 4,
    left: originX + 1 + (sidePanelsFit ? AVATAR_WIDTH_CHARS + AVATAR_GUTTER : 0),
    sidePanelsFit,
  };
}

/**
 * Port of the terminal-fit clamp at src/main.c:1176-1183. The browser version
 * applies the same bounds so a board that would not fit is handled identically.
 */
export function clampDifficulty(
  w: number, h: number, mines: number, cols: number, rows: number, maxW: number, maxH: number,
): { w: number; h: number; mines: number } {
  const maxBoardW = Math.min(Math.floor((cols - 4) / 2), maxW);
  const maxBoardH = Math.min(rows - 10, maxH);
  if (w > maxBoardW) w = maxBoardW;
  if (h > maxBoardH) h = maxBoardH;
  if (w < 4) w = 4;
  if (h < 4) h = 4;
  const maxMines = w * h - 9;
  if (mines > maxMines) mines = maxMines > 0 ? maxMines : 1;
  if (mines < 1) mines = 1;
  return { w, h, mines };
}
