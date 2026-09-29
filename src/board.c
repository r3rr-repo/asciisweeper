#include "board.h"
#include <stdlib.h>
#include <string.h>

void board_init(Board *b, int w, int h, int mines)
{
    memset(b, 0, sizeof(*b));
    b->w = w;
    b->h = h;
    b->mines = mines;
    b->first_move = true;
    b->status = STATE_PLAYING;
    b->exploded_x = -1;
    b->exploded_y = -1;
}

bool board_in_bounds(const Board *b, int x, int y)
{
    return x >= 0 && x < b->w && y >= 0 && y < b->h;
}

void board_place_mines(Board *b, int avoid_x, int avoid_y)
{
    int placed = 0;
    while (placed < b->mines) {
        int x = rand() % b->w;
        int y = rand() % b->h;
        if (abs(x - avoid_x) <= 1 && abs(y - avoid_y) <= 1)
            continue;
        if (b->cells[y][x].mine)
            continue;
        b->cells[y][x].mine = true;
        placed++;
    }

    for (int y = 0; y < b->h; y++) {
        for (int x = 0; x < b->w; x++) {
            if (b->cells[y][x].mine)
                continue;
            int count = 0;
            for (int dy = -1; dy <= 1; dy++) {
                for (int dx = -1; dx <= 1; dx++) {
                    if (dx == 0 && dy == 0) continue;
                    if (board_in_bounds(b, x + dx, y + dy) && b->cells[y + dy][x + dx].mine)
                        count++;
                }
            }
            b->cells[y][x].adjacent = count;
        }
    }
}

void board_reveal_all_mines(Board *b)
{
    for (int y = 0; y < b->h; y++)
        for (int x = 0; x < b->w; x++)
            if (b->cells[y][x].mine)
                b->cells[y][x].revealed = true;
}

void board_check_win(Board *b)
{
    if (b->revealed_count == b->w * b->h - b->mines) {
        b->status = STATE_WON;
        for (int y = 0; y < b->h; y++)
            for (int x = 0; x < b->w; x++)
                if (b->cells[y][x].mine)
                    b->cells[y][x].flagged = true;
        b->flags_placed = b->mines;
    }
}

/* Iterative flood fill starting at (sx, sy); (sx, sy) is guaranteed safe. */
void board_flood_reveal(Board *b, int sx, int sy)
{
    int stack_x[MAX_W * MAX_H];
    int stack_y[MAX_W * MAX_H];
    int sp = 0;
    stack_x[sp] = sx;
    stack_y[sp] = sy;
    sp++;

    while (sp > 0) {
        sp--;
        int x = stack_x[sp];
        int y = stack_y[sp];
        if (!board_in_bounds(b, x, y))
            continue;
        Cell *c = &b->cells[y][x];
        if (c->revealed || c->flagged)
            continue;
        c->revealed = true;
        b->revealed_count++;
        if (c->adjacent == 0) {
            for (int dy = -1; dy <= 1; dy++) {
                for (int dx = -1; dx <= 1; dx++) {
                    if (dx == 0 && dy == 0) continue;
                    int nx = x + dx, ny = y + dy;
                    if (board_in_bounds(b, nx, ny) && !b->cells[ny][nx].revealed && !b->cells[ny][nx].flagged)
                        if (sp < MAX_W * MAX_H) {
                            stack_x[sp] = nx;
                            stack_y[sp] = ny;
                            sp++;
                        }
                }
            }
        }
    }
}

void board_reveal_cell(Board *b, int x, int y)
{
    if (b->status != STATE_PLAYING)
        return;
    Cell *c = &b->cells[y][x];
    if (c->flagged || c->revealed)
        return;

    if (b->first_move) {
        board_place_mines(b, x, y);
        b->first_move = false;
    }

    if (c->mine) {
        c->revealed = true;
        b->exploded_x = x;
        b->exploded_y = y;
        b->status = STATE_LOST;
        board_reveal_all_mines(b);
        return;
    }

    board_flood_reveal(b, x, y);
    board_check_win(b);
}

void board_toggle_flag(Board *b, int x, int y)
{
    if (b->status != STATE_PLAYING)
        return;
    Cell *c = &b->cells[y][x];
    if (c->revealed)
        return;
    if (b->first_move)
        return; /* nothing to flag before mines exist */
    c->flagged = !c->flagged;
    b->flags_placed += c->flagged ? 1 : -1;
}

void board_chord_cell(Board *b, int x, int y)
{
    if (b->status != STATE_PLAYING)
        return;
    Cell *c = &b->cells[y][x];
    if (!c->revealed || c->adjacent == 0)
        return;

    int flagged = 0;
    for (int dy = -1; dy <= 1; dy++)
        for (int dx = -1; dx <= 1; dx++) {
            if (dx == 0 && dy == 0) continue;
            int nx = x + dx, ny = y + dy;
            if (board_in_bounds(b, nx, ny) && b->cells[ny][nx].flagged)
                flagged++;
        }

    if (flagged != c->adjacent)
        return;

    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            if (dx == 0 && dy == 0) continue;
            int nx = x + dx, ny = y + dy;
            if (!board_in_bounds(b, nx, ny)) continue;
            Cell *n = &b->cells[ny][nx];
            if (n->flagged || n->revealed) continue;
            if (n->mine) {
                n->revealed = true;
                b->exploded_x = nx;
                b->exploded_y = ny;
                b->status = STATE_LOST;
                board_reveal_all_mines(b);
                return;
            }
            board_flood_reveal(b, nx, ny);
        }
    }
    board_check_win(b);
}
