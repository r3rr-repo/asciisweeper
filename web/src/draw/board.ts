/*
 * Ports of draw_board_frame, draw_hud, draw_footer, draw_board and render,
 * src/main.c:106-229.
 *
 * draw_board takes the w*h cell-byte snapshot that core_snapshot() produces,
 * which is board_to_wire's encoding - the same bytes the server sends in
 * multiplayer. One decode path serves both modes, mirroring the fact that the C
 * draw_board already does.
 */
import { CELL_ADJACENT, CELL_FLAGGED, CELL_MINE, CELL_REVEALED, LOST, PLAYING } from "../proto";
import type { Surface } from "../term/surface";
import {
  CP_CURSOR, CP_EMPTY, CP_FLAG, CP_HIDDEN, CP_HUD, CP_MINE, CP_MINE_HIT,
  CP_TITLE, CP_WRONG_FLAG, colorForNumber,
} from "./colors";

export interface BoardView {
  cells: Uint8Array; // w*h, net_proto.h encoding
  w: number;
  h: number;
  status: number;
  explodedX: number;
  explodedY: number;
  cursorX: number;
  cursorY: number;
  top: number;
  left: number;
}

/** src/main.c:106-123 */
export function drawBoardFrame(s: Surface, v: BoardView): void {
  const { top, left, w, h } = v;
  s.withAttrs(CP_HUD, false, () => {
    s.addch(top - 1, left - 1, "+");
    s.addch(top - 1, left + w * 2, "+");
    s.addch(top + h, left - 1, "+");
    s.addch(top + h, left + w * 2, "+");
    for (let x = 0; x < w * 2; x++) {
      s.addch(top - 1, left + x, "-");
      s.addch(top + h, left + x, "-");
    }
    for (let y = 0; y < h; y++) {
      s.addch(top + y, left - 1, "|");
      s.addch(top + y, left + w * 2, "|");
    }
  });
}

/** src/main.c:125-150 */
export function drawHud(
  s: Surface, v: BoardView, minesLeft: number, elapsed: number,
): void {
  const { top, left, w } = v;
  const boardWidth = w * 2;

  const title = "ASCIISWEEPER";
  s.withAttrs(CP_TITLE, true, () => {
    s.print(top - 4, s.centreCol(left, boardWidth, title), title);
  });

  let e = elapsed;
  if (e > 999) e = 999;
  const m = minesLeft < 0 ? 0 : minesLeft;
  const statusLine = `Mines: ${pad3(m)}    Time: ${pad3(e)}`;
  s.withAttrs(CP_HUD, false, () => {
    s.print(top - 2, s.centreCol(left, boardWidth, statusLine), statusLine);
  });
}

/** %03d, as the C's snprintf does. */
export function pad3(n: number): string {
  return String(Math.max(0, Math.trunc(n))).padStart(3, "0");
}

/** src/main.c:152-169 - both lines centred on the SCREEN, not the board. */
export function drawFooter(s: Surface, v: BoardView): void {
  const line1 = "Move: arrows/hjkl  |  Reveal: space/enter  |  Flag: f";
  const line2 = "Chord: c  |  Restart: r  |  Menu: n  |  Quit: q";
  s.withAttrs(CP_HUD, false, () => {
    s.print(v.top + v.h + 2, s.centreCol(0, s.cols, line1), line1);
    s.print(v.top + v.h + 3, s.centreCol(0, s.cols, line2), line2);
  });
}

/**
 * src/main.c:171-219.
 *
 * Note the two addch calls per cell: a glyph then a trailing space, both with
 * the same attributes. That is what makes a cell two columns wide, which is how
 * a board cell ends up roughly square in a terminal whose character cell is
 * roughly 1:2. A renderer that skips the blank half destroys the look, because
 * revealed-empty is a 2-wide blue block and the cursor is a 2-wide white block.
 */
export function drawBoard(s: Surface, v: BoardView): void {
  for (let y = 0; y < v.h; y++) {
    for (let x = 0; x < v.w; x++) {
      const byte = v.cells[y * v.w + x];
      const revealed = (byte & CELL_REVEALED) !== 0;
      const flagged = (byte & CELL_FLAGGED) !== 0;
      const mine = (byte & CELL_MINE) !== 0;
      const adjacent = byte & CELL_ADJACENT;

      let ch: string;
      let pair: number;
      let bold = false;

      if (flagged) {
        if (v.status === LOST && !mine) {
          // A flagged cell that did NOT come back as a revealed mine is a wrong
          // flag. board_reveal_all_mines runs on loss, so every real mine is
          // revealed by now, which is what makes this test work.
          ch = "X";
          pair = CP_WRONG_FLAG;
        } else {
          ch = "F";
          pair = CP_FLAG;
          bold = true;
        }
      } else if (!revealed) {
        ch = ".";
        pair = CP_HIDDEN; // cyan and NOT bold: it must stay dim
      } else if (mine) {
        ch = "*";
        pair = x === v.explodedX && y === v.explodedY ? CP_MINE_HIT : CP_MINE;
        bold = true;
      } else if (adjacent === 0) {
        ch = " ";
        pair = CP_EMPTY;
      } else {
        ch = String(adjacent);
        pair = colorForNumber(adjacent);
        bold = true;
      }

      const row = v.top + y;
      const col = v.left + x * 2;
      const isCursor = x === v.cursorX && y === v.cursorY && v.status === PLAYING;

      if (isCursor) {
        // CP_CURSOR is black-on-white drawn with A_BOLD, so with bold->bright
        // mapping the glyph is BRIGHT black, i.e. grey on white. Real terminals
        // do exactly this; see palette.brightenBlack.
        s.withAttrs(CP_CURSOR, true, () => {
          s.addch(row, col, ch);
          s.addch(row, col + 1, " ");
        });
      } else {
        s.withAttrs(pair, bold, () => {
          s.addch(row, col, ch);
          s.addch(row, col + 1, " ");
        });
      }
    }
  }
}

/** src/main.c:221-229 */
export function renderSingle(
  s: Surface, v: BoardView, minesLeft: number, elapsed: number,
): void {
  s.erase();
  drawHud(s, v, minesLeft, elapsed);
  drawBoardFrame(s, v);
  drawBoard(s, v);
  drawFooter(s, v);
}
