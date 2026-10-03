/*
 * Port of play_multiplayer, mp_show_end_screen and mp_show_message,
 * src/main.c:619-979.
 *
 * The C interleaved a select() over stdin and the socket, a nested reconnect loop
 * built on sleep(3), and a nested end screen running its OWN select() that could
 * signal "rematch" through an out-parameter - which made its AfterGame return
 * value meaningless in that case. Rather than transliterate that, the phases are
 * named and the transitions are explicit:
 *
 *   Connecting -> Queued -> InMatch -> EndScreen -> (rematch) InMatch
 *                     \                     \
 *                      \--> Reconnecting ----+--> Done
 *
 * The client never runs reveal/flood-fill/chord logic here. It sends an action
 * and renders whatever snapshot comes back, which is what rules out desync by
 * construction - see the README's "How it works".
 */
import {
  END_BOMB, END_CLEAN_CLEAR, END_OPPONENT_LEFT, MSG, OPP_DISCONNECTED,
  OPP_RECONNECTED, PLAYING,
} from "../proto";
import type { Core } from "../core";
import type { Surface } from "../term/surface";
import type { Key, MouseButton } from "../term/input";
import { LineEdit } from "../term/lineedit";
import { CP_HUD, CP_LOSE, CP_TITLE, CP_WIN } from "../draw/colors";
import { renderMultiplayer, CHAT_LOG_LINES, type MpView } from "../draw/mp";
import type { Avatar } from "../draw/avatar";
import { computeLayout } from "./layout";
import { Blink } from "./blink";
import { WsConn } from "../net/wsconn";
import type { BoardView } from "../draw/board";

/**
 * Rows multiplayer draws below main.c's h+8 block. On the end screen that is
 * two lines of result at +5..+6, the chat log at +7..+9 and the composer at
 * +10, so the deepest row is top+h+10. Reserved so centring keeps it on screen.
 */
const MP_EXTRA_ROWS = 7;

/** src/main.c:794-798 - 20 attempts, 3 s apart, i.e. the server's 60 s grace. */
const RECONNECT_ATTEMPTS = 20;
const RECONNECT_DELAY_MS = 3000;
/** JS cannot send WebSocket control-frame pings, so the app-level ping is used. */
const PING_INTERVAL_MS = 25000;

/**
 * Announced in chat when a player asks for a rematch, so the other side sees
 * the request even if they are not watching the prompt line. Kept identical to
 * src/main.c's REMATCH_CHAT_LINE.
 */
const REMATCH_CHAT_LINE = "wants a rematch";

type Phase = "connecting" | "queued" | "match" | "end" | "reconnecting" | "done";

export type MpResult = "menu" | "quit" | null;

export class Multiplayer {
  private phase: Phase = "connecting";
  private conn: WsConn;
  private blinks: [Blink, Blink] = [new Blink(), new Blink()];

  private myPlayerId = 0;
  private playerToMove = 0;
  private token: Uint8Array | null = null;
  private opponentName = "???";
  private opponentAvatar: Avatar = { skin: 7, hair: 7 };
  private boardW: number;
  private boardH: number;
  private scores: [number, number] = [0, 0];
  private minesLeft = 0;
  private status = PLAYING;
  private explodedX = -1;
  private explodedY = -1;
  private cells = new Uint8Array(0);

  private cursorX: number;
  private cursorY: number;

  private statusLine = "";
  private statusClearAtMs = 0;
  private chatLog: string[] = [];
  private editor: LineEdit | null = null;

  private endReason = 0;
  private endScores: [number, number] = [0, 0];
  private rematchRequested = false;

  private attempts = 0;
  private retryAtMs = 0;
  private lastPingMs = 0;
  private outcome: MpResult = null;

  constructor(
    private core: Core,
    private url: string,
    private myName: string,
    private myAvatar: Avatar,
  ) {
    this.boardW = core.consts.mpW;
    this.boardH = core.consts.mpH;
    this.cursorX = Math.floor(this.boardW / 2);
    this.cursorY = Math.floor(this.boardH / 2);
    this.cells = new Uint8Array(this.boardW * this.boardH);
    this.conn = new WsConn(url, core.consts.maxPayload);
    this.conn.connect();
    this.statusLine = "Connecting...";
  }

  get result(): MpResult { return this.outcome; }
  get textEntryActive(): boolean { return this.editor !== null; }

  dispose(): void { this.conn.close(); }

  private say(msg: string, nowMs: number, holdMs = 3000): void {
    this.statusLine = msg;
    this.statusClearAtMs = nowMs + holdMs;
  }

  /**
   * Sends a chat line and records it in our own log, exactly as a typed line
   * is handled - the server echoes to the opponent only, never back to us.
   */
  private sendChat(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.conn.send(MSG.CHAT, this.core.packChat(t));
    this.pushChat(this.myName, t);
  }

  private pushChat(from: string, text: string): void {
    this.chatLog.push(`${from}: ${text}`);
    if (this.chatLog.length > CHAT_LOG_LINES) this.chatLog.shift();
  }

  // ------------------------------------------------------------------- update

  update(nowMs: number): void {
    if (this.statusClearAtMs && nowMs > this.statusClearAtMs && this.phase === "match") {
      this.statusLine = "";
      this.statusClearAtMs = 0;
    }

    if (this.conn.state === "open" && this.phase === "connecting") {
      // src/main.c - HELLO carries the protocol version, name and avatar.
      this.conn.send(MSG.HELLO, this.core.packHello(this.myName, this.myAvatar.skin, this.myAvatar.hair));
      this.phase = "queued";
      this.statusLine = "Waiting for an opponent...";
      this.lastPingMs = nowMs;
    }

    if ((this.conn.state === "error" || this.conn.state === "closed") &&
        this.phase !== "done" && this.phase !== "reconnecting") {
      if (this.token && (this.phase === "match" || this.phase === "end")) {
        this.phase = "reconnecting";
        this.attempts = 0;
        this.retryAtMs = nowMs;
        this.statusLine = "Connection lost - reconnecting...";
      } else {
        this.say(this.conn.lastError || "Disconnected", nowMs);
        this.outcome = "menu";
        this.phase = "done";
      }
    }

    if (this.phase === "reconnecting") this.tickReconnect(nowMs);

    for (const f of this.conn.take()) this.onFrame(f.type, f.payload, nowMs);

    // Application-level keepalive; also what keeps a quiet turn alive through a
    // reverse proxy with an idle read timeout.
    if (this.conn.state === "open" && nowMs - this.lastPingMs > PING_INTERVAL_MS) {
      this.conn.send(MSG.PING, new Uint8Array(0));
      this.lastPingMs = nowMs;
    }

    // No deadline here on purpose. The server dropped its fixed rematch window
    // too, so inventing one in the client would re-impose the limit this change
    // removed. The screen ends when a player leaves or the socket drops.
  }

  private tickReconnect(nowMs: number): void {
    if (nowMs < this.retryAtMs) return;
    if (this.attempts >= RECONNECT_ATTEMPTS) {
      this.outcome = "menu";
      this.phase = "done";
      return;
    }
    this.attempts++;
    this.statusLine = `Reconnecting (${this.attempts}/${RECONNECT_ATTEMPTS})...`;
    this.retryAtMs = nowMs + RECONNECT_DELAY_MS;
    this.conn.close();
    this.conn = new WsConn(this.url, this.core.consts.maxPayload);
    this.conn.connect();
    // The RECONNECT goes out once the socket opens; handled below by watching for
    // the open state while still in this phase.
    this.pendingReconnectSend = true;
  }

  private pendingReconnectSend = false;

  // -------------------------------------------------------------- frame intake

  private onFrame(type: number, payload: Uint8Array, nowMs: number): void {
    const c = this.core;

    if (this.pendingReconnectSend && this.conn.state === "open" && this.token) {
      this.conn.send(MSG.RECONNECT, c.packReconnect(this.token));
      this.pendingReconnectSend = false;
    }

    if (!c.rx(type, payload)) {
      // A malformed payload is the server's problem, not something to guess at.
      this.say("Malformed message from server", nowMs);
      return;
    }

    switch (type) {
      case MSG.WELCOME:
        this.myPlayerId = c.welcomePlayerId;
        return;

      case MSG.QUEUE_STATUS:
        this.statusLine = `Waiting for an opponent... (queue position ${c.queuePosition})`;
        return;

      case MSG.MATCH_START: {
        const ms = c.matchStart();
        this.boardW = ms.w;
        this.boardH = ms.h;
        this.myPlayerId = ms.playerId;
        // first_to_move is a boolean "is it your turn", not a player id - the
        // server sends each player a different value (server.c:680). Same
        // resolution the terminal client does at main.c:695.
        this.playerToMove = ms.youMoveFirst ? ms.playerId : 1 - ms.playerId;
        this.opponentName = ms.opponentName;
        this.opponentAvatar = { skin: ms.opponentSkin, hair: ms.opponentHair };
        this.token = ms.token;
        this.cursorX = Math.floor(this.boardW / 2);
        this.cursorY = Math.floor(this.boardH / 2);
        this.scores = [0, 0];
        this.status = PLAYING;
        this.explodedX = this.explodedY = -1;
        this.rematchRequested = false;
        this.chatLog = [];
        this.blinks = [new Blink(), new Blink()];
        this.phase = "match";
        this.say(`Matched with ${this.opponentName}`, nowMs);
        return;
      }

      case MSG.RECONNECT_OK: {
        const ro = c.reconnectOk();
        this.boardW = ro.w;
        this.boardH = ro.h;
        this.myPlayerId = ro.playerId;
        this.opponentName = ro.opponentName;
        this.opponentAvatar = { skin: ro.opponentSkin, hair: ro.opponentHair };
        this.phase = "match";
        this.say("Reconnected.", nowMs);
        return;
      }

      case MSG.BOARD_STATE: {
        // The snapshot is authoritative: the client applies it and renders it,
        // and never computes a reveal itself.
        this.cells = c.snapshot().slice();
        this.minesLeft = c.bsMinesLeft;
        this.scores = [c.bsScore(0), c.bsScore(1)];
        this.status = c.bsStatus;
        this.boardW = c.bsW;
        this.boardH = c.bsH;
        this.explodedX = c.explodedX;
        this.explodedY = c.explodedY;
        return;
      }

      case MSG.TURN:
        this.playerToMove = c.turnPlayer;
        return;

      case MSG.OPPONENT_STATUS:
        if (c.oppState === OPP_DISCONNECTED) {
          this.say(`${this.opponentName} disconnected - ${c.oppGrace}s to return`, nowMs, 60000);
        } else if (c.oppState === OPP_RECONNECTED) {
          this.say(`${this.opponentName} reconnected.`, nowMs);
        }
        return;

      case MSG.MATCH_END:
        this.endReason = c.endReason;
        this.endScores = [c.endScore(0), c.endScore(1)];
        this.phase = "end";
        this.rematchRequested = false;
        return;

      case MSG.ERROR:
        this.say(`Error: ${c.errMsg || `code ${c.errCode}`}`, nowMs);
        return;

      case MSG.CHAT_RECV:
        this.pushChat(this.opponentName, c.chatText);
        return;

      case MSG.PONG:
      default:
        return;
    }
  }

  // ------------------------------------------------------------------- render

  private boardView(s: Surface): BoardView {
    const l = computeLayout(this.boardW, this.boardH, s.cols, s.rows, true, MP_EXTRA_ROWS);
    return {
      cells: this.cells, w: this.boardW, h: this.boardH,
      status: this.status, explodedX: this.explodedX, explodedY: this.explodedY,
      // Hide the cursor when it is not your move: the C only ever showed it on a
      // PLAYING board, and a cursor you cannot act with is misleading.
      cursorX: this.playerToMove === this.myPlayerId ? this.cursorX : -1,
      cursorY: this.playerToMove === this.myPlayerId ? this.cursorY : -1,
      myPlayerId: this.myPlayerId,
      top: l.top, left: l.left,
    };
  }

  private view(s: Surface): MpView {
    const l = computeLayout(this.boardW, this.boardH, s.cols, s.rows, true, MP_EXTRA_ROWS);
    return {
      board: this.boardView(s),
      sidePanelsFit: l.sidePanelsFit,
      matched: this.phase === "match",
      myPlayerId: this.myPlayerId,
      playerToMove: this.playerToMove,
      myName: this.myName,
      opponentName: this.opponentName,
      myAvatar: this.myAvatar,
      opponentAvatar: this.opponentAvatar,
      scores: this.scores,
      minesLeft: this.minesLeft,
      statusLine: this.statusLine,
      chatLog: this.chatLog,
      chatMode: this.editor !== null,
      chatInput: this.editor?.text ?? "",
    };
  }

  render(s: Surface, nowMs: number): void {
    if (this.phase === "connecting" || this.phase === "queued") {
      s.erase();
      const title = "ASCIISWEEPER - MULTIPLAYER";
      s.withAttrs(CP_TITLE, true, () => s.print(Math.floor(s.rows / 2) - 2, s.centreCol(0, s.cols, title), title));
      s.withAttrs(CP_HUD, false, () => {
        s.print(Math.floor(s.rows / 2), s.centreCol(0, s.cols, this.statusLine), this.statusLine);
        const help = "Menu: n   Quit: q";
        s.print(Math.floor(s.rows / 2) + 2, s.centreCol(0, s.cols, help), help);
      });
      return;
    }

    // On the end screen the chat log drops a row, to clear the two lines of
    // result drawn at +5..+6.
    renderMultiplayer(s, this.view(s), this.blinks, nowMs, this.phase === "end" ? 1 : 0);

    if (this.phase === "end") this.drawEndScreen(s);
    if (this.phase === "reconnecting") {
      s.withAttrs(CP_HUD, true, () => {
        const row = this.boardView(s).top + this.boardH + 5;
        s.print(row, this.boardView(s).left, this.statusLine);
        s.clrtoeol(row, this.boardView(s).left + this.statusLine.length);
      });
    }
  }

  /** src/main.c:632-722 */
  private drawEndScreen(s: Surface): void {
    const v = this.boardView(s);
    const mine = this.endScores[this.myPlayerId];
    const theirs = this.endScores[1 - this.myPlayerId];

    let headline: string;
    let won = false;
    switch (this.endReason) {
      case END_CLEAN_CLEAR:
        headline = "BOARD CLEARED! Both players score.";
        won = true;
        break;
      case END_BOMB:
        headline = "BOOM! The board was lost.";
        break;
      case END_OPPONENT_LEFT:
        headline = `${this.opponentName} left the match.`;
        break;
      default:
        headline = "Match over.";
    }

    const scoreLine = `You: ${mine}    ${this.opponentName}: ${theirs}`;
    const prompt = this.rematchRequested
      ? "Rematch requested, waiting...  Chat: t  [Q]uit"
      : "[R]ematch  Chat: t  [N]ew game  [Q]uit";

    // Two rows only: the chat log starts at +7 and the composer at +10, so a
    // third line here would be drawn over by drawChat.
    s.withAttrs(won ? CP_WIN : CP_LOSE, true, () => {
      s.print(v.top + this.boardH + 5, v.left, headline);
      s.clrtoeol(v.top + this.boardH + 5, v.left + headline.length);
    });
    const line2 = `${scoreLine}    ${prompt}`;
    s.withAttrs(CP_HUD, false, () => {
      s.print(v.top + this.boardH + 6, v.left, line2);
      s.clrtoeol(v.top + this.boardH + 6, v.left + line2.length);
    });
  }

  // --------------------------------------------------------------------- input

  onKey(k: Key): void {
    // Chat mode swallows everything, exactly as src/main.c:907-932 does.
    if (this.editor) {
      const r = this.editor.handle(k);
      if (r === "commit") {
        this.sendChat(this.editor.text);
        this.editor = null;
      } else if (r === "cancel") {
        this.editor = null;
      }
      return;
    }

    if (this.phase === "end") {
      if (k.name !== "char") return;
      if (k.ch.toLowerCase() === "t") {
        this.editor = new LineEdit(this.core.consts.maxChatLen);
        return;
      }
      switch (k.ch.toLowerCase()) {
        case "r":
          if (!this.rematchRequested) {
            this.conn.send(MSG.REQUEST_REMATCH, new Uint8Array(0));
            // Say so in chat as well: the prompt line only tells YOU that you
            // asked, and the opponent may be reading the log.
            this.sendChat(REMATCH_CHAT_LINE);
            this.rematchRequested = true;
          }
          return;
        case "n": this.outcome = "menu"; this.phase = "done"; return;
        case "q": this.outcome = "quit"; this.phase = "done"; return;
        default: return;
      }
    }

    if (k.name === "char") {
      switch (k.ch.toLowerCase()) {
        case "n": this.outcome = "menu"; this.phase = "done"; return;
        case "q": this.outcome = "quit"; this.phase = "done"; return;
        case "t":
          // The end screen handles t in its own branch above, which returns
          // before reaching here.
          if (this.phase === "match") this.editor = new LineEdit(this.core.consts.maxChatLen);
          return;
        default: break;
      }
    }

    if (this.phase !== "match") return;

    switch (k.name) {
      case "up": if (this.cursorY > 0) this.cursorY--; return;
      case "down": if (this.cursorY < this.boardH - 1) this.cursorY++; return;
      case "left": if (this.cursorX > 0) this.cursorX--; return;
      case "right": if (this.cursorX < this.boardW - 1) this.cursorX++; return;
      case "space":
      case "enter": this.act(this.cursorX, this.cursorY, "reveal"); return;
      case "char": break;
      default: return;
    }

    switch (k.ch.toLowerCase()) {
      case "k": if (this.cursorY > 0) this.cursorY--; break;
      case "j": if (this.cursorY < this.boardH - 1) this.cursorY++; break;
      case "h": if (this.cursorX > 0) this.cursorX--; break;
      case "l": if (this.cursorX < this.boardW - 1) this.cursorX++; break;
      case "f": this.act(this.cursorX, this.cursorY, "flag"); break;
      case "c": this.act(this.cursorX, this.cursorY, "chord"); break;
      default: break;
    }
  }

  /**
   * Sends an action. Flagging is free and does not end a turn (so it is allowed
   * at any time); revealing and chording are turn-consuming, so they are refused
   * locally when it is not your move rather than letting the server reply
   * ERR_NOT_YOUR_TURN.
   */
  private act(x: number, y: number, what: "reveal" | "flag" | "chord"): void {
    const c = this.core;
    if (what === "flag") {
      const flagged = (this.cells[y * this.boardW + x] & 0x40) !== 0;
      this.conn.send(MSG.ACTION_FLAG, c.packFlag(x, y, !flagged));
      return;
    }
    if (this.playerToMove !== this.myPlayerId) return;
    if (what === "chord" || (this.cells[y * this.boardW + x] & 0x80) !== 0) {
      this.conn.send(MSG.ACTION_CHORD, c.packChord(x, y));
    } else {
      this.conn.send(MSG.ACTION_REVEAL, c.packReveal(x, y));
    }
  }

  private toBoard(s: Surface, row: number, col: number): { x: number; y: number } | null {
    const l = computeLayout(this.boardW, this.boardH, s.cols, s.rows, true, MP_EXTRA_ROWS);
    const x = Math.floor((col - l.left) / 2);
    const y = row - l.top;
    if (x < 0 || y < 0 || x >= this.boardW || y >= this.boardH) return null;
    return { x, y };
  }

  onHover(s: Surface, row: number, col: number): void {
    if (this.phase !== "match") return;
    const b = this.toBoard(s, row, col);
    if (b) { this.cursorX = b.x; this.cursorY = b.y; }
  }

  onClick(s: Surface, row: number, col: number, button: MouseButton): void {
    if (this.phase !== "match" || this.editor) return;
    const b = this.toBoard(s, row, col);
    if (!b) return;
    this.cursorX = b.x;
    this.cursorY = b.y;
    if (button === "right") this.act(b.x, b.y, "flag");
    else if (button === "middle") this.act(b.x, b.y, "chord");
    else this.act(b.x, b.y, "reveal");
  }
}
