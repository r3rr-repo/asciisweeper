#include "net_io.h"
#include <string.h>

/* ---- raw framed send/recv ---- */

static bool ssl_write_all(SSL *ssl, const uint8_t *data, size_t len)
{
    size_t off = 0;
    while (off < len) {
        int n = SSL_write(ssl, data + off, (int)(len - off));
        if (n <= 0)
            return false;
        off += (size_t)n;
    }
    return true;
}

static bool ssl_read_all(SSL *ssl, uint8_t *data, size_t len)
{
    size_t off = 0;
    while (off < len) {
        int n = SSL_read(ssl, data + off, (int)(len - off));
        if (n <= 0)
            return false;
        off += (size_t)n;
    }
    return true;
}

bool net_send_frame(SSL *ssl, uint8_t type, const uint8_t *payload, size_t len)
{
    if (len > NET_MAX_PAYLOAD)
        return false;
    uint8_t header[3];
    header[0] = type;
    header[1] = (uint8_t)((len >> 8) & 0xFF);
    header[2] = (uint8_t)(len & 0xFF);
    if (!ssl_write_all(ssl, header, sizeof(header)))
        return false;
    if (len > 0 && !ssl_write_all(ssl, payload, len))
        return false;
    return true;
}

bool net_recv_frame(SSL *ssl, NetFrame *out)
{
    uint8_t header[3];
    if (!ssl_read_all(ssl, header, sizeof(header)))
        return false;
    out->type = header[0];
    size_t len = ((size_t)header[1] << 8) | (size_t)header[2];
    if (len > NET_MAX_PAYLOAD)
        return false; /* protocol violation: oversized frame */
    if (len > 0 && !ssl_read_all(ssl, out->payload, len))
        return false;
    out->len = len;
    return true;
}

/* ---- byte-cursor helpers for pack/unpack ---- */

typedef struct { uint8_t *buf; size_t pos; } Writer;
typedef struct { const uint8_t *buf; size_t len; size_t pos; } Reader;

static void w_init(Writer *w, uint8_t *buf) { w->buf = buf; w->pos = 0; }
static void put_u8(Writer *w, uint8_t v) { w->buf[w->pos++] = v; }
static void put_u16(Writer *w, uint16_t v)
{
    w->buf[w->pos++] = (uint8_t)((v >> 8) & 0xFF);
    w->buf[w->pos++] = (uint8_t)(v & 0xFF);
}
static void put_u32(Writer *w, uint32_t v)
{
    w->buf[w->pos++] = (uint8_t)((v >> 24) & 0xFF);
    w->buf[w->pos++] = (uint8_t)((v >> 16) & 0xFF);
    w->buf[w->pos++] = (uint8_t)((v >> 8) & 0xFF);
    w->buf[w->pos++] = (uint8_t)(v & 0xFF);
}
static void put_i32(Writer *w, int32_t v) { put_u32(w, (uint32_t)v); }
static void put_bytes(Writer *w, const void *src, size_t n)
{
    memcpy(w->buf + w->pos, src, n);
    w->pos += n;
}
static void put_cstr_fixed(Writer *w, const char *s, size_t fixed_len)
{
    size_t n = strnlen(s, fixed_len);
    memcpy(w->buf + w->pos, s, n);
    memset(w->buf + w->pos + n, 0, fixed_len - n);
    w->pos += fixed_len;
}

static void r_init(Reader *r, const uint8_t *buf, size_t len) { r->buf = buf; r->len = len; r->pos = 0; }
static bool r_need(Reader *r, size_t n) { return r->pos + n <= r->len; }
static bool get_u8(Reader *r, uint8_t *out)
{
    if (!r_need(r, 1)) return false;
    *out = r->buf[r->pos++];
    return true;
}
static bool get_u16(Reader *r, uint16_t *out)
{
    if (!r_need(r, 2)) return false;
    *out = (uint16_t)(((uint16_t)r->buf[r->pos] << 8) | r->buf[r->pos + 1]);
    r->pos += 2;
    return true;
}
static bool get_u32(Reader *r, uint32_t *out)
{
    if (!r_need(r, 4)) return false;
    *out = ((uint32_t)r->buf[r->pos] << 24) | ((uint32_t)r->buf[r->pos + 1] << 16) |
           ((uint32_t)r->buf[r->pos + 2] << 8) | (uint32_t)r->buf[r->pos + 3];
    r->pos += 4;
    return true;
}
static bool get_i32(Reader *r, int32_t *out)
{
    uint32_t u;
    if (!get_u32(r, &u)) return false;
    *out = (int32_t)u;
    return true;
}
static bool get_bytes(Reader *r, void *dst, size_t n)
{
    if (!r_need(r, n)) return false;
    memcpy(dst, r->buf + r->pos, n);
    r->pos += n;
    return true;
}
static bool get_cstr_fixed(Reader *r, char *dst, size_t fixed_len)
{
    if (!r_need(r, fixed_len)) return false;
    memcpy(dst, r->buf + r->pos, fixed_len);
    dst[fixed_len] = '\0';
    r->pos += fixed_len;
    return true;
}

/* ---- message pack/unpack ---- */

size_t pack_hello(uint8_t *buf, const MsgHello *m)
{
    Writer w; w_init(&w, buf);
    put_u8(&w, m->protocol_version);
    put_cstr_fixed(&w, m->name, NET_MAX_NAME_LEN);
    return w.pos;
}
bool unpack_hello(const uint8_t *buf, size_t len, MsgHello *out)
{
    Reader r; r_init(&r, buf, len);
    if (!get_u8(&r, &out->protocol_version)) return false;
    if (!get_cstr_fixed(&r, out->name, NET_MAX_NAME_LEN)) return false;
    return true;
}

size_t pack_reconnect(uint8_t *buf, const MsgReconnect *m)
{
    Writer w; w_init(&w, buf);
    put_bytes(&w, m->token, NET_TOKEN_LEN);
    return w.pos;
}
bool unpack_reconnect(const uint8_t *buf, size_t len, MsgReconnect *out)
{
    Reader r; r_init(&r, buf, len);
    return get_bytes(&r, out->token, NET_TOKEN_LEN);
}

size_t pack_action_reveal(uint8_t *buf, const MsgActionReveal *m)
{
    Writer w; w_init(&w, buf);
    put_u8(&w, m->x);
    put_u8(&w, m->y);
    return w.pos;
}
bool unpack_action_reveal(const uint8_t *buf, size_t len, MsgActionReveal *out)
{
    Reader r; r_init(&r, buf, len);
    if (!get_u8(&r, &out->x)) return false;
    if (!get_u8(&r, &out->y)) return false;
    return true;
}

size_t pack_action_flag(uint8_t *buf, const MsgActionFlag *m)
{
    Writer w; w_init(&w, buf);
    put_u8(&w, m->x);
    put_u8(&w, m->y);
    put_u8(&w, m->flagged);
    return w.pos;
}
bool unpack_action_flag(const uint8_t *buf, size_t len, MsgActionFlag *out)
{
    Reader r; r_init(&r, buf, len);
    if (!get_u8(&r, &out->x)) return false;
    if (!get_u8(&r, &out->y)) return false;
    if (!get_u8(&r, &out->flagged)) return false;
    return true;
}

size_t pack_action_chord(uint8_t *buf, const MsgActionChord *m)
{
    Writer w; w_init(&w, buf);
    put_u8(&w, m->x);
    put_u8(&w, m->y);
    return w.pos;
}
bool unpack_action_chord(const uint8_t *buf, size_t len, MsgActionChord *out)
{
    Reader r; r_init(&r, buf, len);
    if (!get_u8(&r, &out->x)) return false;
    if (!get_u8(&r, &out->y)) return false;
    return true;
}

size_t pack_welcome(uint8_t *buf, const MsgWelcome *m)
{
    Writer w; w_init(&w, buf);
    put_u8(&w, m->protocol_version);
    put_u8(&w, m->player_id);
    return w.pos;
}
bool unpack_welcome(const uint8_t *buf, size_t len, MsgWelcome *out)
{
    Reader r; r_init(&r, buf, len);
    if (!get_u8(&r, &out->protocol_version)) return false;
    if (!get_u8(&r, &out->player_id)) return false;
    return true;
}

size_t pack_queue_status(uint8_t *buf, const MsgQueueStatus *m)
{
    Writer w; w_init(&w, buf);
    put_u16(&w, m->position);
    return w.pos;
}
bool unpack_queue_status(const uint8_t *buf, size_t len, MsgQueueStatus *out)
{
    Reader r; r_init(&r, buf, len);
    return get_u16(&r, &out->position);
}

size_t pack_match_start(uint8_t *buf, const MsgMatchStart *m)
{
    Writer w; w_init(&w, buf);
    put_u8(&w, m->w);
    put_u8(&w, m->h);
    put_u16(&w, m->mines);
    put_cstr_fixed(&w, m->opponent_name, NET_MAX_NAME_LEN);
    put_u8(&w, m->your_player_id);
    put_u8(&w, m->first_to_move);
    put_bytes(&w, m->session_token, NET_TOKEN_LEN);
    return w.pos;
}
bool unpack_match_start(const uint8_t *buf, size_t len, MsgMatchStart *out)
{
    Reader r; r_init(&r, buf, len);
    if (!get_u8(&r, &out->w)) return false;
    if (!get_u8(&r, &out->h)) return false;
    if (!get_u16(&r, &out->mines)) return false;
    if (!get_cstr_fixed(&r, out->opponent_name, NET_MAX_NAME_LEN)) return false;
    if (!get_u8(&r, &out->your_player_id)) return false;
    if (!get_u8(&r, &out->first_to_move)) return false;
    if (!get_bytes(&r, out->session_token, NET_TOKEN_LEN)) return false;
    return true;
}

size_t pack_reconnect_ok(uint8_t *buf, const MsgReconnectOk *m)
{
    Writer w; w_init(&w, buf);
    put_u8(&w, m->your_player_id);
    put_u8(&w, m->w);
    put_u8(&w, m->h);
    put_u16(&w, m->mines);
    put_cstr_fixed(&w, m->opponent_name, NET_MAX_NAME_LEN);
    return w.pos;
}
bool unpack_reconnect_ok(const uint8_t *buf, size_t len, MsgReconnectOk *out)
{
    Reader r; r_init(&r, buf, len);
    if (!get_u8(&r, &out->your_player_id)) return false;
    if (!get_u8(&r, &out->w)) return false;
    if (!get_u8(&r, &out->h)) return false;
    if (!get_u16(&r, &out->mines)) return false;
    if (!get_cstr_fixed(&r, out->opponent_name, NET_MAX_NAME_LEN)) return false;
    return true;
}

size_t pack_board_state(uint8_t *buf, const MsgBoardState *m)
{
    Writer w; w_init(&w, buf);
    put_u8(&w, m->w);
    put_u8(&w, m->h);
    for (int y = 0; y < m->h; y++)
        for (int x = 0; x < m->w; x++)
            put_u8(&w, m->cells[y][x]);
    put_u16(&w, m->mines_left);
    put_i32(&w, m->scores[0]);
    put_i32(&w, m->scores[1]);
    put_u16(&w, m->elapsed_seconds);
    put_u8(&w, m->status);
    put_u8(&w, m->exploded_x);
    put_u8(&w, m->exploded_y);
    return w.pos;
}
bool unpack_board_state(const uint8_t *buf, size_t len, MsgBoardState *out)
{
    Reader r; r_init(&r, buf, len);
    if (!get_u8(&r, &out->w)) return false;
    if (!get_u8(&r, &out->h)) return false;
    /* Bounds-check before indexing out->cells: a corrupt/hostile peer
     * declaring an oversized board must not overflow this buffer. */
    if (out->w > MAX_W || out->h > MAX_H) return false;
    for (int y = 0; y < out->h; y++)
        for (int x = 0; x < out->w; x++)
            if (!get_u8(&r, &out->cells[y][x])) return false;
    if (!get_u16(&r, &out->mines_left)) return false;
    if (!get_i32(&r, &out->scores[0])) return false;
    if (!get_i32(&r, &out->scores[1])) return false;
    if (!get_u16(&r, &out->elapsed_seconds)) return false;
    if (!get_u8(&r, &out->status)) return false;
    if (!get_u8(&r, &out->exploded_x)) return false;
    if (!get_u8(&r, &out->exploded_y)) return false;
    return true;
}

size_t pack_turn(uint8_t *buf, const MsgTurn *m)
{
    Writer w; w_init(&w, buf);
    put_u8(&w, m->player_id_to_move);
    return w.pos;
}
bool unpack_turn(const uint8_t *buf, size_t len, MsgTurn *out)
{
    Reader r; r_init(&r, buf, len);
    return get_u8(&r, &out->player_id_to_move);
}

size_t pack_opponent_status(uint8_t *buf, const MsgOpponentStatus *m)
{
    Writer w; w_init(&w, buf);
    put_u8(&w, m->state);
    put_u16(&w, m->grace_seconds);
    return w.pos;
}
bool unpack_opponent_status(const uint8_t *buf, size_t len, MsgOpponentStatus *out)
{
    Reader r; r_init(&r, buf, len);
    if (!get_u8(&r, &out->state)) return false;
    if (!get_u16(&r, &out->grace_seconds)) return false;
    return true;
}

size_t pack_match_end(uint8_t *buf, const MsgMatchEnd *m)
{
    Writer w; w_init(&w, buf);
    put_u8(&w, m->reason);
    put_i32(&w, m->scores[0]);
    put_i32(&w, m->scores[1]);
    return w.pos;
}
bool unpack_match_end(const uint8_t *buf, size_t len, MsgMatchEnd *out)
{
    Reader r; r_init(&r, buf, len);
    if (!get_u8(&r, &out->reason)) return false;
    if (!get_i32(&r, &out->scores[0])) return false;
    if (!get_i32(&r, &out->scores[1])) return false;
    return true;
}

size_t pack_error(uint8_t *buf, const MsgError *m)
{
    Writer w; w_init(&w, buf);
    put_u8(&w, m->code);
    put_cstr_fixed(&w, m->message, NET_ERR_MSG_LEN);
    return w.pos;
}
bool unpack_error(const uint8_t *buf, size_t len, MsgError *out)
{
    Reader r; r_init(&r, buf, len);
    if (!get_u8(&r, &out->code)) return false;
    char tmp[NET_ERR_MSG_LEN + 1];
    if (!get_cstr_fixed(&r, tmp, NET_ERR_MSG_LEN)) return false;
    memcpy(out->message, tmp, NET_ERR_MSG_LEN);
    return true;
}

/* ---- Board <-> wire snapshot ---- */

void board_to_wire(const Board *b, int mines_left, const int32_t scores[2],
                    int elapsed_seconds, MsgBoardState *out)
{
    memset(out, 0, sizeof(*out));
    out->w = (uint8_t)b->w;
    out->h = (uint8_t)b->h;
    for (int y = 0; y < b->h; y++) {
        for (int x = 0; x < b->w; x++) {
            const Cell *c = &b->cells[y][x];
            uint8_t byte = 0;
            if (c->revealed) {
                byte |= CELL_BIT_REVEALED;
                if (c->mine)
                    byte |= CELL_BIT_MINE;
                else
                    byte |= (uint8_t)(c->adjacent & CELL_ADJACENT_MASK);
            }
            if (c->flagged)
                byte |= CELL_BIT_FLAGGED;
            out->cells[y][x] = byte;
        }
    }
    out->mines_left = (uint16_t)(mines_left < 0 ? 0 : mines_left);
    out->scores[0] = scores[0];
    out->scores[1] = scores[1];
    out->elapsed_seconds = (uint16_t)elapsed_seconds;
    out->status = (uint8_t)b->status;
    out->exploded_x = (b->exploded_x < 0) ? 0xFF : (uint8_t)b->exploded_x;
    out->exploded_y = (b->exploded_y < 0) ? 0xFF : (uint8_t)b->exploded_y;
}

void wire_to_board(const MsgBoardState *m, Board *out)
{
    memset(out, 0, sizeof(*out));
    out->w = m->w;
    out->h = m->h;
    for (int y = 0; y < m->h; y++) {
        for (int x = 0; x < m->w; x++) {
            uint8_t byte = m->cells[y][x];
            Cell *c = &out->cells[y][x];
            c->revealed = (byte & CELL_BIT_REVEALED) != 0;
            c->flagged = (byte & CELL_BIT_FLAGGED) != 0;
            if (c->revealed) {
                c->mine = (byte & CELL_BIT_MINE) != 0;
                c->adjacent = byte & CELL_ADJACENT_MASK;
            }
        }
    }
    out->status = (GameStatus)m->status;
    out->exploded_x = (m->exploded_x == 0xFF) ? -1 : (int)m->exploded_x;
    out->exploded_y = (m->exploded_y == 0xFF) ? -1 : (int)m->exploded_y;
    /* mines, flags_placed, revealed_count, first_move intentionally left
     * at zero: the multiplayer HUD reads mines_left/scores directly off
     * MsgBoardState instead of through these single-player-only fields. */
}
