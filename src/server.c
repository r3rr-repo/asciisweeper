/*
 * asciisweeper-server - authoritative matchmaking + game server for
 * turn-based multiplayer asciisweeper.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <time.h>
#include <pthread.h>
#include <ctype.h>
#include <signal.h>

#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>

#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/rand.h>

#include "board.h"
#include "net_proto.h"
#include "net_io.h"

#define MAX_QUEUE            64
#define MAX_TOKENS           128
#define RATE_LIMIT_SLOTS     256
#define MAX_CONNECTIONS      500

#define READ_TIMEOUT_SECONDS       1   /* poll tick for every blocking read */
#define HANDSHAKE_TIMEOUT_SECONDS  10
#define HELLO_TIMEOUT_SECONDS      10
#define IDLE_DISCONNECT_SECONDS    90  /* total silence before treating a connection as dead */
#define RECONNECT_GRACE_SECONDS    60
/* Per-IP throttling blunts a single actor flooding the queue with fake
 * players, without punishing two legitimate players who happen to share
 * a NAT/public IP and queue up close together in time - bounding how many
 * connections one IP can have queued/in-match at once is the meaningful
 * defense here, not a minimum delay between joins. */
#define MAX_QUEUED_PER_IP          4

static volatile sig_atomic_t g_shutdown = 0;
static int g_active_connections = 0;
static pthread_mutex_t g_active_connections_lock = PTHREAD_MUTEX_INITIALIZER;

/* ---------------- connection ---------------- */

typedef struct Connection {
    SSL *ssl;
    int fd;
    struct in_addr ip;
    char name[NET_MAX_NAME_LEN + 1];

    pthread_mutex_t state_lock;
    struct Match *assigned_match; /* set by whichever thread completes the pairing */
    int assigned_player_index;
} Connection;

static Connection *connection_new(SSL *ssl, int fd, struct in_addr ip)
{
    Connection *c = calloc(1, sizeof(*c));
    c->ssl = ssl;
    c->fd = fd;
    c->ip = ip;
    pthread_mutex_init(&c->state_lock, NULL);
    return c;
}

static void connection_free(Connection *c)
{
    if (!c) return;
    if (c->ssl) {
        SSL_shutdown(c->ssl);
        SSL_free(c->ssl);
    }
    if (c->fd >= 0) close(c->fd);
    pthread_mutex_destroy(&c->state_lock);
    free(c);
}

/* ---------------- match ---------------- */

typedef struct Match {
    pthread_mutex_t lock;
    Board board;
    int scores[2];
    int player_to_move;
    Connection *conns[2];
    bool connected[2];
    time_t disconnected_at[2];
    uint8_t token[2][NET_TOKEN_LEN];
    char names[2][NET_MAX_NAME_LEN + 1];
    bool active;
    int refcount; /* one per thread still working on this match; freed at 0 */
} Match;

typedef struct {
    bool used;
    uint8_t token[NET_TOKEN_LEN];
    Match *match;
    int player_index;
} TokenEntry;

static TokenEntry g_tokens[MAX_TOKENS];
static pthread_mutex_t g_tokens_lock = PTHREAD_MUTEX_INITIALIZER;

static void token_register(const uint8_t token[NET_TOKEN_LEN], Match *m, int player_index)
{
    pthread_mutex_lock(&g_tokens_lock);
    for (int i = 0; i < MAX_TOKENS; i++) {
        if (!g_tokens[i].used) {
            g_tokens[i].used = true;
            memcpy(g_tokens[i].token, token, NET_TOKEN_LEN);
            g_tokens[i].match = m;
            g_tokens[i].player_index = player_index;
            break;
        }
    }
    pthread_mutex_unlock(&g_tokens_lock);
}

static bool token_lookup(const uint8_t token[NET_TOKEN_LEN], Match **out_match, int *out_player_index)
{
    bool found = false;
    pthread_mutex_lock(&g_tokens_lock);
    for (int i = 0; i < MAX_TOKENS; i++) {
        if (g_tokens[i].used && memcmp(g_tokens[i].token, token, NET_TOKEN_LEN) == 0) {
            *out_match = g_tokens[i].match;
            *out_player_index = g_tokens[i].player_index;
            found = true;
            break;
        }
    }
    pthread_mutex_unlock(&g_tokens_lock);
    return found;
}

static void token_unregister_match(Match *m)
{
    pthread_mutex_lock(&g_tokens_lock);
    for (int i = 0; i < MAX_TOKENS; i++)
        if (g_tokens[i].used && g_tokens[i].match == m)
            g_tokens[i].used = false;
    pthread_mutex_unlock(&g_tokens_lock);
}

static void match_release(Match *m)
{
    pthread_mutex_lock(&m->lock);
    m->refcount--;
    int rc = m->refcount;
    pthread_mutex_unlock(&m->lock);
    if (rc <= 0) {
        token_unregister_match(m);
        pthread_mutex_destroy(&m->lock);
        free(m);
    }
}

/* ---------------- matchmaking queue ---------------- */

typedef struct {
    Connection *conn;
} QueueSlot;

static QueueSlot g_queue[MAX_QUEUE];
static int g_queue_len = 0;
static pthread_mutex_t g_queue_lock = PTHREAD_MUTEX_INITIALIZER;

/* Enqueues conn, and if this makes the queue reach 2, pops both and
 * starts a match, assigning it to both connections' assigned_match field.
 * Returns the queue position (1-based) if still waiting, or 0 if matched. */
static int queue_join_and_maybe_pair(Connection *conn)
{
    Connection *a = NULL, *b = NULL;

    pthread_mutex_lock(&g_queue_lock);
    if (g_queue_len < MAX_QUEUE) {
        g_queue[g_queue_len].conn = conn;
        g_queue_len++;
    }
    if (g_queue_len >= 2) {
        a = g_queue[0].conn;
        b = g_queue[1].conn;
        memmove(&g_queue[0], &g_queue[2], (size_t)(g_queue_len - 2) * sizeof(QueueSlot));
        g_queue_len -= 2;
    }
    int position = 0;
    if (!a) {
        for (int i = 0; i < g_queue_len; i++)
            if (g_queue[i].conn == conn) { position = i + 1; break; }
    }
    pthread_mutex_unlock(&g_queue_lock);

    if (a && b) {
        Match *m = calloc(1, sizeof(Match));
        pthread_mutex_init(&m->lock, NULL);
        board_init(&m->board, MP_BOARD_W, MP_BOARD_H, MP_MINES);
        m->player_to_move = 0;
        m->conns[0] = a;
        m->conns[1] = b;
        m->connected[0] = m->connected[1] = true;
        m->active = true;
        m->refcount = 2;
        strncpy(m->names[0], a->name, NET_MAX_NAME_LEN);
        strncpy(m->names[1], b->name, NET_MAX_NAME_LEN);
        RAND_bytes(m->token[0], NET_TOKEN_LEN);
        RAND_bytes(m->token[1], NET_TOKEN_LEN);
        token_register(m->token[0], m, 0);
        token_register(m->token[1], m, 1);

        pthread_mutex_lock(&a->state_lock);
        a->assigned_match = m;
        a->assigned_player_index = 0;
        pthread_mutex_unlock(&a->state_lock);

        pthread_mutex_lock(&b->state_lock);
        b->assigned_match = m;
        b->assigned_player_index = 1;
        pthread_mutex_unlock(&b->state_lock);
        return 0;
    }
    return position;
}

static void queue_remove(Connection *conn)
{
    pthread_mutex_lock(&g_queue_lock);
    for (int i = 0; i < g_queue_len; i++) {
        if (g_queue[i].conn == conn) {
            memmove(&g_queue[i], &g_queue[i + 1], (size_t)(g_queue_len - i - 1) * sizeof(QueueSlot));
            g_queue_len--;
            break;
        }
    }
    pthread_mutex_unlock(&g_queue_lock);
}

/* ---------------- per-IP rate limiting ---------------- */

typedef struct {
    bool used;
    struct in_addr ip;
    time_t last_join;
    int active_count;
} RateSlot;

static RateSlot g_rates[RATE_LIMIT_SLOTS];
static pthread_mutex_t g_rate_lock = PTHREAD_MUTEX_INITIALIZER;

static RateSlot *rate_find_or_create(struct in_addr ip)
{
    int free_idx = -1;
    for (int i = 0; i < RATE_LIMIT_SLOTS; i++) {
        if (g_rates[i].used && g_rates[i].ip.s_addr == ip.s_addr)
            return &g_rates[i];
        if (!g_rates[i].used && free_idx < 0)
            free_idx = i;
    }
    if (free_idx >= 0) {
        g_rates[free_idx].used = true;
        g_rates[free_idx].ip = ip;
        g_rates[free_idx].last_join = 0;
        g_rates[free_idx].active_count = 0;
        return &g_rates[free_idx];
    }
    return NULL; /* table full; fail open on the join check, still bounded by MAX_CONNECTIONS */
}

static bool rate_allow_join(struct in_addr ip)
{
    bool ok = true;
    pthread_mutex_lock(&g_rate_lock);
    RateSlot *s = rate_find_or_create(ip);
    if (s) {
        time_t now = time(NULL);
        if (s->active_count >= MAX_QUEUED_PER_IP)
            ok = false;
        else {
            s->last_join = now;
            s->active_count++;
        }
    }
    pthread_mutex_unlock(&g_rate_lock);
    return ok;
}

static void rate_release(struct in_addr ip)
{
    pthread_mutex_lock(&g_rate_lock);
    for (int i = 0; i < RATE_LIMIT_SLOTS; i++) {
        if (g_rates[i].used && g_rates[i].ip.s_addr == ip.s_addr) {
            if (g_rates[i].active_count > 0)
                g_rates[i].active_count--;
            break;
        }
    }
    pthread_mutex_unlock(&g_rate_lock);
}

/* ---------------- socket helpers ---------------- */

static void set_socket_timeouts(int fd)
{
    struct timeval rcv = { READ_TIMEOUT_SECONDS, 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &rcv, sizeof(rcv));
    struct timeval snd = { 10, 0 };
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &snd, sizeof(snd));
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
}

static void send_error(Connection *c, ErrorCode code, const char *msg)
{
    MsgError m = { .code = (uint8_t)code };
    strncpy(m.message, msg, NET_ERR_MSG_LEN - 1);
    uint8_t buf[NET_MAX_PAYLOAD];
    size_t n = pack_error(buf, &m);
    net_send_frame(c->ssl, MSG_ERROR, buf, n);
}

static void sanitize_name(char *name)
{
    for (int i = 0; name[i]; i++)
        if (!isprint((unsigned char)name[i]))
            name[i] = '_';
    if (name[0] == '\0')
        strncpy(name, "Player", NET_MAX_NAME_LEN);
}

/* ---------------- match play ---------------- */

static void broadcast_board_state(Match *m)
{
    /* Compose the outgoing snapshot while holding the lock, then send
     * outside of it so a slow peer can't stall the other player's thread. */
    pthread_mutex_lock(&m->lock);
    int mines_left = m->board.mines - m->board.flags_placed;
    int32_t scores[2] = { m->scores[0], m->scores[1] };
    MsgBoardState wire;
    board_to_wire(&m->board, mines_left, scores, 0, &wire);
    MsgTurn turn = { .player_id_to_move = (uint8_t)m->player_to_move };
    Connection *c0 = m->connected[0] ? m->conns[0] : NULL;
    Connection *c1 = m->connected[1] ? m->conns[1] : NULL;
    pthread_mutex_unlock(&m->lock);

    uint8_t buf[NET_MAX_PAYLOAD];
    size_t n = pack_board_state(buf, &wire);
    uint8_t tbuf[8];
    size_t tn = pack_turn(tbuf, &turn);

    if (c0) { net_send_frame(c0->ssl, MSG_BOARD_STATE, buf, n); net_send_frame(c0->ssl, MSG_TURN, tbuf, tn); }
    if (c1) { net_send_frame(c1->ssl, MSG_BOARD_STATE, buf, n); net_send_frame(c1->ssl, MSG_TURN, tbuf, tn); }
}

/* Sends the current snapshot to exactly one connection - used when a
 * connection is (re)joining a match, so its own thread is the only one
 * touching its socket at that moment (no race with the peer's thread also
 * independently deciding to broadcast at the same time). */
static void send_board_state_to(Connection *conn, Match *m)
{
    pthread_mutex_lock(&m->lock);
    int mines_left = m->board.mines - m->board.flags_placed;
    int32_t scores[2] = { m->scores[0], m->scores[1] };
    MsgBoardState wire;
    board_to_wire(&m->board, mines_left, scores, 0, &wire);
    MsgTurn turn = { .player_id_to_move = (uint8_t)m->player_to_move };
    pthread_mutex_unlock(&m->lock);

    uint8_t buf[NET_MAX_PAYLOAD];
    size_t n = pack_board_state(buf, &wire);
    uint8_t tbuf[8];
    size_t tn = pack_turn(tbuf, &turn);
    net_send_frame(conn->ssl, MSG_BOARD_STATE, buf, n);
    net_send_frame(conn->ssl, MSG_TURN, tbuf, tn);
}

static void send_match_end(Match *m, MatchEndReason reason)
{
    pthread_mutex_lock(&m->lock);
    MsgMatchEnd me = { .reason = (uint8_t)reason, .scores = { m->scores[0], m->scores[1] } };
    Connection *c0 = m->connected[0] ? m->conns[0] : NULL;
    Connection *c1 = m->connected[1] ? m->conns[1] : NULL;
    pthread_mutex_unlock(&m->lock);

    uint8_t buf[32];
    size_t n = pack_match_end(buf, &me);
    if (c0) net_send_frame(c0->ssl, MSG_MATCH_END, buf, n);
    if (c1) net_send_frame(c1->ssl, MSG_MATCH_END, buf, n);
}

/* Applies a validated reveal/chord/flag action. Returns true if the turn
 * passed to the other player (reveal/chord always do; flag never does). */
static void apply_action_and_broadcast(Match *m, int player_index, uint8_t type,
                                        const uint8_t *payload, size_t len)
{
    pthread_mutex_lock(&m->lock);

    if (!m->active) {
        pthread_mutex_unlock(&m->lock);
        return;
    }

    bool ends_turn = false;
    bool rejected = false;
    ErrorCode reject_code = ERR_INVALID_ACTION;

    if (type == MSG_ACTION_FLAG) {
        MsgActionFlag act;
        if (!unpack_action_flag(payload, len, &act)) { rejected = true; reject_code = ERR_MALFORMED; }
        else if (!board_in_bounds(&m->board, act.x, act.y)) { rejected = true; reject_code = ERR_OUT_OF_BOUNDS; }
        else {
            Cell *c = &m->board.cells[act.y][act.x];
            if (!c->revealed && !m->board.first_move) {
                if (act.flagged && !c->flagged) { c->flagged = true; m->board.flags_placed++; }
                else if (!act.flagged && c->flagged) { c->flagged = false; m->board.flags_placed--; }
            }
        }
    } else if (type == MSG_ACTION_REVEAL) {
        MsgActionReveal act;
        if (!unpack_action_reveal(payload, len, &act)) { rejected = true; reject_code = ERR_MALFORMED; }
        else if (player_index != m->player_to_move) { rejected = true; reject_code = ERR_NOT_YOUR_TURN; }
        else if (!board_in_bounds(&m->board, act.x, act.y)) { rejected = true; reject_code = ERR_OUT_OF_BOUNDS; }
        else {
            int before_count = m->board.revealed_count;
            GameStatus before_status = m->board.status;
            board_reveal_cell(&m->board, act.x, act.y);
            /* A reveal on an already-revealed/flagged cell is a no-op;
             * don't burn the player's turn for nothing. */
            ends_turn = (m->board.revealed_count != before_count) || (m->board.status != before_status);
        }
    } else if (type == MSG_ACTION_CHORD) {
        MsgActionChord act;
        if (!unpack_action_chord(payload, len, &act)) { rejected = true; reject_code = ERR_MALFORMED; }
        else if (player_index != m->player_to_move) { rejected = true; reject_code = ERR_NOT_YOUR_TURN; }
        else if (!board_in_bounds(&m->board, act.x, act.y)) { rejected = true; reject_code = ERR_OUT_OF_BOUNDS; }
        else {
            int before_count = m->board.revealed_count;
            GameStatus before_status = m->board.status;
            board_chord_cell(&m->board, act.x, act.y);
            /* An unsatisfied/no-op chord shouldn't cost the turn either. */
            ends_turn = (m->board.revealed_count != before_count) || (m->board.status != before_status);
        }
    }

    MatchEndReason end_reason = END_CLEAN_CLEAR;
    bool match_ended = false;

    if (!rejected && ends_turn) {
        if (m->board.status == STATE_LOST) {
            m->scores[player_index] -= (m->board.mines - 1);
            match_ended = true;
            end_reason = END_BOMB;
        } else if (m->board.status == STATE_WON) {
            m->scores[0] += m->board.mines;
            m->scores[1] += m->board.mines;
            match_ended = true;
            end_reason = END_CLEAN_CLEAR;
        } else {
            m->player_to_move = 1 - m->player_to_move;
        }
    }

    if (match_ended)
        m->active = false;

    Connection *rejecting_conn = rejected ? m->conns[player_index] : NULL;
    pthread_mutex_unlock(&m->lock);

    if (rejecting_conn) {
        send_error(rejecting_conn, reject_code, "action rejected");
        return;
    }

    broadcast_board_state(m);
    if (match_ended)
        send_match_end(m, end_reason);
}

/* Waits up to RECONNECT_GRACE_SECONDS for the given player slot to
 * reconnect (polled once a second). Returns true if it reconnected. */
static bool wait_for_reconnect(Match *m, int player_index)
{
    for (int waited = 0; waited < RECONNECT_GRACE_SECONDS; waited++) {
        sleep(1);
        pthread_mutex_lock(&m->lock);
        bool reconnected = m->connected[player_index];
        bool still_active = m->active;
        pthread_mutex_unlock(&m->lock);
        if (reconnected || !still_active)
            return reconnected;
    }
    return false;
}

/* The main loop once a connection is attached to a match (fresh match
 * start, or after a successful reconnect). Returns when the connection's
 * own socket dies or the match concludes. */
static void play_match(Connection *conn, Match *m, int player_index)
{
    while (1) {
        pthread_mutex_lock(&m->lock);
        bool still_active = m->active;
        pthread_mutex_unlock(&m->lock);
        if (!still_active)
            break;

        NetFrame frame;
        NetResult r = net_recv_frame_ex(conn->ssl, &frame);

        if (r == NET_TIMEOUT)
            continue;

        if (r != NET_OK) {
            /* This player's connection died. Mark disconnected, notify the
             * opponent, and wait out the reconnect grace period before
             * giving up on their behalf. */
            pthread_mutex_lock(&m->lock);
            m->connected[player_index] = false;
            m->disconnected_at[player_index] = time(NULL);
            Connection *opponent = m->connected[1 - player_index] ? m->conns[1 - player_index] : NULL;
            pthread_mutex_unlock(&m->lock);

            if (opponent) {
                MsgOpponentStatus st = { .state = OPP_DISCONNECTED, .grace_seconds = RECONNECT_GRACE_SECONDS };
                uint8_t buf[8];
                size_t n = pack_opponent_status(buf, &st);
                net_send_frame(opponent->ssl, MSG_OPPONENT_STATUS, buf, n);
            }

            bool came_back = wait_for_reconnect(m, player_index);
            if (came_back)
                return; /* the reconnecting thread now owns play_match for this slot */

            pthread_mutex_lock(&m->lock);
            bool still_active2 = m->active;
            if (still_active2)
                m->active = false; /* grace period expired with no score change, per the confirmed rule */
            pthread_mutex_unlock(&m->lock);
            if (still_active2)
                send_match_end(m, END_OPPONENT_LEFT);
            return;
        }

        if (frame.type == MSG_PING) {
            net_send_frame(conn->ssl, MSG_PONG, NULL, 0);
            continue;
        }
        if (frame.type == MSG_ACTION_REVEAL || frame.type == MSG_ACTION_FLAG || frame.type == MSG_ACTION_CHORD) {
            apply_action_and_broadcast(m, player_index, frame.type, frame.payload, frame.len);
            continue;
        }
        /* Unrecognized message type while in a match: ignore rather than
         * drop the connection, to stay forward-compatible with clients
         * that might send additional keepalive-style chatter. */
    }
}

/* ---------------- connection lifecycle ---------------- */

static void handle_connection(Connection *conn)
{
    time_t hello_deadline = time(NULL) + HELLO_TIMEOUT_SECONDS;
    NetFrame frame;

    while (1) {
        NetResult r = net_recv_frame_ex(conn->ssl, &frame);
        if (r == NET_TIMEOUT) {
            if (time(NULL) > hello_deadline) return;
            continue;
        }
        if (r != NET_OK) return;
        break;
    }

    if (frame.type == MSG_RECONNECT) {
        MsgReconnect rc;
        if (!unpack_reconnect(frame.payload, frame.len, &rc)) return;
        Match *m; int player_index;
        if (!token_lookup(rc.token, &m, &player_index)) {
            send_error(conn, ERR_RECONNECT_FAILED, "unknown or expired session");
            return;
        }
        pthread_mutex_lock(&m->lock);
        bool active = m->active;
        if (active) {
            m->conns[player_index] = conn;
            m->connected[player_index] = true;
            m->refcount++;
        }
        char opp_name[NET_MAX_NAME_LEN + 1];
        strncpy(opp_name, m->names[1 - player_index], NET_MAX_NAME_LEN);
        opp_name[NET_MAX_NAME_LEN] = '\0';
        uint8_t w = (uint8_t)m->board.w, h = (uint8_t)m->board.h;
        uint16_t mines = (uint16_t)m->board.mines;
        Connection *opponent = active && m->connected[1 - player_index] ? m->conns[1 - player_index] : NULL;
        pthread_mutex_unlock(&m->lock);

        if (!active) {
            send_error(conn, ERR_RECONNECT_FAILED, "match already ended");
            return;
        }

        MsgReconnectOk ok = { .your_player_id = (uint8_t)player_index, .w = w, .h = h,
                               .mines = mines };
        strncpy(ok.opponent_name, opp_name, NET_MAX_NAME_LEN);
        uint8_t buf[NET_MAX_PAYLOAD];
        size_t n = pack_reconnect_ok(buf, &ok);
        net_send_frame(conn->ssl, MSG_RECONNECT_OK, buf, n);

        if (opponent) {
            MsgOpponentStatus st = { .state = OPP_RECONNECTED, .grace_seconds = 0 };
            uint8_t sbuf[8];
            size_t sn = pack_opponent_status(sbuf, &st);
            net_send_frame(opponent->ssl, MSG_OPPONENT_STATUS, sbuf, sn);
        }

        send_board_state_to(conn, m);
        play_match(conn, m, player_index);
        match_release(m);
        return;
    }

    if (frame.type != MSG_HELLO) {
        send_error(conn, ERR_MALFORMED, "expected HELLO or RECONNECT");
        return;
    }

    MsgHello hello;
    if (!unpack_hello(frame.payload, frame.len, &hello)) {
        send_error(conn, ERR_MALFORMED, "malformed HELLO");
        return;
    }
    if (hello.protocol_version != NET_PROTO_VERSION) {
        send_error(conn, ERR_BAD_VERSION, "unsupported protocol version");
        return;
    }
    sanitize_name(hello.name);
    strncpy(conn->name, hello.name, NET_MAX_NAME_LEN);

    if (!rate_allow_join(conn->ip)) {
        send_error(conn, ERR_RATE_LIMITED, "too many queue joins, slow down");
        return;
    }

    MsgWelcome welcome = { .protocol_version = NET_PROTO_VERSION, .player_id = 0 };
    uint8_t wbuf[8];
    size_t wn = pack_welcome(wbuf, &welcome);
    net_send_frame(conn->ssl, MSG_WELCOME, wbuf, wn);

    int position = queue_join_and_maybe_pair(conn);

    if (position > 0) {
        /* Still waiting: poll for pairing, periodically reporting queue
         * position, and bail out if the client disconnects while queued. */
        while (1) {
            pthread_mutex_lock(&conn->state_lock);
            Match *m = conn->assigned_match;
            int pidx = conn->assigned_player_index;
            pthread_mutex_unlock(&conn->state_lock);
            if (m) {
                MsgMatchStart ms = { .w = (uint8_t)m->board.w, .h = (uint8_t)m->board.h,
                                      .mines = (uint16_t)m->board.mines,
                                      .your_player_id = (uint8_t)pidx,
                                      .first_to_move = (m->player_to_move == pidx) ? 1 : 0 };
                strncpy(ms.opponent_name, m->names[1 - pidx], NET_MAX_NAME_LEN);
                memcpy(ms.session_token, m->token[pidx], NET_TOKEN_LEN);
                uint8_t buf[NET_MAX_PAYLOAD];
                size_t n = pack_match_start(buf, &ms);
                net_send_frame(conn->ssl, MSG_MATCH_START, buf, n);

                rate_release(conn->ip);
                send_board_state_to(conn, m);
                play_match(conn, m, pidx);
                match_release(m);
                return;
            }

            NetFrame f;
            NetResult r = net_recv_frame_ex(conn->ssl, &f);
            if (r != NET_TIMEOUT && r != NET_OK) {
                queue_remove(conn);
                rate_release(conn->ip);
                return;
            }
            if (r == NET_OK && f.type == MSG_PING)
                net_send_frame(conn->ssl, MSG_PONG, NULL, 0);
            /* MSG_QUEUE_STATUS updates are a nice-to-have; v1 keeps the
             * waiting screen simple and doesn't push periodic position
             * updates - the client just shows "Waiting for opponent...". */
        }
    } else {
        /* This HELLO completed a pair; assigned_match is already set. */
        pthread_mutex_lock(&conn->state_lock);
        Match *m = conn->assigned_match;
        int pidx = conn->assigned_player_index;
        pthread_mutex_unlock(&conn->state_lock);

        MsgMatchStart ms = { .w = (uint8_t)m->board.w, .h = (uint8_t)m->board.h,
                              .mines = (uint16_t)m->board.mines,
                              .your_player_id = (uint8_t)pidx,
                              .first_to_move = (m->player_to_move == pidx) ? 1 : 0 };
        strncpy(ms.opponent_name, m->names[1 - pidx], NET_MAX_NAME_LEN);
        memcpy(ms.session_token, m->token[pidx], NET_TOKEN_LEN);
        uint8_t buf[NET_MAX_PAYLOAD];
        size_t n = pack_match_start(buf, &ms);
        net_send_frame(conn->ssl, MSG_MATCH_START, buf, n);

        rate_release(conn->ip);
        send_board_state_to(conn, m);
        play_match(conn, m, pidx);
        match_release(m);
    }
}

typedef struct {
    SSL_CTX *ctx;
    int client_fd;
    struct in_addr ip;
} ThreadArgs;

static void *client_thread(void *arg)
{
    ThreadArgs *ta = arg;
    set_socket_timeouts(ta->client_fd);

    SSL *ssl = SSL_new(ta->ctx);
    SSL_set_fd(ssl, ta->client_fd);

    time_t deadline = time(NULL) + HANDSHAKE_TIMEOUT_SECONDS;
    int r;
    while ((r = SSL_accept(ssl)) != 1) {
        int e = SSL_get_error(ssl, r);
        bool retryable = (e == SSL_ERROR_WANT_READ || e == SSL_ERROR_WANT_WRITE) ||
                          (e == SSL_ERROR_SYSCALL && (errno == EAGAIN || errno == EWOULDBLOCK));
        if (!retryable || time(NULL) > deadline) {
            SSL_free(ssl);
            close(ta->client_fd);
            pthread_mutex_lock(&g_active_connections_lock);
            g_active_connections--;
            pthread_mutex_unlock(&g_active_connections_lock);
            free(ta);
            return NULL;
        }
    }

    Connection *conn = connection_new(ssl, ta->client_fd, ta->ip);
    handle_connection(conn);
    connection_free(conn);

    pthread_mutex_lock(&g_active_connections_lock);
    g_active_connections--;
    pthread_mutex_unlock(&g_active_connections_lock);
    free(ta);
    return NULL;
}

static SSL_CTX *make_server_ctx(const char *cert_path, const char *key_path)
{
    SSL_CTX *ctx = SSL_CTX_new(TLS_server_method());
    if (!ctx) { fprintf(stderr, "SSL_CTX_new failed\n"); return NULL; }
    SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);

    if (SSL_CTX_use_certificate_chain_file(ctx, cert_path) != 1) {
        fprintf(stderr, "Failed to load certificate chain: %s\n", cert_path);
        ERR_print_errors_fp(stderr);
        return NULL;
    }
    if (SSL_CTX_use_PrivateKey_file(ctx, key_path, SSL_FILETYPE_PEM) != 1) {
        fprintf(stderr, "Failed to load private key: %s\n", key_path);
        ERR_print_errors_fp(stderr);
        return NULL;
    }
    if (!SSL_CTX_check_private_key(ctx)) {
        fprintf(stderr, "Private key does not match certificate\n");
        return NULL;
    }
    return ctx;
}

int main(int argc, char **argv)
{
    const char *cert_path = NULL, *key_path = NULL;
    int port = 4443;
    unsigned seed = (unsigned)time(NULL);
    bool seed_given = false;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--cert") == 0 && i + 1 < argc) cert_path = argv[++i];
        else if (strcmp(argv[i], "--key") == 0 && i + 1 < argc) key_path = argv[++i];
        else if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) port = atoi(argv[++i]);
        else if (strcmp(argv[i], "--seed") == 0 && i + 1 < argc) { seed = (unsigned)atoi(argv[++i]); seed_given = true; }
        else {
            fprintf(stderr, "Usage: %s --cert <chain.pem> --key <key.pem> [--port %d] [--seed N]\n",
                    argv[0], port);
            return 1;
        }
    }
    if (!cert_path || !key_path) {
        fprintf(stderr, "Usage: %s --cert <chain.pem> --key <key.pem> [--port %d] [--seed N]\n",
                argv[0], port);
        return 1;
    }

    srand(seed);
    if (seed_given)
        fprintf(stderr, "Deterministic mode: seeded rand() with %u (test/debug only)\n", seed);

    SSL_library_init();
    SSL_load_error_strings();
    SSL_CTX *ctx = make_server_ctx(cert_path, key_path);
    if (!ctx) return 1;

    int listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons((uint16_t)port);

    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        perror("bind");
        return 1;
    }
    if (listen(listen_fd, 64) != 0) {
        perror("listen");
        return 1;
    }

    fprintf(stderr, "asciisweeper-server listening on port %d\n", port);

    while (!g_shutdown) {
        struct sockaddr_in client_addr;
        socklen_t client_len = sizeof(client_addr);
        int client_fd = accept(listen_fd, (struct sockaddr *)&client_addr, &client_len);
        if (client_fd < 0) {
            if (errno == EINTR) continue;
            perror("accept");
            continue;
        }

        pthread_mutex_lock(&g_active_connections_lock);
        bool over_capacity = g_active_connections >= MAX_CONNECTIONS;
        if (!over_capacity) g_active_connections++;
        pthread_mutex_unlock(&g_active_connections_lock);

        if (over_capacity) {
            close(client_fd);
            continue;
        }

        ThreadArgs *ta = malloc(sizeof(*ta));
        ta->ctx = ctx;
        ta->client_fd = client_fd;
        ta->ip = client_addr.sin_addr;

        pthread_t tid;
        pthread_attr_t attr;
        pthread_attr_init(&attr);
        pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
        pthread_attr_setstacksize(&attr, 256 * 1024);
        if (pthread_create(&tid, &attr, client_thread, ta) != 0) {
            close(client_fd);
            free(ta);
            pthread_mutex_lock(&g_active_connections_lock);
            g_active_connections--;
            pthread_mutex_unlock(&g_active_connections_lock);
        }
        pthread_attr_destroy(&attr);
    }

    close(listen_fd);
    SSL_CTX_free(ctx);
    return 0;
}
