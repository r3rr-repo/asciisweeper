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
./build-web.sh --serve  # dev server, for playing locally
./build-web.sh --test   # typecheck + 637 tests
```

**The C is not modified for it.** `src/` and `CMakeLists.txt` are exactly what
the terminal game builds from; [`src/board.c`](src/board.c) and
[`src/net_io.c`](src/net_io.c) are compiled *as they are* to WebAssembly, so the
rules and the wire protocol stay defined once for all three programs. The only
trick is a fake `<openssl/ssl.h>` on the wasm build's include path, which lets
`net_io.c` compile without its five TLS framing functions — see
[`web/README.md`](web/README.md).

### Requirements

Building the browser client needs **Node 18+** and nothing else:
`web/wasm/core.wasm` is committed, so the WebAssembly toolchain is only needed if
you change the C it is built from. If you do, `build-web.sh` says so and stops
rather than shipping a stale one, and you will want:

```sh
# macOS / Linuxbrew, ~79 MB:
brew install llvm lld wasi-libc wasi-runtimes

# Anywhere else, including FreeBSD: unpack a wasi-sdk release and point
# $WASI_SDK at it (/opt/wasi-sdk and ~/.wasi-sdk are also searched).
export WASI_SDK=/opt/wasi-sdk
```

`build-web.sh` finds either layout, and tells you how to install one if it finds
neither. It never downloads anything itself.

## Hosting the browser version

Single-player is pure static files. Multiplayer additionally needs one small
process on the same host as `asciisweeper-server`, because browsers cannot open
raw TLS sockets. The game server itself is **not** modified, reconfigured or
restarted — same binary, same port, same certificate.

[`web/deploy/README.md`](web/deploy/README.md) is the fuller reference, with a
troubleshooting table. The steps below are the whole job.

The paths differ by OS; adjust as you read:

| | Linux | FreeBSD |
|---|---|---|
| Repo checkout | `/opt/asciisweeper` | `/usr/local/share/asciisweeper` |
| Docroot | `/var/www/sweeper` | `/usr/local/www/sweeper` |
| `node` | `/usr/bin/node` | `/usr/local/bin/node` |
| nginx config | `/etc/nginx/` | `/usr/local/etc/nginx/` |
| Service | systemd unit | `rc.d` script |
| Unprivileged user | often `www-data` | `www` |

### 1. Build, on your workstation

```sh
./build-web.sh
```

That produces `web/dist/` — three files, about 60 KB in total:

```
index.html                 3.8 KB
assets/index-<hash>.js      46 KB   client, renderer and the ncurses shim
assets/core-<hash>.wasm     11 KB   board.c + net_io.c
```

Asset paths are relative, so it works at a domain root or in a subdirectory like
`/games/sweeper/`. No font is bundled: the glyph atlas is rasterised at runtime
from a system monospace font, so the exact typeface follows the viewer's machine
(`Menlo` and `SF Mono` first, then generic fallbacks).

### 2. Copy the static files to the docroot

```sh
rsync -av --delete web/dist/ youruser@yourhost:/var/www/sweeper/
```

Copy **`web/dist/`, not `web/`**. The source tree needs a bundler — browsers
cannot execute TypeScript — so serving `web/` as static files cannot work. (It
will tell you so if you try it.)

Single-player works at this point. Everything below is for multiplayer.

### 3. Serve it, and serve `.wasm` correctly

Any static web server will do. The one thing to check is that `.wasm` is sent as
`application/wasm`; Caddy already does, and older nginx needs:

```nginx
types { application/wasm wasm; }
```

Without it the page still works, via a slower fallback path.

### 4. Put the bridge on the server host

```sh
ssh youruser@yourhost

# Node 18+ and npm, if not already present:
#   Debian/Ubuntu:  sudo apt install nodejs npm
#   FreeBSD:        sudo pkg install node npm

cd /opt/asciisweeper && git pull origin main      # or /usr/local/share/asciisweeper
cd web && npm ci --omit=dev                      # installs exactly one package: ws
```

Vite and TypeScript are devDependencies and are deliberately not installed on a
server. Run this from inside `web/`, not with `npm --prefix web`, which resolves
against the current directory.

### 5. Choose the bridge's upstream TLS flags

**This is the step that bites.** Node verifies the game server's certificate
against `servername || host`, so connecting to `127.0.0.1` without `--servername`
checks the certificate against the *IP address* — which a certificate issued for
a domain name does not cover. Passing `--ca` does not help; the identity check
still uses the host.

| The game server's certificate is... | Flags |
|--------------------------------------|-------|
| Issued for a domain (Let's Encrypt)  | `--upstream 127.0.0.1:4443 --servername yourdomain.com` |
| Signed by a private CA               | `--upstream 127.0.0.1:4443 --servername <name in cert> --ca /path/ca.pem` |
| Self-signed **with** `IP:127.0.0.1` in its SANs | `--upstream 127.0.0.1:4443 --ca /path/server.crt` |

With a publicly valid certificate, `--ca` is unnecessary — the system trust store
covers it. The bridge prints a note at startup if it sees an IP upstream with no
`--servername`.

### 6. Install the service

The bridge binds to loopback only in both cases; the reverse proxy reaches it
locally, so nothing new is exposed to the internet.

**Linux, systemd:**

```sh
sudo cp web/deploy/asciisweeper-bridge.service /etc/systemd/system/
sudoedit /etc/systemd/system/asciisweeper-bridge.service   # User, paths, step-5 flags
sudo systemctl daemon-reload
sudo systemctl enable --now asciisweeper-bridge
systemctl status asciisweeper-bridge
```

**FreeBSD, rc.d:**

```sh
sudo install -m 555 web/deploy/asciisweeper-bridge.rc \
  /usr/local/etc/rc.d/asciisweeper_bridge

sudo sysrc asciisweeper_bridge_enable="YES"
sudo sysrc asciisweeper_bridge_servername="yourdomain.com"   # from step 5

sudo service asciisweeper_bridge start
sudo service asciisweeper_bridge status
```

Everything is configurable through `rc.conf` rather than by editing the script —
`sysrc asciisweeper_bridge_ca=...`, `_upstream`, `_listen`, `_bind`, `_user`,
`_dir`, `_node`, `_logfile`. Run `service asciisweeper_bridge start` once by hand
before relying on it: the script checks that `node` and `bridge.mjs` are where it
expects and fails with a clear message if not. Output goes to
`/var/log/asciisweeper-bridge.log`, and `daemon(8)` restarts the bridge if it
exits.

Anything else — runit, s6, OpenRC, a supervisor of your choice, or just a
`tmux` session while you try it out — only needs to run this, as an unprivileged
user:

```sh
node /path/to/web/bridge/bridge.mjs --bind 127.0.0.1 --listen 8080 \
  --upstream 127.0.0.1:4443 --servername yourdomain.com
```

It stays in the foreground, logs to stdout, and exits on `SIGTERM`/`SIGINT`.

### 7. Route `/ws` through the reverse proxy

Copy the relevant part of
[`web/deploy/Caddyfile.example`](web/deploy/Caddyfile.example) or
[`web/deploy/nginx.conf.example`](web/deploy/nginx.conf.example). Two things have
to be right:

- **`/ws` is matched before the static file handler**, or the WebSocket upgrade
  gets served as a 404.
- **The read timeout is generous.** nginx defaults `proxy_read_timeout` to 60s,
  which is *shorter* than the game server's own 90s idle disconnect — and a
  turn-based game sends nothing at all while someone is thinking. Without a
  longer timeout, an opponent who takes a minute gets dropped for no reason. The
  examples set 1h; Caddy has no read timeout by default, which is what you want.

```sh
# Linux
sudo nginx -t && sudo systemctl reload nginx
# FreeBSD
sudo nginx -t && sudo service nginx reload
# Caddy, either
caddy validate --config /path/to/Caddyfile && sudo service caddy reload
```

### 8. Verify

```sh
# on the host - the bridge is up
curl -s http://127.0.0.1:8080/healthz                              # -> ok

# from anywhere - TLS and the static files
curl -s -o /dev/null -w '%{http_code}\n' https://yourdomain.com/   # -> 200

# the real proof: two clients through the deployed bridge into the deployed
# server, speaking the actual protocol
BRIDGE_URL=wss://yourdomain.com/ws node web/test/mp.e2e.mjs        # -> 34 passed
```

Watch the bridge while testing with
`journalctl -u asciisweeper-bridge -f`. A healthy connection logs
`open from <ip>` then `upstream connected`. If you see
`Hostname/IP does not match certificate's altnames`, go back to step 5.

Players do not have to type an address: the client derives `wss://host/ws` from
the page's own origin, so the multiplayer menu asks only for a name. Because
matchmaking is FIFO and client-agnostic, a browser player and a terminal player
are paired with each other and play the same board.

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
