#ifndef ASCIISWEEPER_NET_PROTO_H
#define ASCIISWEEPER_NET_PROTO_H

#include <stdint.h>
#include <stddef.h>
#include "board.h"

#define NET_PROTO_VERSION   1
#define NET_MAX_PAYLOAD     8192
#define NET_MAX_NAME_LEN    16
#define NET_TOKEN_LEN       16
#define NET_ERR_MSG_LEN     64

/* Fixed board size for multiplayer matches (v1: no per-match negotiation). */
#define MP_BOARD_W  16
#define MP_BOARD_H  16
#define MP_MINES    40

typedef enum {
    /* client -> server */
    MSG_HELLO          = 0x01,
    MSG_RECONNECT      = 0x02,
    MSG_ACTION_REVEAL  = 0x03,
    MSG_ACTION_FLAG    = 0x04,
    MSG_ACTION_CHORD   = 0x05,
    MSG_PING           = 0x06,

    /* server -> client */
    MSG_WELCOME         = 0x81,
    MSG_QUEUE_STATUS    = 0x82,
    MSG_MATCH_START     = 0x83,
    MSG_BOARD_STATE     = 0x84,
    MSG_TURN            = 0x85,
    MSG_OPPONENT_STATUS = 0x86,
    MSG_MATCH_END       = 0x87,
    MSG_ERROR           = 0x88,
    MSG_RECONNECT_OK    = 0x89,
    MSG_PONG            = 0x8A,
} MsgType;

typedef enum {
    END_CLEAN_CLEAR   = 1,
    END_BOMB          = 2,
    END_OPPONENT_LEFT = 3,
} MatchEndReason;

typedef enum {
    OPP_DISCONNECTED = 1,
    OPP_RECONNECTED  = 2,
} OpponentStatusState;

typedef enum {
    ERR_BAD_VERSION      = 1,
    ERR_NOT_YOUR_TURN    = 2,
    ERR_OUT_OF_BOUNDS    = 3,
    ERR_INVALID_ACTION   = 4,
    ERR_RECONNECT_FAILED = 5,
    ERR_QUEUE_FULL       = 6,
    ERR_RATE_LIMITED     = 7,
    ERR_MALFORMED        = 8,
} ErrorCode;

/* --- client -> server payloads --- */

typedef struct {
    uint8_t protocol_version;
    char name[NET_MAX_NAME_LEN + 1];
} MsgHello;

typedef struct {
    uint8_t token[NET_TOKEN_LEN];
} MsgReconnect;

typedef struct {
    uint8_t x, y;
} MsgActionReveal;

typedef struct {
    uint8_t x, y;
    uint8_t flagged;
} MsgActionFlag;

typedef struct {
    uint8_t x, y;
} MsgActionChord;

/* --- server -> client payloads --- */

typedef struct {
    uint8_t protocol_version;
    uint8_t player_id;
} MsgWelcome;

typedef struct {
    uint16_t position;
} MsgQueueStatus;

typedef struct {
    uint8_t w, h;
    uint16_t mines;
    char opponent_name[NET_MAX_NAME_LEN + 1];
    uint8_t your_player_id;
    uint8_t first_to_move;
    uint8_t session_token[NET_TOKEN_LEN];
} MsgMatchStart;

typedef struct {
    uint8_t your_player_id;
    uint8_t w, h;
    uint16_t mines;
    char opponent_name[NET_MAX_NAME_LEN + 1];
} MsgReconnectOk;

/* Cell byte layout: bit7 revealed, bit6 flagged, bit5 is_mine (only
 * meaningful/sent when revealed - an unclicked mine's location is never
 * transmitted), bits0-3 adjacent count (0-8, meaningful when revealed and
 * not a mine). */
#define CELL_BIT_REVEALED 0x80
#define CELL_BIT_FLAGGED  0x40
#define CELL_BIT_MINE     0x20
#define CELL_ADJACENT_MASK 0x0F

typedef struct {
    uint8_t w, h;
    uint8_t cells[MAX_H][MAX_W];
    uint16_t mines_left;
    int32_t scores[2];
    uint16_t elapsed_seconds;
    uint8_t status;       /* GameStatus: STATE_PLAYING/STATE_WON/STATE_LOST */
    uint8_t exploded_x;   /* 0xFF = none */
    uint8_t exploded_y;   /* 0xFF = none */
} MsgBoardState;

typedef struct {
    uint8_t player_id_to_move;
} MsgTurn;

typedef struct {
    uint8_t state;
    uint16_t grace_seconds;
} MsgOpponentStatus;

typedef struct {
    uint8_t reason;
    int32_t scores[2];
} MsgMatchEnd;

typedef struct {
    uint8_t code;
    char message[NET_ERR_MSG_LEN];
} MsgError;

#endif
