/*
 * A fidelity test card: every glyph the game draws, in every CP_* pair, bold and
 * not. Exhaustive in a way a real board is not, which makes it the thing that
 * actually catches a wrong bold->bright mapping or a mis-tinted atlas.
 *
 * Open it with #testcard in the URL, screenshot it, and compare against the same
 * pattern printed by a real terminal.
 */
import type { Surface } from "./surface";
import {
  CP_CURSOR, CP_EMPTY, CP_FLAG, CP_HIDDEN, CP_HUD, CP_LOSE, CP_MINE,
  CP_MINE_HIT, CP_NUM1, CP_NUM2, CP_NUM3, CP_NUM4, CP_NUM5, CP_NUM6, CP_NUM7,
  CP_NUM8, CP_TITLE, CP_WIN, CP_WRONG_FLAG,
} from "../draw/colors";

const PAIRS: [string, number][] = [
  ["NUM1", CP_NUM1], ["NUM2", CP_NUM2], ["NUM3", CP_NUM3], ["NUM4", CP_NUM4],
  ["NUM5", CP_NUM5], ["NUM6", CP_NUM6], ["NUM7", CP_NUM7], ["NUM8", CP_NUM8],
  ["HIDDEN", CP_HIDDEN], ["FLAG", CP_FLAG], ["MINE", CP_MINE],
  ["MINE_HIT", CP_MINE_HIT], ["WRONG_FLAG", CP_WRONG_FLAG], ["EMPTY", CP_EMPTY],
  ["HUD", CP_HUD], ["TITLE", CP_TITLE], ["CURSOR", CP_CURSOR],
  ["WIN", CP_WIN], ["LOSE", CP_LOSE],
];

export function drawTestCard(s: Surface): void {
  s.erase();
  const header = "ASCIISWEEPER TEST CARD - every pair, normal then bold";
  s.withAttrs(CP_TITLE, true, () => s.print(0, 1, header));

  // Each pair twice: normal weight, then bold (which should also brighten).
  PAIRS.forEach(([name, pair], i) => {
    const row = 2 + i;
    s.withAttrs(CP_HUD, false, () => s.print(row, 1, name.padEnd(11)));
    const sample = " .F*X12345678 ";
    s.withAttrs(pair, false, () => s.print(row, 13, sample));
    s.withAttrs(pair, true, () => s.print(row, 13 + sample.length + 2, sample));
  });

  // The full printable ASCII range, to prove every atlas tile is in the right
  // place and nothing is off by one.
  const base = 2 + PAIRS.length + 1;
  s.withAttrs(CP_HUD, false, () => s.print(base, 1, "ASCII 32..126:"));
  let row = base + 1;
  let col = 1;
  for (let code = 32; code <= 126; code++) {
    if (col >= s.cols - 1) { col = 1; row++; }
    s.withAttrs(CP_HUD, false, () => s.addch(row, col, String.fromCharCode(code)));
    col++;
  }
  row += 2;
  s.withAttrs(CP_HUD, true, () => s.print(row, 1, "same, bold:"));
  row++;
  col = 1;
  for (let code = 32; code <= 126; code++) {
    if (col >= s.cols - 1) { col = 1; row++; }
    s.withAttrs(CP_HUD, true, () => s.addch(row, col, String.fromCharCode(code)));
    col++;
  }
}
