/*
 * Port of setup_colors() and color_for_number() from src/main.c:43-80.
 *
 * The CP_* ids and the fg/bg of every pair are kept exactly as the C declares
 * them, including the avatar's reserved ranges from src/avatar.c, so this file
 * can be read side by side with the original.
 */
import { DEFAULT } from "../term/palette";
import type { Surface } from "../term/surface";

// ncurses COLOR_* constants are 0-7 and map straight onto palette slots.
export const BLACK = 0, RED = 1, GREEN = 2, YELLOW = 3,
             BLUE = 4, MAGENTA = 5, CYAN = 6, WHITE = 7;

/** src/main.c:37-41 */
export const CP_NUM1 = 1, CP_NUM2 = 2, CP_NUM3 = 3, CP_NUM4 = 4,
             CP_NUM5 = 5, CP_NUM6 = 6, CP_NUM7 = 7, CP_NUM8 = 8,
             CP_HIDDEN = 9, CP_FLAG = 10, CP_MINE = 11, CP_MINE_HIT = 12,
             CP_WRONG_FLAG = 13, CP_EMPTY = 14, CP_HUD = 15, CP_TITLE = 16,
             CP_CURSOR = 17, CP_WIN = 18, CP_LOSE = 19;

/** src/avatar.c:10 and :20 - deliberately out of the way of the CP_* range. */
export const AVATAR_PAIR_BASE = 100;
export const AVATAR_BLINK_PAIR_BASE = 120;
/** src/avatar.c:15 - eyes are always this, and never generated as skin/hair. */
export const AVATAR_EYE_COLOR = BLACK;

export function setupColors(s: Surface): void {
  s.initPair(CP_NUM1, BLUE, DEFAULT);
  s.initPair(CP_NUM2, GREEN, DEFAULT);
  s.initPair(CP_NUM3, RED, DEFAULT);
  s.initPair(CP_NUM4, MAGENTA, DEFAULT);
  s.initPair(CP_NUM5, YELLOW, DEFAULT);
  s.initPair(CP_NUM6, CYAN, DEFAULT);
  s.initPair(CP_NUM7, WHITE, DEFAULT);
  s.initPair(CP_NUM8, WHITE, DEFAULT); // identical to NUM7 in the C; preserved
  s.initPair(CP_HIDDEN, CYAN, DEFAULT);
  s.initPair(CP_FLAG, YELLOW, DEFAULT);
  s.initPair(CP_MINE, WHITE, DEFAULT);
  s.initPair(CP_MINE_HIT, WHITE, RED);
  s.initPair(CP_WRONG_FLAG, RED, DEFAULT);
  s.initPair(CP_EMPTY, DEFAULT, BLUE);
  s.initPair(CP_HUD, WHITE, DEFAULT);
  s.initPair(CP_TITLE, GREEN, DEFAULT);
  s.initPair(CP_CURSOR, BLACK, WHITE);
  s.initPair(CP_WIN, GREEN, DEFAULT);
  s.initPair(CP_LOSE, RED, DEFAULT);

  // src/avatar.c:28-31 - white on the colour for the body, eye-colour on the
  // colour for a closed (blinking) eye.
  for (let c = 0; c <= 7; c++) {
    s.initPair(AVATAR_PAIR_BASE + c, WHITE, c);
    s.initPair(AVATAR_BLINK_PAIR_BASE + c, AVATAR_EYE_COLOR, c);
  }
}

/** src/main.c:68-80 */
export function colorForNumber(n: number): number {
  switch (n) {
    case 1: return CP_NUM1;
    case 2: return CP_NUM2;
    case 3: return CP_NUM3;
    case 4: return CP_NUM4;
    case 5: return CP_NUM5;
    case 6: return CP_NUM6;
    case 7: return CP_NUM7;
    default: return CP_NUM8;
  }
}
