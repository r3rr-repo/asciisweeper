/*
 * WebSocket transport, replacing client_net.c and net_recv_frame.
 *
 * The bridge is a dumb byte pipe: it relays the raw TLS byte stream to and from
 * asciisweeper-server without understanding the protocol. That means
 * WEBSOCKET MESSAGE BOUNDARIES ARE NOT FRAME BOUNDARIES - one message may carry
 * several protocol frames, or part of one. So this keeps a reassembly buffer and
 * parses [type u8][len u16 BE] out of it, which is exactly what ssl_read_all plus
 * net_recv_frame do in C (src/net_io.c:32-60).
 *
 * The 3-byte framing is redundant inside WebSocket's own framing, and is kept
 * anyway: it means zero changes to server.c and net_io.c, and it means a browser
 * player and a terminal player can share a match.
 */

export interface Frame {
  type: number;
  payload: Uint8Array;
}

export type ConnState = "connecting" | "open" | "closed" | "error";

const HEADER = 3;

export class WsConn {
  private ws: WebSocket | null = null;
  private rx = new Uint8Array(0);
  private queue: Frame[] = [];
  state: ConnState = "connecting";
  lastError = "";

  constructor(
    private url: string,
    private maxPayload: number,
    private onStateChange?: (s: ConnState) => void,
  ) {}

  connect(): void {
    this.state = "connecting";
    this.rx = new Uint8Array(0);
    this.queue = [];
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.state = "open";
      this.onStateChange?.(this.state);
    };
    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      this.absorb(new Uint8Array(ev.data));
    };
    ws.onerror = () => {
      // The browser deliberately withholds the reason for WebSocket failures.
      this.fail("connection failed");
    };
    ws.onclose = () => {
      if (this.state !== "error") {
        this.state = "closed";
        this.onStateChange?.(this.state);
      }
    };
  }

  private fail(msg: string): void {
    this.lastError = msg;
    this.state = "error";
    this.onStateChange?.(this.state);
  }

  /** Appends bytes and extracts every whole frame now available. */
  private absorb(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.rx.length + chunk.length);
    merged.set(this.rx, 0);
    merged.set(chunk, this.rx.length);
    this.rx = merged;

    let off = 0;
    for (;;) {
      if (this.rx.length - off < HEADER) break;
      const type = this.rx[off];
      const len = (this.rx[off + 1] << 8) | this.rx[off + 2];
      if (len > this.maxPayload) {
        // Same judgement net_recv_frame makes: an oversized length is a protocol
        // violation, not something to try to resynchronise from.
        this.fail("protocol violation: oversized frame");
        this.close();
        return;
      }
      if (this.rx.length - off < HEADER + len) break;
      this.queue.push({ type, payload: this.rx.slice(off + HEADER, off + HEADER + len) });
      off += HEADER + len;
    }
    this.rx = off > 0 ? this.rx.slice(off) : this.rx;
  }

  /** Drains every frame received since the last call. */
  take(): Frame[] {
    if (this.queue.length === 0) return [];
    const out = this.queue;
    this.queue = [];
    return out;
  }

  send(type: number, payload: Uint8Array): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const buf = new Uint8Array(HEADER + payload.length);
    buf[0] = type;
    buf[1] = (payload.length >> 8) & 0xff;
    buf[2] = payload.length & 0xff;
    buf.set(payload, HEADER);
    this.ws.send(buf);
    return true;
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch { /* already gone */ }
    }
  }
}
