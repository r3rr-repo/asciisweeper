/*
 * The ncurses shim.
 *
 * This is deliberately shaped as the subset of ncurses that src/main.c actually
 * uses, measured across the whole codebase: COLOR_PAIR, mvprintw, attron/attroff,
 * init_pair, A_BOLD, mvaddch, refresh, getmaxyx, erase, clear, clrtoeol. No
 * windows or pads beyond stdscr, no ACS_* line drawing, no wide characters, no
 * box(). A_BOLD is the only attribute. That is why the draw code ports from C
 * almost line for line, and why each ported function stays diffable against its
 * original.
 *
 * Two intentional departures from the C API:
 *   - withAttrs(pair, bold, fn) replaces the attron/attroff pair. The C always
 *     uses them symmetrically; a scoped form removes the leaked-attribute bug
 *     class outright.
 *   - print() takes an already-formatted string. TS template literals do what
 *     mvprintw's format string did.
 */
import { DEFAULT, SLOT_DEFAULT_FG, SLOT_DEFAULT_BG, resolveBold, type Palette } from "./palette";

/** fg/bg as given to initPair: 0-7, or DEFAULT for ncurses' -1. */
export interface Pair {
  fg: number;
  bg: number;
}

/**
 * One cell is 4 bytes, mirroring ncurses' chtype: glyph, fg slot, bg slot, flags.
 * Uploaded straight to the GPU as an RGBA8 texel, so this is both the model and
 * the vertex data.
 */
export const CELL_BYTES = 4;
const FLAG_BOLD = 1;

export class Surface {
  cols = 0;
  rows = 0;
  /** cols*rows*4 bytes, row-major from the top. */
  cells = new Uint8Array(0);
  /** Bumped on every mutation so the renderer knows to re-upload. */
  version = 0;

  private pairs = new Map<number, Pair>();
  private curFg = SLOT_DEFAULT_FG;
  private curBg = SLOT_DEFAULT_BG;
  private curBold = false;

  constructor(private palette: Palette) {}

  setPalette(p: Palette): void {
    this.palette = p;
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.cells = new Uint8Array(cols * rows * CELL_BYTES);
    this.erase();
  }

  /** ncurses init_pair. Ids are the CP_* values from src/main.c, kept verbatim. */
  initPair(id: number, fg: number, bg: number): void {
    this.pairs.set(id, { fg, bg });
  }

  private slotsFor(pairId: number, bold: boolean): [number, number] {
    const p = this.pairs.get(pairId);
    if (!p) return [SLOT_DEFAULT_FG, SLOT_DEFAULT_BG];
    const fg = p.fg === DEFAULT ? SLOT_DEFAULT_FG : resolveBold(p.fg, bold, this.palette);
    // Bold never affects the background in a terminal, so bg is never brightened.
    const bg = p.bg === DEFAULT ? SLOT_DEFAULT_BG : p.bg;
    return [fg, bg];
  }

  /** Scoped attron/attroff. Nested calls restore the outer attributes. */
  withAttrs(pairId: number, bold: boolean, fn: () => void): void {
    const pfg = this.curFg, pbg = this.curBg, pbold = this.curBold;
    const [fg, bg] = this.slotsFor(pairId, bold);
    this.curFg = fg;
    this.curBg = bg;
    this.curBold = bold;
    try {
      fn();
    } finally {
      this.curFg = pfg;
      this.curBg = pbg;
      this.curBold = pbold;
    }
  }

  /** ncurses erase(): clear to the terminal's default colours. */
  erase(): void {
    const c = this.cells;
    for (let i = 0; i < c.length; i += CELL_BYTES) {
      c[i] = 32;
      c[i + 1] = SLOT_DEFAULT_FG;
      c[i + 2] = SLOT_DEFAULT_BG;
      c[i + 3] = 0;
    }
    this.version++;
  }

  /** ncurses clear(). Same effect here - there is no physical screen to force. */
  clear(): void {
    this.erase();
  }

  /** ncurses mvaddch / mvwaddch. */
  addch(row: number, col: number, ch: string): void {
    this.put(row, col, ch.charCodeAt(0));
  }

  /** ncurses mvprintw, with formatting already done by the caller. */
  print(row: number, col: number, text: string): void {
    for (let i = 0; i < text.length; i++) {
      const c = col + i;
      if (c >= this.cols) break;
      this.put(row, c, text.charCodeAt(i));
    }
    this.version++;
  }

  /**
   * ncurses clrtoeol: clear to the right edge using the CURRENT attributes, not
   * the default ones. mp_show_end_screen depends on this to wipe a previous,
   * longer status message - get it wrong and stale text lingers under the new.
   */
  clrtoeol(row: number, col: number): void {
    for (let c = col; c < this.cols; c++) this.put(row, c, 32);
    this.version++;
  }

  private put(row: number, col: number, code: number): void {
    if (row < 0 || col < 0 || row >= this.rows || col >= this.cols) return;
    // The atlas holds printable ASCII only; anything else becomes a space so a
    // stray glyph can never desync the grid.
    const glyph = code >= 32 && code <= 126 ? code : 32;
    const i = (row * this.cols + col) * CELL_BYTES;
    const c = this.cells;
    c[i] = glyph;
    c[i + 1] = this.curFg;
    c[i + 2] = this.curBg;
    c[i + 3] = this.curBold ? FLAG_BOLD : 0;
    this.version++;
  }

  /** Centre a string in a field, the way main.c's many `(w - strlen(s)) / 2` do. */
  centreCol(fieldLeft: number, fieldWidth: number, text: string): number {
    const col = fieldLeft + Math.floor((fieldWidth - text.length) / 2);
    return col < 0 ? 0 : col;
  }
}
