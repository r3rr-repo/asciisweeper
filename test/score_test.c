/*
 * Tests for the multiplayer flag scoring.
 *
 *   cmake --build build --target score-test && ./build/score-test
 *
 * score_flags is pure over a finished board and the ownership grid, so every
 * case can be set up directly - including the ones a live match cannot reach
 * cheaply, like a cleanly cleared board.
 */
#include <stdio.h>
#include <string.h>

#include "board.h"
#include "score.h"

static int pass = 0, fail = 0;

static void check(bool cond, const char *what)
{
    if (cond) { pass++; }
    else { fail++; printf("FAIL: %s\n", what); }
}

static void check_scores(const Board *b, const FlagState f[MAX_H][MAX_W],
                         int want0, int want1, const char *what)
{
    int got[2];
    score_flags(b, f, got);
    if (got[0] == want0 && got[1] == want1) { pass++; }
    else {
        fail++;
        printf("FAIL: %s (got %d/%d, want %d/%d)\n", what, got[0], got[1], want0, want1);
    }
}

/* A board with mines exactly where asked, no RNG involved. */
static void make_board(Board *b, int w, int h, const char *layout)
{
    board_init(b, w, h, 0);
    int mines = 0;
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            if (layout[y * w + x] == '*') { b->cells[y][x].mine = true; mines++; }
        }
    }
    b->mines = mines;
    b->first_move = false;
}

int main(void)
{
    Board b;
    FlagState f[MAX_H][MAX_W];

    /* 3x1: mine, empty, mine */
    make_board(&b, 3, 1, "*.*");

    /* ---- flags that stand ---- */
    memset(f, 0, sizeof(f));
    f[0][0].flagger = 1;                       /* player 0 flags a mine */
    check_scores(&b, f, 1, 0, "a correct flag scores +1 for its owner");

    memset(f, 0, sizeof(f));
    f[0][1].flagger = 1;                       /* player 0 flags an empty cell */
    check_scores(&b, f, -1, 0, "a wrong flag costs its owner 1");

    memset(f, 0, sizeof(f));
    f[0][0].flagger = 2;
    f[0][2].flagger = 2;
    check_scores(&b, f, 0, 2, "player 1's flags are credited to player 1");

    memset(f, 0, sizeof(f));
    f[0][0].flagger = 1;                       /* right */
    f[0][1].flagger = 1;                       /* wrong */
    check_scores(&b, f, 0, 0, "one right and one wrong cancel out");

    /* ---- reversals ---- */
    memset(f, 0, sizeof(f));
    f[0][1].flagger = 1; f[0][1].reverser = 2; f[0][1].settled = true;
    check_scores(&b, f, 0, 2, "overruling a wrong flag pays the reverser +2");

    memset(f, 0, sizeof(f));
    f[0][0].flagger = 1; f[0][0].reverser = 2; f[0][0].settled = true;
    check_scores(&b, f, 1, -2,
        "overruling a CORRECT flag costs the reverser 2 and still credits the flagger");

    memset(f, 0, sizeof(f));
    f[0][0].flagger = 2; f[0][0].reverser = 1; f[0][0].settled = true;
    check_scores(&b, f, -2, 1, "...and symmetrically the other way round");

    /* A reversal where nobody owned the flag should pay only the reverser:
     * that is the shape left if an unowned flag were ever overruled. */
    memset(f, 0, sizeof(f));
    f[0][1].reverser = 1; f[0][1].settled = true;
    check_scores(&b, f, 2, 0, "a reversal with no original flagger pays only the reverser");

    /* ---- taking back your own flag ---- */
    memset(f, 0, sizeof(f));
    /* The server clears flagger and leaves reverser unset for a self-undo. */
    check_scores(&b, f, 0, 0, "taking back your own flag scores nothing either way");

    /* ---- the subtle one: a cleanly cleared board ---- */
    /* board_check_win flags every mine. Those flags belong to nobody, so they
     * must score nothing - otherwise simply winning would inflate both totals. */
    {
        Board w;
        make_board(&w, 3, 1, "*.*");
        w.revealed_count = 1;                  /* the single non-mine cell */
        board_check_win(&w);
        check(w.status == STATE_WON, "the test board reaches STATE_WON");
        check(w.cells[0][0].flagged && w.cells[0][2].flagged,
              "board_check_win auto-flagged both mines");

        memset(f, 0, sizeof(f));
        check_scores(&w, f, 0, 0, "auto-flags from a clean clear score for nobody");

        /* A player's own correct flag still counts on a won board. */
        memset(f, 0, sizeof(f));
        f[0][0].flagger = 1;
        check_scores(&w, f, 1, 0, "a real flag still scores on a won board");
    }

    /* ---- spam is not profitable ---- */
    /* Flagging everything on a 5x5 with 3 mines: +3 for the mines, -22 for the
     * rest. The rule exists to make this losing, so assert that it is. */
    {
        Board s;
        make_board(&s, 5, 5, "*...."
                             "....."
                             "..*.."
                             "....."
                             "....*");
        memset(f, 0, sizeof(f));
        for (int y = 0; y < 5; y++)
            for (int x = 0; x < 5; x++)
                f[y][x].flagger = 1;
        int got[2];
        score_flags(&s, f, got);
        check(got[0] == 3 - 22, "flagging every cell scores 3 - 22 = -19");
        check(got[0] < 0, "flagging everything is a net loss, which is the point");
    }

    printf("%d passed, %d failed\n", pass, fail);
    return fail ? 1 : 0;
}
