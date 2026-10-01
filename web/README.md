# asciisweeper — WebGL browser client

The same game as the terminal client, drawn with WebGL instead of ncurses: the
same glyphs, the same 16-colour palette, the same centred 2-columns-per-cell
board. Not a graphical reimagining — a character grid on the GPU.

**The C is untouched.** `src/` and `CMakeLists.txt` are byte-for-byte what the
terminal game builds from. `board.c` and `net_io.c` are compiled *as they are*
to wasm, so the Minesweeper rules and the wire protocol are defined exactly once
for the terminal client, the server and the browser.

## Build

```sh
./build-web.sh            # -> web/dist/   (needs only Node)
./build-web.sh --serve    # dev server with HMR
./build-web.sh --test     # typecheck + 637 tests
./build-web.sh --wasm     # rebuild core.wasm (needs the wasm toolchain)
```

`web/dist/` is static files with no runtime — copy it into a docroot and
single-player works. Asset paths are relative, so it runs unchanged at a domain
root or in a subdirectory like `/games/sweeper/`.

`web/wasm/core.wasm` is committed, so the ordinary build needs no C toolchain.
It is only needed when the C sources change, and `build-web.sh` refuses to build
a stale one rather than let the browser play by different rules than the C.

### The wasm toolchain

```sh
brew install llvm lld wasi-libc wasi-runtimes     # ~79 MB
```

A monolithic `wasi-sdk` at `$WASI_SDK`, `/opt/wasi-sdk` or `~/.wasi-sdk` is also
recognised. Nothing is downloaded automatically.

## How the C compiles unchanged

`net_io.c` mixes the pure wire codec — which the browser needs — with five TLS
framing functions, which it does not. The TLS half touches exactly nine OpenSSL
symbols, all above line 106; everything from 107 down is pure.

So instead of splitting the file, `web/core/shim/openssl/ssl.h` declares those
nine for the wasm build only. `net_io.c` then compiles untouched, and the linker
discards the framing functions because nothing exported reaches them. See the
comment at the top of that header.

`web/core/core_api.c` is the only new C: a thin export surface over `board.c` and
the codec. It holds one static `Board` (so the module needs no allocator) and
bounds-checks every coordinate, which `board.c` deliberately does not — the
terminal client guards with its cursor, but a browser has a mouse.

The module needs **no wasm imports at all**; `--test` asserts that.

## Multiplayer

Browsers cannot open raw TCP or TLS sockets, so `web/bridge/bridge.mjs` relays
bytes between a WebSocket and `asciisweeper-server`. It is a dumb byte pipe that
never parses the protocol, which is why `server.c` needs no changes and why a
browser player and a terminal player can share a match.

```
browser --wss--> Caddy/nginx --ws (loopback)--> bridge --TLS (pinned)--> asciisweeper-server:4443
```

The proxy terminates TLS for both the site and `/ws` with the certificate you
already have, so the bridge does none itself. Upstream it pins the game server's
certificate with `--ca`, exactly as the native client does — the job a browser
cannot do, since it cannot pin a CA.

Because the site and the bridge are same-origin, the client derives
`wss://host/ws` from `location`; there is no address to type. See `deploy/` for a
Caddyfile, an nginx snippet and a systemd unit.

**One deployment trap:** nginx's default `proxy_read_timeout` is 60s, shorter
than the server's own 90s idle disconnect. A turn-based game is quiet by design,
so an opponent thinking for a minute would be dropped for no reason. The examples
in `deploy/` set it generously.

### Local testing

```sh
# terminal 1 — the game server, self-signed cert as in the main README
./build/asciisweeper-server --cert server.crt --key server.key --port 4443

# terminal 2 — the bridge, plaintext on loopback, pinning that cert
node web/bridge/bridge.mjs --listen 8080 --upstream 127.0.0.1:4443 --ca server.crt

# terminal 3 — the client
./build-web.sh --serve
```

Then open the dev server and set the multiplayer URL to `ws://127.0.0.1:8080/ws`
(the field is an override; the default assumes the bridge is same-origin).

## What differs from the terminal game

Faithful everywhere except these, which a browser forces or obviously wants:

- **Mouse**, which the terminal game has not got. Mapped onto the existing visual
  language so no new glyph appears: hovering moves the cursor, so the cursor
  highlight *is* the hover indicator. Left = reveal/chord, right = flag, middle =
  chord. Touch: tap reveals, long-press flags.
- **Resize works.** `game_init` computes the centring once and `main.c` never
  handles `SIGWINCH`, so the terminal game does not recentre mid-game. This does.
- **Text entry** uses an in-grid line editor rather than `echo()`/`getnstr`. It is
  the chat composer from `main.c:907-932`, extracted so prompts and chat share it.
- **No CA-file prompt**, since a browser cannot pin a CA. The bridge does it.
- `q` cannot exit a tab, so it shows a farewell screen.

## Fidelity status

> **The palette is still the xterm defaults, not sampled from a real terminal.**

`setup_colors` names only the 8 base ANSI colours and calls
`use_default_colors()`, so the actual RGB never existed in the repo — it came
from whatever terminal the game was run in. Until those are sampled from a
screenshot, the colours are approximately right rather than exactly right. The
two that matter most, because they dominate the screen:

- `ansi[4]`, dim blue — `CP_EMPTY` paints every revealed cell in it.
- `ansi[6]`, dim cyan — `CP_HIDDEN` draws every `.` in it, and **not** bold, so a
  bright cyan here reads instantly as a different game.

Open `#testcard` in the URL for every glyph in every pair, bold and not, which is
the pattern to compare against a screenshot. Everything is in
`web/src/term/palette.ts`; `baseCell` in the config controls the cell aspect
ratio, which is what keeps the board's proportions right.

## Layout

```
web/
  core/core_api.c            the wasm export surface
  core/shim/openssl/ssl.h    fake header; see "How the C compiles unchanged"
  wasm/core.wasm             committed build artifact + core.hash
  src/core.ts                the only module that talks to wasm
  src/proto.ts               constants mirrored from net_proto.h / board.h
  src/term/surface.ts        the ncurses shim (~12 calls is all main.c uses)
  src/term/webgl.ts          one draw call: a cell texture and a fullscreen quad
  src/term/atlas.ts          glyph atlas, rebuilt on DPR/scale change
  src/term/palette.ts        16 ANSI + the two values ncurses leaves unspecified
  src/draw/*.ts              ports of main.c's draw functions, kept diffable
  src/game/*.ts              ports of play_game / play_multiplayer, as state machines
  src/net/wsconn.ts          WebSocket + protocol frame reassembly
  bridge/bridge.mjs          WebSocket -> TLS byte pipe
  deploy/                    Caddyfile, nginx snippet, systemd unit
  test/                      637 tests, no browser or GPU needed
```

Each `draw/` function is a near-transliteration of its C original and names it in
a comment, so the two can be read side by side — that is how fidelity gets
reviewed rather than eyeballed.
