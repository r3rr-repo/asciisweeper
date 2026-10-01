/*
 * Shader index-math tests.
 *
 * The fragment shader in term/webgl.ts turns a cell's (glyph, fg, bg, flags)
 * into an atlas tile and two palette texels. That is pure arithmetic, and it is
 * where an off-by-one quietly draws the WRONG GLYPH rather than crashing - so it
 * is worth testing even though the GPU itself is not available here.
 *
 * The functions below mirror the GLSL line for line. If the shader changes,
 * change these together and the mismatch shows up as a failure.
 */
import { ATLAS_COLS, ATLAS_ROWS, ATLAS_ROWS_PER_WEIGHT } from "../src/term/atlas";
import { PALETTE_SLOTS, SLOT_DEFAULT_BG, SLOT_DEFAULT_FG, XTERM, paletteTexels, resolveBold } from "../src/term/palette";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };
const eq = <T>(a: T, b: T, m: string) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

/** Mirrors: tile = max(glyph - 32, 0); ax = mod(tile, cols); ay = floor(tile/cols) + bold*boldRow */
function atlasTile(glyph: number, bold: boolean): { ax: number; ay: number } {
  const tile = Math.max(glyph - 32, 0);
  return {
    ax: tile % ATLAS_COLS,
    ay: Math.floor(tile / ATLAS_COLS) + (bold ? ATLAS_ROWS_PER_WEIGHT : 0),
  };
}

/** Mirrors: texture2D(uPalette, vec2((idx + 0.5)/uSlots, 0.5)) */
function paletteTexel(idx: number): number {
  const u = (idx + 0.5) / PALETTE_SLOTS;
  return Math.floor(u * PALETTE_SLOTS); // NEAREST sampling of a PALETTE_SLOTS-wide texture
}

// ------------------------------------------------------------- atlas tile mapping
{
  // Space is the first tile; '~' (126) is the last. Anything outside is clamped
  // by the Surface before it ever reaches here.
  eq(JSON.stringify(atlasTile(32, false)), JSON.stringify({ ax: 0, ay: 0 }), "space maps to tile 0,0");
  eq(JSON.stringify(atlasTile(126, false)), JSON.stringify({ ax: 94 % 16, ay: Math.floor(94 / 16) }),
    "'~' maps to the last regular tile");

  // 95 printable glyphs must fit the rows reserved for one weight.
  const lastRegular = atlasTile(126, false);
  ok(lastRegular.ay < ATLAS_ROWS_PER_WEIGHT,
    `the 95 glyphs fit in ${ATLAS_ROWS_PER_WEIGHT} rows (last row used: ${lastRegular.ay})`);

  // Bold must land in the second half and never collide with a regular tile.
  const boldSpace = atlasTile(32, true);
  eq(boldSpace.ay, ATLAS_ROWS_PER_WEIGHT, "bold space starts at the bold row offset");
  const lastBold = atlasTile(126, true);
  ok(lastBold.ay < ATLAS_ROWS, `the bold half fits the atlas (last row ${lastBold.ay} < ${ATLAS_ROWS})`);

  // Every glyph in range gets a distinct tile, in both weights.
  const seen = new Set<string>();
  for (let code = 32; code <= 126; code++) {
    for (const bold of [false, true]) {
      const t = atlasTile(code, bold);
      const key = `${t.ax},${t.ay}`;
      ok(!seen.has(key), `tile ${key} is used only once (glyph ${code}, bold=${bold})`);
      seen.add(key);
      ok(t.ax >= 0 && t.ax < ATLAS_COLS && t.ay >= 0 && t.ay < ATLAS_ROWS,
        `glyph ${code} bold=${bold} stays inside the atlas`);
    }
  }
  eq(seen.size, 95 * 2, "95 glyphs x 2 weights all have their own tile");
}

// ------------------------------------------------------------- the glyphs in play
{
  // Everything the game actually draws must be in range.
  const used = " .F*X+-|12345678>_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:()[]/";
  for (const ch of used) {
    const code = ch.charCodeAt(0);
    ok(code >= 32 && code <= 126, `'${ch}' (${code}) is inside printable ASCII`);
  }
}

// ----------------------------------------------------------- palette texel lookup
{
  for (let i = 0; i < PALETTE_SLOTS; i++) {
    eq(paletteTexel(i), i, `palette slot ${i} samples its own texel under NEAREST`);
  }

  const texels = paletteTexels(XTERM);
  eq(texels.length, PALETTE_SLOTS * 4, "palette texture is PALETTE_SLOTS wide, RGBA");

  // ANSI blue is slot 4 - the colour CP_EMPTY paints every revealed cell.
  eq(texels[4 * 4 + 0], 0x00, "slot 4 red");
  eq(texels[4 * 4 + 1], 0x00, "slot 4 green");
  eq(texels[4 * 4 + 2], 0xaa, "slot 4 blue is the DIM ANSI blue");
  eq(texels[4 * 4 + 3], 255, "slot 4 is opaque");

  // The default foreground must equal ANSI white exactly, or CP_HUD text would
  // differ from plain default text - in a terminal they match.
  for (let k = 0; k < 3; k++) {
    eq(texels[SLOT_DEFAULT_FG * 4 + k], texels[7 * 4 + k],
      `defaultFg channel ${k} equals ANSI white`);
  }
  eq(texels[SLOT_DEFAULT_BG * 4 + 0], 0x00, "defaultBg is black");
}

// ------------------------------------------------------------------ bold -> bright
{
  const p = { ...XTERM, brightenBlack: true };
  for (let c = 0; c <= 7; c++) {
    eq(resolveBold(c, false, p), c, `colour ${c} unbold stays itself`);
    eq(resolveBold(c, true, p), c + 8, `colour ${c} bold becomes ${c + 8}`);
  }
  // The defaults are not ANSI indices and must pass through untouched.
  eq(resolveBold(SLOT_DEFAULT_FG, true, p), SLOT_DEFAULT_FG, "bold does not shift the default fg slot");

  const q = { ...XTERM, brightenBlack: false };
  eq(resolveBold(0, true, q), 0, "with brightenBlack off, bold black stays black");
  eq(resolveBold(4, true, q), 12, "...but other colours still brighten");
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
