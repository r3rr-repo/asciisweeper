#ifndef ASCIISWEEPER_BOARD_H
#define ASCIISWEEPER_BOARD_H

#include <stdbool.h>

#define MAX_W 60
#define MAX_H 30

typedef struct {
    bool mine;
    bool revealed;
    bool flagged;
    int adjacent;
} Cell;

typedef enum { STATE_PLAYING, STATE_WON, STATE_LOST } GameStatus;

/* Pure Minesweeper board state and rules, shared by the single-player
 * client, the multiplayer client's rendering path, and the server's
 * authoritative match state. No rendering or networking concerns here. */
typedef struct {
    int w, h, mines;
    Cell cells[MAX_H][MAX_W];
    int flags_placed;
    int revealed_count;
    bool first_move;
    GameStatus status;
    int exploded_x, exploded_y;
} Board;

void board_init(Board *b, int w, int h, int mines);
bool board_in_bounds(const Board *b, int x, int y);
void board_place_mines(Board *b, int avoid_x, int avoid_y);
void board_reveal_all_mines(Board *b);
void board_check_win(Board *b);
void board_flood_reveal(Board *b, int sx, int sy);
void board_reveal_cell(Board *b, int x, int y);
void board_toggle_flag(Board *b, int x, int y);
void board_chord_cell(Board *b, int x, int y);

#endif
