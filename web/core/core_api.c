/*
 * core_api.c - wasm export surface for the browser client.
 *
 * Wraps the UNMODIFIED src/board.c and src/net_io.c so JavaScript never needs
 * to know struct Board's layout, and so the Minesweeper rules and the wire
 * protocol are defined exactly once for the terminal client, the server and
 * the browser. Built only by build-web.sh; the native CMake build never sees
 * this file. See shim/openssl/ssl.h for why net_io.c compiles here unedited.
 *
 * Conventions:
 *   - One static Board. The client is only ever in single-player OR rendering a
 *     multiplayer snapshot, never both, so there is no need for malloc and the
 *     module has no allocator to initialise.
 *   - Every x/y entry point bounds-checks. board.c deliberately does not
 *     (main.c guards with its cursor), but the browser has mouse input, which
 *     can produce coordinates outside the board.
 *   - Strings are returned as pointers into static storage; JS decodes NUL
 *     terminated UTF-8 from the exported memory.
 */
#include <string.h>
#include <stdlib.h>

#include "board.h"
#include "net_proto.h"
#include "net_io.h"
#include "uuid.h"

#define WASM_EXPORT(n) __attribute__((export_name(n), used))

static Board            g_board;
static MsgBoardState    g_bs;           /* last applied multiplayer snapshot */
static uint8_t          g_cells[MAX_W * MAX_H];
static uint8_t          g_tx[NET_MAX_PAYLOAD];   /* outgoing: packed payload */
/* Inbound scratch for JS -> wasm strings and tokens. Separate from g_tx so a
 * pack_* call can never read its own input out from under itself. Sized for the
 * largest thing JS passes in (a chat line, NET_CHAT_MSG_LEN = 120). */
static uint8_t          g_in[256];

static MsgWelcome       g_welcome;
static MsgQueueStatus   g_queue;
static MsgMatchStart    g_match_start;
static MsgReconnectOk   g_reconnect_ok;
static MsgTurn          g_turn;
static MsgOpponentStatus g_oppstat;
static MsgMatchEnd      g_match_end;
static MsgError         g_error;
static MsgChatRecv      g_chat;

/* ---- compile-time constants, so TS never duplicates them ---- */

WASM_EXPORT("core_proto_version") int core_proto_version(void) { return NET_PROTO_VERSION; }
WASM_EXPORT("core_max_w")         int core_max_w(void)         { return MAX_W; }
WASM_EXPORT("core_max_h")         int core_max_h(void)         { return MAX_H; }
WASM_EXPORT("core_mp_w")          int core_mp_w(void)          { return MP_BOARD_W; }
WASM_EXPORT("core_mp_h")          int core_mp_h(void)          { return MP_BOARD_H; }
WASM_EXPORT("core_mp_mines")      int core_mp_mines(void)      { return MP_MINES; }
WASM_EXPORT("core_max_name_len")  int core_max_name_len(void)  { return NET_MAX_NAME_LEN; }
WASM_EXPORT("core_max_chat_len")  int core_max_chat_len(void)  { return NET_CHAT_MSG_LEN; }
WASM_EXPORT("core_token_len")     int core_token_len(void)     { return NET_TOKEN_LEN; }
WASM_EXPORT("core_max_payload")   int core_max_payload(void)   { return NET_MAX_PAYLOAD; }

/* ---- rng ---- */

WASM_EXPORT("core_srand") void core_srand(unsigned seed) { srand(seed); }

/* ---- single-player board ---- */

WASM_EXPORT("core_board_init")
void core_board_init(int w, int h, int mines)
{
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    if (w > MAX_W) w = MAX_W;
    if (h > MAX_H) h = MAX_H;
    /* board_place_mines loops until it has placed `mines` of them, so a count
     * at or above the placeable area would spin forever. The 3x3 around the
     * first click is excluded, hence the -9 rather than -1. */
    int max_mines = w * h - 9;
    if (max_mines < 1) max_mines = 1;
    if (mines < 1) mines = 1;
    if (mines > max_mines) mines = max_mines;
    board_init(&g_board, w, h, mines);
}

WASM_EXPORT("core_reveal")
void core_reveal(int x, int y)
{
    if (board_in_bounds(&g_board, x, y)) board_reveal_cell(&g_board, x, y);
}

WASM_EXPORT("core_flag")
void core_flag(int x, int y)
{
    if (board_in_bounds(&g_board, x, y)) board_toggle_flag(&g_board, x, y);
}

WASM_EXPORT("core_chord")
void core_chord(int x, int y)
{
    if (board_in_bounds(&g_board, x, y)) board_chord_cell(&g_board, x, y);
}

WASM_EXPORT("core_w")             int core_w(void)             { return g_board.w; }
WASM_EXPORT("core_h")             int core_h(void)             { return g_board.h; }
WASM_EXPORT("core_mines")         int core_mines(void)         { return g_board.mines; }
WASM_EXPORT("core_status")        int core_status(void)        { return (int)g_board.status; }
WASM_EXPORT("core_first_move")    int core_first_move(void)    { return g_board.first_move ? 1 : 0; }
WASM_EXPORT("core_flags_placed")  int core_flags_placed(void)  { return g_board.flags_placed; }
WASM_EXPORT("core_revealed")      int core_revealed(void)      { return g_board.revealed_count; }
WASM_EXPORT("core_exploded_x")    int core_exploded_x(void)    { return g_board.exploded_x; }
WASM_EXPORT("core_exploded_y")    int core_exploded_y(void)    { return g_board.exploded_y; }

WASM_EXPORT("core_cell_is_revealed")
int core_cell_is_revealed(int x, int y)
{
    if (!board_in_bounds(&g_board, x, y)) return 0;
    return g_board.cells[y][x].revealed ? 1 : 0;
}

/*
 * The single render input format, for BOTH single-player and multiplayer.
 *
 * Reuses board_to_wire's cell encoding (net_proto.h: bit7 revealed, bit6
 * flagged, bit5 mine-when-revealed, bits0-3 adjacent) so draw_board has exactly
 * one thing to decode, mirroring the fact that the C draw_board already serves
 * both modes. Writes w*h bytes tightly packed (board_to_wire's own array is
 * MAX_W-strided) and returns that count.
 */
WASM_EXPORT("core_snapshot")
int core_snapshot(void)
{
    static const int32_t zero_scores[2] = { 0, 0 };
    MsgBoardState bs;
    board_to_wire(&g_board, g_board.mines - g_board.flags_placed, zero_scores, 0, &bs);
    int n = 0;
    for (int y = 0; y < g_board.h; y++)
        for (int x = 0; x < g_board.w; x++)
            g_cells[n++] = bs.cells[y][x];
    return n;
}

WASM_EXPORT("core_cells_ptr") const uint8_t *core_cells_ptr(void) { return g_cells; }
WASM_EXPORT("core_tx_ptr")    uint8_t       *core_tx_ptr(void)    { return g_tx; }
WASM_EXPORT("core_in_ptr")    uint8_t       *core_in_ptr(void)    { return g_in; }
WASM_EXPORT("core_in_size")   int            core_in_size(void)   { return (int)sizeof(g_in); }

/* ---- avatar (keeps the "skip COLOR_BLACK, reserved for eyes" rule here) ---- */

/* Mirrors avatar_random() in src/avatar.c: 1-7, never 0 (COLOR_BLACK), which is
 * reserved for eyes so they always contrast against the chosen skin and hair. */
WASM_EXPORT("core_avatar_random")
void core_avatar_random(uint8_t *out_skin_hair)
{
    out_skin_hair[0] = (uint8_t)(1 + rand() % 7);
    out_skin_hair[1] = (uint8_t)(1 + rand() % 7);
}

/* ---- player identity ----
 *
 * The browser reaches the SAME uuid.c the terminal client uses, rather than
 * reimplementing RFC 9562 in TypeScript. Clock and entropy come from JS
 * (Date.now and crypto.getRandomValues) because this module has no imports and
 * therefore no access to either.
 *
 * `unix_ms` is a double: JS numbers hold milliseconds exactly well past any
 * plausible date, and it avoids i64/BigInt at the boundary.
 */
WASM_EXPORT("core_uuid_v7")
void core_uuid_v7(double unix_ms, const uint8_t *rnd10, uint8_t *out16)
{
    uuid_v7(out16, (uint64_t)unix_ms, rnd10);
}

WASM_EXPORT("core_uuid_is_v7")
int core_uuid_is_v7(const uint8_t *u) { return uuid_is_v7(u) ? 1 : 0; }

/* Writes the canonical 36-character form plus a terminator. */
WASM_EXPORT("core_uuid_format")
void core_uuid_format(const uint8_t *u, char *out) { uuid_format(u, out); }

WASM_EXPORT("core_uuid_parse")
int core_uuid_parse(const char *s, uint8_t *out) { return uuid_parse(s, out) ? 1 : 0; }

WASM_EXPORT("core_hex_encode")
void core_hex_encode(const uint8_t *in, int len, char *out) { hex_encode(in, (size_t)len, out); }

WASM_EXPORT("core_hex_decode")
int core_hex_decode(const char *s, uint8_t *out, int len) { return hex_decode(s, out, (size_t)len) ? 1 : 0; }

WASM_EXPORT("core_uuid_len")   int core_uuid_len(void)   { return NET_UUID_LEN; }
WASM_EXPORT("core_secret_len") int core_secret_len(void) { return NET_SECRET_LEN; }

/* ---- outgoing messages: pack into g_tx, return payload length ---- */

WASM_EXPORT("core_pack_hello")
int core_pack_hello(const char *name, int skin, int hair,
                    const uint8_t *uuid, const uint8_t *secret)
{
    MsgHello m;
    memset(&m, 0, sizeof(m));
    m.protocol_version = NET_PROTO_VERSION;
    strncpy(m.name, name, NET_MAX_NAME_LEN);
    m.name[NET_MAX_NAME_LEN] = '\0';
    m.avatar_skin = (uint8_t)skin;
    m.avatar_hair = (uint8_t)hair;
    memcpy(m.player_uuid, uuid, NET_UUID_LEN);
    memcpy(m.player_secret, secret, NET_SECRET_LEN);
    return (int)pack_hello(g_tx, &m);
}

WASM_EXPORT("core_pack_reconnect")
int core_pack_reconnect(const uint8_t *token)
{
    MsgReconnect m;
    memcpy(m.token, token, NET_TOKEN_LEN);
    return (int)pack_reconnect(g_tx, &m);
}

WASM_EXPORT("core_pack_action_reveal")
int core_pack_action_reveal(int x, int y)
{
    MsgActionReveal m; m.x = (uint8_t)x; m.y = (uint8_t)y;
    return (int)pack_action_reveal(g_tx, &m);
}

WASM_EXPORT("core_pack_action_flag")
int core_pack_action_flag(int x, int y, int flagged)
{
    MsgActionFlag m; m.x = (uint8_t)x; m.y = (uint8_t)y; m.flagged = (uint8_t)(flagged ? 1 : 0);
    return (int)pack_action_flag(g_tx, &m);
}

WASM_EXPORT("core_pack_action_chord")
int core_pack_action_chord(int x, int y)
{
    MsgActionChord m; m.x = (uint8_t)x; m.y = (uint8_t)y;
    return (int)pack_action_chord(g_tx, &m);
}

WASM_EXPORT("core_pack_chat")
int core_pack_chat(const char *text)
{
    MsgChat m;
    memset(&m, 0, sizeof(m));
    strncpy(m.text, text, NET_CHAT_MSG_LEN);
    m.text[NET_CHAT_MSG_LEN] = '\0';
    return (int)pack_chat(g_tx, &m);
}

/* ---- incoming messages ---- */

/* Decode a received payload into this module's static storage. Returns 1 on
 * success, 0 if the payload was malformed/short. Read the fields afterwards
 * with the typed accessors below - no offset table to keep in sync. */
WASM_EXPORT("core_rx")
int core_rx(int type, const uint8_t *buf, int len)
{
    size_t n = (size_t)len;
    switch (type) {
        case MSG_WELCOME:         return unpack_welcome(buf, n, &g_welcome) ? 1 : 0;
        case MSG_QUEUE_STATUS:    return unpack_queue_status(buf, n, &g_queue) ? 1 : 0;
        case MSG_MATCH_START:     return unpack_match_start(buf, n, &g_match_start) ? 1 : 0;
        case MSG_RECONNECT_OK:    return unpack_reconnect_ok(buf, n, &g_reconnect_ok) ? 1 : 0;
        case MSG_TURN:            return unpack_turn(buf, n, &g_turn) ? 1 : 0;
        case MSG_OPPONENT_STATUS: return unpack_opponent_status(buf, n, &g_oppstat) ? 1 : 0;
        case MSG_MATCH_END:       return unpack_match_end(buf, n, &g_match_end) ? 1 : 0;
        case MSG_ERROR:           return unpack_error(buf, n, &g_error) ? 1 : 0;
        case MSG_CHAT_RECV:       return unpack_chat_recv(buf, n, &g_chat) ? 1 : 0;
        case MSG_PONG:            return 1; /* no payload */
        case MSG_BOARD_STATE:
            if (!unpack_board_state(buf, n, &g_bs)) return 0;
            wire_to_board(&g_bs, &g_board);
            return 1;
        default: return 0;
    }
}

WASM_EXPORT("core_welcome_player_id") int core_welcome_player_id(void) { return g_welcome.player_id; }
WASM_EXPORT("core_welcome_version")   int core_welcome_version(void)   { return g_welcome.protocol_version; }
WASM_EXPORT("core_queue_position")    int core_queue_position(void)    { return g_queue.position; }

WASM_EXPORT("core_ms_w")            int core_ms_w(void)            { return g_match_start.w; }
WASM_EXPORT("core_ms_h")            int core_ms_h(void)            { return g_match_start.h; }
WASM_EXPORT("core_ms_mines")        int core_ms_mines(void)        { return g_match_start.mines; }
WASM_EXPORT("core_ms_player_id")    int core_ms_player_id(void)    { return g_match_start.your_player_id; }
WASM_EXPORT("core_ms_first_to_move")int core_ms_first_to_move(void){ return g_match_start.first_to_move; }
WASM_EXPORT("core_ms_opp_skin")     int core_ms_opp_skin(void)     { return g_match_start.opponent_avatar_skin; }
WASM_EXPORT("core_ms_opp_hair")     int core_ms_opp_hair(void)     { return g_match_start.opponent_avatar_hair; }
WASM_EXPORT("core_ms_opp_name")     const char    *core_ms_opp_name(void) { return g_match_start.opponent_name; }
WASM_EXPORT("core_ms_token")        const uint8_t *core_ms_token(void)    { return g_match_start.session_token; }

WASM_EXPORT("core_ro_player_id") int core_ro_player_id(void) { return g_reconnect_ok.your_player_id; }
WASM_EXPORT("core_ro_w")         int core_ro_w(void)         { return g_reconnect_ok.w; }
WASM_EXPORT("core_ro_h")         int core_ro_h(void)         { return g_reconnect_ok.h; }
WASM_EXPORT("core_ro_mines")     int core_ro_mines(void)     { return g_reconnect_ok.mines; }
WASM_EXPORT("core_ro_opp_skin")  int core_ro_opp_skin(void)  { return g_reconnect_ok.opponent_avatar_skin; }
WASM_EXPORT("core_ro_opp_hair")  int core_ro_opp_hair(void)  { return g_reconnect_ok.opponent_avatar_hair; }
WASM_EXPORT("core_ro_opp_name")  const char *core_ro_opp_name(void) { return g_reconnect_ok.opponent_name; }

WASM_EXPORT("core_turn_player")  int core_turn_player(void)  { return g_turn.player_id_to_move; }

WASM_EXPORT("core_opp_state")    int core_opp_state(void)    { return g_oppstat.state; }
WASM_EXPORT("core_opp_grace")    int core_opp_grace(void)    { return g_oppstat.grace_seconds; }

WASM_EXPORT("core_end_reason")   int core_end_reason(void)   { return g_match_end.reason; }
WASM_EXPORT("core_end_score")    int core_end_score(int i)   { return (i == 0 || i == 1) ? g_match_end.scores[i] : 0; }

WASM_EXPORT("core_err_code")     int core_err_code(void)     { return g_error.code; }
WASM_EXPORT("core_err_msg")      const char *core_err_msg(void) { return g_error.message; }

WASM_EXPORT("core_chat_text")    const char *core_chat_text(void) { return g_chat.text; }

/* Multiplayer HUD numbers come straight off the snapshot message, NOT off the
 * Board: wire_to_board deliberately leaves mines/flags_placed/revealed_count
 * zeroed (see the comment at the end of src/net_io.c). */
WASM_EXPORT("core_bs_mines_left") int core_bs_mines_left(void) { return g_bs.mines_left; }
WASM_EXPORT("core_bs_score")      int core_bs_score(int i)     { return (i == 0 || i == 1) ? g_bs.scores[i] : 0; }
WASM_EXPORT("core_bs_elapsed")    int core_bs_elapsed(void)    { return g_bs.elapsed_seconds; }
WASM_EXPORT("core_bs_status")     int core_bs_status(void)     { return g_bs.status; }
WASM_EXPORT("core_bs_w")          int core_bs_w(void)          { return g_bs.w; }
WASM_EXPORT("core_bs_h")          int core_bs_h(void)          { return g_bs.h; }
