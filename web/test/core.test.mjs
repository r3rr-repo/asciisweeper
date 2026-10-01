/*
 * Tests for the wasm core. Run with: ./build-web.sh --test
 *
 * These are property-based rather than golden-value: wasi-libc's rand() differs
 * from the native libc's, so the same seed does NOT produce the same board in
 * the C binary and in wasm. Asserting internal consistency of the rules is both
 * achievable and the thing that actually matters.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(join(here, "..", "wasm", "core.wasm"));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("FAIL:", msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${a}, want ${b})`);

// ---------------------------------------------------------------- instantiation
const mod = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(mod);
ok(imports.length === 0, `module must need no imports, got ${JSON.stringify(imports)}`);

const inst = new WebAssembly.Instance(mod, {});
const C = inst.exports;
const mem = () => new Uint8Array(C.memory.buffer);

const REVEALED = 0x80, FLAGGED = 0x40, MINE = 0x20, ADJ = 0x0f;
const PLAYING = 0, WON = 1, LOST = 2;

const cstr = (ptr) => {
  const m = mem(); let e = ptr; while (m[e]) e++;
  return new TextDecoder().decode(m.subarray(ptr, e));
};
const snapshot = () => {
  const n = C.core_snapshot();
  return mem().slice(C.core_cells_ptr(), C.core_cells_ptr() + n);
};
const at = (cells, x, y) => cells[y * C.core_w() + x];

// ------------------------------------------------------------------- constants
eq(C.core_proto_version(), 4, "protocol version matches net_proto.h");
eq(C.core_max_w(), 60, "MAX_W");
eq(C.core_max_h(), 30, "MAX_H");
eq(C.core_mp_w(), 16, "MP board width");
eq(C.core_mp_mines(), 40, "MP mine count");
eq(C.core_max_name_len(), 16, "name length");
eq(C.core_token_len(), 16, "token length");

// ------------------------------------------------------------- first-click safety
// board.c places mines only on the first reveal, avoiding the 3x3 around it.
C.core_srand(12345);
for (let trial = 0; trial < 200; trial++) {
  C.core_board_init(9, 9, 10);
  C.core_reveal(4, 4);
  if (C.core_status() !== PLAYING) { ok(false, `first click hit a mine on trial ${trial}`); break; }
}
ok(true, "200 first clicks were all safe");

// --------------------------------------------------------------- flood-fill rules
C.core_board_init(16, 16, 40);
C.core_reveal(8, 8);
let cells = snapshot();
eq(cells.length, 16 * 16, "snapshot is w*h bytes, tightly packed");

// Every revealed zero must have all 8 neighbours revealed (flood fill completeness).
let zeros = 0, leaks = 0;
for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
  const b = at(cells, x, y);
  if (!(b & REVEALED) || (b & MINE) || (b & ADJ) !== 0) continue;
  zeros++;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx > 15 || ny > 15) continue;
    if (!(at(cells, nx, ny) & REVEALED)) leaks++;
  }
}
ok(zeros > 0, "the opening reveal produced at least one zero cell");
eq(leaks, 0, "every neighbour of a revealed zero is itself revealed");

// revealed_count must equal the number of REVEALED non-mine cells in the snapshot
let revealedNonMine = 0;
for (const b of cells) if ((b & REVEALED) && !(b & MINE)) revealedNonMine++;
eq(C.core_revealed(), revealedNonMine, "revealed_count agrees with the snapshot");

// -------------------------------------------------------------------- flagging
C.core_board_init(9, 9, 10);
C.core_flag(0, 0);
eq(C.core_flags_placed(), 0, "flagging before the first reveal is a no-op (board.c:144)");
C.core_reveal(4, 4);
const before = C.core_flags_placed();
// find a hidden cell to flag
let fx = -1, fy = -1;
cells = snapshot();
for (let y = 0; y < 9 && fx < 0; y++) for (let x = 0; x < 9; x++) {
  if (!(at(cells, x, y) & REVEALED)) { fx = x; fy = y; break; }
}
ok(fx >= 0, "found a hidden cell to flag");
C.core_flag(fx, fy);
eq(C.core_flags_placed(), before + 1, "flagging increments the counter");
ok((at(snapshot(), fx, fy) & FLAGGED) !== 0, "flag shows in the snapshot");
C.core_flag(fx, fy);
eq(C.core_flags_placed(), before, "unflagging decrements it again");

// ------------------------------------------------------- out-of-bounds is ignored
// board.c does NOT bounds-check; core_api.c must, because mouse input can be off-board.
C.core_board_init(9, 9, 10);
C.core_reveal(4, 4);
const sane = C.core_revealed();
for (const [x, y] of [[-1, 0], [0, -1], [9, 0], [0, 9], [999, 999], [-999, -999]]) {
  C.core_reveal(x, y); C.core_flag(x, y); C.core_chord(x, y);
}
eq(C.core_revealed(), sane, "out-of-bounds coordinates change nothing");
eq(C.core_status(), PLAYING, "out-of-bounds coordinates do not end the game");

// ------------------------------------------------------------------ loss encoding
// Play until a loss, then check the glyph-selection inputs draw_board relies on.
let lost = false;
for (let trial = 0; trial < 400 && !lost; trial++) {
  C.core_board_init(9, 9, 20);
  C.core_reveal(4, 4);
  for (let y = 0; y < 9 && C.core_status() === PLAYING; y++)
    for (let x = 0; x < 9 && C.core_status() === PLAYING; x++) C.core_reveal(x, y);
  if (C.core_status() === LOST) lost = true;
}
ok(lost, "reached a loss");
if (lost) {
  ok(C.core_exploded_x() >= 0 && C.core_exploded_y() >= 0, "loss records the exploded cell");
  cells = snapshot();
  // board_reveal_all_mines runs on loss, so every mine must arrive as REVEALED|MINE.
  let hiddenMines = 0;
  for (const b of cells) if ((b & MINE) && !(b & REVEALED)) hiddenMines++;
  eq(hiddenMines, 0, "no mine is encoded as unrevealed after a loss");
}

// ------------------------------------------------------------------- win encoding
// Win by revealing every non-mine cell. Mines get flagged but NOT revealed, which
// is what makes draw_board's F-vs-X distinction work.
let won = false;
for (let trial = 0; trial < 400 && !won; trial++) {
  C.core_board_init(5, 5, 1);
  C.core_reveal(2, 2);
  for (let y = 0; y < 5 && C.core_status() === PLAYING; y++)
    for (let x = 0; x < 5 && C.core_status() === PLAYING; x++) C.core_reveal(x, y);
  if (C.core_status() === WON) won = true;
}
ok(won, "reached a win");
if (won) {
  eq(C.core_revealed(), 5 * 5 - 1, "win means every non-mine cell is revealed");
  eq(C.core_flags_placed(), 1, "win auto-flags the mines (board.c:69)");
  cells = snapshot();
  let flaggedUnrevealed = 0;
  for (const b of cells) if ((b & FLAGGED) && !(b & REVEALED)) flaggedUnrevealed++;
  eq(flaggedUnrevealed, 1, "the won board's mine is FLAGGED but not REVEALED");
}

// --------------------------------------------------------- mine-count clamping
// A mine count at or above the placeable area would make board_place_mines spin.
// The clamp deliberately matches main.c:1100 (`max_mines = d.w * d.h - 9`), the
// 9 being the 3x3 around the first click that board_place_mines refuses to fill.
C.core_board_init(5, 5, 9999);
eq(C.core_mines(), 5 * 5 - 9, "mine count clamped exactly as main.c:1100 does");
C.core_reveal(2, 2);
// At exactly w*h-9 mines every safe cell is in the opening 3x3, so the board is
// won on the first click. Degenerate, but it is what the terminal game does too,
// and the point of the clamp is that board_place_mines terminates at all.
ok(C.core_status() === WON || C.core_status() === PLAYING, "clamped board resolves without hanging");
C.core_board_init(999, 999, 10);
eq(C.core_w(), 60, "width clamped to MAX_W");
eq(C.core_h(), 30, "height clamped to MAX_H");

// -------------------------------------------------------------- codec round-trip
// Pack HELLO, then decode it back through the same C codec the server uses.
const enc = new TextEncoder();
const writeStr = (ptr, s) => { const b = enc.encode(s + "\0"); mem().set(b, ptr); return ptr; };
const scratch = C.core_in_ptr();          // dedicated inbound buffer, never aliases g_tx
ok(C.core_in_size() >= 128, "inbound scratch is big enough for a chat line");

writeStr(scratch, "Rob");
let n = C.core_pack_hello(scratch, 3, 5);
ok(n > 0, "pack_hello produced a payload");
const helloBytes = mem().slice(C.core_tx_ptr(), C.core_tx_ptr() + n);
eq(helloBytes[0], 4, "hello carries the protocol version");

// MSG_CHAT_RECV round-trip through core_rx
writeStr(scratch, "hello there");
n = C.core_pack_chat(scratch);
const chatPayload = mem().slice(C.core_tx_ptr(), C.core_tx_ptr() + n);
mem().set(chatPayload, scratch);
eq(C.core_rx(0x8b, scratch, n), 1, "core_rx accepts a CHAT_RECV payload");
eq(cstr(C.core_chat_text()), "hello there", "chat text survives the round trip");

// A truncated payload must be rejected, not silently accepted.
eq(C.core_rx(0x83, scratch, 2), 0, "core_rx rejects a short MATCH_START");
eq(C.core_rx(0xff, scratch, 8), 0, "core_rx rejects an unknown message type");

// ------------------------------------------------------------------ avatar rule
C.core_srand(7);
let outOfRange = 0;
for (let i = 0; i < 500; i++) {
  C.core_avatar_random(scratch);
  const skin = mem()[scratch], hair = mem()[scratch + 1];
  if (skin < 1 || skin > 7 || hair < 1 || hair > 7) outOfRange++;
}
eq(outOfRange, 0, "avatar colours stay in 1-7, never 0 (COLOR_BLACK is for eyes)");

// ---------------------------------------------------------------------- results
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
