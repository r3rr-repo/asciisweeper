/*
 * Grid sizing tests.
 *
 * The cases below are the regression baseline: every one of these screens had
 * the multiplayer chat drawn off the bottom of the window, because the old code
 * chose the largest cells at which the 40x20 MINIMUM still fit, so a bigger
 * screen meant fewer rows.
 */
import {
  chooseGrid, clampTargetRows, fitFontSize,
  DEFAULT_TARGET_ROWS, MIN_TARGET_ROWS, MAX_TARGET_ROWS, MIN_COLS, MIN_ROWS,
} from "../src/term/sizing";
import { computeLayout } from "../src/game/layout";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };
const eq = <T>(a: T, b: T, m: string) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

/** The multiplayer screen: 16x16 board, avatars either side. */
const MP_H = 16;
const MP_COLS_NEEDED = 16 * 2 + 2 + 2 * (12 + 2); // 62
const MP_EXTRA = 7;
/**
 * The deepest thing multiplayer draws: on the end screen the chat log starts at
 * +7 and the composer sits below it at +10.
 */
const deepestMpRow = (top: number) => top + MP_H + 10;

const SCREENS: [string, number, number, number][] = [
  ["MacBook Air 13in", 1512, 860, 2],
  ["MacBook Pro 14in", 1512, 945, 2],
  ["MacBook Pro 16in", 1728, 1080, 2],
  ["1080p dpr1", 1920, 1080, 1],
  ["1440p dpr1", 2560, 1440, 1],
  ["4K dpr1", 3840, 2160, 1],
  ["small window", 1100, 700, 2],
  ["half-width window", 760, 900, 2],
  ["portrait tablet", 820, 1180, 2],
];

// ------------------------------------------------- every real screen must work
for (const [name, cssW, cssH, dpr] of SCREENS) {
  const backW = Math.round(cssW * dpr), backH = Math.round(cssH * dpr);
  const g = chooseGrid(backW, backH, DEFAULT_TARGET_ROWS);

  ok(Number.isInteger(g.cellW) && Number.isInteger(g.cellH),
    `${name}: cell dimensions are integers (${g.cellW}x${g.cellH}) - the crispness requirement`);
  ok(g.cellW > 0 && g.cellH > 0, `${name}: cells are positive`);

  // The terminal convention is about 1:2; allow a little slack from rounding.
  const aspect = g.cellW / g.cellH;
  ok(Math.abs(aspect - 0.5) < 0.06,
    `${name}: cell aspect stays near 1:2 (got ${aspect.toFixed(3)} from ${g.cellW}x${g.cellH})`);

  ok(g.cols >= MIN_COLS && g.rows >= MIN_ROWS, `${name}: clears the hard minimum (${g.cols}x${g.rows})`);
  ok(g.cols >= MP_COLS_NEEDED, `${name}: fits the multiplayer width, needs ${MP_COLS_NEEDED} (got ${g.cols})`);

  // The actual regression: the chat composer has to be on screen.
  const l = computeLayout(16, MP_H, g.cols, g.rows, true, MP_EXTRA);
  ok(deepestMpRow(l.top) <= g.rows - 1,
    `${name}: chat composer on screen (row ${deepestMpRow(l.top)} of ${g.rows - 1}) [${g.cols}x${g.rows}]`);
  ok(l.sidePanelsFit, `${name}: avatar side panels fit`);

  // The grid must not overflow the canvas it was derived from.
  ok(g.cols * g.cellW <= backW, `${name}: grid width fits the backing store`);
  ok(g.rows * g.cellH <= backH, `${name}: grid height fits the backing store`);
}

// ---------------------------------------- zoom range stays usable end to end
{
  const [, cssW, cssH, dpr] = SCREENS[1]; // 14in MacBook
  const backW = Math.round(cssW * dpr), backH = Math.round(cssH * dpr);
  for (let t = MIN_TARGET_ROWS; t <= MAX_TARGET_ROWS; t += 2) {
    const g = chooseGrid(backW, backH, t);
    ok(g.cols >= MP_COLS_NEEDED, `zoom ${t}: still fits multiplayer width (${g.cols})`);
    const l = computeLayout(16, MP_H, g.cols, g.rows, true, MP_EXTRA);
    ok(deepestMpRow(l.top) <= g.rows - 1, `zoom ${t}: chat still on screen (${g.cols}x${g.rows})`);
  }
}

// Zooming in must actually make cells bigger, and out smaller - monotonic.
{
  const backW = 3024, backH = 1890;
  let prev = chooseGrid(backW, backH, MIN_TARGET_ROWS).cellH;
  for (let t = MIN_TARGET_ROWS + 2; t <= MAX_TARGET_ROWS; t += 2) {
    const h = chooseGrid(backW, backH, t).cellH;
    ok(h <= prev, `target ${t}: more rows requested means cells no larger (${h} <= ${prev})`);
    prev = h;
  }
}

// ----------------------------------------------------------- target clamping
eq(clampTargetRows(DEFAULT_TARGET_ROWS), DEFAULT_TARGET_ROWS, "default passes through");
eq(clampTargetRows(2), MIN_TARGET_ROWS, "absurdly small target clamps up");
eq(clampTargetRows(9999), MAX_TARGET_ROWS, "absurdly large target clamps down");
eq(clampTargetRows(NaN), DEFAULT_TARGET_ROWS, "NaN falls back to the default");
eq(clampTargetRows(Infinity), DEFAULT_TARGET_ROWS, "Infinity is garbage input, so it falls back to the default like NaN");
eq(clampTargetRows(31.6), 32, "fractional target rounds");

// ------------------------------------------------- single-player is unchanged
// blockH must still be exactly h+8 there: that is ported arithmetic from
// game_init (src/main.c:93) and should stay diffable against the C.
{
  const sp = computeLayout(16, 16, 80, 30, false);
  const expectedTop = Math.max(0, Math.floor((30 - (16 + 8)) / 2)) + 4;
  eq(sp.top, expectedTop, "single-player layout still uses blockH = h + 8");

  const mp = computeLayout(16, 16, 80, 30, true, MP_EXTRA);
  const expectedMpTop = Math.max(0, Math.floor((30 - (16 + 8 + MP_EXTRA)) / 2)) + 4;
  eq(mp.top, expectedMpTop, "multiplayer layout reserves the chat rows");
  ok(mp.top <= sp.top, "reserving rows moves the multiplayer block up, not down");
}

// --------------------------------------------------------------- font fitting
// The width constraint is the one that cannot be reproduced here: the font is a
// stack, so the resolved family decides the advance.
for (const advance of [0.5, 0.55, 0.6, 0.6023, 0.65, 0.7]) {
  for (const [cw, ch] of [[10, 20], [15, 30], [20, 40], [30, 59], [8, 16]] as const) {
    const px = fitFontSize(cw, ch, advance, 0.78);
    ok(px >= 1, `advance ${advance} cell ${cw}x${ch}: a usable size`);
    ok(px * advance <= cw,
      `advance ${advance} cell ${cw}x${ch}: glyph cannot bleed into the next tile ` +
      `(${(px * advance).toFixed(1)} <= ${cw})`);
    ok(px <= ch * 0.78 + 1, `advance ${advance} cell ${cw}x${ch}: still fits vertically`);
  }
}
// A font wide enough to overflow must be shrunk, not merely clipped.
ok(fitFontSize(10, 20, 0.7, 0.78) < Math.floor(20 * 0.78),
  "a wide font is scaled down below the height-derived size");
eq(fitFontSize(10, 20, 0, 0.78), Math.floor(20 * 0.78),
  "an unmeasurable advance falls back to the height constraint");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
