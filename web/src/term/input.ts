/*
 * Keyboard, mouse and touch, normalised into the key vocabulary the ported
 * switch statements expect.
 *
 * The C read ints from getch(): printable ASCII plus KEY_UP/DOWN/LEFT/RIGHT and
 * KEY_ENTER. Here a key is a small object, so the ports stay readable.
 *
 * Mouse is an addition - the terminal game has none - but it is mapped onto the
 * EXISTING visual language: hovering moves the cursor cell, so the cursor
 * highlight that already exists doubles as the hover indicator and no new glyph
 * is introduced.
 */
import type { GridMetrics } from "./webgl";

export type KeyName =
  | "up" | "down" | "left" | "right"
  | "enter" | "space" | "escape" | "backspace" | "tab" | "char";

export interface Key {
  name: KeyName;
  /** For name === "char", the single printable character (32..126). */
  ch: string;
}

export type MouseButton = "left" | "right" | "middle";

export interface CellPos {
  row: number;
  col: number;
}

export interface InputEvents {
  onKey(k: Key): void;
  onHover(p: CellPos): void;
  onClick(p: CellPos, button: MouseButton): void;
}

const KEYMAP: Record<string, KeyName> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Enter: "enter", NumpadEnter: "enter", Escape: "escape",
  Backspace: "backspace", Delete: "backspace", Tab: "tab",
  " ": "space", Spacebar: "space",
};

export class Input {
  private metrics: GridMetrics = { cellW: 1, cellH: 1, originX: 0, originY: 0 };
  private dpr = 1;
  private longPressTimer: number | null = null;
  private longPressFired = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private ime: HTMLInputElement,
    private ev: InputEvents,
  ) {
    window.addEventListener("keydown", this.onKeyDown, { passive: false });
    canvas.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("mousedown", this.onMouseDown);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("touchstart", this.onTouchStart, { passive: false });
    canvas.addEventListener("touchend", this.onTouchEnd);
    // Keep focus on the canvas so keystrokes land, but let the hidden input take
    // it while a line editor is open (that is what summons a mobile keyboard).
    canvas.addEventListener("pointerdown", () => canvas.focus());
    ime.addEventListener("input", this.onImeInput);
  }

  setMetrics(m: GridMetrics, dpr: number): void {
    this.metrics = m;
    this.dpr = dpr;
  }

  /** Opens/closes the hidden input that makes mobile keyboards appear. */
  setTextEntry(active: boolean): void {
    if (active) {
      this.ime.value = "";
      this.ime.focus();
    } else {
      this.ime.blur();
      this.canvas.focus();
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // leave browser shortcuts alone

    const mapped = KEYMAP[e.key];
    if (mapped) {
      // Arrows scroll the page and space scrolls it too; both must be swallowed.
      if (mapped !== "tab") e.preventDefault();
      this.ev.onKey({ name: mapped, ch: "" });
      return;
    }
    if (e.key.length === 1) {
      const code = e.key.charCodeAt(0);
      if (code >= 32 && code <= 126) {
        e.preventDefault();
        this.ev.onKey({ name: "char", ch: e.key });
      }
    }
  };

  /** Paste and IME composition arrive here rather than as keydown. */
  private onImeInput = (): void => {
    const text = this.ime.value;
    this.ime.value = "";
    for (const chr of text) {
      const code = chr.charCodeAt(0);
      if (code >= 32 && code <= 126) this.ev.onKey({ name: "char", ch: chr });
    }
  };

  private toCell(clientX: number, clientY: number): CellPos | null {
    const r = this.canvas.getBoundingClientRect();
    const px = (clientX - r.left) * this.dpr;
    const py = (clientY - r.top) * this.dpr;
    const m = this.metrics;
    const col = Math.floor((px - m.originX) / m.cellW);
    const row = Math.floor((py - m.originY) / m.cellH);
    if (col < 0 || row < 0) return null;
    return { row, col };
  }

  private onMouseMove = (e: MouseEvent): void => {
    const p = this.toCell(e.clientX, e.clientY);
    if (p) this.ev.onHover(p);
  };

  private onMouseDown = (e: MouseEvent): void => {
    const p = this.toCell(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    this.canvas.focus();
    const button: MouseButton = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    this.ev.onClick(p, button);
  };

  // Tap reveals, long-press flags - the touch equivalent of left/right click.
  private onTouchStart = (e: TouchEvent): void => {
    const t = e.touches[0];
    if (!t) return;
    e.preventDefault();
    const p = this.toCell(t.clientX, t.clientY);
    if (!p) return;
    this.ev.onHover(p);
    this.longPressFired = false;
    this.longPressTimer = window.setTimeout(() => {
      this.longPressFired = true;
      this.ev.onClick(p, "right");
    }, 400);
  };

  private onTouchEnd = (e: TouchEvent): void => {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    if (this.longPressFired) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const p = this.toCell(t.clientX, t.clientY);
    if (p) this.ev.onClick(p, "left");
  };
}
