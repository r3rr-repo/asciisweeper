# Deployment reference

**The step-by-step sequence lives in the main [README](../../README.md), under
"Hosting the browser version."** This file is the reference behind it: the
certificate detail in full, a troubleshooting table, and notes on the files here.
Keeping the steps in one place stops the two from drifting.

## Files

| File | Purpose |
|---|---|
| `asciisweeper-server.service` | systemd unit for the game server. Runs as `asciisweeper`; edit the `--cert`/`--key` paths. |
| `asciisweeper-server.rc` | FreeBSD `rc.d` script for the game server. Configured through `rc.conf`. |
| `asciisweeper-bridge.service` | systemd unit for the bridge. Runs as `asciisweeper`; edit `WorkingDirectory` and the upstream flags. |
| `asciisweeper-bridge.rc` | FreeBSD `rc.d` script for the bridge. Configured through `rc.conf`, not by editing it. |
| `Caddyfile.example` | Caddy: static files plus the `/ws` route. |
| `nginx.conf.example` | nginx equivalent, including the `.wasm` media type and the read timeout. |

None of them is required. Both the server and the bridge are foreground
processes that log lines to stderr and die on `SIGTERM`, so any supervisor will
do — runit, s6, OpenRC, a jail's own init, or nothing at all while you are
trying it out:

```sh
asciisweeper-server --cert fullchain.pem --key privkey.pem --port 4443

node web/bridge/bridge.mjs --bind 127.0.0.1 --listen 8080 \
  --upstream 127.0.0.1:4443 --servername yourdomain.com
```

| Variable | Default |
|---|---|
| `asciisweeper_server_enable` | `NO` |
| `asciisweeper_server_runas` | `asciisweeper` |
| `asciisweeper_server_bin` | `/usr/local/bin/asciisweeper-server` |
| `asciisweeper_server_cert` | *(required)* |
| `asciisweeper_server_key` | *(required)* |
| `asciisweeper_server_port` | `4443` |
| `asciisweeper_server_logfile` | `/var/log/asciisweeper-server.log` |

Both services restart the process if it exits — `Restart=always` and `daemon -r`.
That is deliberate rather than cautious: the server has no clean exit path, it
runs its accept loop until killed, so any exit at all is a crash.

### The private key must be readable by `asciisweeper`

This is the one thing that will stop the server starting. It reads the
certificate and key at startup, as the service account, and never drops
privileges — on port 4443 it needs none to begin with. A Let's Encrypt
`privkey.pem` is `root:root 600` as installed, and OpenSSL's failure says
nothing about permissions. Three ways, best first:

1. **`LoadCredential=`** (systemd 247+): systemd reads the files as root and
   places copies in `$CREDENTIALS_DIRECTORY`, readable only by this service.
   Nothing on disk changes. Commented out in the unit, ready to use.
2. **A group:** `chgrp asciisweeper` the key and `chmod 640`. Re-apply after
   every renewal — certbot replaces the file — so put it in a renewal hook.
3. **A deploy hook** that copies cert and key somewhere `asciisweeper` owns.

The `rc.d` script checks for this at startup and warns with the `chgrp` line if
the key looks unreadable. It cannot be certain — the account may reach the file
through a secondary group — so it warns rather than refusing to start.

**Restart after renewal either way.** The key is read once, at startup, so a
renewed certificate is not served until the service restarts. In a certbot
`--deploy-hook`: `service asciisweeper_server restart` or
`systemctl restart asciisweeper-server`.

## The bridge, on FreeBSD

```sh
pkg install node npm
pw useradd asciisweeper -d /nonexistent -s /usr/sbin/nologin -c 'asciisweeper bridge'
install -m 555 asciisweeper-bridge.rc /usr/local/etc/rc.d/asciisweeper_bridge
sysrc asciisweeper_bridge_enable="YES"
sysrc asciisweeper_bridge_servername="yourdomain.com"
service asciisweeper_bridge start
```

All settings are `rc.conf` variables, so the script itself never needs editing.

Two things about the user it runs as. It defaults to a dedicated
`asciisweeper` account, matching the systemd unit — not `www`, which belongs to
the web server and has no reason to also own a WebSocket proxy. And the variable
is `_runas`, **not** `_user`: `${name}_user` is reserved by `rc.subr`, which
would run `daemon(8)` itself as that user, leaving it unable to drop privileges
and failing with `initgroups(www,80): Operation not permitted`.

To use an account you already have, `sysrc asciisweeper_bridge_runas="www"`. The
script checks the account exists before starting, and re-owns the logfile to it,
so switching is just the one `sysrc`. If you set `_ca`, make sure that file is
readable by whichever account you pick — the bridge reads it after dropping
privileges.

| Variable | Default |
|---|---|
| `asciisweeper_bridge_enable` | `NO` |
| `asciisweeper_bridge_runas` | `asciisweeper` |
| `asciisweeper_bridge_node` | `/usr/local/bin/node` |
| `asciisweeper_bridge_dir` | `/usr/local/share/asciisweeper/web/bridge` |
| `asciisweeper_bridge_bind` | `127.0.0.1` |
| `asciisweeper_bridge_listen` | `8080` |
| `asciisweeper_bridge_upstream` | `127.0.0.1:4443` |
| `asciisweeper_bridge_servername` | *(empty — but see below)* |
| `asciisweeper_bridge_ca` | *(empty)* |
| `asciisweeper_bridge_logfile` | `/var/log/asciisweeper-bridge.log` |

`daemon(8)` handles backgrounding, the pidfile, dropping to `_runas` and restarting
the bridge if it exits. Start it by hand once: the script checks that `node` and
`bridge.mjs` are where it expects, and warns if `ws` has not been installed with
`npm ci --omit=dev`.

Two FreeBSD-specific notes:

- **`node` lives at `/usr/local/bin/node`**, not `/usr/bin/node`, and `npm` is a
  separate package from `node`.
- **`shasum` is not in the base system** — it comes from Perl. `build-web.sh`
  falls back through `sha256sum`, `shasum`, `sha256` and finally `openssl dgst`,
  so it works on a stock install. This only matters if you rebuild the wasm.

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

An IPv6 upstream is written bracketed: `--upstream [::1]:4443`. The bridge also
takes `--bind ::` to accept both families, or `--bind ::1` for IPv6 loopback
only. The game server always listens on both IPv4 and IPv6 and says which at
startup; if one is unavailable it logs that and serves the other.

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
| `daemon: failed to set user environment`, or `initgroups(www,80): Operation not permitted` | a leftover `asciisweeper_bridge_user` in `rc.conf`: `sysrc -x asciisweeper_bridge_user`, then `_runas`. The script now refuses to start and says this |
| `service stop` leaves the bridge running | an `rc.d` script older than 0.12, whose `pidfile` was the child that `daemon -r` respawns; reinstall it |

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
| Server exits at startup with an OpenSSL error about the key or `PEM routines` | the key is not readable by `asciisweeper` — see above |
| Clients get the old certificate after a renewal | the server reads it once at startup; restart it from a deploy hook |
