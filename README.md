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
| `t`                  | Multiplayer only: chat, during a match and after it |
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
or one chord. Matches are fixed at Intermediate size (16x16, 40 mines).

**Flags score.** A flag is a claim that there is a bomb underneath, and you
are held to it when the match ends:

| | |
|---|---|
| Your flag was on a bomb | **+1** |
| Your flag was on an empty cell | **−1** |
| You reversed their flag and there was no bomb | **+2** |
| You reversed their flag and there *was* a bomb | **−2** to you, they still get **+1** |

Plus the outcome: hitting a bomb costs the player who clicked it
`mines - 1` and ends the match, and clearing the board gives both players
`mines`.

Two rules keep flags honest. You may only flag **on your turn** — though
flagging still doesn't end it, so you can mark the board up while you
think — and a cell **settles after one reversal**: once someone has
overruled a flag, that cell is frozen for the rest of the match. Taking
back your own flag is just a correction and scores nothing. Your flags
and your opponent's are drawn in different colours.

### Player identity

Every client generates a **UUIDv7** on first run and stores it alongside a
32-byte secret — in `~/.config/asciisweeper/config` for the terminal, in
localStorage for the browser. Scores follow that id rather than your nickname,
so you can rename freely and two players can share a name without sharing a
history.

The secret is what proves the id is yours. The server binds the pair the first
time it sees a UUID and refuses it afterwards if the secret does not match, so
nobody can claim someone else's identity.

**Which half is public.** The UUID is the public one: safe in logs, on profile
pages and in URLs, because on its own it proves nothing. It does encode its own
creation time to the millisecond — the first 48 bits are a unix timestamp — so
account age is not private, though the remaining 74 bits are random and ids are
neither guessable nor enumerable.

**The secret is the credential**, and the `<uuid>:<secret>` string from Export
is a *complete* one. That pair is the thing never to paste into a bug report, a
screenshot or a chat — a far likelier accident than the UUID leaking, which is
why Export is behind an explicit keypress.

This split is load-bearing. Authenticating with the UUID alone would turn the
public identifier into a bearer token and undo all of the above.

**Identity...** in the menu shows your id, and can export it as
`<uuid>:<secret>` or import one, which is how you play as the same person from
the terminal and the browser, or from a second machine. Exporting reveals the
secret, so it is shown only when asked for.

The binding currently lives in the server's memory and is lost on restart;
making it persistent is part of the ranking work, and needs no protocol change.

### URL scheme, for when there is a site

Notes for a future profile and ranking site, written down while the reasoning
is fresh. None of this needs a protocol change — a web handle is purely a
website concept the game server never sees.

```
/p/<uuid>                permalink - always works, never changes
/p/<handle>              canonical once claimed; the uuid URL redirects here
/leaderboard
/m/<match-uuid>          if matches get shareable pages
/api/v1/players/<uuid>   always the uuid, never the handle
```

**Start with `/p/<uuid>` alone.** The choice is low-stakes because it forecloses
nothing: if UUID URLs are permalinks from day one, adding handles later breaks
no existing link, the old URL simply starts redirecting. So there is no reason
to build a handle system — claiming flow, uniqueness index, reserved words,
rename policy — before it is clearly wanted.

**Use the canonical dashed form, not a shortened encoding.** The same id three
ways:

| form | |
|---|---|
| canonical, 36 | `/p/01a10141-7c0c-7150-819a-f697b6c7a52c` |
| base64url, 22 | `/p/AaEBQXwMcVCBmvaXtselLA` |
| base32, 26 | `/p/01m40m2z0ce58836qpjyvcf99c` |

Shortening saves fourteen characters and costs recognisability, case-safety
(base64url is mixed-case, unpleasant to read aloud or retype) and the ability to
paste straight into anything that understands UUIDs.

**Handles for humans, UUIDs for APIs.** This is the rule worth holding to: a
handle is renameable by definition, so any machine consumer that stores one
eventually breaks. Internal links, API responses and foreign keys should use the
UUID even after handles exist.

**A nickname cannot be the URL key.** The game deliberately allows duplicate
names and free renames — that is why identities exist at all — so a handle would
be a separate thing, unique only within the site.

If handles do arrive: keep profiles under a `/p/` prefix rather than at the root,
since root-level usernames mean maintaining a reserved-word list forever.
`^[a-z0-9][a-z0-9_-]{2,23}$` can never collide with a canonical UUID, so one
route can serve both and dispatch on shape — but it does admit `admin`, so a
reserved list is still needed.

Two things to do regardless. Set `Referrer-Policy:
strict-origin-when-cross-origin` on profile pages, since URLs leak into access
logs, browser history and third-party `Referer` headers whatever they contain.
And remember a stable pseudonymous id is personal data under GDPR, so a deletion
story is worth having before ids are scattered through logs.

Matches have no ids today. If `/m/<id>` is wanted, generate a UUIDv7 per match
server-side — [`src/uuid.c`](src/uuid.c) is already linked into the server, and
v7's time ordering means match ids sort chronologically for free.

**Run a server:**

```sh
./build/asciisweeper-server --cert fullchain.pem --key privkey.pem [--port 4443]
```

The server listens on **both IPv4 and IPv6** and reports which at startup. If
one family is unavailable — a container with IPv6 off, say — it logs that and
serves the other; it only refuses to start when neither works. Rate limiting
treats a whole IPv6 /64 as one client, since that is what a single subscriber
is normally given.

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

When a match ends you stay on the result screen for as long as you like —
chat with `t`, offer a rematch with `r`. Asking for a rematch also posts
"wants a rematch" to the chat, so your opponent sees it whether or not
they are watching the prompt. There is no countdown: the screen
ends when a player leaves, or when one goes completely silent for 90
seconds, which is what stops a dropped connection holding a match open.

## Browser version

There is also a WebGL client that renders the same ASCII grid in a browser —
same glyphs, same palette, same centred board — with the same single-player and
multiplayer modes.

```sh
./build-web.sh          # -> web/dist/, static files, copy to a docroot
./build-web.sh --serve  # dev server, for playing locally
./build-web.sh --test   # typecheck + 695 tests
./build-web.sh --card   # regenerate the social card and icons
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

Two optional build-time variables:

```sh
SITE_URL=https://yourdomain.com \
WS_URL=wss://yourdomain.com/ws \
  ./build-web.sh
```

**`SITE_URL`** makes link previews work. `og:image` and `canonical` must be
absolute URLs — relative ones are ignored by Facebook, X, Slack and Discord — so
without it those tags are **omitted rather than wrong**, and the build says so.
It also enables `robots.txt` and `sitemap.xml`, which only matter at a domain
root anyway.

**`WS_URL`** sets the default multiplayer endpoint. Leave it unset and the client
uses `/ws` on whatever origin serves the page, which is the usual arrangement.
Set it when the bridge lives on a different host — note that an `https` page can
only open `wss`, never `ws`, so a separately hosted bridge needs its own
certificate. Players can also override it in the multiplayer menu.

That produces `web/dist/` — about 85 KB in total:

```
index.html                  7 KB
assets/index-<hash>.js     46 KB   client, renderer and the ncurses shim
assets/core-<hash>.wasm    11 KB   board.c + net_io.c
social-card.png            24 KB   generated from a real frame of the game
favicon.svg, icon-*.png           the avatar face
site.webmanifest
robots.txt, sitemap.xml           only with SITE_URL
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
sudo useradd --system --no-create-home --shell /usr/sbin/nologin asciisweeper

sudo cp web/deploy/asciisweeper-bridge.service /etc/systemd/system/
sudoedit /etc/systemd/system/asciisweeper-bridge.service   # paths, step-5 flags
sudo systemctl daemon-reload
sudo systemctl enable --now asciisweeper-bridge
systemctl status asciisweeper-bridge
```

**FreeBSD, rc.d:**

```sh
sudo install -m 555 web/deploy/asciisweeper-bridge.rc \
  /usr/local/etc/rc.d/asciisweeper_bridge

sudo pw useradd asciisweeper -d /nonexistent -s /usr/sbin/nologin \
  -c 'asciisweeper bridge'

sudo sysrc asciisweeper_bridge_enable="YES"
sudo sysrc asciisweeper_bridge_servername="yourdomain.com"   # from step 5

sudo service asciisweeper_bridge start
sudo service asciisweeper_bridge status
```

Everything is configurable through `rc.conf` rather than by editing the script —
`sysrc asciisweeper_bridge_ca=...`, `_upstream`, `_listen`, `_bind`, `_runas`,
`_dir`, `_node`, `_logfile`. (`_runas`, not `_user` — that suffix is reserved by
`rc.subr`.) Run `service asciisweeper_bridge start` once by hand
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
