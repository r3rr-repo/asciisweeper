/*
 * In-grid line editor, replacing echo() + getnstr (src/main.c:329-373).
 *
 * The C already contained exactly this, in the multiplayer chat composer at
 * src/main.c:907-932: printable 32..126 append, backspace deletes, Enter commits,
 * Esc cancels, and a trailing '_' stands in for the cursor. That behaviour is
 * lifted here once and reused for the menu prompts AND for chat, so the two
 * cannot drift apart.
 */
import type { Key } from "./input";

export type LineEditResult = "editing" | "commit" | "cancel";

export class LineEdit {
  text = "";

  constructor(public readonly maxLen: number, initial = "") {
    this.text = initial.slice(0, maxLen);
  }

  handle(k: Key): LineEditResult {
    switch (k.name) {
      case "enter": return "commit";
      case "escape": return "cancel";
      case "backspace":
        // The C accepts KEY_BACKSPACE, 127 and 8 interchangeably.
        this.text = this.text.slice(0, -1);
        return "editing";
      case "space":
        if (this.text.length < this.maxLen) this.text += " ";
        return "editing";
      case "char":
        if (this.text.length < this.maxLen) this.text += k.ch;
        return "editing";
      default:
        return "editing";
    }
  }

  /** What the C draws: the buffer followed by an underscore caret. */
  get display(): string {
    return `${this.text}_`;
  }

  /**
   * prompt_int's semantics (src/main.c:329-351): atoi, clamp into range, and an
   * empty entry keeps the default.
   */
  static toInt(text: string, min: number, max: number, def: number): number {
    const t = text.trim();
    if (t === "") return def;
    const n = parseInt(t, 10);
    if (Number.isNaN(n)) return def;
    return n < min ? min : n > max ? max : n;
  }
}
