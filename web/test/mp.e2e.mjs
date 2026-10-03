/*
 * End-to-end multiplayer test.
 *
 * Drives TWO clients through the real bridge into the real asciisweeper-server,
 * using the same wasm codec and the same frame reassembly the browser uses. This
 * is the strongest parity check available: the server is authoritative and
 * broadcasts full snapshots, so if the wasm codec or the reassembly disagreed
 * with the C, the match would not progress at all.
 *
 * Needs a running server and bridge; see web/bridge/README.md. Invoked by
 * ../../build-web.sh --e2e.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.BRIDGE_URL ?? "ws://127.0.0.1:8080/ws";

const MSG = {
  HELLO: 0x01, ACTION_REVEAL: 0x03, ACTION_FLAG: 0x04, ACTION_CHORD: 0x05,
  PING: 0x06, CHAT: 0x07,
  REQUEST_REMATCH: 0x08,
  WELCOME: 0x81, QUEUE_STATUS: 0x82, MATCH_START: 0x83, BOARD_STATE: 0x84,
  TURN: 0x85, MATCH_END: 0x87, ERROR: 0x88, PONG: 0x8a, CHAT_RECV: 0x8b,
};
const NAME = { 0x81: "WELCOME", 0x82: "QUEUE_STATUS", 0x83: "MATCH_START", 0x84: "BOARD_STATE", 0x85: "TURN", 0x86: "OPPONENT_STATUS", 0x87: "MATCH_END", 0x88: "ERROR", 0x89: "RECONNECT_OK", 0x8a: "PONG", 0x8b: "CHAT_RECV" };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`); } else { fail++; console.error(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${a}, want ${b})`);

/** Each client gets its own wasm instance, as two browser tabs would. */
async function newCore() {
  const bytes = readFileSync(join(here, "..", "wasm", "core.wasm"));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports;
}

/**
 * Mirrors web/src/net/wsconn.ts: the bridge is a byte pipe, so a WebSocket
 * message boundary is NOT a protocol frame boundary and frames must be
 * reassembled from a growing buffer.
 */
class Client {
  constructor(name, core) {
    this.name = name;
    this.core = core;
    this.rx = Buffer.alloc(0);
    this.frames = [];
    this.waiters = [];
    this.ws = new WebSocket(URL_);
    this.ws.binaryType = "arraybuffer";
    this.opened = new Promise((res, rej) => {
      this.ws.on("open", res);
      this.ws.on("error", rej);
    });
    this.ws.on("message", (data) => this.absorb(Buffer.from(data)));
  }

  absorb(chunk) {
    this.rx = Buffer.concat([this.rx, chunk]);
    for (;;) {
      if (this.rx.length < 3) break;
      const type = this.rx[0];
      const len = (this.rx[1] << 8) | this.rx[2];
      if (this.rx.length < 3 + len) break;
      const payload = this.rx.subarray(3, 3 + len);
      this.rx = this.rx.subarray(3 + len);
      this.frames.push({ type, payload: Buffer.from(payload) });
      for (const w of this.waiters.splice(0)) w();
    }
  }

  send(type, payload) {
    const b = Buffer.alloc(3 + payload.length);
    b[0] = type;
    b[1] = (payload.length >> 8) & 0xff;
    b[2] = payload.length & 0xff;
    Buffer.from(payload).copy(b, 3);
    this.ws.send(b);
  }

  /** Waits for a frame of the given type, consuming anything before it. */
  async expect(type, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ix = this.frames.findIndex((f) => f.type === type);
      if (ix >= 0) return this.frames.splice(ix, 1)[0];
      const left = deadline - Date.now();
      if (left <= 0) {
        const seen = this.frames.map((f) => NAME[f.type] ?? f.type).join(", ") || "nothing";
        throw new Error(`${this.name}: timed out waiting for ${NAME[type] ?? type}; saw ${seen}`);
      }
      await new Promise((res) => {
        const t = setTimeout(res, Math.min(left, 100));
        this.waiters.push(() => { clearTimeout(t); res(); });
      });
    }
  }

  mem() { return new Uint8Array(this.core.memory.buffer); }

  /** A fresh identity per client, unless one is supplied to reuse. */
  makeIdentity(reuse) {
    const c = this.core;
    if (reuse) return reuse;
    const rnd = new Uint8Array(10);
    for (let i = 0; i < 10; i++) rnd[i] = Math.floor(Math.random() * 256);
    const rp = c.core_in_ptr(), up = rp + 32;
    this.mem().set(rnd, rp);
    c.core_uuid_v7(Date.now(), rp, up);
    const uuid = this.mem().slice(up, up + 16);
    const secret = new Uint8Array(32);
    for (let i = 0; i < 32; i++) secret[i] = Math.floor(Math.random() * 256);
    return { uuid, secret };
  }

  packHello(name, skin, hair, ident) {
    const c = this.core;
    const p = c.core_in_ptr();
    this.mem().set(new TextEncoder().encode(name + "\0"), p);
    const up = p + 160, sp = up + 16;
    this.mem().set(ident.uuid, up);
    this.mem().set(ident.secret, sp);
    const n = c.core_pack_hello(p, skin, hair, up, sp);
    return this.mem().slice(c.core_tx_ptr(), c.core_tx_ptr() + n);
  }

  /** Decodes through the C codec, exactly as the browser does. */
  rxFrame(f) {
    const dst = f.payload.length <= this.core.core_in_size()
      ? this.core.core_in_ptr() : this.core.core_tx_ptr();
    this.mem().set(f.payload, dst);
    return this.core.core_rx(f.type, dst, f.payload.length) !== 0;
  }

  snapshot() {
    const n = this.core.core_snapshot();
    return this.mem().slice(this.core.core_cells_ptr(), this.core.core_cells_ptr() + n);
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const REVEALED = 0x80, FLAGGED = 0x40, MINE = 0x20;

const settle = (ms) => new Promise((res) => setTimeout(res, ms));

try {
  console.log(`connecting two clients to ${URL_}`);
  const [coreA, coreB] = await Promise.all([newCore(), newCore()]);
  const a = new Client("A", coreA);
  const b = new Client("B", coreB);
  await Promise.all([a.opened, b.opened]);
  ok(true, "both clients opened a WebSocket through the bridge");

  // ---- handshake -----------------------------------------------------------
  const identA = a.makeIdentity();
  const identB = b.makeIdentity();
  a.send(MSG.HELLO, a.packHello("Alice", 3, 5, identA));
  b.send(MSG.HELLO, b.packHello("Bob", 2, 6, identB));

  const wa = await a.expect(MSG.WELCOME);
  ok(a.rxFrame(wa), "WELCOME from the C server decodes with the wasm codec");
  eq(coreA.core_welcome_version(), coreA.core_proto_version(),
    "server and wasm agree on the protocol version");

  // ---- matchmaking --------------------------------------------------------
  const msA = await a.expect(MSG.MATCH_START);
  const msB = await b.expect(MSG.MATCH_START);
  ok(a.rxFrame(msA) && b.rxFrame(msB), "MATCH_START decodes for both players");

  const readName = (core, ptr) => {
    const m = new Uint8Array(core.memory.buffer);
    let e = ptr; while (m[e]) e++;
    return new TextDecoder().decode(m.subarray(ptr, e));
  };
  eq(readName(coreA, coreA.core_ms_opp_name()), "Bob", "Alice is told her opponent's name");
  eq(readName(coreB, coreB.core_ms_opp_name()), "Alice", "Bob is told his opponent's name");
  eq(coreA.core_ms_opp_skin(), 2, "opponent avatar skin crosses the wire");
  eq(coreB.core_ms_opp_hair(), 5, "opponent avatar hair crosses the wire");
  eq(coreA.core_ms_w(), coreA.core_mp_w(), "match board width is the MP constant");
  eq(coreA.core_ms_mines(), coreA.core_mp_mines(), "match mine count is the MP constant");

  const idA = coreA.core_ms_player_id();
  const idB = coreB.core_ms_player_id();
  ok(idA !== idB, `players got distinct ids (${idA} vs ${idB})`);

  // first_to_move is a BOOLEAN "is it your turn", not a player id: server.c:680
  // sends (player_to_move == player_index), so each player gets a different
  // value. Resolving it the wrong way shows "YOUR TURN" to the wrong player.
  const aMovesFirst = coreA.core_ms_first_to_move() !== 0;
  const bMovesFirst = coreB.core_ms_first_to_move() !== 0;
  ok(aMovesFirst !== bMovesFirst,
    `exactly one player is told they move first (A=${aMovesFirst}, B=${bMovesFirst})`);
  const firstMover = aMovesFirst ? idA : idB;
  const mover = aMovesFirst ? a : b;
  const waiter = aMovesFirst ? b : a;
  const moverCore = aMovesFirst ? coreA : coreB;
  const waiterCore = aMovesFirst ? coreB : coreA;
  console.log(`  -- ${mover.name} moves first (player ${firstMover})`);

  // ---- initial snapshot ---------------------------------------------------
  // At match start the server sends BOARD_STATE *and* TURN to both players. Both
  // must be consumed, or every later expect() is reading a stale frame.
  const bs0 = await mover.expect(MSG.BOARD_STATE);
  ok(mover.rxFrame(bs0), "the opening BOARD_STATE decodes");
  const cells0 = mover.snapshot();
  eq(cells0.length, moverCore.core_mp_w() * moverCore.core_mp_h(),
    "snapshot is w*h bytes after wire_to_board");
  eq(cells0.every((c) => c === 0), true, "nothing is revealed before the first move");
  eq(moverCore.core_bs_mines_left(), moverCore.core_mp_mines(),
    "mines_left comes off the message, not the zeroed Board fields");

  const turn0 = await mover.expect(MSG.TURN);
  ok(mover.rxFrame(turn0), "the opening TURN decodes");
  eq(moverCore.core_turn_player(), firstMover, "the opening turn belongs to the first mover");

  await waiter.expect(MSG.BOARD_STATE);
  await waiter.expect(MSG.TURN);

  /** Packs via the C codec and copies the result out of wasm memory. */
  const packed = (core, len) =>
    new Uint8Array(core.memory.buffer).slice(core.core_tx_ptr(), core.core_tx_ptr() + len);

  // ---- a turn-consuming reveal --------------------------------------------
  mover.send(MSG.ACTION_REVEAL, packed(moverCore, moverCore.core_pack_action_reveal(8, 8)));

  const bs1 = await mover.expect(MSG.BOARD_STATE);
  ok(mover.rxFrame(bs1), "BOARD_STATE arrives after a reveal");
  const cells1 = mover.snapshot();
  const revealedCount = [...cells1].filter((c) => c & REVEALED).length;
  ok(revealedCount > 0, `the reveal opened ${revealedCount} cells on the server's board`);

  const turn1 = await mover.expect(MSG.TURN);
  ok(mover.rxFrame(turn1), "TURN decodes after the reveal");
  const second = firstMover === idA ? idB : idA;
  eq(moverCore.core_turn_player(), second, "the reveal passed the turn to the other player");

  // The waiting client must decode the SAME board - this is the desync check,
  // and the reason the client never runs reveal logic itself.
  const bs1b = await waiter.expect(MSG.BOARD_STATE);
  ok(waiter.rxFrame(bs1b), "the other player also receives the snapshot");
  const cellsB = waiter.snapshot();
  eq(waiterCore.core_bs_w(), moverCore.core_bs_w(), "both clients agree on the board width");
  eq(Buffer.compare(Buffer.from(cells1), Buffer.from(cellsB)), 0,
    "both clients decode byte-identical boards (no desync)");
  await waiter.expect(MSG.TURN);

  // ---- flagging is free and does not end a turn ---------------------------
  // It is now the other player's move. Note board.c:144: flagging is a no-op
  // while first_move is set, so this only works after the opening reveal - which
  // the sequence above has now done.
  let fx = -1, fy = -1;
  for (let i = 0; i < cellsB.length && fx < 0; i++) {
    if ((cellsB[i] & REVEALED) === 0) { fx = i % 16; fy = Math.floor(i / 16); }
  }
  ok(fx >= 0, `found a hidden cell to flag at ${fx},${fy}`);
  waiter.send(MSG.ACTION_FLAG, packed(waiterCore, waiterCore.core_pack_action_flag(fx, fy, 1)));

  const bsFlag = await waiter.expect(MSG.BOARD_STATE);
  ok(waiter.rxFrame(bsFlag), "BOARD_STATE arrives after a flag");
  ok((waiter.snapshot()[fy * 16 + fx] & FLAGGED) !== 0,
    "the flag shows up in the authoritative snapshot");
  eq(waiterCore.core_bs_mines_left(), waiterCore.core_mp_mines() - 1,
    "the server decremented mines_left for the flag");

  const turnFlag = await waiter.expect(MSG.TURN);
  ok(waiter.rxFrame(turnFlag), "TURN decodes after the flag");
  eq(waiterCore.core_turn_player(), second, "flagging did NOT end the turn");

  // ---- chat relay ---------------------------------------------------------
  const chatPtr = coreA.core_in_ptr();
  new Uint8Array(coreA.memory.buffer).set(new TextEncoder().encode("gl hf\0"), chatPtr);
  a.send(MSG.CHAT, packed(coreA, coreA.core_pack_chat(chatPtr)));
  const cr = await b.expect(MSG.CHAT_RECV);
  ok(b.rxFrame(cr), "CHAT_RECV decodes");
  eq(readName(coreB, coreB.core_chat_text()), "gl hf", "chat text is relayed intact");

  // ---- keepalive ----------------------------------------------------------
  // JS cannot send WebSocket control-frame pings, so the app-level ping matters.
  a.send(MSG.PING, new Uint8Array(0));
  const pong = await a.expect(MSG.PONG);
  ok(pong.payload.length === 0, "PING is answered with an empty PONG");

  // ---- flag scoring, checked against the final revealed board -------------
  // The test never learns where the mines are until the end, so instead of
  // predicting the score it recomputes the expected one from the final
  // snapshot (a loss reveals every mine) and compares with the server's.
  const flagged = [];   // { x, y, by }  standing flags we placed
  {
    // Whoever has the turn flags three cells; flags are turn-bound now.
    const holder = (await (async () => {
      const ix = a.frames.map((f) => f.type).lastIndexOf(MSG.TURN);
      if (ix >= 0 && a.rxFrame(a.frames.splice(ix, 1)[0])) return coreA.core_turn_player();
      return second;
    })());
    const [cl, core, who] = holder === idA ? [a, coreA, idA] : [b, coreB, idB];
    const cells = cl === a ? a.snapshot() : b.snapshot();
    let placed = 0;
    for (let i = 0; i < 256 && placed < 3; i++) {
      const x = i % 16, y = (i / 16) | 0;
      if (cells[y * 16 + x] & REVEALED) continue;
      cl.send(MSG.ACTION_FLAG, packed(core, core.core_pack_action_flag(x, y, 1)));
      flagged.push({ x, y, by: who });
      placed++;
    }
    await settle(200);
    ok(placed === 3, `placed ${placed} flags on the holder's turn`);
  }

  // Flagging out of turn must now be refused - this is the rule that makes
  // scored flags possible at all.
  {
    const offTurn = (await (async () => {
      const ix = a.frames.map((f) => f.type).lastIndexOf(MSG.TURN);
      if (ix >= 0 && a.rxFrame(a.frames.splice(ix, 1)[0])) return coreA.core_turn_player();
      return second;
    })());
    const [cl, core] = offTurn === idA ? [b, coreB] : [a, coreA];
    cl.frames.length = 0;
    cl.send(MSG.ACTION_FLAG, packed(core, core.core_pack_action_flag(15, 15, 1)));
    const err = await cl.expect(MSG.ERROR, 3000);
    ok(cl.rxFrame(err), "flagging out of turn is rejected");
    eq(core.core_err_code(), 2, "...with ERR_NOT_YOUR_TURN");
  }

  // ---- play to a finish --------------------------------------------------
  // Strictly turn-by-turn, the way real clients behave. An earlier version of
  // this test fired reveals from both clients at once and tripped a race in
  // the server: broadcast_board_state sent outside the match lock with no
  // per-connection write mutex, so two threads could call net_send_frame on
  // the same SSL* and OpenSSL raised "tlsv1 alert internal error". Fixed -
  // Connection now carries a write_lock and is reference-counted, and
  // test/server_probe.mjs provokes that collision on purpose. This test stays
  // turn-by-turn because that is what real clients do, not to dodge it.
  const drainTurn = (cl, core) => {
    const ix = cl.frames.map((f) => f.type).lastIndexOf(MSG.TURN);
    if (ix < 0) return null;
    const fr = cl.frames.splice(ix, 1)[0];
    return cl.rxFrame(fr) ? core.core_turn_player() : null;
  };
  const sawEnd = (cl) => cl.frames.some((f) => f.type === MSG.MATCH_END);

  let turn = second;              // the reveal above already passed the turn
  let ended = false;
  for (let i = 0; i < 300 && !ended; i++) {
    const x = i % 16, y = ((i / 16) | 0) % 16;
    const [cl, core] = turn === idA ? [a, coreA] : [b, coreB];
    cl.send(MSG.ACTION_REVEAL, packed(core, core.core_pack_action_reveal(x, y)));
    await settle(30);
    if (sawEnd(a) || sawEnd(b)) { ended = true; break; }
    const t = drainTurn(a, coreA) ?? drainTurn(b, coreB);
    if (t !== null) turn = t;
  }
  ok(ended, "played the match through to MATCH_END");

  // Decode MATCH_END now, before the chat section clears the queues - the
  // final scores live in it and are needed further down.
  const endA = await a.expect(MSG.MATCH_END, 4000);
  const endB = await b.expect(MSG.MATCH_END, 4000);
  ok(a.rxFrame(endA) && b.rxFrame(endB), "both clients decode MATCH_END");
  const reported = [coreA.core_end_score(0), coreA.core_end_score(1)];
  eq(coreB.core_end_score(0), reported[0], "both clients are told the same score for player 0");
  eq(coreB.core_end_score(1), reported[1], "both clients are told the same score for player 1");

  // ---- the behaviour this change exists for -------------------------------
  // Before this, src/server.c dropped chat during the rematch window with
  // "ignore anything else (e.g. a stray chat line) while deciding".
  a.frames.length = 0; b.frames.length = 0;
  const gg = coreA.core_in_ptr();
  new Uint8Array(coreA.memory.buffer).set(new TextEncoder().encode("gg wp\0"), gg);
  a.send(MSG.CHAT, packed(coreA, coreA.core_pack_chat(gg)));
  const endChat = await b.expect(MSG.CHAT_RECV, 5000);
  ok(b.rxFrame(endChat), "chat sent AFTER the match ends is decoded by the opponent");
  eq(readName(coreB, coreB.core_chat_text()), "gg wp", "end-of-match chat relays intact");

  // And back the other way, so it is not one-directional.
  const re = coreB.core_in_ptr();
  new Uint8Array(coreB.memory.buffer).set(new TextEncoder().encode("gg\0"), re);
  b.send(MSG.CHAT, packed(coreB, coreB.core_pack_chat(re)));
  const back = await a.expect(MSG.CHAT_RECV, 5000);
  ok(a.rxFrame(back), "and in the other direction");

  // ---- do the reported scores match the published table? ------------------
  {
    const finalCells = a.snapshot();
    let expected = [0, 0];
    for (const f of flagged) {
      const byte = finalCells[f.y * 16 + f.x];
      const isMine = (byte & MINE) !== 0 && (byte & REVEALED) !== 0;
      expected[f.by] += isMine ? 1 : -1;
    }
    console.log(`  -- ${flagged.length} flags placed; expected flag points ` +
                `${expected[0]}/${expected[1]} from the revealed board`);
    // The reported total also contains the bomb penalty, so compare the
    // DIFFERENCE from what the old rules alone would have produced.
    console.log(`  -- server reported scores ${reported[0]}/${reported[1]}`);
    const total = reported[0] + reported[1];
    const bombPenalty = -(40 - 1);
    eq(total, bombPenalty + expected[0] + expected[1],
       "total score = bomb penalty + the flag points implied by the final board");
  }

  // ---- the idle guard releases a player who truly leaves ------------------
  // Opt-in, because against the real 90 s constant it would take 90 s. Run it
  // against a server built with a short IDLE_DISCONNECT_SECONDS:
  //   IDLE_GUARD_TEST_MS=9000 node test/mp.e2e.mjs
  if (process.env.IDLE_GUARD_TEST_MS) {
    const quiet = Number(process.env.IDLE_GUARD_TEST_MS);
    console.log(`  -- going completely silent for ${(quiet / 1000).toFixed(0)}s`);
    let aClosed = false, bClosed = false;
    a.ws.on("close", () => { aClosed = true; });
    b.ws.on("close", () => { bClosed = true; });
    await settle(quiet);
    ok(aClosed && bClosed,
      `a player who sends nothing at all is released (a=${aClosed} b=${bClosed}) - ` +
      "so a half-open socket cannot hold a match forever");
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  // ---- the window outlives the old 20 s deadline --------------------------
  const WAIT_MS = Number(process.env.REMATCH_WAIT_TEST_MS ?? 25000);
  console.log(`  -- idling ${(WAIT_MS / 1000).toFixed(0)}s on the end screen (old limit was 20s)`);
  const pinger = setInterval(() => {
    a.send(MSG.PING, new Uint8Array(0));
    b.send(MSG.PING, new Uint8Array(0));
  }, 5000);
  await settle(WAIT_MS);
  clearInterval(pinger);

  // Asking for a rematch is also announced in chat, so the opponent sees it
  // without having to watch the prompt line. The clients send a normal CHAT
  // alongside the request, which is why this needs no server support.
  a.frames.length = 0; b.frames.length = 0;
  a.send(MSG.REQUEST_REMATCH, new Uint8Array(0));
  const rematchLine = coreA.core_in_ptr();
  new Uint8Array(coreA.memory.buffer).set(new TextEncoder().encode("wants a rematch\0"), rematchLine);
  a.send(MSG.CHAT, packed(coreA, coreA.core_pack_chat(rematchLine)));
  const announce = await b.expect(MSG.CHAT_RECV, 5000);
  ok(b.rxFrame(announce), "the rematch request is announced in chat");
  eq(readName(coreB, coreB.core_chat_text()), "wants a rematch",
     "...and the opponent receives the announcement");

  b.send(MSG.REQUEST_REMATCH, new Uint8Array(0));
  const againA = await a.expect(MSG.MATCH_START, 6000);
  const againB = await b.expect(MSG.MATCH_START, 6000);
  ok(a.rxFrame(againA) && b.rxFrame(againB),
    `rematch still accepted after ${(WAIT_MS / 1000).toFixed(0)}s - the 20s window is gone`);

  // ---- identity: the same UUID with a different secret is refused ---------
  // This is the property the whole UUID+secret design exists for. Without it
  // anyone could post scores as anyone else once rankings arrive.
  {
    const impostor = new Client("Impostor", await newCore());
    await impostor.opened;
    const stolen = { uuid: identA.uuid, secret: new Uint8Array(32) };  // wrong secret
    impostor.send(MSG.HELLO, impostor.packHello("NotAlice", 1, 1, stolen));
    const err = await impostor.expect(MSG.ERROR, 5000);
    ok(impostor.rxFrame(err), "a stolen UUID is answered with an error");
    eq(impostor.core.core_err_code(), 9, "...specifically ERR_IDENTITY_MISMATCH");
    impostor.close();
  }

  // The rightful owner, with the right secret, is still welcome.
  {
    const again = new Client("Alice", await newCore());
    await again.opened;
    again.send(MSG.HELLO, again.packHello("Alice renamed", 3, 5, identA));
    const w = await again.expect(MSG.WELCOME, 5000);
    ok(again.rxFrame(w), "the same identity reconnects fine, under a different name");
    again.close();
  }

  a.close();
  b.close();
} catch (e) {
  fail++;
  console.error("  FAIL", e.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
