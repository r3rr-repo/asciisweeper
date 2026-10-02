/*
 * Boot and the single requestAnimationFrame loop.
 *
 * src/main.c had three blocking loops - single-player (wtimeout 200 ms +
 * getch), multiplayer (select() on stdin and the socket at a 100 ms tick), and
 * fully-blocking menus - plus main()'s own screen-to-screen loop. All four
 * collapse into one rAF loop over a Screen union. The 200 ms and 100 ms ticks
 * existed only to repaint the timer and the blink animation, which rAF
 * supersedes.
 */
import { Core } from "./core";
import { Surface } from "./term/surface";
import { GridRenderer, type GridMetrics } from "./term/webgl";
import { buildAtlas, sameSpec, type Atlas, type AtlasSpec } from "./term/atlas";
import { XTERM, type Palette } from "./term/palette";
import { Input, type CellPos, type Key, type MouseButton } from "./term/input";
import { LineEdit } from "./term/lineedit";
import { drawTestCard } from "./term/testcard";
import { setupColors, CP_HUD, CP_LOSE, CP_TITLE } from "./draw/colors";
import {
  MENU_AVATAR, MENU_BEGINNER, MENU_CUSTOM, MENU_EXPERT, MENU_INTERMEDIATE,
  MENU_ITEMS, MENU_MULTIPLAYER, MENU_QUIT, PRESETS,
  drawAvatarScreen, drawMenu, drawPrompt, menuHitTest,
} from "./draw/menu";
import { clampDifficulty } from "./game/layout";
import { SinglePlayer } from "./game/single";
import { Multiplayer } from "./game/multi";
import { loadConfig, resolveWsUrl, saveConfig, validateWsUrl, type Config } from "./config";

/** src/main.c:1143-1149 - the C exits outright below this; we draw a message. */
const MIN_COLS = 40;
const MIN_ROWS = 20;
/** Keeps a huge monitor from producing an absurdly wide terminal. */
const MAX_COLS = 120;
const MAX_ROWS = 40;

const VERSION = "asciisweeper-web 0.4";

type Mode =
  | { kind: "menu"; sel: number }
  | { kind: "avatar" }
  | { kind: "custom"; fields: LineEdit[]; active: number }
  | { kind: "mpSetup"; fields: LineEdit[]; active: number; error: string }
  | { kind: "single"; game: SinglePlayer }
  | { kind: "multi"; game: Multiplayer }
  | { kind: "testcard" }
  | { kind: "quit" }
  | { kind: "tooSmall" }
  | { kind: "fatal"; message: string };

class App {
  private surface: Surface;
  private renderer: GridRenderer;
  private input: Input;
  private atlas: Atlas | null = null;
  private atlasSpec: AtlasSpec | null = null;
  private metrics: GridMetrics = { cellW: 10, cellH: 20, originX: 0, originY: 0 };
  private palette: Palette;
  private mode: Mode = { kind: "menu", sel: 0 };
  private lastDifficulty: { w: number; h: number; mines: number } = { ...PRESETS[0] };
  private dpr = 1;

  constructor(
    private core: Core,
    private config: Config,
    private canvas: HTMLCanvasElement,
    ime: HTMLInputElement,
  ) {
    this.palette = { ...XTERM, brightenBlack: config.brightenBlack };
    document.documentElement.style.setProperty("--term-bg", this.palette.defaultBg);

    this.surface = new Surface(this.palette);
    this.renderer = new GridRenderer(canvas);
    this.renderer.setPalette(this.palette);
    setupColors(this.surface);

    this.input = new Input(canvas, ime, {
      onKey: (k) => this.onKey(k),
      onHover: (p) => this.onHover(p),
      onClick: (p, b) => this.onClick(p, b),
    });

    if (location.hash.includes("testcard")) this.mode = { kind: "testcard" };

    this.resize();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    // Browser zoom and moving between monitors both change devicePixelRatio,
    // which changes the device-pixel cell size and so requires a new atlas.
    window.addEventListener("resize", () => this.resize());
  }

  /**
   * Derives cols/rows from the canvas, then centres an integer-scaled grid.
   *
   * Everything in device pixels is an integer so cells land on exact pixel
   * boundaries - that, plus NEAREST sampling and an atlas rasterised at exactly
   * this cell size, is what keeps the glyphs crisp.
   */
  private resize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;
    const backW = Math.max(1, Math.round(cssW * this.dpr));
    const backH = Math.max(1, Math.round(cssH * this.dpr));
    if (this.canvas.width !== backW || this.canvas.height !== backH) {
      this.canvas.width = backW;
      this.canvas.height = backH;
    }

    const base = this.config.baseCell;
    // Whole-number scale only, chosen so the smallest supported grid still fits.
    const scale = Math.max(1, Math.floor(Math.min(
      backW / (MIN_COLS * base.w * this.dpr),
      backH / (MIN_ROWS * base.h * this.dpr),
    )));
    const cellWdev = Math.max(1, Math.round(base.w * scale * this.dpr));
    const cellHdev = Math.max(1, Math.round(base.h * scale * this.dpr));

    let cols = Math.floor(backW / cellWdev);
    let rows = Math.floor(backH / cellHdev);
    cols = Math.min(Math.max(cols, 1), MAX_COLS);
    rows = Math.min(Math.max(rows, 1), MAX_ROWS);

    if (cols < MIN_COLS || rows < MIN_ROWS) {
      if (this.mode.kind !== "fatal") this.tooSmall(cols, rows, cellWdev, cellHdev);
      return;
    }
    if (this.mode.kind === "tooSmall") this.mode = { kind: "menu", sel: 0 };

    this.surface.resize(cols, rows);
    this.metrics = {
      cellW: cellWdev,
      cellH: cellHdev,
      originX: Math.floor((backW - cols * cellWdev) / 2),
      originY: Math.floor((backH - rows * cellHdev) / 2),
    };
    this.input.setMetrics(this.metrics, this.dpr);
    this.ensureAtlas();
  }

  private tooSmall(cols: number, rows: number, cw: number, ch: number): void {
    this.mode = { kind: "tooSmall" };
    this.surface.resize(Math.max(cols, 20), Math.max(rows, 3));
    this.metrics = { cellW: cw, cellH: ch, originX: 0, originY: 0 };
    this.input.setMetrics(this.metrics, this.dpr);
    this.ensureAtlas();
  }

  private ensureAtlas(): void {
    const spec: AtlasSpec = {
      cellW: this.metrics.cellW,
      cellH: this.metrics.cellH,
      fontFamily: this.config.fontFamily,
      fontScale: 0.78,
    };
    if (sameSpec(this.atlasSpec, spec)) return;
    this.atlas = buildAtlas(spec);
    this.atlasSpec = spec;
    this.renderer.setAtlas(this.atlas);
  }

  // ------------------------------------------------------------------ main loop

  start(): void {
    const frame = (t: number) => {
      try {
        this.step(t);
      } catch (e) {
        this.mode = { kind: "fatal", message: e instanceof Error ? e.message : String(e) };
        this.drawFatal();
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private step(nowMs: number): void {
    const s = this.surface;

    switch (this.mode.kind) {
      case "menu": drawMenu(s, this.mode.sel, VERSION); break;
      case "avatar": drawAvatarScreen(s, this.config.avatar); break;
      case "custom": {
        const f = this.mode.fields;
        drawPrompt(s, "CUSTOM BOARD", [
          { label: "Width", value: f[0].display },
          { label: "Height", value: f[1].display },
          { label: "Mines", value: f[2].display },
        ], this.mode.active);
        break;
      }
      case "mpSetup": {
        const f = this.mode.fields;
        drawPrompt(s, "MULTIPLAYER", [
          { label: "Server", value: f[0].text === "" && this.mode.active !== 0 ? "(this site)" : f[0].display },
          { label: "Your name", value: f[1].display },
        ], this.mode.active);
        const err = this.mode.error;
        if (err) {
          s.withAttrs(CP_LOSE, true, () => s.print(s.rows - 3, s.centreCol(0, s.cols, err), err));
        }
        break;
      }
      case "single":
        this.mode.game.update(nowMs);
        this.mode.game.render(s, nowMs);
        this.afterSingle();
        break;
      case "multi":
        this.mode.game.update(nowMs);
        this.mode.game.render(s, nowMs);
        this.input.setTextEntry(this.mode.game.textEntryActive);
        this.afterMulti();
        break;
      case "testcard": drawTestCard(s); break;
      case "quit": {
        s.erase();
        const msg = "Thanks for playing. Close the tab to quit.";
        s.withAttrs(CP_TITLE, true, () => s.print(Math.floor(s.rows / 2), s.centreCol(0, s.cols, msg), msg));
        const help = "any key: back to the menu";
        s.withAttrs(CP_HUD, false, () => s.print(Math.floor(s.rows / 2) + 2, s.centreCol(0, s.cols, help), help));
        break;
      }
      case "tooSmall": this.drawTooSmall(); break;
      case "fatal": this.drawFatal(); return;
    }

    this.renderer.draw(s, this.metrics);
  }

  private drawTooSmall(): void {
    const s = this.surface;
    s.erase();
    const msg = "Window too small";
    s.withAttrs(CP_LOSE, true, () => s.print(0, 0, msg.slice(0, s.cols)));
    s.withAttrs(CP_HUD, false, () => {
      s.print(1, 0, `need ${MIN_COLS}x${MIN_ROWS}`.slice(0, s.cols));
    });
    this.renderer.draw(s, this.metrics);
  }

  private drawFatal(): void {
    const s = this.surface;
    if (s.cols < 10) s.resize(40, 6);
    s.erase();
    const m = this.mode.kind === "fatal" ? this.mode.message : "unknown error";
    s.withAttrs(CP_LOSE, true, () => s.print(0, 0, "asciisweeper could not start"));
    s.withAttrs(CP_HUD, false, () => {
      for (let i = 0; i * s.cols < m.length && i < 4; i++) {
        s.print(2 + i, 0, m.slice(i * s.cols, (i + 1) * s.cols));
      }
    });
    try {
      this.renderer.draw(s, this.metrics);
    } catch {
      document.body.textContent = `asciisweeper could not start: ${m}`;
    }
  }

  private afterSingle(): void {
    if (this.mode.kind !== "single") return;
    const r = this.mode.game.result;
    if (!r) return;
    if (r === "restart") {
      const d = this.lastDifficulty;
      this.mode = { kind: "single", game: new SinglePlayer(this.core, d.w, d.h, d.mines) };
    } else {
      this.mode = { kind: "menu", sel: 0 };
    }
  }

  private afterMulti(): void {
    if (this.mode.kind !== "multi") return;
    const r = this.mode.game.result;
    if (!r) return;
    this.mode.game.dispose();
    this.input.setTextEntry(false);
    this.mode = { kind: "menu", sel: 0 };
  }

  // --------------------------------------------------------------------- input

  private startGame(w: number, h: number, mines: number): void {
    const d = clampDifficulty(w, h, mines, this.surface.cols, this.surface.rows,
      this.core.consts.maxW, this.core.consts.maxH);
    this.lastDifficulty = d;
    this.mode = { kind: "single", game: new SinglePlayer(this.core, d.w, d.h, d.mines) };
  }

  private chooseMenu(sel: number): void {
    switch (sel) {
      case MENU_BEGINNER:
      case MENU_INTERMEDIATE:
      case MENU_EXPERT: {
        const p = PRESETS[sel];
        this.startGame(p.w, p.h, p.mines);
        return;
      }
      case MENU_CUSTOM:
        this.mode = {
          kind: "custom",
          fields: [new LineEdit(3, "16"), new LineEdit(3, "16"), new LineEdit(4, "40")],
          active: 0,
        };
        return;
      case MENU_AVATAR:
        this.mode = { kind: "avatar" };
        return;
      case MENU_MULTIPLAYER:
        this.mode = {
          kind: "mpSetup",
          // Blank server means this site, which is the usual deployment; the
          // field exists for a bridge hosted somewhere else.
          fields: [
            new LineEdit(120, this.config.wsUrl ?? ""),
            new LineEdit(this.core.consts.maxNameLen, this.config.name),
          ],
          active: 0,
          error: "",
        };
        this.input.setTextEntry(true);
        return;
      case MENU_QUIT:
      default:
        this.quit();
        return;
    }
  }

  /** A tab cannot exit itself, so 'q' lands on a farewell screen rather than
   *  appearing to do nothing. Any key returns to the menu. */
  private quit(): void {
    this.mode = { kind: "quit" };
  }

  private onKey(k: Key): void {
    const now = performance.now();
    switch (this.mode.kind) {
      case "menu": {
        const m = this.mode;
        if (k.name === "up" || (k.name === "char" && k.ch === "k")) {
          m.sel = (m.sel + MENU_ITEMS.length - 1) % MENU_ITEMS.length;
        } else if (k.name === "down" || (k.name === "char" && k.ch === "j")) {
          m.sel = (m.sel + 1) % MENU_ITEMS.length;
        } else if (k.name === "enter" || k.name === "space") {
          this.chooseMenu(m.sel);
        } else if (k.name === "char" && k.ch.toLowerCase() === "q") {
          this.quit();
        }
        return;
      }

      case "avatar":
        if (k.name === "char" && k.ch.toLowerCase() === "r") {
          this.config.avatar = this.core.avatarRandom();
          saveConfig(this.config);
        } else if (k.name === "enter" || k.name === "escape") {
          this.mode = { kind: "menu", sel: MENU_AVATAR };
        }
        return;

      case "custom": {
        const m = this.mode;
        const r = m.fields[m.active].handle(k);
        if (r === "cancel") {
          this.mode = { kind: "menu", sel: MENU_CUSTOM };
        } else if (r === "commit") {
          if (m.active < 2) {
            m.active++;
          } else {
            const maxW = this.core.consts.maxW;
            const maxH = this.core.consts.maxH;
            const w = LineEdit.toInt(m.fields[0].text, 5, maxW, 16);
            const h = LineEdit.toInt(m.fields[1].text, 5, maxH, 16);
            const mines = LineEdit.toInt(m.fields[2].text, 1, Math.max(1, w * h - 9), Math.floor((w * h) / 6));
            this.startGame(w, h, mines);
          }
        }
        return;
      }

      case "mpSetup": {
        const m = this.mode;
        const r = m.fields[m.active].handle(k);
        if (r === "cancel") {
          this.input.setTextEntry(false);
          this.mode = { kind: "menu", sel: MENU_MULTIPLAYER };
          return;
        }
        if (r !== "commit") {
          m.error = "";
          return;
        }
        if (m.active === 0) {
          // Catch a bad server URL here rather than letting it surface later as
          // an unexplained "connection failed".
          const problem = validateWsUrl(m.fields[0].text);
          if (problem) { m.error = problem; return; }
          m.error = "";
          m.active = 1;
          return;
        }
        const problem = validateWsUrl(m.fields[0].text);
        if (problem) { m.error = problem; m.active = 0; return; }

        this.config.wsUrl = m.fields[0].text.trim() || null;
        this.config.name = m.fields[1].text.trim() || "Player";
        saveConfig(this.config);
        this.input.setTextEntry(false);
        this.mode = {
          kind: "multi",
          game: new Multiplayer(this.core, resolveWsUrl(this.config), this.config.name, this.config.avatar),
        };
        return;
      }

      case "single": this.mode.game.onKey(k, now); return;
      case "multi": this.mode.game.onKey(k, now); return;
      case "testcard":
        if (k.name === "escape") this.mode = { kind: "menu", sel: 0 };
        return;
      case "quit":
        this.mode = { kind: "menu", sel: MENU_QUIT };
        return;
      default: return;
    }
  }

  private onHover(p: CellPos): void {
    if (this.mode.kind === "single") this.mode.game.onHover(this.surface, p.row, p.col);
    else if (this.mode.kind === "multi") this.mode.game.onHover(this.surface, p.row, p.col);
  }

  private onClick(p: CellPos, b: MouseButton): void {
    const now = performance.now();
    if (this.mode.kind === "single") this.mode.game.onClick(this.surface, p.row, p.col, b, now);
    else if (this.mode.kind === "multi") this.mode.game.onClick(this.surface, p.row, p.col, b);
    else if (this.mode.kind === "menu") {
      const i = menuHitTest(this.surface, p.row);
      if (i >= 0) this.chooseMenu(i);
    }
  }
}

declare global {
  interface Window { __asciisweeperBooted?: boolean }
}

async function boot(): Promise<void> {
  // Tells the guard in index.html that the module really did run, so it stops
  // waiting to report a failure. Set before any await, since the guard fires on a
  // timer and wasm loading can be slow on a cold cache.
  window.__asciisweeperBooted = true;
  const canvas = document.getElementById("screen") as HTMLCanvasElement;
  const ime = document.getElementById("ime") as HTMLInputElement;
  const bootMsg = document.getElementById("boot");
  try {
    const core = await Core.load();
    core.initConsts();
    const config = loadConfig(() => core.avatarRandom());
    bootMsg?.remove();
    const app = new App(core, config, canvas, ime);
    app.start();
    canvas.focus();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (bootMsg) bootMsg.textContent = `asciisweeper could not start: ${msg}`;
    else document.body.textContent = `asciisweeper could not start: ${msg}`;
  }
}

void boot();
