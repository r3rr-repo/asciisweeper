#ifndef ASCIISWEEPER_SCORE_H
#define ASCIISWEEPER_SCORE_H

#include <stdbool.h>
#include <stdint.h>

#include "board.h"

/* Who placed the flag on a cell, and whether it has already been overruled.
 *
 * Deliberately NOT a field on Cell: board.c is shared with the single-player
 * game, which has no notion of ownership, and keeping it pure means the rules
 * engine stays identical across all three programs.
 */
typedef struct {
    uint8_t flagger;   /* 0 = nobody, otherwise player_index + 1 */
    uint8_t reverser;  /* 0 = nobody, otherwise player_index + 1 */
    bool settled;      /* reversed once already; the cell is now frozen */
} FlagState;

/* Awards the flag points for a finished match. Pure over the final board and
 * the ownership grid - no locking, no I/O - so it can be tested directly.
 *
 *   reversed, no mine    reverser +2   (a correct overrule)
 *   reversed, mine       reverser -2,  original flagger +1 (they were right)
 *   flag stands, mine    flagger  +1
 *   flag stands, empty   flagger  -1
 *
 * Flags that board_check_win places automatically once the board is clear have
 * flagger == 0 and score for nobody. */
void score_flags(const Board *b, const FlagState flags[MAX_H][MAX_W], int out[2]);

#endif
