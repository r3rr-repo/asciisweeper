#ifndef ASCIISWEEPER_NET_IO_H
#define ASCIISWEEPER_NET_IO_H

#include <stdbool.h>
#include <stddef.h>
#include <openssl/ssl.h>

#include "net_proto.h"

typedef struct {
    uint8_t type;
    uint8_t payload[NET_MAX_PAYLOAD];
    size_t len;
} NetFrame;

/* Blocking framed send/recv over an established SSL connection.
 * net_recv_frame returns false on error, EOF, or a frame declaring a
 * length above NET_MAX_PAYLOAD (treated as a protocol violation). */
bool net_send_frame(SSL *ssl, uint8_t type, const uint8_t *payload, size_t len);
bool net_recv_frame(SSL *ssl, NetFrame *out);

typedef enum { NET_OK, NET_TIMEOUT, NET_CLOSED, NET_ERROR } NetResult;

/* Like net_recv_frame, but distinguishes "no frame arrived before the
 * socket's SO_RCVTIMEO elapsed" (NET_TIMEOUT, connection still alive - the
 * caller should loop and retry) from a genuine disconnect (NET_CLOSED) or
 * hard error (NET_ERROR). Only a timeout on the very first byte of a new
 * frame is reported as NET_TIMEOUT; once any byte of a frame has been
 * read, a further stall is NET_ERROR, since resuming mid-frame after a
 * partial read is not safe. Requires SO_RCVTIMEO to be set on the
 * underlying socket. */
NetResult net_recv_frame_ex(SSL *ssl, NetFrame *out);

/* Pack: serialize a message struct into a payload buffer (caller-provided,
 * at least NET_MAX_PAYLOAD bytes), returns the number of bytes written.
 * Unpack: parse a received payload back into a message struct; returns
 * false if the payload is too short/malformed. */
size_t pack_hello(uint8_t *buf, const MsgHello *m);
bool   unpack_hello(const uint8_t *buf, size_t len, MsgHello *out);

size_t pack_reconnect(uint8_t *buf, const MsgReconnect *m);
bool   unpack_reconnect(const uint8_t *buf, size_t len, MsgReconnect *out);

size_t pack_action_reveal(uint8_t *buf, const MsgActionReveal *m);
bool   unpack_action_reveal(const uint8_t *buf, size_t len, MsgActionReveal *out);

size_t pack_action_flag(uint8_t *buf, const MsgActionFlag *m);
bool   unpack_action_flag(const uint8_t *buf, size_t len, MsgActionFlag *out);

size_t pack_action_chord(uint8_t *buf, const MsgActionChord *m);
bool   unpack_action_chord(const uint8_t *buf, size_t len, MsgActionChord *out);

size_t pack_welcome(uint8_t *buf, const MsgWelcome *m);
bool   unpack_welcome(const uint8_t *buf, size_t len, MsgWelcome *out);

size_t pack_queue_status(uint8_t *buf, const MsgQueueStatus *m);
bool   unpack_queue_status(const uint8_t *buf, size_t len, MsgQueueStatus *out);

size_t pack_match_start(uint8_t *buf, const MsgMatchStart *m);
bool   unpack_match_start(const uint8_t *buf, size_t len, MsgMatchStart *out);

size_t pack_reconnect_ok(uint8_t *buf, const MsgReconnectOk *m);
bool   unpack_reconnect_ok(const uint8_t *buf, size_t len, MsgReconnectOk *out);

size_t pack_board_state(uint8_t *buf, const MsgBoardState *m);
bool   unpack_board_state(const uint8_t *buf, size_t len, MsgBoardState *out);

size_t pack_turn(uint8_t *buf, const MsgTurn *m);
bool   unpack_turn(const uint8_t *buf, size_t len, MsgTurn *out);

size_t pack_opponent_status(uint8_t *buf, const MsgOpponentStatus *m);
bool   unpack_opponent_status(const uint8_t *buf, size_t len, MsgOpponentStatus *out);

size_t pack_match_end(uint8_t *buf, const MsgMatchEnd *m);
bool   unpack_match_end(const uint8_t *buf, size_t len, MsgMatchEnd *out);

size_t pack_error(uint8_t *buf, const MsgError *m);
bool   unpack_error(const uint8_t *buf, size_t len, MsgError *out);

/* Board <-> wire snapshot conversion (server builds outgoing, client
 * applies incoming). Unclicked mines are never encoded as mines. */
void board_to_wire(const Board *b, int mines_left, const int32_t scores[2],
                    int elapsed_seconds, MsgBoardState *out);
void wire_to_board(const MsgBoardState *m, Board *out);

#endif
