/*
 * Generates the social card and the icons.
 *
 * Deliberately NOT a mockup: this drives the real core.wasm through a few moves,
 * then renders the resulting board through the same Surface, drawBoard, drawHud
 * and drawAvatar the game itself uses, with the same palette. So the card is an
 * actual frame of the game, and when the palette is eventually sampled from a
 * real terminal screenshot the card regenerates correctly instead of going stale.
 *
 * Run via: ./build-web.sh --card
 *
 * Output lands in web/public/, which Vite copies to the dist root verbatim -
 * og:image needs a stable, unhashed path.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { Surface } from "../src/term/surface";
import { XTERM, SLOT_DEFAULT_BG, SLOT_DEFAULT_FG, type Palette } from "../src/term/palette";
import { setupColors, CP_HUD, CP_TITLE } from "../src/draw/colors";
import { drawBoard, drawBoardFrame, drawHud, type BoardView } from "../src/draw/board";
import { drawAvatar, type Avatar } from "../src/draw/avatar";
import { AVATAR_GUTTER, AVATAR_HEIGHT_CHARS, AVATAR_WIDTH_CHARS, computeLayout } from "../src/game/layout";

// The web root is passed in, not derived from import.meta.url: this file is
// bundled by esbuild into a temporary directory before it runs, so paths relative
// to the bundle would point at the wrong place.
const WEB = resolve(process.argv[2] ?? process.cwd());
const OUT = join(WEB, "public");
const WASM = join(WEB, "wasm", "core.wasm");

// Cells stay at the game's 1:2 aspect; padding rather than stretching to 630
// keeps the glyphs exactly the proportions a player sees.
//
// The grid is sized so the content fills the card. The multiplayer layout is
// 16*2+2 + 2*(12+2) = 62 columns wide and needs 16+8 = 24 rows, so a 120-column
// grid left half the card empty. 100x26 at 12x24 px gives 1200x624 with the
// board block spanning ~62% of the width and a row of margin top and bottom.
const COLS = 100;
const ROWS = 26;
const CELL_W = 12;
const CELL_H = 24;
const CARD_W = 1200;
const CARD_H = 630;
const PAD_Y = (CARD_H - ROWS * CELL_H) / 2;

const FONT = "Menlo, 'DejaVu Sans Mono', 'Liberation Mono', monospace";
const palette: Palette = XTERM;

// ---------------------------------------------------------------- the board
interface Core {
  memory: WebAssembly.Memory;
  core_srand(n: number): void;
  core_board_init(w: number, h: number, m: number): void;
  core_reveal(x: number, y: number): void;
  core_flag(x: number, y: number): void;
  core_snapshot(): number;
  core_cells_ptr(): number;
  core_status(): number;
  core_mines(): number;
  core_flags_placed(): number;
  core_exploded_x(): number;
  core_exploded_y(): number;
}

async function playABoard(w: number, h: number, mines: number) {
  const { instance } = await WebAssembly.instantiate(readFileSync(WASM), {});
  const c = instance.exports as unknown as Core;

  // A fixed seed keeps the card reproducible: regenerating it after a palette
  // change should alter colours, not the board.
  c.core_srand(20261002);
  c.core_board_init(w, h, mines);

  // Open the middle, then a couple of corners, so the card shows numbers and
  // revealed space rather than a wall of dots. Stop if a click ends the game -
  // a card showing a loss would be a strange advert.
  for (const [x, y] of [[w >> 1, h >> 1], [2, 2], [w - 3, h - 3]] as const) {
    if (c.core_status() !== 0) break;
    c.core_reveal(x, y);
  }
  // A flag, so CP_FLAG appears on the card too.
  const cells0 = snapshot(c, w, h);
  outer: for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((cells0[y * w + x] & 0x80) === 0) { c.core_flag(x, y); break outer; }
    }
  }
  return { core: c, cells: snapshot(c, w, h) };
}

function snapshot(c: Core, w: number, h: number): Uint8Array {
  const n = c.core_snapshot();
  const p = c.core_cells_ptr();
  const out = new Uint8Array(w * h);
  out.set(new Uint8Array(c.memory.buffer).subarray(p, p + Math.min(n, w * h)));
  return out;
}

// ------------------------------------------------------------- the composition
async function compose(): Promise<Surface> {
  const W = 16, H = 16, MINES = 40;
  const { core, cells } = await playABoard(W, H, MINES);

  const s = new Surface(palette);
  s.resize(COLS, ROWS);
  setupColors(s);

  // The multiplayer layout, so the two avatars flank the board exactly as they
  // do in game (game_init's side_panels_fit branch).
  const l = computeLayout(W, H, COLS, ROWS, true);
  const view: BoardView = {
    cells, w: W, h: H,
    status: core.core_status(),
    explodedX: core.core_exploded_x(),
    explodedY: core.core_exploded_y(),
    cursorX: 9, cursorY: 6,     // show the cursor highlight; it is part of the look
    top: l.top, left: l.left,
  };

  drawHud(s, view, core.core_mines() - core.core_flags_placed(), 42);
  drawBoardFrame(s, view);
  drawBoard(s, view);

  if (l.sidePanelsFit) {
    const leftX = l.left - 1 - AVATAR_GUTTER - AVATAR_WIDTH_CHARS;
    const rightX = l.left + W * 2 + 1 + AVATAR_GUTTER;
    const top = l.top + Math.floor((H - AVATAR_HEIGHT_CHARS) / 2);
    // Two visibly different avatars, and one mid-blink, since the blink is a
    // real part of how the game feels.
    // Deliberately not cyan for either: CP_HIDDEN draws every unrevealed cell in
    // cyan, so a cyan avatar reads as a smudge of board rather than a face.
    const me: Avatar = { skin: 3, hair: 5 };
    const them: Avatar = { skin: 2, hair: 1 };
    drawAvatar(s, top, leftX, me, true);
    drawAvatar(s, top, rightX, them, false);

    const nameRow = top + AVATAR_HEIGHT_CHARS + 1;
    s.withAttrs(CP_HUD, false, () => {
      s.print(nameRow, leftX + 3, "you");
      s.print(nameRow, rightX + 2, "them");
    });
  }

  const tag = "Minesweeper in ASCII - now in your browser";
  s.withAttrs(CP_TITLE, false, () => {
    s.print(l.top + H + 3, s.centreCol(0, COLS, tag), tag);
  });

  return s;
}

// ----------------------------------------------------------------------- SVG
const esc = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function slotColor(slot: number): string {
  if (slot === SLOT_DEFAULT_FG) return palette.defaultFg;
  if (slot === SLOT_DEFAULT_BG) return palette.defaultBg;
  return palette.ansi[slot] ?? palette.defaultFg;
}

function surfaceToSvg(s: Surface): string {
  const rects: string[] = [];
  const texts: string[] = [];

  for (let y = 0; y < s.rows; y++) {
    // Merge horizontal runs of identical background into one rect, so the file
    // stays small instead of carrying 3720 of them.
    let runStart = 0;
    let runBg = -1;
    const flush = (endX: number) => {
      if (runBg < 0 || endX <= runStart) return;
      const col = slotColor(runBg);
      if (col === palette.defaultBg) { return; } // the page background covers it
      rects.push(
        `<rect x="${runStart * CELL_W}" y="${PAD_Y + y * CELL_H}" ` +
        `width="${(endX - runStart) * CELL_W}" height="${CELL_H}" fill="${col}"/>`,
      );
    };

    for (let x = 0; x < s.cols; x++) {
      const i = (y * s.cols + x) * 4;
      const glyph = s.cells[i];
      const fg = s.cells[i + 1];
      const bg = s.cells[i + 2];
      const bold = (s.cells[i + 3] & 1) !== 0;

      if (bg !== runBg) { flush(x); runStart = x; runBg = bg; }

      if (glyph !== 32) {
        texts.push(
          `<text x="${x * CELL_W + CELL_W / 2}" y="${PAD_Y + y * CELL_H + CELL_H / 2}" ` +
          `fill="${slotColor(fg)}"${bold ? ' font-weight="bold"' : ""}>` +
          `${esc(String.fromCharCode(glyph))}</text>`,
        );
      }
    }
    flush(s.cols);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">
<rect width="100%" height="100%" fill="${palette.defaultBg}"/>
<g>${rects.join("")}</g>
<g font-family="${FONT}" font-size="${Math.round(CELL_H * 0.78)}" text-anchor="middle" dominant-baseline="central" xml:space="preserve">
${texts.join("\n")}
</g>
</svg>
`;
}

// --------------------------------------------------------------------- icons
/**
 * The avatar face as six blocks, matching src/avatar.c's pixel rules.
 *
 * Blocks overlap by half a unit and rendering is crispEdges: the icon is scaled
 * to 180, 192 and 512, none of which divide the 96-unit viewBox evenly, and
 * abutting rects at a fractional scale leave antialiased hairline seams.
 */
function faviconSvg(a: Avatar): string {
  const px = 16;
  const bleed = 0.5;
  const parts: string[] = [`<rect width="96" height="96" fill="${palette.defaultBg}"/>`];
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      const isHair = row < 2;
      const isEye = !isHair && row === 2 && (col === 2 || col === 4);
      const slot = isEye ? 0 : isHair ? a.hair : a.skin;
      parts.push(
        `<rect x="${col * px - bleed}" y="${row * px - bleed}" ` +
        `width="${px + bleed * 2}" height="${px + bleed * 2}" fill="${slotColor(slot)}"/>`,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" shape-rendering="crispEdges">
${parts.join("\n")}
</svg>
`;
}

// ------------------------------------------------------------------ rasterise
function rasterise(svgPath: string, pngPath: string, w: number, h: number): boolean {
  const attempts: [string, string[]][] = [
    ["rsvg-convert", ["-w", String(w), "-h", String(h), "-o", pngPath, svgPath]],
    ["magick", [svgPath, "-resize", `${w}x${h}!`, pngPath]],
    ["convert", [svgPath, "-resize", `${w}x${h}!`, pngPath]],
  ];
  for (const [bin, args] of attempts) {
    try {
      execFileSync(bin, args, { stdio: "pipe" });
      return true;
    } catch {
      /* try the next one */
    }
  }
  return false;
}

// ----------------------------------------------------------------------- main
const s = await compose();
mkdirSync(OUT, { recursive: true });

// The SVG is the source the PNG is rasterised from, so it lives with the tool
// rather than in public/ - otherwise every visitor downloads 20 KB of it.
const cardSvg = join(WEB, "tools", "social-card.svg");
const cardPng = join(OUT, "social-card.png");
writeFileSync(cardSvg, surfaceToSvg(s));

const favSvg = join(OUT, "favicon.svg");
writeFileSync(favSvg, faviconSvg({ skin: 3, hair: 5 }));

writeFileSync(join(OUT, "site.webmanifest"), JSON.stringify({
  name: "asciisweeper",
  short_name: "asciisweeper",
  description: "Minesweeper rendered as an ASCII terminal, drawn with WebGL.",
  start_url: ".",
  scope: ".",
  display: "standalone",
  orientation: "any",
  background_color: palette.defaultBg,
  theme_color: palette.defaultBg,
  icons: [
    { src: "favicon.svg", sizes: "any", type: "image/svg+xml" },
    { src: "icon-192.png", sizes: "192x192", type: "image/png" },
    // Deliberately not "maskable": the face fills the frame, so a maskable
    // crop would cut the hair off. A real maskable icon needs the content
    // inside the central 80% safe zone.
    { src: "icon-512.png", sizes: "512x512", type: "image/png" },
  ],
}, null, 2) + "\n");

let ok = rasterise(cardSvg, cardPng, CARD_W, CARD_H);
for (const [name, size] of [["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]] as const) {
  ok = rasterise(favSvg, join(OUT, name), size, size) && ok;
}

console.log(`card: ${cardSvg}`);
if (ok) {
  console.log(`card: ${cardPng} (${CARD_W}x${CARD_H}) + icons`);
} else {
  console.warn(
    "card: no SVG rasteriser found (rsvg-convert, magick or convert).\n" +
    "      The SVG was written; the committed PNGs are unchanged.",
  );
  process.exitCode = 1;
}
