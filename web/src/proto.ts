/*
 * Constants mirrored from src/net_proto.h and src/board.h.
 *
 * Deliberately separate from core.ts: core.ts imports the .wasm through Vite's
 * ?url, which only a bundler understands, so anything that needs these values in
 * plain Node - the render tests, for instance - could not import them from
 * there. Keeping them here means the draw code is testable without a browser or
 * a GPU.
 *
 * These are the only protocol values duplicated in TypeScript, and they are all
 * compile-time constants that the wasm core also reports at runtime (core_*
 * getters), so test/core.test.mjs asserts the two agree.
 */

/** Cell byte layout, src/net_proto.h:128-135. */
export const CELL_REVEALED = 0x80;
export const CELL_FLAGGED = 0x40;
export const CELL_MINE = 0x20;
/** Only meaningful with CELL_FLAGGED: clear = player 0's flag, set = player 1's. */
export const CELL_FLAG_P1 = 0x10;
export const CELL_ADJACENT = 0x0f;

/** GameStatus, src/board.h:16. */
export const PLAYING = 0;
export const WON = 1;
export const LOST = 2;

/** MsgType, src/net_proto.h:20-43. */
export const MSG = {
  HELLO: 0x01, RECONNECT: 0x02, ACTION_REVEAL: 0x03, ACTION_FLAG: 0x04,
  ACTION_CHORD: 0x05, PING: 0x06, CHAT: 0x07, REQUEST_REMATCH: 0x08,
  WELCOME: 0x81, QUEUE_STATUS: 0x82, MATCH_START: 0x83, BOARD_STATE: 0x84,
  TURN: 0x85, OPPONENT_STATUS: 0x86, MATCH_END: 0x87, ERROR: 0x88,
  RECONNECT_OK: 0x89, PONG: 0x8a, CHAT_RECV: 0x8b,
} as const;

/** MatchEndReason, src/net_proto.h:45-49. */
export const END_CLEAN_CLEAR = 1;
export const END_BOMB = 2;
export const END_OPPONENT_LEFT = 3;

/** OpponentStatusState, src/net_proto.h:51-54. */
export const OPP_DISCONNECTED = 1;
export const OPP_RECONNECTED = 2;
