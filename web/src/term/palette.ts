/*
 * The 16 ANSI colours, plus the two values ncurses leaves unspecified.
 *
 * src/main.c's setup_colors() names only the 8 base colours and calls
 * use_default_colors(), so the actual RGB never existed in the repo - it came
 * from whatever terminal emulator the game was run in. The values below are the
 * xterm defaults, which most terminals approximate.
 *
 * >>> THESE ARE PLACEHOLDERS UNTIL SAMPLED FROM A REAL SCREENSHOT. <<<
 * Phase 0 of the plan is to run ./build/asciisweeper, screenshot it, and replace
 * ANSI/defaultFg/defaultBg here with pixel values read out of that screenshot.
 * Two of these dominate the look and are the ones to get right:
 *   - ansi[4] (blue): CP_EMPTY paints every revealed cell in it.
 *   - ansi[6] (cyan): CP_HIDDEN draws every unrevealed '.' in it, NOT bold, so
 *     it must stay dim. A bright cyan here reads instantly as a different game.
 */

/** Sentinel for ncurses' `-1`, i.e. "the terminal's own colour". */
export const DEFAULT = -1;

/** Palette texture slots. 0-15 are ANSI; 16/17 hold the two defaults. */
export const SLOT_DEFAULT_FG = 16;
export const SLOT_DEFAULT_BG = 17;
export const PALETTE_SLOTS = 32; // texture width; 18 used, rounded up

export interface Palette {
  /** 16 entries: 0-7 normal, 8-15 bright. */
  ansi: string[];
  defaultFg: string;
  defaultBg: string;
  /**
   * ncurses' A_BOLD on a coloured foreground renders as the *bright* variant in
   * virtually every modern terminal. With this on, bold also brightens black -
   * which makes the cursor (CP_CURSOR is black-on-white, drawn with A_BOLD) a
   * grey glyph on white rather than a black one. Real terminals do exactly that,
   * so `true` is the faithful setting even though it looks slightly wrong.
   */
  brightenBlack: boolean;
}

export const XTERM: Palette = {
  ansi: [
    "#000000", // 0 black
    "#aa0000", // 1 red
    "#00aa00", // 2 green
    "#aa5500", // 3 yellow (xterm's is brownish)
    "#0000aa", // 4 blue      <- CP_EMPTY background
    "#aa00aa", // 5 magenta
    "#00aaaa", // 6 cyan      <- CP_HIDDEN foreground
    "#aaaaaa", // 7 white
    "#555555", // 8 bright black
    "#ff5555", // 9 bright red
    "#55ff55", // 10 bright green
    "#ffff55", // 11 bright yellow
    "#5555ff", // 12 bright blue
    "#ff55ff", // 13 bright magenta
    "#55ffff", // 14 bright cyan
    "#ffffff", // 15 bright white
  ],
  // Must equal ansi[7], not pure white: CP_HUD is explicitly COLOR_WHITE on -1,
  // so if the default foreground were brighter than ANSI white, HUD text and
  // plain default text would differ - in a real terminal they match.
  defaultFg: "#aaaaaa",
  defaultBg: "#000000",
  brightenBlack: true,
};

export function resolveBold(slot: number, bold: boolean, p: Palette): number {
  if (!bold || slot < 0 || slot > 7) return slot;
  if (slot === 0 && !p.brightenBlack) return 0;
  return slot + 8;
}

/** Packs a palette into the 32x1 RGBA8 texture the shader indexes. */
export function paletteTexels(p: Palette): Uint8Array {
  const out = new Uint8Array(PALETTE_SLOTS * 4);
  const put = (i: number, hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    out[i * 4 + 0] = (n >> 16) & 255;
    out[i * 4 + 1] = (n >> 8) & 255;
    out[i * 4 + 2] = n & 255;
    out[i * 4 + 3] = 255;
  };
  for (let i = 0; i < 16; i++) put(i, p.ansi[i]);
  put(SLOT_DEFAULT_FG, p.defaultFg);
  put(SLOT_DEFAULT_BG, p.defaultBg);
  return out;
}
