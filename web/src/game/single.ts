/*
 * Port of play_game(), src/main.c:234-319.
 *
 * The C was `wtimeout(stdscr, 200); while(1){ render(); getch(); }` - a blocking
 * loop where getch doubled as the frame clock. Here it is a Screen driven by
 * requestAnimationFrame, which supersedes the 200 ms tick entirely (that tick
 * existed only to repaint the timer).
 */
import { LOST, PLAYING, WON } from "../proto";
import type { Core } from "../core";
import type { Surface } from "../term/surface";
import type { Key, MouseButton } from "../term/input";
import { CP_HUD, CP_LOSE, CP_WIN } from "../draw/colors";
import { drawBoardFrame, drawBoard, drawFooter, drawHud, type BoardView } from "../draw/board";
import { computeLayout } from "./layout";

/** src/main.c:231 */
const AUTO_RESTART_SECONDS = 2;

export type AfterGame = "restart" | "menu" | "quit" | null;

export class SinglePlayer {
  private cursorX: number;
  private cursorY: number;
  private startMs = 0;
  private elapsed = 0;
  private gameOverAtMs = 0;
  private outcome: AfterGame = null;

  constructor(
    private core: Core,
    readonly w: number,
    readonly h: number,
    readonly mines: number,
  ) {
    core.boardInit(w, h, mines);
    this.cursorX = Math.floor(w / 2);
    this.cursorY = Math.floor(h / 2);
  }

  /** Non-null once the screen wants to be replaced. */
  get result(): AfterGame {
    return this.outcome;
  }

  update(nowMs: number): void {
    const c = this.core;
    if (!c.firstMove && c.status === PLAYING) {
      this.elapsed = Math.floor((nowMs - this.startMs) / 1000);
    }
    if (c.status !== PLAYING) {
      if (this.gameOverAtMs === 0) this.gameOverAtMs = nowMs;
      const remaining = AUTO_RESTART_SECONDS - Math.floor((nowMs - this.gameOverAtMs) / 1000);
      if (remaining <= 0) this.outcome = "restart";
    }
  }

  private view(s: Surface): BoardView {
    const l = computeLayout(this.w, this.h, s.cols, s.rows, false);
    const cells = this.core.snapshot();
    return {
      cells, w: this.w, h: this.h,
      status: this.core.status,
      explodedX: this.core.explodedX,
      explodedY: this.core.explodedY,
      cursorX: this.cursorX, cursorY: this.cursorY,
      top: l.top, left: l.left,
    };
  }

  render(s: Surface, nowMs: number): void {
    const c = this.core;
    const v = this.view(s);
    const elapsed = c.firstMove ? 0 : this.elapsed;

    s.erase();
    drawHud(s, v, c.mines - c.flagsPlaced, elapsed);
    drawBoardFrame(s, v);
    drawBoard(s, v);
    drawFooter(s, v);

    // src/main.c:249-263 - the end banner and the auto-restart countdown.
    if (c.status !== PLAYING) {
      const won = c.status === WON;
      const banner = won ? `YOU WIN! Time: ${elapsed}s` : "BOOM! Game Over.";
      const remaining = Math.max(
        0, AUTO_RESTART_SECONDS - Math.floor((nowMs - (this.gameOverAtMs || nowMs)) / 1000),
      );
      s.withAttrs(won ? CP_WIN : CP_LOSE, true, () => {
        s.print(v.top + this.h + 5, v.left, banner);
      });
      s.withAttrs(CP_HUD, false, () => {
        s.print(v.top + this.h + 6, v.left,
          `[R]estart  [N]ew game  [Q]uit  -  new game in ${remaining}s`);
      });
    }
  }

  onKey(k: Key, nowMs: number): void {
    const c = this.core;

    // src/main.c:273-278 - once the game is over only these three keys matter.
    if (c.status !== PLAYING) {
      if (k.name === "char") {
        const ch = k.ch.toLowerCase();
        if (ch === "r") this.outcome = "restart";
        else if (ch === "n") this.outcome = "menu";
        else if (ch === "q") this.outcome = "quit";
      }
      return;
    }

    switch (k.name) {
      case "up": if (this.cursorY > 0) this.cursorY--; return;
      case "down": if (this.cursorY < this.h - 1) this.cursorY++; return;
      case "left": if (this.cursorX > 0) this.cursorX--; return;
      case "right": if (this.cursorX < this.w - 1) this.cursorX++; return;
      case "space":
      case "enter": this.revealOrChord(this.cursorX, this.cursorY, nowMs); return;
      case "char": break;
      default: return;
    }

    switch (k.ch.toLowerCase()) {
      case "k": if (this.cursorY > 0) this.cursorY--; break;
      case "j": if (this.cursorY < this.h - 1) this.cursorY++; break;
      case "h": if (this.cursorX > 0) this.cursorX--; break;
      case "l": if (this.cursorX < this.w - 1) this.cursorX++; break;
      case "f": c.flag(this.cursorX, this.cursorY); break;
      case "c": c.chord(this.cursorX, this.cursorY); break;
      case "r": this.outcome = "restart"; break;
      case "n": this.outcome = "menu"; break;
      case "q": this.outcome = "quit"; break;
      default: break;
    }
  }

  /**
   * src/main.c:293-301 - reveal, but chord instead if the cell is already
   * revealed. Also starts the clock on the move that places the mines.
   */
  private revealOrChord(x: number, y: number, nowMs: number): void {
    const c = this.core;
    if (c.isRevealed(x, y)) {
      c.chord(x, y);
      return;
    }
    const wasFirst = c.firstMove;
    c.reveal(x, y);
    if (wasFirst && !c.firstMove) this.startMs = nowMs;
  }

  // ---- mouse: a web addition, mapped onto the existing cursor highlight ----

  /** Converts a grid cell to a board cell, or null if outside the board. */
  private toBoard(s: Surface, row: number, col: number): { x: number; y: number } | null {
    const l = computeLayout(this.w, this.h, s.cols, s.rows, false);
    const x = Math.floor((col - l.left) / 2);
    const y = row - l.top;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    return { x, y };
  }

  onHover(s: Surface, row: number, col: number): void {
    if (this.core.status !== PLAYING) return;
    const b = this.toBoard(s, row, col);
    if (b) { this.cursorX = b.x; this.cursorY = b.y; }
  }

  onClick(s: Surface, row: number, col: number, button: MouseButton, nowMs: number): void {
    const c = this.core;
    if (c.status !== PLAYING) {
      this.outcome = "restart";
      return;
    }
    const b = this.toBoard(s, row, col);
    if (!b) return;
    this.cursorX = b.x;
    this.cursorY = b.y;
    if (button === "left") this.revealOrChord(b.x, b.y, nowMs);
    else if (button === "right") c.flag(b.x, b.y);
    else c.chord(b.x, b.y);
  }
}

export { LOST, WON, PLAYING };
