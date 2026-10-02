# Deployment reference

**The step-by-step sequence lives in the main [README](../../README.md), under
"Hosting the browser version."** This file is the reference behind it: the
certificate detail in full, a troubleshooting table, and notes on the files here.
Keeping the steps in one place stops the two from drifting.

## Files

| File | Purpose |
|---|---|
| `asciisweeper-bridge.service` | systemd unit for the bridge. Edit `User`, `WorkingDirectory` and the upstream flags. |
| `Caddyfile.example` | Caddy: static files plus the `/ws` route. |
| `nginx.conf.example` | nginx equivalent, including the `.wasm` media type and the read timeout. |

## Why `--servername` is required

This is the one configuration mistake that is easy to make and hard to read.

Node verifies the upstream certificate against `servername || host`. The bridge
connects to the game server over loopback, so with `--upstream 127.0.0.1:4443`
and no `--servername`, Node checks the certificate against the **IP address**. A
certificate issued for a domain name has no IP SAN, so the handshake fails:

```
upstream error: Hostname/IP does not match certificate's altnames:
    IP: 127.0.0.1 is not in the cert's list:
```

**`--ca` does not fix this.** Supplying the CA changes which chain is trusted; it
does not change which name is checked. The identity check still uses the host.

The fix is to tell Node the name the certificate was issued for, while still
connecting to loopback:

```sh
node bridge.mjs --listen 8080 --upstream 127.0.0.1:4443 --servername yourdomain.com
```

### Why local testing does not catch it

The self-signed certificate in the main README's local-testing recipe is created
with:

```
-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

That `IP:127.0.0.1` is why `--ca server.crt` alone succeeds locally — the
certificate really does cover the IP being connected to. A Let's Encrypt
certificate does not, which is why the same flags fail in production. The bridge
prints a note at startup when it sees an IP upstream with no `--servername`, to
surface this before a player hits it.

### Flag combinations

| The game server's certificate is... | Flags |
|---|---|
| Issued for a domain (Let's Encrypt etc.) | `--upstream 127.0.0.1:4443 --servername yourdomain.com` |
| Signed by a private CA | `--upstream 127.0.0.1:4443 --servername <name in cert> --ca /path/ca.pem` |
| Self-signed **with** `IP:127.0.0.1` in its SANs | `--upstream 127.0.0.1:4443 --ca /path/server.crt` |
| Local development, any certificate | `--upstream 127.0.0.1:4443 --insecure` |

`--insecure` skips upstream verification entirely and prints a warning. It is for
development only: the bridge's upstream hop exists precisely to do the
certificate pinning a browser cannot.

## Why the read timeout matters

A turn-based game is silent while a player thinks. nginx defaults
`proxy_read_timeout` to 60 seconds, which is **shorter than the game server's own
90-second idle disconnect** (`src/server.c`), so an opponent who deliberates for a
minute is dropped by the proxy rather than by the game. `nginx.conf.example` sets
one hour. Caddy has no read timeout by default, which is already correct.

The client also sends `MSG_PING` every 25 seconds, which helps — but do not rely
on it instead of the timeout. That message type was defined in the protocol from
the start and never used by the terminal client; it earns its keep in the browser
because JavaScript cannot send WebSocket control-frame pings.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Page stuck on "loading…", console 404 on a `.ts` file | `web/` was deployed instead of `web/dist/` |
| `.wasm` served as `application/octet-stream` | older nginx without the wasm media type; add `types { application/wasm wasm; }`. The page still works, via a slower fallback |
| Multiplayer reports "connection failed" immediately | bridge not running, or `/ws` not routed |
| Bridge logs `Hostname/IP does not match certificate's altnames` | missing `--servername` — see above |
| WebSocket upgrade returns 404 | `/ws` is matched after the static file handler; move it before |
| Matches die after about a minute of thinking | proxy read timeout too low |
| Server rejects with "unsupported protocol version" | the deployed `asciisweeper-server` predates the client's `NET_PROTO_VERSION`; rebuild and restart it |

## Verifying a deployment

```sh
curl -s http://127.0.0.1:8080/healthz                          # on the host -> ok
BRIDGE_URL=wss://yourdomain.com/ws node web/test/mp.e2e.mjs    # -> 34 passed
journalctl -u asciisweeper-bridge -f                           # open from <ip>, upstream connected
```

The middle one is the real check: it drives two clients through the deployed
bridge into the deployed server using the same wasm codec the browser uses. It
queues two players on the live server for a few seconds, so run it when nobody is
waiting for a match.
