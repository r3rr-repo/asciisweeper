# asciisweeper multiplayer bridge

A browser cannot open a raw TCP or TLS socket, and `src/net_io.c` takes an `SSL *`
directly with no transport abstraction. This relays bytes between a WebSocket and
`asciisweeper-server` so the browser client can play, with **no changes to
`server.c` or `net_io.c`**.

It is deliberately a dumb byte pipe. It never parses the protocol, so:

- the game server is untouched and unaware of it;
- a browser player and a terminal player can be matched against each other;
- the protocol's own 3-byte framing survives end to end — which means the browser
  client must reassemble frames itself, since a WebSocket message boundary is
  **not** a frame boundary. See `web/src/net/wsconn.ts`.

## Running it

```sh
node bridge.mjs --listen 8080 --upstream 127.0.0.1:4443 --ca /path/to/cert.pem
```

| Flag | Meaning |
|---|---|
| `--listen` | port to serve `ws://.../ws` on (default 8080) |
| `--bind` | address to bind (default `127.0.0.1`, i.e. loopback only) |
| `--upstream` | `host:port` of `asciisweeper-server` (default `127.0.0.1:4443`) |
| `--ca` | certificate to pin for the upstream, as the native client's `--ca` |
| `--servername` | SNI name, if it differs from the upstream host |
| `--insecure` | skip upstream verification — **local development only** |

`GET /healthz` returns `ok` for health checks.

## Choosing the upstream flags

**`--servername` is the one easy mistake.** Node verifies the upstream
certificate against `servername || host`, so dialling `127.0.0.1` without it
checks the certificate against the *IP address*. A certificate issued for a
domain name has no IP SAN, so the handshake fails:

```
upstream error: Hostname/IP does not match certificate's altnames
```

**`--ca` does not fix this** — the identity check still uses the host. The bridge
prints a note at startup when it spots the combination.

| The game server's certificate is... | Flags |
|---|---|
| Issued for a domain (Let's Encrypt etc.) | `--upstream 127.0.0.1:4443 --servername yourdomain.com` |
| Signed by a private CA | `--upstream 127.0.0.1:4443 --servername <name in cert> --ca /path/ca.pem` |
| Self-signed **with** `IP:127.0.0.1` in its SANs | `--upstream 127.0.0.1:4443 --ca /path/server.crt` |

With a publicly valid certificate, `--ca` is unnecessary: the system trust store
covers it. Adding it pins more tightly, which is fine — but `--servername` is
still required.

The third row is the case the main README's local-testing recipe produces, since
that `openssl req` includes `IP:127.0.0.1` in `subjectAltName`. It is why local
testing works with `--ca` alone and a deployment often does not.

## TLS

**This process does not terminate TLS.** Put it behind the reverse proxy that
already serves the static files and let that handle `wss://` with the certificate
you already have; it reaches this over loopback. That keeps all certificate
handling in one place.

Upstream, it *does* verify the game server's certificate and pins it with
`--ca` — the job a browser cannot do, since browsers cannot pin a certificate
authority. So `asciisweeper-server` keeps its current setup and gains no new
network exposure.

Only `--insecure` skips that check, and only for a self-signed cert in local
development. It prints a warning when used.

## Local development

No proxy, so the bridge is plain `ws://` on loopback and no certificate is
involved on the browser side at all:

```sh
./build/asciisweeper-server --cert server.crt --key server.key --port 4443
node bridge.mjs --listen 8080 --upstream 127.0.0.1:4443 --ca server.crt
```

Then point the client's multiplayer URL at `ws://127.0.0.1:8080/ws`.

## Deployment

See `../deploy/` for a Caddyfile, an nginx `location /ws` snippet and a systemd
unit. The one trap worth repeating: **nginx's default `proxy_read_timeout` is
60s, shorter than the server's own 90s idle disconnect.** A turn-based game is
quiet by design, so without a longer timeout an opponent who thinks for a minute
gets dropped. The client also sends `MSG_PING` every 25s — the protocol defined
it and the native client never used it, but JS cannot send WebSocket
control-frame pings, so it earns its keep here.

Its only dependency is `ws`; `tls` and `http` are built into Node.
