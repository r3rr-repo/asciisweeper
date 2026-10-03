#!/usr/bin/env node
/*
 * WebSocket -> TLS bridge for asciisweeper multiplayer.
 *
 * Browsers cannot open raw TCP or TLS sockets, and src/net_io.c takes an SSL*
 * directly with no transport abstraction. So this sits in front of the existing
 * asciisweeper-server and relays bytes. It is deliberately a DUMB BYTE PIPE: it
 * never parses the protocol, which is why server.c and net_io.c need no changes
 * at all and why a browser player can share a match with a terminal player.
 *
 * Because the protocol's own 3-byte framing is preserved end to end, the browser
 * client must reassemble frames itself - a WebSocket message boundary is not a
 * frame boundary. See web/src/net/wsconn.ts.
 *
 * TLS: this process does NOT terminate TLS. Put it behind the same reverse proxy
 * that already serves the static files and let that proxy handle wss:// with the
 * certificate you already have; the proxy reaches this over loopback. Upstream,
 * this verifies asciisweeper-server's certificate, pinning with --ca exactly as
 * the native client does - so the game server keeps its current setup and gains
 * no new network exposure.
 *
 *   node bridge.mjs --listen 8080 --upstream 127.0.0.1:4443 --ca /path/cert.pem
 */
import { createServer } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";

/*
 * Splits host:port, coping with IPv6.
 *
 * A naive lastIndexOf(":") turns "[::1]:4443" into the host "[::1]" with the
 * brackets attached, which Node cannot resolve, and cannot tell a bare IPv6
 * literal from a host:port pair at all. Bracketed form wins; otherwise a
 * single colon is host:port and several colons mean a bare IPv6 address.
 */
function parseHostPort(v, defaultPort) {
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    if (end < 0) {
      console.error(`bridge: unbalanced brackets in "${v}"`);
      process.exit(2);
    }
    const host = v.slice(1, end);
    const rest = v.slice(end + 1);
    return { host, port: rest.startsWith(":") ? Number(rest.slice(1)) : defaultPort };
  }
  const first = v.indexOf(":");
  if (first < 0) return { host: v, port: defaultPort };
  if (first === v.lastIndexOf(":")) {
    return { host: v.slice(0, first) || "127.0.0.1", port: Number(v.slice(first + 1)) };
  }
  // Several colons and no brackets: a bare IPv6 literal, no port.
  return { host: v, port: defaultPort };
}

/** Brackets an IPv6 literal so a logged host:port stays readable. */
function hostForDisplay(h) {
  return h.includes(":") ? `[${h}]` : h;
}

function parseArgs(argv) {
  const o = { listen: 8080, host: "127.0.0.1", upstreamHost: "127.0.0.1", upstreamPort: 4443, ca: null, servername: null, insecure: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--listen": o.listen = Number(next()); break;
      case "--bind": o.host = next(); break;
      case "--upstream": {
        const hp = parseHostPort(next(), o.upstreamPort);
        o.upstreamHost = hp.host;
        o.upstreamPort = hp.port;
        break;
      }
      case "--ca": o.ca = next(); break;
      case "--servername": o.servername = next(); break;
      // Local development against a self-signed certificate only. Never in
      // production: the whole point of the bridge's upstream hop is that it does
      // the certificate pinning the browser cannot.
      case "--insecure": o.insecure = true; break;
      case "-h": case "--help":
        console.log("usage: bridge.mjs [--listen 8080] [--bind 127.0.0.1|::1|::] [--upstream host:4443|[::1]:4443] [--ca file] [--servername name] [--insecure]");
        process.exit(0);
        break;
      default:
        console.error(`bridge: unknown argument ${a}`);
        process.exit(2);
    }
  }
  return o;
}

const opt = parseArgs(process.argv);
const ca = opt.ca ? readFileSync(opt.ca) : undefined;

/*
 * SNI is only valid for a hostname. src/client_net.c:73-89 draws the same
 * distinction: SSL_set1_host plus SNI for a name, X509_VERIFY_PARAM_set1_ip_asc
 * for an IP literal. Node refuses outright if servername is an IP, and when it is
 * omitted Node verifies against the certificate's IP SAN instead - which is what
 * the local-testing certificate in the main README carries.
 */
const isIpLiteral = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
const upstreamServername =
  opt.servername ?? (isIpLiteral(opt.upstreamHost) ? undefined : opt.upstreamHost);

if (opt.insecure) {
  console.warn("bridge: WARNING --insecure disables upstream certificate verification (development only)");
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// A plain HTTP server so a health check has somewhere to land; the WebSocket
// upgrade is handled on /ws.
const http = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: http, path: "/ws", perMessageDeflate: false });

let nextId = 1;

wss.on("connection", (ws, req) => {
  const id = nextId++;
  const peer = req.headers["x-forwarded-for"] ?? req.socket.remoteAddress;
  log(`[${id}] open from ${peer}`);

  /*
   * A failure here must close THIS connection only. Letting it throw would take
   * the whole bridge down and disconnect every other match in progress.
   */
  let upstream;
  try {
    upstream = tlsConnect({
      host: opt.upstreamHost,
      port: opt.upstreamPort,
      ca,
      ...(upstreamServername ? { servername: upstreamServername } : {}),
      rejectUnauthorized: !opt.insecure,
      minVersion: "TLSv1.2",
    });
  } catch (e) {
    log(`[${id}] upstream connect failed: ${e.message}`);
    try { ws.close(); } catch { /* already gone */ }
    return;
  }

  // Anything the browser sends before the TLS handshake finishes must be held,
  // not dropped - MSG_HELLO is the very first thing it sends.
  let ready = false;
  const pending = [];

  upstream.on("secureConnect", () => {
    ready = true;
    for (const chunk of pending) upstream.write(chunk);
    pending.length = 0;
    log(`[${id}] upstream connected`);
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary) return; // the protocol is binary only
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (ready) upstream.write(buf);
    else pending.push(buf);
  });

  upstream.on("data", (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
  });

  const shutdown = (why) => {
    if (!upstream.destroyed) upstream.destroy();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    log(`[${id}] closed (${why})`);
  };

  upstream.on("error", (e) => shutdown(`upstream error: ${e.message}`));
  upstream.on("close", () => shutdown("upstream closed"));
  ws.on("error", (e) => shutdown(`client error: ${e.message}`));
  ws.on("close", () => shutdown("client closed"));
});

http.listen(opt.listen, opt.host, () => {
  log(`bridge listening on ws://${hostForDisplay(opt.host)}:${opt.listen}/ws -> tls://${hostForDisplay(opt.upstreamHost)}:${opt.upstreamPort}`);
  if (!ca && !opt.insecure) {
    log("bridge: no --ca given, using the system trust store for the upstream");
  }
  /*
   * Node verifies the upstream certificate against `servername || host`. Reaching
   * a loopback address with no --servername therefore checks the certificate
   * against the IP, which only succeeds if it carries an IP SAN. A certificate
   * issued for a domain name will fail with "Hostname/IP does not match
   * certificate's altnames" on the first connection - so say so now, before a
   * player hits it. Note --ca alone does NOT help: the identity check still uses
   * the host.
   */
  if (!opt.insecure && !upstreamServername && isIpLiteral(opt.upstreamHost)) {
    log(`bridge: NOTE upstream is the IP ${opt.upstreamHost} and no --servername was given,`);
    log("bridge:      so its certificate must contain a matching IP SAN. If it was issued");
    log("bridge:      for a domain name, pass --servername <that name>.");
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`bridge: ${sig}, shutting down`);
    wss.close();
    http.close(() => process.exit(0));
  });
}
