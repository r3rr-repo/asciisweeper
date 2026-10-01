/*
 * Port of the quick-double-blink state machine, src/main.c:469-541.
 *
 * Two closed frames separated by a short open gap, then a long random wait. Each
 * avatar gets its own instance so the two never blink in lockstep - in the C that
 * was `static BlinkState states[2]`; here it is an object per avatar, which also
 * means a new match starts with fresh schedules.
 */

/** src/main.c:469-472 */
const FRAME_MS = 120;   // how long each of the two blinks stays closed
const GAP_MS = 90;      // eyes-open gap between them
const MIN_GAP_MS = 2000; // shortest wait before the next double-blink
const MAX_GAP_MS = 8000; // longest

const enum Phase { Idle, Closed1, Gap, Closed2 }

export class Blink {
  private phase = Phase.Idle;
  private nextEventMs = 0;
  private phaseEndMs = 0;
  private started = false;

  /** Honour the OS "reduce motion" setting by simply never closing the eyes. */
  private readonly reduced =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  private randomGap(): number {
    return MIN_GAP_MS + Math.floor(Math.random() * (MAX_GAP_MS - MIN_GAP_MS + 1));
  }

  /** Advances the schedule and reports whether the eyes are shut right now. */
  closed(nowMs: number): boolean {
    if (this.reduced) return false;
    if (!this.started) {
      this.started = true;
      this.phase = Phase.Idle;
      this.nextEventMs = nowMs + this.randomGap();
    }
    switch (this.phase) {
      case Phase.Idle:
        if (nowMs >= this.nextEventMs) {
          this.phase = Phase.Closed1;
          this.phaseEndMs = nowMs + FRAME_MS;
        }
        break;
      case Phase.Closed1:
        if (nowMs >= this.phaseEndMs) {
          this.phase = Phase.Gap;
          this.phaseEndMs = nowMs + GAP_MS;
        }
        break;
      case Phase.Gap:
        if (nowMs >= this.phaseEndMs) {
          this.phase = Phase.Closed2;
          this.phaseEndMs = nowMs + FRAME_MS;
        }
        break;
      case Phase.Closed2:
        if (nowMs >= this.phaseEndMs) {
          this.phase = Phase.Idle;
          this.nextEventMs = nowMs + this.randomGap();
        }
        break;
    }
    return this.phase === Phase.Closed1 || this.phase === Phase.Closed2;
  }
}
