/*
 * Server robustness probes: what a stranger can do to asciisweeper-server
 * without ever playing a game.
 *
 * Unlike web/test/mp.e2e.mjs, which drives correct clients through the bridge,
 * this talks raw TLS and misbehaves on purpose. It owns the server process, so
 * it can report HOW the server died - the exit signal is the evidence.
 *
 *   node test/server_probe.mjs                 # builds nothing; needs the binary
 *   SERVER_BIN=... ITERATIONS=500 node test/server_probe.mjs
 *   PROBES=3 node test/server_probe.mjs        # one probe on its own
 *
 * Probe 3 needs the server built with -fsanitize=address to be conclusive.
 *
 * Invoked by `cmake --build build --target probe-test`.
 *
 * Two probes:
 *
 * 1. VANISHING PEER. Connect, send a HELLO the server must reject, read the
 *    rejection, then RST the socket. The server writes again after that - the
 *    close_notify from SSL_shutdown in connection_free - and a write to a reset
 *    socket raises SIGPIPE, whose default disposition kills the whole process
 *    and every match in it. One stranger, every game.
 *
 * 2. STALLED PEER. Two clients in a match; one stops reading until the server's
 *    write to it blocks (SO_SNDTIMEO is 10s), then RSTs. The blocked write
 *    returns EPIPE, which is the same SIGPIPE with a window of seconds instead
 *    of microseconds - deterministic where probe 1 is a race.
 *
 * 3. LEAVING A FINISHED MATCH. Play to a finish, then one player drops while
 *    the other is still on the end screen and chats. Only the mid-match
 *    disconnect path used to clear m->conns[], so a match that ended normally
 *    left the slot pointing at a connection its owner was about to free, and
 *    the remaining player's chat relay would write through it.
 *
 *    This one is a guard rather than a demonstration: it was written for a bug
 *    found by reading, and it has never been seen to fail. Showing it fail
 *    needs an -fsanitize=address build, and such a build predating the
 *    write_lock often cannot finish a match at all - probe 4's race fires
 *    first. It stands here so the invariant stays true.
 *
 * 4. CONCURRENT WRITES. Two clients in one match, both spamming chat and pings.
 *    Chat is relayed by the SENDER's thread straight into the recipient's SSL
 *    (relay_chat, src/server.c), while that recipient's own thread is writing
 *    PONGs to the same SSL. Two threads, one SSL object, no write mutex:
 *    OpenSSL raises "tlsv1 alert internal error". web/test/mp.e2e.mjs documents
 *    tripping this and was made strictly turn-by-turn to avoid it.
 */
import net from "node:net";
import tls from "node:tls";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const SERVER_BIN = process.env.SERVER_BIN ?? join(repo, "build", "asciisweeper-server");
const PORT = Number(process.env.PORT ?? 14443);
const ITERATIONS = Number(process.env.ITERATIONS ?? 300);
const CHAT_ROUNDS = Number(process.env.CHAT_ROUNDS ?? 400);
/* Which probes to run, e.g. PROBES=3. An earlier probe that kills the server
 * stops the ones after it, so selecting is how you reach a later one on a
 * build that still has an earlier bug. */
const WANTED = (process.env.PROBES ?? "1,2,3,4").split(",").map(Number);
const wanted = (n) => WANTED.includes(n);

const PROTO_VERSION = 6; // src/net_proto.h NET_PROTO_VERSION
const MSG = {
  HELLO: 0x01, ACTION_REVEAL: 0x03, PING: 0x06, CHAT: 0x07,
  WELCOME: 0x81, QUEUE_STATUS: 0x82, MATCH_START: 0x83, BOARD_STATE: 0x84,
  TURN: 0x85, OPPONENT_STATUS: 0x86, MATCH_END: 0x87, ERROR: 0x88,
  PONG: 0x8a, CHAT_RECV: 0x8b,
};
const NAME = Object.fromEntries(Object.entries(MSG).map(([k, v]) => [v, k]));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`); } else { fail++; console.error(`  FAIL ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- protocol ---- */

const frame = (type, payload = Buffer.alloc(0)) => {
  const h = Buffer.alloc(3);
  h[0] = type;
  h.writeUInt16BE(payload.length, 1);
  return Buffer.concat([h, payload]);
};

/* UUIDv7 as src/uuid.c builds it, and as uuid_is_v7 checks it: 48-bit
 * big-endian millisecond timestamp, version nibble 7, variant bits 10. */
function uuidV7() {
  const u = Buffer.alloc(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) u[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  for (let i = 6; i < 16; i++) u[i] = Math.floor(Math.random() * 256);
  u[6] = (u[6] & 0x0f) | 0x70;
  u[8] = (u[8] & 0x3f) | 0x80;
  return u;
}

/* pack_hello: version u8, name[16], skin u8, hair u8, uuid[16], secret[32] */
function helloPayload(name, { version = PROTO_VERSION, id } = {}) {
  const b = Buffer.alloc(1 + 16 + 1 + 1 + 16 + 32);
  b[0] = version;
  Buffer.from(name).copy(b, 1, 0, Math.min(16, Buffer.byteLength(name)));
  b[17] = 3;
  b[18] = 5;
  (id?.uuid ?? uuidV7()).copy(b, 19);
  (id?.secret ?? Buffer.alloc(32, 7)).copy(b, 35);
  return b;
}

/* ---- a deliberately rude client ---- */

class Peer {
  constructor() {
    this.rx = Buffer.alloc(0);
    this.frames = [];
    this.waiters = [];
    this.errors = [];
    /* The TCP socket is created separately so resetAndDestroy() is available:
     * a TLSSocket wraps it, and only the raw socket can send RST. */
    this.raw = new net.Socket();
    this.tls = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.raw.connect(PORT, "127.0.0.1", () => {
        this.tls = tls.connect({ socket: this.raw, rejectUnauthorized: false }, resolve);
        this.tls.on("data", (d) => this.absorb(d));
        this.tls.on("error", (e) => this.errors.push(e));
        this.raw.on("error", (e) => this.errors.push(e));
      });
      this.raw.once("error", reject);
      setTimeout(() => reject(new Error("connect timed out")), 5000);
    });
  }

  absorb(chunk) {
    this.rx = Buffer.concat([this.rx, chunk]);
    for (;;) {
      if (this.rx.length < 3) break;
      const len = this.rx.readUInt16BE(1);
      if (this.rx.length < 3 + len) break;
      const f = { type: this.rx[0], payload: this.rx.subarray(3, 3 + len) };
      this.rx = this.rx.subarray(3 + len);
      this.frames.push(f);
      this.waiters.splice(0).forEach((w) => w());
    }
  }

  send(type, payload) {
    if (this.tls?.writable) this.tls.write(frame(type, payload));
  }

  async expect(type, ms = 5000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.frames.findIndex((f) => f.type === type);
      if (i >= 0) return this.frames.splice(i, 1)[0];
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${NAME[type] ?? type}`);
      await Promise.race([
        new Promise((r) => this.waiters.push(r)),
        sleep(Math.min(100, Math.max(1, deadline - Date.now()))),
      ]);
    }
  }

  /** RST, not FIN: every later write by the server fails rather than being
   *  quietly discarded, which is the whole point of the probe. */
  reset() {
    try { this.raw.resetAndDestroy(); } catch { this.raw.destroy(); }
  }

  close() { try { this.tls?.end(); this.raw.destroy(); } catch { /* going away anyway */ } }
}

/* ---- the server under test ---- */

function makeCert(dir) {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
    "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  return { cert: join(dir, "c.pem"), key: join(dir, "k.pem") };
}

function startServer({ cert, key }) {
  const p = spawn(SERVER_BIN, ["--cert", cert, "--key", key, "--port", String(PORT)],
                  { stdio: ["ignore", "pipe", "pipe"] });
  const s = { proc: p, log: "", exit: null };
  p.stderr.on("data", (d) => { s.log += d; });
  p.stdout.on("data", (d) => { s.log += d; });
  p.on("exit", (code, signal) => { s.exit = { code, signal }; });
  s.ready = new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (s.log.includes("listening on port")) { clearInterval(t); resolve(); }
      if (s.exit) { clearInterval(t); reject(new Error(`server exited at startup: ${s.log}`)); }
    }, 20);
    setTimeout(() => { clearInterval(t); reject(new Error("server never reported listening")); }, 5000);
  });
  return s;
}

const describeExit = (e) =>
  e.signal ? `killed by ${e.signal}` : `exited with status ${e.code}`;

/* ---- probe 1 ---- */

async function probeVanishingPeer(server) {
  console.log(`\n== probe 1: ${ITERATIONS} peers that vanish mid-write ==`);
  let completed = 0;

  for (let i = 1; i <= ITERATIONS; i++) {
    if (server.exit) break;
    const p = new Peer();
    try {
      await p.connect();
      /* A version the server must reject, so it answers and then tears the
       * connection down - two chances to write to a peer that is already gone. */
      p.send(MSG.HELLO, helloPayload("prober", { version: 255 }));
      await p.expect(MSG.ERROR, 2000);
      p.reset();
      completed++;
    } catch {
      /* A failure here is the server already being gone; the exit check below
       * is what reports it. */
      p.reset();
    }
    /* Let the server reach connection_free (and its SSL_shutdown write) while
     * our RST is in flight. */
    await sleep(1);
  }

  if (server.exit) {
    ok(false, `server died after ${completed} probes: ${describeExit(server.exit)}`);
    if (server.exit.signal === "SIGPIPE")
      console.error("       ^ SIGPIPE: an unhandled write to a closed socket, as expected");
    return false;
  }

  ok(true, `survived ${completed} vanishing peers`);

  /* Still actually serving, not merely still running. */
  const after = new Peer();
  try {
    await after.connect();
    after.send(MSG.HELLO, helloPayload("after"));
    await after.expect(MSG.WELCOME, 3000);
    ok(true, "still accepting and welcoming new players afterwards");
  } catch (e) {
    ok(false, `no longer serving after the probes: ${e.message}`);
  }
  after.close();
  return true;
}

/* ---- probe 2 ---- */

/*
 * Probe 1 needs the RST to land inside the microseconds between the server's
 * reply and its close_notify. This widens that window to seconds: stop reading
 * until the server's socket buffer to us is full and its thread is parked in
 * write(), and only then RST. The parked write is what fails.
 */
async function probeStalledPeer(server) {
  console.log(`\n== probe 2: a peer that stops reading, then resets ==`);

  const a = new Peer(), b = new Peer();
  try {
    await a.connect();
    await b.connect();
    a.send(MSG.HELLO, helloPayload("Chatter"));
    b.send(MSG.HELLO, helloPayload("Deaf"));
    await a.expect(MSG.WELCOME);
    await b.expect(MSG.WELCOME);
    await a.expect(MSG.MATCH_START, 10000);
    await b.expect(MSG.MATCH_START, 10000);
  } catch (e) {
    ok(false, `could not set up a match: ${e.message}`);
    a.close(); b.close();
    return;
  }

  /* From here B reads nothing, so everything the server relays to it piles up
   * in the kernel buffers until they are full. */
  b.tls.pause();
  b.tls.removeAllListeners("data");

  /* Each chat line is relayed to B by A's thread. Enough of them to overflow
   * a loopback socket buffer, which can be generous. */
  const line = Buffer.alloc(120, 0x61);
  for (let i = 0; i < 40000; i++) {
    if (server.exit) break;
    a.send(MSG.CHAT, line);
    if (i % 2000 === 0) await sleep(1);   // let the server drain our side
  }
  await sleep(250);

  if (server.exit) {
    ok(false, `server died while writing to a stalled peer: ${describeExit(server.exit)}`);
    return;
  }

  /* A's thread should now be parked writing to B. Pull the floor out. */
  b.reset();
  await sleep(500);

  if (server.exit) {
    ok(false, `server died when the stalled peer reset: ${describeExit(server.exit)}`);
    if (server.exit.signal === "SIGPIPE")
      console.error("       ^ SIGPIPE: the parked write failed, killing every match on the server");
    return;
  }

  ok(true, "survived a stalled peer resetting mid-write");

  try {
    a.send(MSG.PING);
    await a.expect(MSG.PONG, 3000);
    ok(true, "the other player's connection survived it too");
  } catch (e) {
    ok(false, `the other player was taken down with it: ${e.message}`);
  }
  a.close();
  b.close();
}

/* ---- probe 3 ---- */

/*
 * Drives a real match to its end, then has the loser vanish while the winner
 * is still chatting on the end screen. Build the server with
 * -fsanitize=address to make the dangling slot fatal rather than merely
 * usually-harmless.
 */
async function probeLeaveFinishedMatch(server) {
  console.log(`\n== probe 3: a player who leaves a finished match ==`);

  const a = new Peer(), b = new Peer();
  try {
    await a.connect();
    await b.connect();
    a.send(MSG.HELLO, helloPayload("Stayer"));
    b.send(MSG.HELLO, helloPayload("Leaver"));
    await a.expect(MSG.WELCOME);
    await b.expect(MSG.WELCOME);
    await a.expect(MSG.MATCH_START, 10000);
    await b.expect(MSG.MATCH_START, 10000);
  } catch (e) {
    ok(false, `could not set up a match: ${e.message}`);
    a.close(); b.close();
    return;
  }

  /* Reveal cells until somebody hits a mine. Both sides try each round and the
   * one that is out of turn just gets an error back, which saves tracking
   * whose turn it is. 16x16 with 40 mines ends this quickly. */
  const ended = () => a.frames.some((f) => f.type === MSG.MATCH_END) ||
                       b.frames.some((f) => f.type === MSG.MATCH_END);
  let x = 0, y = 0;
  for (let i = 0; i < 256 && !ended(); i++) {
    const at = Buffer.from([x, y]);
    a.send(MSG.ACTION_REVEAL, at);
    b.send(MSG.ACTION_REVEAL, at);
    if (++x >= 16) { x = 0; y++; }
    if (y >= 16) break;
    /* Unhurried on purpose: a server built with sanitizers is slow enough that
     * a tighter loop outruns it and the reveals come back rejected. */
    await sleep(30);
  }
  if (!ended()) {
    ok(false, "could not drive the match to an end");
    a.close(); b.close();
    return;
  }
  ok(true, "played a match through to MATCH_END");

  /* The loser goes away. Its thread returns from handle_connection and frees
   * its Connection - while the match slot may still point at it. */
  b.reset();
  await sleep(300);

  /* Now make the remaining player use that slot: a chat relay reads
   * m->conns[the other slot] and writes through it. */
  for (let i = 0; i < 20; i++) {
    const line = Buffer.alloc(120);
    Buffer.from(`still here ${i}`).copy(line);
    a.send(MSG.CHAT, line);
    await sleep(25);
  }
  await sleep(300);

  if (server.exit) {
    ok(false, `server died after a player left a finished match: ${describeExit(server.exit)}`);
    return;
  }
  ok(true, "survived a player leaving a finished match");

  /* Nothing is asserted about the stayer's own session: its opponent left, so
   * the match is over and being returned to the menu is correct. What matters
   * is that the PROCESS is healthy, which a fresh connection proves. */
  a.close();
  const fresh = new Peer();
  try {
    await fresh.connect();
    fresh.send(MSG.HELLO, helloPayload("after3"));
    await fresh.expect(MSG.WELCOME, 3000);
    ok(true, "the server still serves new players afterwards");
  } catch (e) {
    ok(false, `the server stopped serving: ${e.message}`);
  }
  fresh.close();
}

/* ---- probe 4 ---- */

/*
 * Forces the two-threads-one-SSL collision rather than waiting for it. Spamming
 * chat from both sides does trip it, but only about one run in three - too
 * flaky to detect a regression. Scaling out to more matches is not available
 * either: MAX_QUEUED_PER_IP is 4, so one address can hold two matches. So widen
 * the window instead:
 *
 *   - B stops reading, so the server's socket buffer to B fills and A's thread
 *     PARKS inside SSL_write on B's SSL (SO_SNDTIMEO gives it 10s there).
 *   - B then pings. B's own thread answers with a PONG on that same SSL, while
 *     A's thread is still inside a write to it.
 *
 * Two threads inside SSL_write on one SSL object mangles the record stream, and
 * B sees it as a decrypt failure the moment it reads again.
 */
async function probeConcurrentWrites(server) {
  console.log(`\n== probe 4: two threads writing one SSL ==`);

  const a = new Peer(), b = new Peer();
  try {
    await a.connect();
    await b.connect();
    a.send(MSG.HELLO, helloPayload("Writer"));
    b.send(MSG.HELLO, helloPayload("Target"));
    await a.expect(MSG.WELCOME);
    await b.expect(MSG.WELCOME);
    await a.expect(MSG.MATCH_START, 10000);
    await b.expect(MSG.MATCH_START, 10000);
    ok(true, "two raw-TLS clients were matched");
  } catch (e) {
    ok(false, `could not set up a match: ${e.message}`);
    a.close(); b.close();
    return;
  }

  b.tls.pause();
  b.tls.removeAllListeners("data");

  /* Park A's thread in a write to B: enough relayed chat to overflow the socket
   * buffers, but no more, so that resuming B drains quickly. */
  const line = Buffer.alloc(120, 0x62);
  for (let i = 0; i < 8000; i++) {
    if (server.exit) break;
    a.send(MSG.CHAT, line);
    if (i % 1000 === 0) await sleep(1);
  }
  await sleep(400);

  /* ...and now have B's own thread write to the very same SSL. */
  for (let i = 0; i < 50; i++) b.send(MSG.PING);
  await sleep(500);

  if (server.exit) {
    ok(false, `server died during concurrent writes: ${describeExit(server.exit)}`);
    return;
  }

  /* Read again and see whether the stream survived. */
  b.errors.length = 0;
  b.tls.on("data", (d) => b.absorb(d));
  b.tls.resume();
  await sleep(1500);

  /* The collision shows up one of two ways, so check for both: OpenSSL may
   * raise a decrypt/internal error on the mangled records, or the server's own
   * write may fail and drop the connection outright. */
  const corrupt = [...a.errors, ...b.errors]
    .map((e) => e.message)
    .filter((m) => /internal error|bad record mac|decrypt|wrong version|packet length/i.test(m));
  ok(corrupt.length === 0,
     corrupt.length ? `TLS stream corrupted: ${corrupt[0]}` : "the TLS stream survived concurrent writes");

  /* Serialized writes mean B's thread may have had to wait out A's parked
   * write before answering - that is the intended trade-off - so allow for it
   * generously. What must not happen is the connection being gone. */
  try {
    b.send(MSG.PING);
    await b.expect(MSG.PONG, 15000);
    ok(true, "the target connection still answers");
  } catch (e) {
    ok(false, `the target connection broke: ${e.message}`);
  }

  a.close();
  b.close();
}

/* ---- main ---- */

if (!existsSync(SERVER_BIN)) {
  console.error(`server binary not found at ${SERVER_BIN}`);
  console.error("build it first: cmake -S . -B build && cmake --build build");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "asciisweeper-probe-"));
const certs = makeCert(dir);
const server = startServer(certs);

try {
  await server.ready;
  console.log(`server up on 127.0.0.1:${PORT} (${SERVER_BIN})`);
  let alive = true;
  if (wanted(1)) alive = await probeVanishingPeer(server);
  if (alive && wanted(2)) { await probeStalledPeer(server); alive = !server.exit; }
  if (alive && wanted(3)) { await probeLeaveFinishedMatch(server); alive = !server.exit; }
  if (alive && wanted(4)) await probeConcurrentWrites(server);
} catch (e) {
  fail++;
  console.error("  FAIL", e.message);
} finally {
  if (!server.exit) server.proc.kill("SIGKILL");
  writeFileSync(join(dir, "server.log"), server.log);
  if (fail) console.log(`\nserver log: ${join(dir, "server.log")}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
