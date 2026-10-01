/*
 * The wasm core: src/board.c and src/net_io.c, unmodified, compiled by
 * build-web.sh. This module is the only place that talks to it.
 *
 * The rules and the wire codec live in C so the browser client, the terminal
 * client and the server cannot disagree. Nothing here reimplements game logic -
 * if you find yourself wanting to, add an export to web/core/core_api.c instead.
 *
 * The module needs no imports (verified by test/core.test.mjs), because board.c
 * and the codec touch only pure libc. It also has no allocator: the C side holds
 * one static Board and fixed scratch buffers.
 */
import coreUrl from "../wasm/core.wasm?url";
// Re-exported so callers can keep importing protocol values from the core.
export * from "./proto";

interface Raw {
  memory: WebAssembly.Memory;
  core_proto_version(): number;
  core_max_w(): number; core_max_h(): number;
  core_mp_w(): number; core_mp_h(): number; core_mp_mines(): number;
  core_max_name_len(): number; core_max_chat_len(): number;
  core_token_len(): number; core_max_payload(): number;
  core_srand(seed: number): void;
  core_board_init(w: number, h: number, mines: number): void;
  core_reveal(x: number, y: number): void;
  core_flag(x: number, y: number): void;
  core_chord(x: number, y: number): void;
  core_w(): number; core_h(): number; core_mines(): number;
  core_status(): number; core_first_move(): number;
  core_flags_placed(): number; core_revealed(): number;
  core_exploded_x(): number; core_exploded_y(): number;
  core_cell_is_revealed(x: number, y: number): number;
  core_snapshot(): number;
  core_cells_ptr(): number; core_tx_ptr(): number;
  core_in_ptr(): number; core_in_size(): number;
  core_avatar_random(out: number): void;
  core_pack_hello(name: number, skin: number, hair: number): number;
  core_pack_reconnect(token: number): number;
  core_pack_action_reveal(x: number, y: number): number;
  core_pack_action_flag(x: number, y: number, flagged: number): number;
  core_pack_action_chord(x: number, y: number): number;
  core_pack_chat(text: number): number;
  core_rx(type: number, buf: number, len: number): number;
  core_welcome_player_id(): number; core_welcome_version(): number;
  core_queue_position(): number;
  core_ms_w(): number; core_ms_h(): number; core_ms_mines(): number;
  core_ms_player_id(): number; core_ms_first_to_move(): number;
  core_ms_opp_skin(): number; core_ms_opp_hair(): number;
  core_ms_opp_name(): number; core_ms_token(): number;
  core_ro_player_id(): number; core_ro_w(): number; core_ro_h(): number;
  core_ro_mines(): number; core_ro_opp_skin(): number; core_ro_opp_hair(): number;
  core_ro_opp_name(): number;
  core_turn_player(): number;
  core_opp_state(): number; core_opp_grace(): number;
  core_end_reason(): number; core_end_score(i: number): number;
  core_err_code(): number; core_err_msg(): number;
  core_chat_text(): number;
  core_bs_mines_left(): number; core_bs_score(i: number): number;
  core_bs_elapsed(): number; core_bs_status(): number;
  core_bs_w(): number; core_bs_h(): number;
}

export interface MatchStart {
  w: number; h: number; mines: number;
  playerId: number;
  /**
   * NOT a player id - the wire field is a boolean meaning "is it YOUR turn",
   * because server.c:680 sends `(player_to_move == player_index) ? 1 : 0` and so
   * each player receives a different value. Resolve it against playerId; see
   * main.c:695 for the C doing the same.
   */
  youMoveFirst: boolean;
  opponentName: string; opponentSkin: number; opponentHair: number;
  token: Uint8Array;
}

export class Core {
  private constructor(private x: Raw) {}

  static async load(): Promise<Core> {
    const res = await fetch(coreUrl);
    if (!res.ok) throw new Error(`could not fetch core.wasm: ${res.status} ${res.statusText}`);
    // instantiateStreaming needs Content-Type: application/wasm. Some static
    // hosts (older nginx without the mime entry) serve it as octet-stream, so
    // fall back rather than failing - see the deploy notes.
    let inst: WebAssembly.Instance;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/wasm") && typeof WebAssembly.instantiateStreaming === "function") {
      inst = (await WebAssembly.instantiateStreaming(res, {})).instance;
    } else {
      inst = (await WebAssembly.instantiate(await res.arrayBuffer(), {})).instance;
    }
    const core = new Core(inst.exports as unknown as Raw);
    core.srand(Date.now() >>> 0);
    return core;
  }

  private get mem(): Uint8Array {
    return new Uint8Array(this.x.memory.buffer);
  }

  private readCStr(ptr: number, max = 256): string {
    const m = this.mem;
    let end = ptr;
    while (end < ptr + max && m[end] !== 0) end++;
    return new TextDecoder().decode(m.subarray(ptr, end));
  }

  /** Writes a NUL-terminated string into the C-side inbound buffer. */
  private writeIn(s: string): number {
    const ptr = this.x.core_in_ptr();
    const cap = this.x.core_in_size();
    const bytes = new TextEncoder().encode(s);
    const n = Math.min(bytes.length, cap - 1);
    const m = this.mem;
    m.set(bytes.subarray(0, n), ptr);
    m[ptr + n] = 0;
    return ptr;
  }

  // ---- constants, read from the C so TS never duplicates them ----
  readonly consts = {
    protoVersion: 0, maxW: 0, maxH: 0,
    mpW: 0, mpH: 0, mpMines: 0,
    maxNameLen: 0, maxChatLen: 0, tokenLen: 0, maxPayload: 0,
  };

  initConsts(): void {
    const c = this.consts;
    c.protoVersion = this.x.core_proto_version();
    c.maxW = this.x.core_max_w();
    c.maxH = this.x.core_max_h();
    c.mpW = this.x.core_mp_w();
    c.mpH = this.x.core_mp_h();
    c.mpMines = this.x.core_mp_mines();
    c.maxNameLen = this.x.core_max_name_len();
    c.maxChatLen = this.x.core_max_chat_len();
    c.tokenLen = this.x.core_token_len();
    c.maxPayload = this.x.core_max_payload();
  }

  srand(seed: number): void { this.x.core_srand(seed >>> 0); }

  // ---- board ----
  boardInit(w: number, h: number, mines: number): void { this.x.core_board_init(w, h, mines); }
  reveal(x: number, y: number): void { this.x.core_reveal(x, y); }
  flag(x: number, y: number): void { this.x.core_flag(x, y); }
  chord(x: number, y: number): void { this.x.core_chord(x, y); }

  get w(): number { return this.x.core_w(); }
  get h(): number { return this.x.core_h(); }
  get mines(): number { return this.x.core_mines(); }
  get status(): number { return this.x.core_status(); }
  get firstMove(): boolean { return this.x.core_first_move() !== 0; }
  get flagsPlaced(): number { return this.x.core_flags_placed(); }
  get revealedCount(): number { return this.x.core_revealed(); }
  get explodedX(): number { return this.x.core_exploded_x(); }
  get explodedY(): number { return this.x.core_exploded_y(); }
  isRevealed(x: number, y: number): boolean { return this.x.core_cell_is_revealed(x, y) !== 0; }

  /**
   * The single render input: w*h cell bytes in net_proto.h's encoding, for both
   * single-player and multiplayer. Returns a view into wasm memory, valid until
   * the next core call - the caller must not retain it.
   */
  snapshot(): Uint8Array {
    const n = this.x.core_snapshot();
    const p = this.x.core_cells_ptr();
    return this.mem.subarray(p, p + n);
  }

  avatarRandom(): { skin: number; hair: number } {
    const p = this.x.core_in_ptr();
    this.x.core_avatar_random(p);
    const m = this.mem;
    return { skin: m[p], hair: m[p + 1] };
  }

  // ---- outgoing: returns a copy, safe to hand to the socket ----
  private tx(len: number): Uint8Array {
    const p = this.x.core_tx_ptr();
    return this.mem.slice(p, p + len);
  }
  packHello(name: string, skin: number, hair: number): Uint8Array {
    return this.tx(this.x.core_pack_hello(this.writeIn(name), skin, hair));
  }
  packReconnect(token: Uint8Array): Uint8Array {
    const p = this.x.core_in_ptr();
    this.mem.set(token.subarray(0, this.consts.tokenLen), p);
    return this.tx(this.x.core_pack_reconnect(p));
  }
  packReveal(x: number, y: number): Uint8Array { return this.tx(this.x.core_pack_action_reveal(x, y)); }
  packFlag(x: number, y: number, flagged: boolean): Uint8Array {
    return this.tx(this.x.core_pack_action_flag(x, y, flagged ? 1 : 0));
  }
  packChord(x: number, y: number): Uint8Array { return this.tx(this.x.core_pack_action_chord(x, y)); }
  packChat(text: string): Uint8Array { return this.tx(this.x.core_pack_chat(this.writeIn(text))); }

  // ---- incoming ----
  /** Decodes into the C side's statics. Returns false on a malformed payload. */
  rx(type: number, payload: Uint8Array): boolean {
    // Most payloads fit the small inbound buffer; a BOARD_STATE snapshot does
    // not, so those land in the tx buffer instead, which is NET_MAX_PAYLOAD and
    // therefore always large enough. Neither aliases the decode destination.
    const dst = payload.length <= this.x.core_in_size() ? this.x.core_in_ptr() : this.x.core_tx_ptr();
    this.mem.set(payload, dst);
    return this.x.core_rx(type, dst, payload.length) !== 0;
  }

  get welcomePlayerId(): number { return this.x.core_welcome_player_id(); }
  get welcomeVersion(): number { return this.x.core_welcome_version(); }
  get queuePosition(): number { return this.x.core_queue_position(); }

  matchStart(): MatchStart {
    const tp = this.x.core_ms_token();
    return {
      w: this.x.core_ms_w(), h: this.x.core_ms_h(), mines: this.x.core_ms_mines(),
      playerId: this.x.core_ms_player_id(),
      youMoveFirst: this.x.core_ms_first_to_move() !== 0,
      opponentName: this.readCStr(this.x.core_ms_opp_name(), 17),
      opponentSkin: this.x.core_ms_opp_skin(), opponentHair: this.x.core_ms_opp_hair(),
      token: this.mem.slice(tp, tp + this.consts.tokenLen),
    };
  }

  reconnectOk(): Omit<MatchStart, "token" | "youMoveFirst"> {
    return {
      w: this.x.core_ro_w(), h: this.x.core_ro_h(), mines: this.x.core_ro_mines(),
      playerId: this.x.core_ro_player_id(),
      opponentName: this.readCStr(this.x.core_ro_opp_name(), 17),
      opponentSkin: this.x.core_ro_opp_skin(), opponentHair: this.x.core_ro_opp_hair(),
    };
  }

  get turnPlayer(): number { return this.x.core_turn_player(); }
  get oppState(): number { return this.x.core_opp_state(); }
  get oppGrace(): number { return this.x.core_opp_grace(); }
  get endReason(): number { return this.x.core_end_reason(); }
  endScore(i: number): number { return this.x.core_end_score(i); }
  get errCode(): number { return this.x.core_err_code(); }
  get errMsg(): string { return this.readCStr(this.x.core_err_msg(), 64); }
  get chatText(): string { return this.readCStr(this.x.core_chat_text(), 121); }

  // Multiplayer HUD numbers come off the snapshot message, NOT the Board:
  // wire_to_board leaves mines/flags_placed/revealed_count zeroed on purpose.
  get bsMinesLeft(): number { return this.x.core_bs_mines_left(); }
  bsScore(i: number): number { return this.x.core_bs_score(i); }
  get bsStatus(): number { return this.x.core_bs_status(); }
  get bsW(): number { return this.x.core_bs_w(); }
  get bsH(): number { return this.x.core_bs_h(); }
}
