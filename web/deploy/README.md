# Deploying the browser client

Two pieces, and they are independent:

| | What | Needs |
|---|---|---|
| **Single-player** | the contents of `web/dist/` in a docroot | nothing else |
| **Multiplayer** | the bridge process + a `/ws` proxy route | Node on the host |

The game server is **not** modified or restarted. Same binary, same `:4443`, same
certificate. Multiplayer needs the bridge only because a browser cannot open a raw
TLS socket, so something on that host has to relay bytes to `127.0.0.1:4443`.

Protocol compatibility is already settled: `src/server.c:857` requires an exact
`NET_PROTO_VERSION` match, and the browser sends the same version from the same
header as the terminal client. If `./build/asciisweeper` plays against your server
today, the browser will too.

## Prerequisites on the host

- Node 18 or newer (`bridge.mjs` uses `node:`-prefixed imports).
- `asciisweeper-server` already running on `:4443` with its certificate.
- A reverse proxy already terminating TLS for the domain.
- Knowing what kind of certificate the game server uses — it decides the bridge
  flags, and it is the one step people get wrong. See step 4.

## 1. Get the code onto the host

```sh
cd /opt/asciisweeper && git pull origin main
```

## 2. Install the bridge's one runtime dependency

```sh
cd /opt/asciisweeper/web && npm ci --omit=dev
```

`ws` is the only entry in `dependencies`; Vite and TypeScript are devDependencies
and are deliberately not installed on a server.

Run it from inside `web/`, not with `npm --prefix web`, which resolves against the
current directory and silently installs in the wrong place from anywhere else.

## 3. Build the static files on your workstation, then copy them

The host has no build toolchain after step 2, which is intentional:

```sh
# on your workstation
./build-web.sh
rsync -av --delete web/dist/ youruser@yourhost:/var/www/sweeper/
```

Copy **`web/dist/`, not `web/`**. The source tree needs a bundler — browsers
cannot execute TypeScript — so serving `web/` as static files cannot work. (It
will tell you so if you try.) `dist/` is self-contained and its asset paths are
relative, so it works at a domain root or in a subdirectory like
`/games/sweeper/`.

## 4. Choose the upstream flags

**This is the step to read twice.** Node verifies the upstream certificate against
`servername || host`, so dialling `127.0.0.1` with no `--servername` checks the
certificate against the *IP address*. A certificate issued for a domain name has
no IP SAN, and the handshake fails with:

```
upstream error: Hostname/IP does not match certificate's altnames
```

**`--ca` does not fix that** — the identity check still uses the host.

| The game server's certificate is... | Flags |
|---|---|
| Issued for a domain (Let's Encrypt etc.) | `--upstream 127.0.0.1:4443 --servername yourdomain.com` |
| Signed by a private CA | `--upstream 127.0.0.1:4443 --servername <name in cert> --ca /path/ca.pem` |
| Self-signed **with** `IP:127.0.0.1` in its SANs | `--upstream 127.0.0.1:4443 --ca /path/server.crt` |

With a publicly valid certificate, `--ca` is unnecessary — the system trust store
covers it. Adding it pins more tightly, which is fine, but `--servername` is still
required. The bridge prints a note at startup if it sees an IP upstream with no
`--servername`.

The third row is what the main README's local-testing recipe produces, because
that `openssl req` puts `IP:127.0.0.1` in `subjectAltName`. That is exactly why
local testing succeeds with `--ca` alone while a real deployment often does not.

## 5. Install the service

```sh
sudo cp /opt/asciisweeper/web/deploy/asciisweeper-bridge.service /etc/systemd/system/
sudoedit /etc/systemd/system/asciisweeper-bridge.service    # User, paths, step-4 flags
sudo systemctl daemon-reload
sudo systemctl enable --now asciisweeper-bridge
systemctl status asciisweeper-bridge
```

The unit binds the bridge to loopback only, since the proxy reaches it locally.
Nothing new is exposed to the internet.

## 6. Route /ws through the proxy

Copy the relevant part of `Caddyfile.example` or `nginx.conf.example`. Two things
have to be right:

- **`/ws` is matched before the static file handler**, or the upgrade request gets
  served as a 404.
- **The read timeout is generous.** nginx defaults `proxy_read_timeout` to 60s,
  which is *shorter* than the game server's own 90s idle disconnect — and a
  turn-based game sends nothing at all while someone is thinking. Without a longer
  timeout, an opponent who takes a minute gets dropped for no reason. The examples
  set 1h. Caddy has no read timeout by default, which is what you want.

Then:

```sh
sudo nginx -t && sudo systemctl reload nginx     # or: caddy validate && systemctl reload caddy
```

## 7. Verify, in increasing order of realism

```sh
# on the host - the bridge is up
curl -s http://127.0.0.1:8080/healthz                              # -> ok

# from anywhere - TLS and the static files
curl -s -o /dev/null -w '%{http_code}\n' https://yourdomain.com/   # -> 200

# the real proof: two clients through the DEPLOYED bridge into the DEPLOYED
# server, using the same wasm codec the browser uses
BRIDGE_URL=wss://yourdomain.com/ws node web/test/mp.e2e.mjs        # -> 34 passed
```

That last command is the one that actually tells you multiplayer works. It queues
two players on the live server for a few seconds, so run it when nobody is waiting
for a match.

Watch the bridge while testing:

```sh
journalctl -u asciisweeper-bridge -f
```

A healthy connection logs `open from <ip>` and then `upstream connected`. If you
see `upstream error: Hostname/IP does not match certificate's altnames`, go back
to step 4.

Finally, the human check: open the site, choose Multiplayer, and have someone join
with the terminal client from another machine. They are matched FIFO, so a browser
player and a terminal player get paired with each other and should see an
identical board.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Page stuck on "loading…", console 404 on a `.ts` file | `web/` was deployed instead of `web/dist/` |
| `.wasm` served as `application/octet-stream` | older nginx without the wasm media type; add `types { application/wasm wasm; }`. It still works via a slower fallback path |
| Multiplayer says "connection failed" immediately | bridge not running, or `/ws` not routed |
| Bridge logs `Hostname/IP does not match certificate's altnames` | missing `--servername`; step 4 |
| Matches die after about a minute of thinking | proxy `proxy_read_timeout` too low; step 6 |
| Server rejects with "unsupported protocol version" | the deployed `asciisweeper-server` predates the client's `NET_PROTO_VERSION`; rebuild and restart it |
