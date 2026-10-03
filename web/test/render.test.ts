/*
 * Render tests for the ported draw code.
 *
 * The WebGL layer only turns a cell buffer into pixels; everything that decides
 * WHAT is on screen lives in the Surface and the draw/* ports. So those can be
 * tested with no GPU and no browser by rendering into a Surface and dumping it
 * back to text, which is exactly the "golden frame" harness the plan calls for.
 *
 * Run via ../../build-web.sh --test.
 */
import { Surface } from "../src/term/surface";
import { XTERM, SLOT_DEFAULT_BG, SLOT_DEFAULT_FG } from "../src/term/palette";
import { setupColors, CP_CURSOR, CP_EMPTY, CP_FLAG, CP_FLAG_OPP, CP_HIDDEN, CP_NUM1, CP_WRONG_FLAG, CP_MINE_HIT } from "../src/draw/colors";
import { drawBoard, drawBoardFrame, drawHud, drawFooter, type BoardView } from "../src/draw/board";
import { drawAvatar } from "../src/draw/avatar";
import { computeLayout, clampDifficulty, AVATAR_WIDTH_CHARS } from "../src/game/layout";
import { CELL_FLAG_P1, CELL_FLAGGED, CELL_MINE, CELL_REVEALED, LOST, PLAYING, WON } from "../src/proto";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };
const eq = <T>(a: T, b: T, m: string) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

function makeSurface(cols: number, rows: number): Surface {
  const s = new Surface({ ...XTERM });
  s.resize(cols, rows);
  setupColors(s);
  return s;
}

/** The glyph layer of the surface, as lines of text with trailing blanks cut. */
function toText(s: Surface): string[] {
  const out: string[] = [];
  for (let y = 0; y < s.rows; y++) {
    let line = "";
    for (let x = 0; x < s.cols; x++) line += String.fromCharCode(s.cells[(y * s.cols + x) * 4]);
    out.push(line.replace(/\s+$/, ""));
  }
  return out;
}

const fgAt = (s: Surface, y: number, x: number) => s.cells[(y * s.cols + x) * 4 + 1];
const bgAt = (s: Surface, y: number, x: number) => s.cells[(y * s.cols + x) * 4 + 2];
const chAt = (s: Surface, y: number, x: number) => String.fromCharCode(s.cells[(y * s.cols + x) * 4]);

/** Builds a cell-byte grid the way core_snapshot() would. */
function cells(w: number, h: number, spec: (x: number, y: number) => number): Uint8Array {
  const c = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) c[y * w + x] = spec(x, y);
  return c;
}

function view(over: Partial<BoardView> & { w: number; h: number; cells: Uint8Array }): BoardView {
  return {
    status: PLAYING, explodedX: -1, explodedY: -1,
    cursorX: -1, cursorY: -1, top: 4, left: 1,
    ...over,
  };
}

// ---------------------------------------------------------------- erase/clrtoeol
{
  const s = makeSurface(20, 3);
  s.withAttrs(CP_FLAG, true, () => s.print(0, 0, "a longer message"));
  // clrtoeol must clear with the CURRENT attributes, which is what lets the
  // multiplayer end screen wipe a previous, longer line (src/main.c).
  s.withAttrs(CP_NUM1, false, () => { s.print(0, 0, "short"); s.clrtoeol(0, 5); });
  eq(toText(s)[0], "short", "clrtoeol wipes the tail of a longer previous line");
  eq(bgAt(s, 0, 10), SLOT_DEFAULT_BG, "cleared tail takes the current pair's background");

  s.erase();
  eq(toText(s)[0], "", "erase blanks the grid");
  eq(fgAt(s, 0, 0), SLOT_DEFAULT_FG, "erase restores the default foreground");
}

// ------------------------------------------------------------------- bold->bright
{
  const s = makeSurface(10, 2);
  s.withAttrs(CP_NUM1, false, () => s.addch(0, 0, "1"));
  s.withAttrs(CP_NUM1, true, () => s.addch(0, 1, "1"));
  eq(fgAt(s, 0, 0), 4, "CP_NUM1 normal is ANSI blue (4)");
  eq(fgAt(s, 0, 1), 12, "CP_NUM1 bold is BRIGHT blue (12)");

  // CP_HIDDEN is drawn WITHOUT bold in the C, so it must stay the dim cyan.
  s.withAttrs(CP_HIDDEN, false, () => s.addch(1, 0, "."));
  eq(fgAt(s, 1, 0), 6, "CP_HIDDEN stays dim cyan (6), not bright");

  // CP_CURSOR is black-on-white drawn WITH bold, so the glyph is bright black.
  s.withAttrs(CP_CURSOR, true, () => s.addch(1, 1, "x"));
  eq(fgAt(s, 1, 1), 8, "bold black becomes bright black (8) - grey on white");
  eq(bgAt(s, 1, 1), 7, "bold never brightens the background");

  // With brightenBlack off, the cursor glyph is true black instead.
  const s2 = new Surface({ ...XTERM, brightenBlack: false });
  s2.resize(4, 1);
  setupColors(s2);
  s2.withAttrs(CP_CURSOR, true, () => s2.addch(0, 0, "x"));
  eq(fgAt(s2, 0, 0), 0, "brightenBlack=false keeps the cursor glyph true black");
}

// ------------------------------------------------------------------- glyph choice
{
  const w = 6, h = 1;
  //   x=0 hidden, 1 flagged, 2 revealed empty, 3 revealed '3', 4 revealed mine, 5 flagged
  const c = cells(w, h, (x) => {
    switch (x) {
      case 0: return 0;
      case 1: return CELL_FLAGGED;
      case 2: return CELL_REVEALED;
      case 3: return CELL_REVEALED | 3;
      case 4: return CELL_REVEALED | CELL_MINE;
      default: return CELL_FLAGGED;
    }
  });
  const s = makeSurface(40, 10);
  drawBoard(s, view({ w, h, cells: c }));
  const row = 4;
  eq(chAt(s, row, 1 + 0 * 2), ".", "hidden cell draws '.'");
  eq(chAt(s, row, 1 + 1 * 2), "F", "flagged cell draws 'F'");
  eq(chAt(s, row, 1 + 2 * 2), " ", "revealed empty draws a space");
  eq(bgAt(s, row, 1 + 2 * 2), 4, "revealed empty is on ANSI blue (CP_EMPTY)");
  eq(chAt(s, row, 1 + 3 * 2), "3", "revealed 3 draws '3'");
  eq(chAt(s, row, 1 + 4 * 2), "*", "revealed mine draws '*'");

  // Each cell occupies TWO columns: glyph then a blank with the same attributes.
  // Dropping the blank half would break the look, since revealed-empty is a
  // 2-wide blue block.
  eq(chAt(s, row, 1 + 2 * 2 + 1), " ", "the second column of a cell is blank");
  eq(bgAt(s, row, 1 + 2 * 2 + 1), 4, "...and carries the same background");
}

// -------------------------------------------------------- wrong flag only on loss
{
  const w = 2, h = 1;
  // x=0 flagged non-mine, x=1 flagged mine revealed (board_reveal_all_mines ran)
  const c = cells(w, h, (x) => (x === 0 ? CELL_FLAGGED : CELL_FLAGGED | CELL_MINE | CELL_REVEALED));

  const lost = makeSurface(20, 10);
  drawBoard(lost, view({ w, h, cells: c, status: LOST }));
  eq(chAt(lost, 4, 1), "X", "on a lost board a flagged non-mine is a wrong flag 'X'");
  eq(fgAt(lost, 4, 1), 1, "...drawn in red (CP_WRONG_FLAG), not bold");
  eq(chAt(lost, 4, 3), "F", "a correctly flagged mine stays 'F' even on a loss");

  // On a win, board_check_win flags the mines WITHOUT revealing them, so they
  // must still read as 'F' rather than falling into the wrong-flag branch.
  const won = makeSurface(20, 10);
  drawBoard(won, view({ w, h, cells: cells(w, h, () => CELL_FLAGGED), status: WON }));
  eq(chAt(won, 4, 1), "F", "on a won board flagged-but-unrevealed mines draw 'F'");
  eq(chAt(won, 4, 3), "F", "...for every mine");
  void CP_WRONG_FLAG;
}

// ------------------------------------------------------- flag ownership colours
{
  const w = 2, h = 1;
  // x=0 flagged by player 0 (bit4 clear), x=1 flagged by player 1 (bit4 set)
  const c = cells(w, h, (x) => CELL_FLAGGED | (x === 1 ? CELL_FLAG_P1 : 0));

  // Seen as player 0: the first flag is mine, the second theirs.
  const as0 = makeSurface(20, 10);
  drawBoard(as0, view({ w, h, cells: c, myPlayerId: 0 }));
  eq(chAt(as0, 4, 1), "F", "an owned flag is still drawn as 'F'");
  eq(chAt(as0, 4, 3), "F", "an opponent flag uses the same glyph, not a new one");
  eq(fgAt(as0, 4, 1), 11, "player 0 sees their own flag in bright yellow (CP_FLAG bold)");
  eq(fgAt(as0, 4, 3), 13, "...and the opponent's in bright magenta (CP_FLAG_OPP bold)");

  // The same board seen as player 1: the colours swap.
  const as1 = makeSurface(20, 10);
  drawBoard(as1, view({ w, h, cells: c, myPlayerId: 1 }));
  eq(fgAt(as1, 4, 1), 13, "player 1 sees player 0's flag as the opponent's");
  eq(fgAt(as1, 4, 3), 11, "...and their own as their own");

  // Single-player has no owner, so every flag is drawn as yours.
  const sp = makeSurface(20, 10);
  drawBoard(sp, view({ w, h, cells: c }));
  eq(fgAt(sp, 4, 1), 11, "single-player draws flags as yours");
  eq(fgAt(sp, 4, 3), 11, "...even when bit 4 happens to be set");

  // A wrong flag on a lost board must still read as wrong, whoever placed it.
  const lost = makeSurface(20, 10);
  drawBoard(lost, view({ w, h, cells: c, status: LOST, myPlayerId: 0 }));
  eq(chAt(lost, 4, 1), "X", "a wrong flag is still X on a loss");
  eq(chAt(lost, 4, 3), "X", "...including the opponent's");
  void CP_FLAG; void CP_FLAG_OPP;
}

// ------------------------------------------------------------------ exploded cell
{
  const w = 2, h = 1;
  const c = cells(w, h, () => CELL_REVEALED | CELL_MINE);
  const s = makeSurface(20, 10);
  drawBoard(s, view({ w, h, cells: c, status: LOST, explodedX: 1, explodedY: 0 }));
  eq(bgAt(s, 4, 3), 1, "the exploded mine is on a red background (CP_MINE_HIT)");
  eq(bgAt(s, 4, 1), SLOT_DEFAULT_BG, "other mines keep the default background");
  void CP_MINE_HIT;
}

// ----------------------------------------------------------- cursor suppression
{
  const w = 3, h = 1;
  const c = cells(w, h, () => 0);
  const playing = makeSurface(20, 10);
  drawBoard(playing, view({ w, h, cells: c, cursorX: 1, cursorY: 0 }));
  eq(bgAt(playing, 4, 3), 7, "the cursor cell is on white while playing");

  // src/main.c:207 gates the cursor on status == STATE_PLAYING.
  const over = makeSurface(20, 10);
  drawBoard(over, view({ w, h, cells: c, cursorX: 1, cursorY: 0, status: LOST }));
  ok(bgAt(over, 4, 3) !== 7, "the cursor is not drawn once the game is over");
}

// --------------------------------------------------------------------- frame + hud
{
  const w = 8, h = 3;
  const s = makeSurface(40, 14);
  const v = view({ w, h, cells: cells(w, h, () => 0), top: 5, left: 2 });
  drawBoardFrame(s, v);
  drawHud(s, v, 7, 42);
  const t = toText(s);
  eq(t[4], " +----------------+", "top border is + - + spanning w*2 columns");
  eq(t[5][1], "|", "left border on the first board row");
  eq(t[5][2 + w * 2], "|", "right border on the first board row");
  eq(t[5 + h], " +----------------+", "bottom border");
  ok(t[1].includes("ASCIISWEEPER"), "the title sits 4 rows above the board");
  ok(t[3].includes("Mines: 007    Time: 042"),
    `HUD is zero-padded like the C's %03d (got "${t[3].trim()}")`);

  // Clamping, matching src/main.c:138 and :143.
  drawHud(s, v, -5, 5000);
  const t2 = toText(s);
  ok(t2[3].includes("Mines: 000"), "a negative mine count clamps to 000");
  ok(t2[3].includes("Time: 999"), "elapsed clamps to 999");
}

// ------------------------------------------------------------------------ footer
{
  const s = makeSurface(60, 14);
  const v = view({ w: 8, h: 3, cells: cells(8, 3, () => 0), top: 4, left: 2 });
  drawFooter(s, v);
  const t = toText(s);
  // The footer centres on the SCREEN, not the board (src/main.c:160-163).
  const line1 = "Move: arrows/hjkl  |  Reveal: space/enter  |  Flag: f";
  eq(t[9].trim(), line1, "footer line 1 is two rows below the board");
  eq(t[9].indexOf("M"), Math.floor((60 - line1.length) / 2), "footer centres on the screen width");
}

// ------------------------------------------------------------------------ layout
{
  // src/main.c:93 - block height is h+8, board block width is w*2+2.
  const l = computeLayout(16, 16, 80, 30, false);
  eq(l.top, Math.floor((30 - 24) / 2) + 4, "top matches game_init's arithmetic");
  eq(l.left, Math.floor((80 - 34) / 2) + 1, "left matches game_init's arithmetic");
  eq(l.sidePanelsFit, false, "side panels are off when not requested");

  // Avatar panels need board width + 2*(12+2) columns.
  eq(computeLayout(16, 16, 80, 30, true).sidePanelsFit, true, "panels fit at 80 columns");
  eq(computeLayout(16, 16, 50, 30, true).sidePanelsFit, false, "panels do not fit at 50 columns");
  const withPanels = computeLayout(16, 16, 80, 30, true);
  eq(withPanels.left, Math.floor((80 - (34 + 28)) / 2) + 1 + AVATAR_WIDTH_CHARS + 2,
    "the board shifts right to make room for the left avatar panel");

  // Never negative, even when the board cannot fit.
  const tight = computeLayout(30, 16, 20, 10, false);
  ok(tight.top >= 4 && tight.left >= 1, "layout stays on screen when the board is too big");
}

// ------------------------------------------------------- difficulty clamp (main.c:1176)
{
  const c1 = clampDifficulty(30, 16, 99, 80, 30, 60, 30);
  eq(c1.w, 30, "expert width survives an 80-column terminal");
  const c2 = clampDifficulty(30, 16, 99, 40, 20, 60, 30);
  eq(c2.w, Math.floor((40 - 4) / 2), "width clamps to (cols-4)/2");
  eq(c2.h, 20 - 10, "height clamps to rows-10");
  const c3 = clampDifficulty(5, 5, 999, 80, 30, 60, 30);
  eq(c3.mines, 5 * 5 - 9, "mines clamp to w*h-9, as the C does");
  const c4 = clampDifficulty(1, 1, 1, 80, 30, 60, 30);
  ok(c4.w >= 4 && c4.h >= 4, "a tiny board is floored at 4x4");
  const c5 = clampDifficulty(999, 999, 10, 400, 200, 60, 30);
  eq(c5.w, 60, "width never exceeds MAX_W");
  eq(c5.h, 30, "height never exceeds MAX_H");
}

// ------------------------------------------------------------------------ avatar
{
  const s = makeSurface(20, 8);
  const a = { skin: 3, hair: 5 };
  drawAvatar(s, 0, 0, a, true);
  // Rows 0-1 are hair, the rest skin; the image is carried in the BACKGROUND.
  eq(bgAt(s, 0, 0), 5, "row 0 is hair-coloured");
  eq(bgAt(s, 1, 0), 5, "row 1 is hair-coloured");
  eq(bgAt(s, 3, 0), 3, "row 3 is skin-coloured");
  // Eyes at row 2, columns 2 and 4, each 2 characters wide.
  eq(bgAt(s, 2, 4), 0, "left eye is black (column 2 -> screen column 4)");
  eq(bgAt(s, 2, 8), 0, "right eye is black (column 4 -> screen column 8)");
  eq(bgAt(s, 2, 0), 3, "the rest of the eye row is skin");
  eq(chAt(s, 2, 4), " ", "an open eye is a blank cell");
  // Every pixel is two characters wide.
  eq(bgAt(s, 2, 5), 0, "the eye's second column matches");

  drawAvatar(s, 0, 0, a, false);
  eq(chAt(s, 2, 4), "-", "a closed eye is an eyelid '-'");
  eq(bgAt(s, 2, 4), 3, "...on the SKIN background, not a black square");
  eq(fgAt(s, 2, 4), 0, "...drawn in the eye colour");
}

// ------------------------------------------------------- a full frame, as text
{
  const w = 8, h = 8;
  const s = makeSurface(44, 20);
  // A board resembling the README's mockup: some numbers, a flag, hidden cells.
  const c = cells(w, h, (x, y) => {
    if (y === 0 && x < 2) return CELL_REVEALED | 1;
    if (y === 5 && x === 0) return CELL_FLAGGED;
    if (y === 3 && x === 3) return CELL_REVEALED;
    return 0;
  });
  const v = view({ w, h, cells: c, top: 5, left: 2, cursorX: 4, cursorY: 4 });
  drawBoardFrame(s, v);
  drawBoard(s, v);
  drawHud(s, v, 7, 42);
  drawFooter(s, v);
  const t = toText(s);
  // top = 5, so the frame's top border is at row top-1, board row y at top+y,
  // and the bottom border at top+h.
  eq(t[4], " +----------------+", "frame top");
  eq(t[5], " |1 1 . . . . . . |", "first board row: two 1s then hidden cells");
  eq(t[10], " |F . . . . . . . |", "the flag row");
  eq(t[13], " +----------------+", "frame bottom");
  console.log("\n--- rendered frame ---");
  for (const line of t) if (line) console.log(`|${line}`);
  console.log("--- end frame ---\n");
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
