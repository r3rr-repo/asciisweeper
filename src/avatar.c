#include "avatar.h"
#include <stdlib.h>
#include <stdbool.h>

/* Avatar color pairs live in their own reserved range so they can't collide
 * with main.c's own CP_* enum, without avatar.c needing to know its exact
 * values. ncurses's COLOR_BLACK..COLOR_WHITE constants are already 0-7, so
 * an Avatar's skin_color/hair_color (0-7) map directly onto them - no
 * separate lookup table needed. */
#define AVATAR_PAIR_BASE 100

/* Eyes are always this color, and it's excluded from random skin/hair
 * generation, so eyes never blend into the face regardless of the chosen
 * colors. */
#define AVATAR_EYE_COLOR COLOR_BLACK

static bool g_avatar_colors_ready = false;

static void ensure_avatar_colors(void)
{
    if (g_avatar_colors_ready)
        return;
    for (int c = 0; c <= 7; c++)
        init_pair((short)(AVATAR_PAIR_BASE + c), COLOR_WHITE, c);
    g_avatar_colors_ready = true;
}

void avatar_random(Avatar *out)
{
    /* 1-7: skip COLOR_BLACK (0), reserved for eyes so they always contrast
     * against the skin/hair colors actually chosen. */
    out->skin_color = (uint8_t)(1 + rand() % 7);
    out->hair_color = (uint8_t)(1 + rand() % 7);
}

void avatar_draw(WINDOW *win, int top, int left, const Avatar *a)
{
    ensure_avatar_colors();

    for (int row = 0; row < AVATAR_ROWS; row++) {
        for (int col = 0; col < AVATAR_COLS; col++) {
            bool is_hair = row < 2;
            bool is_eye = !is_hair && row == 2 && (col == 2 || col == 4);
            int color = is_eye ? AVATAR_EYE_COLOR : (is_hair ? a->hair_color : a->skin_color);

            int attrs = COLOR_PAIR(AVATAR_PAIR_BASE + color);
            wattron(win, attrs);
            mvwaddch(win, top + row, left + col * 2, ' ');
            mvwaddch(win, top + row, left + col * 2 + 1, ' ');
            wattroff(win, attrs);
        }
    }
}
