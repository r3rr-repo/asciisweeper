# asciisweeper

A classic game of Minesweeper, rendered entirely in ASCII as a terminal UI
(TUI) using `ncurses`. Centered board, colored numbers, flood-fill reveal,
flagging, chording, and a live timer — all in your terminal.

```
                                    ASCIISWEEPER

                                    Mines: 007        Time: 042
                                  +------------------+
                                  |1 1          1 1  |
                                  |. 1          1 . 1|
                                  |. 2 1      1 2 . 1|
                                  |. . 1      . 1 1  |
                                  |1 1 1      1 1     |
                                  |F . . 1 1 1 . .   |
                                  |. . . 1 F 1 . .   |
                                  |. . . 1 1 1 . .   |
                                  +------------------+

                     Move: arrows/hjkl  |  Reveal: space/enter  |  Flag: f
                        Chord: c  |  Restart: r  |  Menu: n  |  Quit: q
```

## Features

- Classic Minesweeper rules: flood-fill reveal of empty areas, numbered
  clues, flagging, and win/loss detection
- **First-click safety** — you'll never hit a mine on your first move
- **Chording** — reveal all neighbors of a satisfied number in one keypress
- Live mine counter and timer
- Beginner / Intermediate / Expert presets, plus a custom board size and
  mine count
- Board and menu automatically center in your terminal window
- Color-coded numbers, just like the original
- **Turn-based multiplayer** over TLS: queue up, get matched with an
  opponent, and take turns on a shared board (see below)

## Requirements

- CMake 3.16+ and a C compiler (`cc`/`gcc`/`clang`)
- `ncurses` development headers
  - macOS: included with Xcode Command Line Tools, or `brew install ncurses`
  - Debian/Ubuntu: `sudo apt install libncurses-dev`
  - Fedora: `sudo dnf install ncurses-devel`
- OpenSSL development headers (for multiplayer; the single-player game
  doesn't need them, but the client and server binaries link against them)
  - macOS: `brew install openssl`
  - Debian/Ubuntu: `sudo apt install libssl-dev`
  - Fedora: `sudo dnf install openssl-devel`

## Build & run

```sh
cmake -S . -B build
cmake --build build
./build/asciisweeper
```

This also builds `build/asciisweeper-server`, the multiplayer server binary.

## Controls

| Key(s)              | Action                                   |
|----------------------|-------------------------------------------|
| Arrow keys / `hjkl`  | Move the cursor                           |
| `Space` / `Enter`    | Reveal the selected cell                  |
| `f`                  | Flag / unflag the selected cell           |
| `c`                  | Chord: reveal neighbors of a satisfied number |
| `r`                  | Restart with the same settings            |
| `n`                  | Return to the menu                        |
| `q`                  | Quit                                      |

Reveal (`Space`/`Enter`) also chords automatically when used on an
already-revealed number.

## Difficulty presets

| Preset       | Size   | Mines |
|--------------|--------|-------|
| Beginner     | 9x9    | 10    |
| Intermediate | 16x16  | 40    |
| Expert       | 30x16  | 99    |
| Custom       | your choice | your choice |

## Multiplayer

Two players share one minefield and alternate turns. A turn is one reveal
or one chord; flagging is free and doesn't end your turn. If you click a
bomb, you lose `mines - 1` points and the match ends; if the board is
fully cleared without anyone hitting a bomb, both players gain `mines`
points. Multiplayer matches are fixed at Intermediate size (16x16, 40
mines).

**Run a server:**

```sh
./build/asciisweeper-server --cert fullchain.pem --key privkey.pem [--port 4443]
```

The server needs a real TLS certificate and key (e.g. from Let's Encrypt
for a public server, or a self-signed one for local testing — see below).
It matches players FIFO: the first two to queue up get paired together.

**Connect a client:** choose "Multiplayer..." from the menu and enter the
server's host, port, your name, and (optionally) a CA file. The CA file
lets you pin a specific certificate authority — useful for a self-hosted
server with a private CA, or for local testing — instead of relying on
the system's trust store. The client always verifies the server's
certificate; it never falls back to an unverified connection.

**Local testing** without a real certificate:

```sh
openssl req -x509 -newkey rsa:2048 -keyout server.key -out server.crt \
  -days 1 -nodes -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
./build/asciisweeper-server --cert server.crt --key server.key --port 4443
```

Then connect a client with host `127.0.0.1`, port `4443`, and `server.crt`
as the CA file.

If your connection drops mid-match, the client automatically tries to
reconnect using your session token for up to 60 seconds before giving up
and returning to the menu.

## Browser version

There is also a WebGL client that renders the same ASCII grid in a browser —
same glyphs, same palette, same centred board — with the same single-player and
multiplayer modes.

```sh
./build-web.sh          # -> web/dist/, static files, copy to a docroot
./build-web.sh --serve  # dev server
./build-web.sh --test   # typecheck + 637 tests
```

**The C is not modified for it.** `src/` and `CMakeLists.txt` are exactly what
the terminal game builds from; [`src/board.c`](src/board.c) and
[`src/net_io.c`](src/net_io.c) are compiled *as they are* to WebAssembly, so the
rules and the wire protocol stay defined once for all three programs. The only
trick is a fake `<openssl/ssl.h>` on the wasm build's include path, which lets
`net_io.c` compile without its five TLS framing functions — see
[`web/README.md`](web/README.md).

Multiplayer needs one extra process, because browsers cannot open raw TLS
sockets: [`web/bridge/bridge.mjs`](web/bridge/bridge.mjs) relays bytes between a
WebSocket and `asciisweeper-server`. It never parses the protocol, so the server
is unchanged and a browser player can be matched against a terminal player.

## How it works

The Minesweeper rules (board state, flood-fill reveal, flagging, chording,
win/loss detection) live in [`src/board.c`](src/board.c), shared by the
single-player game, the multiplayer client's rendering, and the server's
authoritative match state — so the rules are defined once, not
reimplemented. [`src/main.c`](src/main.c) is the ncurses client: the menu,
the single-player game loop, and the multiplayer game loop. Mines are
placed only after the first reveal, avoiding that cell and its neighbors,
so the opening move is always safe.

Multiplayer adds a simple binary wire protocol
([`src/net_proto.h`](src/net_proto.h), framed and (de)serialized in
[`src/net_io.c`](src/net_io.c)), a TLS client helper
([`src/client_net.c`](src/client_net.c)), and a standalone matchmaking
server ([`src/server.c`](src/server.c)) that holds the only authoritative
copy of the board — the client never runs reveal/flood-fill/chord logic
itself in multiplayer, it only renders whatever the server sends, which
rules out client/server desync by construction.
