/*
 * IPv6 handling in the multiplayer server URL.
 *
 * A bracketed IPv6 authority is the one shape easy to get wrong: location.host
 * brackets it automatically, so resolveWsUrl must not add or strip brackets of
 * its own, and validateWsUrl must accept it.
 */
import { resolveWsUrl, validateWsUrl, type Config } from "../src/config";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };
const eq = <T>(a: T, b: T, m: string) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

/** Stands in for the browser's location, which the tests do not have. */
function withLocation(protocol: string, host: string, fn: () => void) {
  (globalThis as Record<string, unknown>).location = { protocol, host };
  try { fn(); } finally { delete (globalThis as Record<string, unknown>).location; }
}

const cfg = (wsUrl: string | null): Config => ({
  v: 1, playerId: "", playerSecret: "", avatar: { skin: 1, hair: 1 },
  wsUrl, name: "Player", baseCell: { w: 10, h: 20 }, targetRows: 32,
  brightenBlack: true, fontFamily: "monospace",
});

// ---------------------------------------------- same-origin, both families
withLocation("https:", "example.com", () => {
  eq(resolveWsUrl(cfg(null)), "wss://example.com/ws", "a hostname origin resolves to wss");
});
withLocation("http:", "127.0.0.1:5173", () => {
  eq(resolveWsUrl(cfg(null)), "ws://127.0.0.1:5173/ws", "an IPv4 origin keeps its port");
});
withLocation("https:", "[2001:db8::1]", () => {
  // location.host is already bracketed, so passing it through is correct;
  // adding brackets would double them and stripping them would break the URL.
  eq(resolveWsUrl(cfg(null)), "wss://[2001:db8::1]/ws",
     "an IPv6 origin keeps exactly one pair of brackets");
});
withLocation("http:", "[::1]:8080", () => {
  eq(resolveWsUrl(cfg(null)), "ws://[::1]:8080/ws", "an IPv6 origin keeps its port too");
});

// An explicit override always wins over the origin.
withLocation("https:", "example.com", () => {
  eq(resolveWsUrl(cfg("wss://[2001:db8::2]:9443/ws")), "wss://[2001:db8::2]:9443/ws",
     "an explicit IPv6 URL is used verbatim");
});

// ------------------------------------------------------------ validation
withLocation("https:", "example.com", () => {
  eq(validateWsUrl(""), null, "blank means same origin and is valid");
  eq(validateWsUrl("wss://[::1]:8080/ws"), null, "a bracketed IPv6 wss URL is accepted");
  eq(validateWsUrl("wss://[2001:db8::1]/ws"), null, "...with or without a port");
  ok(validateWsUrl("ws://[::1]:8080/ws") !== null,
     "ws:// from an https page is refused - it would be blocked as mixed content");
  ok(validateWsUrl("https://[::1]/ws") !== null, "a non-ws scheme is refused");
  ok(validateWsUrl("[::1]:8080") !== null, "a bare authority with no scheme is refused");
});
withLocation("http:", "localhost:5173", () => {
  eq(validateWsUrl("ws://[::1]:8080/ws"), null, "ws:// is fine from an http page");
});

// An unbracketed IPv6 authority is genuinely ambiguous and must not be
// silently accepted: the last colon would be read as a port separator.
withLocation("http:", "localhost:5173", () => {
  const r = validateWsUrl("ws://::1:8080/ws");
  ok(r !== null, "an unbracketed IPv6 authority is rejected rather than misparsed");
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
