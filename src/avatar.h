#ifndef ASCIISWEEPER_AVATAR_H
#define ASCIISWEEPER_AVATAR_H

#include <stdint.h>
#include <stdbool.h>
#include <ncurses.h>

/* A player avatar is just two small color indices (0-7, the 8 base
 * terminal colors) - cheap to generate, persist, and send over the wire.
 * Rendering fills in a fixed pixel template (hair band over a skin-toned
 * face with two fixed-dark eye pixels), so the two colors alone produce a
 * recognizable little blocky face, in the spirit of a low-res Minecraft
 * skin head. */
typedef struct {
    uint8_t skin_color;
    uint8_t hair_color;
} Avatar;

#define AVATAR_ROWS 6
#define AVATAR_COLS 6          /* pixels; each pixel is drawn 2 chars wide */
#define AVATAR_WIDTH_CHARS  (AVATAR_COLS * 2)
#define AVATAR_HEIGHT_CHARS AVATAR_ROWS

/* Fills *out with a random skin/hair color pair. */
void avatar_random(Avatar *out);

/* Draws the avatar at (top, left) in the given window (pass stdscr for the
 * main screen). Uses the same COLOR_PAIR-per-cell approach as draw_board;
 * must be called after setup_colors()/start_color(). When eyes_open is
 * false, the eye pixels render in the skin color instead (a blink) rather
 * than the whole avatar disappearing. */
void avatar_draw(WINDOW *win, int top, int left, const Avatar *a, bool eyes_open);

#endif
