/*
 * asciisweeper - a Minesweeper clone for the terminal, rendered in ASCII
 * with ncurses.
 */

#include <ncurses.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <stdbool.h>

#include "board.h"

typedef struct {
    Board board;
    int cursor_x, cursor_y;
    time_t start_time;
    int elapsed;
    int top, left; /* screen origin of the board, for centering */
} Game;

typedef enum { MENU_BEGINNER, MENU_INTERMEDIATE, MENU_EXPERT, MENU_CUSTOM, MENU_QUIT } MenuChoice;

typedef enum { AFTER_RESTART, AFTER_MENU, AFTER_QUIT } AfterGame;

/* Color pair ids */
enum {
    CP_NUM1 = 1, CP_NUM2, CP_NUM3, CP_NUM4, CP_NUM5, CP_NUM6, CP_NUM7, CP_NUM8,
    CP_HIDDEN, CP_FLAG, CP_MINE, CP_MINE_HIT, CP_WRONG_FLAG, CP_EMPTY,
    CP_HUD, CP_TITLE, CP_CURSOR, CP_WIN, CP_LOSE
};

static void setup_colors(void)
{
    start_color();
    use_default_colors();
    init_pair(CP_NUM1, COLOR_BLUE, -1);
    init_pair(CP_NUM2, COLOR_GREEN, -1);
    init_pair(CP_NUM3, COLOR_RED, -1);
    init_pair(CP_NUM4, COLOR_MAGENTA, -1);
    init_pair(CP_NUM5, COLOR_YELLOW, -1);
    init_pair(CP_NUM6, COLOR_CYAN, -1);
    init_pair(CP_NUM7, COLOR_WHITE, -1);
    init_pair(CP_NUM8, COLOR_WHITE, -1);
    init_pair(CP_HIDDEN, COLOR_CYAN, -1);
    init_pair(CP_FLAG, COLOR_YELLOW, -1);
    init_pair(CP_MINE, COLOR_WHITE, -1);
    init_pair(CP_MINE_HIT, COLOR_WHITE, COLOR_RED);
    init_pair(CP_WRONG_FLAG, COLOR_RED, -1);
    init_pair(CP_EMPTY, -1, -1);
    init_pair(CP_HUD, COLOR_WHITE, -1);
    init_pair(CP_TITLE, COLOR_GREEN, -1);
    init_pair(CP_CURSOR, COLOR_BLACK, COLOR_WHITE);
    init_pair(CP_WIN, COLOR_GREEN, -1);
    init_pair(CP_LOSE, COLOR_RED, -1);
}

static int color_for_number(int n)
{
    switch (n) {
        case 1: return CP_NUM1;
        case 2: return CP_NUM2;
        case 3: return CP_NUM3;
        case 4: return CP_NUM4;
        case 5: return CP_NUM5;
        case 6: return CP_NUM6;
        case 7: return CP_NUM7;
        default: return CP_NUM8;
    }
}

static void game_init(Game *g, int w, int h, int mines)
{
    memset(g, 0, sizeof(*g));
    board_init(&g->board, w, h, mines);
    g->cursor_x = w / 2;
    g->cursor_y = h / 2;

    int scr_h, scr_w;
    getmaxyx(stdscr, scr_h, scr_w);
    int block_h = h + 8;   /* title, blank, hud, border*2, board rows, blank, footer*2 */
    int block_w = w * 2 + 2;
    int origin_y = (scr_h - block_h) / 2;
    int origin_x = (scr_w - block_w) / 2;
    if (origin_y < 0) origin_y = 0;
    if (origin_x < 0) origin_x = 0;
    g->top = origin_y + 4;
    g->left = origin_x + 1;
}

static void draw_board_frame(Game *g)
{
    int top = g->top, left = g->left;
    attron(COLOR_PAIR(CP_HUD));
    mvaddch(top - 1, left - 1, '+');
    mvaddch(top - 1, left + g->board.w * 2, '+');
    mvaddch(top + g->board.h, left - 1, '+');
    mvaddch(top + g->board.h, left + g->board.w * 2, '+');
    for (int x = 0; x < g->board.w * 2; x++) {
        mvaddch(top - 1, left + x, '-');
        mvaddch(top + g->board.h, left + x, '-');
    }
    for (int y = 0; y < g->board.h; y++) {
        mvaddch(top + y, left - 1, '|');
        mvaddch(top + y, left + g->board.w * 2, '|');
    }
    attroff(COLOR_PAIR(CP_HUD));
}

static void draw_hud(Game *g)
{
    int top = g->top, left = g->left;
    const char *title = "ASCIISWEEPER";
    int board_width = g->board.w * 2;
    int title_col = left + (board_width - (int)strlen(title)) / 2;
    if (title_col < 0) title_col = 0;

    attron(COLOR_PAIR(CP_TITLE) | A_BOLD);
    mvprintw(top - 4, title_col, "%s", title);
    attroff(COLOR_PAIR(CP_TITLE) | A_BOLD);

    int elapsed = g->board.first_move ? 0 : g->elapsed;
    if (elapsed > 999) elapsed = 999;
    int mines_left = g->board.mines - g->board.flags_placed;

    char status_line[40];
    snprintf(status_line, sizeof(status_line), "Mines: %03d    Time: %03d",
             mines_left < 0 ? 0 : mines_left, elapsed);
    int status_col = left + (board_width - (int)strlen(status_line)) / 2;
    if (status_col < 0) status_col = 0;

    attron(COLOR_PAIR(CP_HUD));
    mvprintw(top - 2, status_col, "%s", status_line);
    attroff(COLOR_PAIR(CP_HUD));
}

static void draw_footer(Game *g)
{
    const char *line1 = "Move: arrows/hjkl  |  Reveal: space/enter  |  Flag: f";
    const char *line2 = "Chord: c  |  Restart: r  |  Menu: n  |  Quit: q";
    int scr_h, scr_w;
    getmaxyx(stdscr, scr_h, scr_w);
    (void)scr_h;

    int col1 = (scr_w - (int)strlen(line1)) / 2;
    int col2 = (scr_w - (int)strlen(line2)) / 2;
    if (col1 < 0) col1 = 0;
    if (col2 < 0) col2 = 0;

    attron(COLOR_PAIR(CP_HUD));
    mvprintw(g->top + g->board.h + 2, col1, "%s", line1);
    mvprintw(g->top + g->board.h + 3, col2, "%s", line2);
    attroff(COLOR_PAIR(CP_HUD));
}

static void draw_board(Game *g)
{
    for (int y = 0; y < g->board.h; y++) {
        for (int x = 0; x < g->board.w; x++) {
            Cell *c = &g->board.cells[y][x];
            chtype ch;
            int pair;
            bool bold = false;

            if (c->flagged) {
                if (g->board.status == STATE_LOST && !c->mine) {
                    ch = 'X';
                    pair = CP_WRONG_FLAG;
                } else {
                    ch = 'F';
                    pair = CP_FLAG;
                    bold = true;
                }
            } else if (!c->revealed) {
                ch = '.';
                pair = CP_HIDDEN;
            } else if (c->mine) {
                ch = '*';
                pair = (x == g->board.exploded_x && y == g->board.exploded_y) ? CP_MINE_HIT : CP_MINE;
                bold = true;
            } else if (c->adjacent == 0) {
                ch = ' ';
                pair = CP_EMPTY;
            } else {
                ch = '0' + c->adjacent;
                pair = color_for_number(c->adjacent);
                bold = true;
            }

            int row = g->top + y;
            int col = g->left + x * 2;
            bool is_cursor = (x == g->cursor_x && y == g->cursor_y && g->board.status == STATE_PLAYING);

            int attrs = COLOR_PAIR(pair) | (bold ? A_BOLD : 0);
            if (is_cursor)
                attrs = COLOR_PAIR(CP_CURSOR) | A_BOLD;

            attron(attrs);
            mvaddch(row, col, ch);
            mvaddch(row, col + 1, ' ');
            attroff(attrs);
        }
    }
}

static void render(Game *g)
{
    erase();
    draw_hud(g);
    draw_board_frame(g);
    draw_board(g);
    draw_footer(g);
    refresh();
}

/* Returns what to do after the game ends: restart / back to menu / quit. */
static AfterGame play_game(int w, int h, int mines)
{
    Game g;
    game_init(&g, w, h, mines);
    wtimeout(stdscr, 200);
    clear(); /* force a full physical redraw when coming from a differently-shaped screen */

    while (1) {
        if (!g.board.first_move && g.board.status == STATE_PLAYING)
            g.elapsed = (int)(time(NULL) - g.start_time);

        render(&g);

        if (g.board.status != STATE_PLAYING) {
            attron(COLOR_PAIR(g.board.status == STATE_WON ? CP_WIN : CP_LOSE) | A_BOLD);
            mvprintw(g.top + g.board.h + 5, g.left,
                     g.board.status == STATE_WON ? "YOU WIN! Time: %ds" : "BOOM! Game Over.", g.elapsed);
            attroff(COLOR_PAIR(g.board.status == STATE_WON ? CP_WIN : CP_LOSE) | A_BOLD);
            attron(COLOR_PAIR(CP_HUD));
            mvprintw(g.top + g.board.h + 6, g.left, "[R]estart  [N]ew game  [Q]uit");
            attroff(COLOR_PAIR(CP_HUD));
            refresh();
        }

        int ch = getch();
        if (ch == ERR)
            continue;

        if (g.board.status != STATE_PLAYING) {
            if (ch == 'r' || ch == 'R') return AFTER_RESTART;
            if (ch == 'n' || ch == 'N') return AFTER_MENU;
            if (ch == 'q' || ch == 'Q') return AFTER_QUIT;
            continue;
        }

        switch (ch) {
            case KEY_UP: case 'k':
                if (g.cursor_y > 0) g.cursor_y--;
                break;
            case KEY_DOWN: case 'j':
                if (g.cursor_y < g.board.h - 1) g.cursor_y++;
                break;
            case KEY_LEFT: case 'h':
                if (g.cursor_x > 0) g.cursor_x--;
                break;
            case KEY_RIGHT: case 'l':
                if (g.cursor_x < g.board.w - 1) g.cursor_x++;
                break;
            case ' ': case '\n': case KEY_ENTER:
                if (g.board.cells[g.cursor_y][g.cursor_x].revealed) {
                    board_chord_cell(&g.board, g.cursor_x, g.cursor_y);
                } else {
                    bool was_first = g.board.first_move;
                    board_reveal_cell(&g.board, g.cursor_x, g.cursor_y);
                    if (was_first && !g.board.first_move)
                        g.start_time = time(NULL);
                }
                break;
            case 'f': case 'F':
                board_toggle_flag(&g.board, g.cursor_x, g.cursor_y);
                break;
            case 'c': case 'C':
                board_chord_cell(&g.board, g.cursor_x, g.cursor_y);
                break;
            case 'r': case 'R':
                return AFTER_RESTART;
            case 'n': case 'N':
                return AFTER_MENU;
            case 'q': case 'Q':
                return AFTER_QUIT;
            default:
                break;
        }
    }
}

typedef struct { int w, h, mines; } Difficulty;

static const Difficulty PRESETS[3] = {
    { 9, 9, 10 },    /* beginner */
    { 16, 16, 40 },  /* intermediate */
    { 30, 16, 99 },  /* expert */
};

static void prompt_int(const char *label, int row, int col, int minv, int maxv, int def, int *out)
{
    char buf[16];
    echo();
    curs_set(1);
    attron(COLOR_PAIR(CP_HUD));
    mvprintw(row, col, "%s [%d-%d, default %d]: ", label, minv, maxv, def);
    attroff(COLOR_PAIR(CP_HUD));
    clrtoeol();
    refresh();
    getnstr(buf, sizeof(buf) - 1);
    noecho();
    curs_set(0);

    if (buf[0] == '\0') {
        *out = def;
        return;
    }
    int v = atoi(buf);
    if (v < minv) v = minv;
    if (v > maxv) v = maxv;
    *out = v;
}

static MenuChoice menu(Difficulty *custom_out)
{
    const char *title = "ASCIISWEEPER";
    const char *subtitle = "a terminal minesweeper";
    const char *labels[] = {
        "Beginner     (9x9, 10 mines)",
        "Intermediate (16x16, 40 mines)",
        "Expert       (30x16, 99 mines)",
        "Custom...",
        "Quit"
    };
    const char *hint = "Move: up/down or j/k   Select: enter/space   Quit: q";
    int n = 5;
    int sel = 0;
    wtimeout(stdscr, -1); /* blocking while in menu */
    clear(); /* force a full physical redraw when coming from a differently-shaped screen */

    /* Center the whole menu block as a unit. */
    size_t width = strlen(subtitle);
    for (int i = 0; i < n; i++) {
        size_t w = strlen(labels[i]) + 2;
        if (w > width) width = w;
    }
    if (strlen(hint) > width) width = strlen(hint);

    int scr_h, scr_w;
    getmaxyx(stdscr, scr_h, scr_w);
    int block_h = 2 + 1 + n + 1 + 1; /* title+subtitle, blank, options, blank, hint */
    int top = (scr_h - block_h) / 2;
    int left = (scr_w - (int)width) / 2;
    if (top < 0) top = 0;
    if (left < 0) left = 0;

    while (1) {
        erase();
        attron(COLOR_PAIR(CP_TITLE) | A_BOLD);
        mvprintw(top, left + ((int)width - (int)strlen(title)) / 2, "%s", title);
        mvprintw(top + 1, left + ((int)width - (int)strlen(subtitle)) / 2, "%s", subtitle);
        attroff(COLOR_PAIR(CP_TITLE) | A_BOLD);

        for (int i = 0; i < n; i++) {
            int attrs = (i == sel) ? (COLOR_PAIR(CP_CURSOR) | A_BOLD) : COLOR_PAIR(CP_HUD);
            attron(attrs);
            mvprintw(top + 3 + i, left, "%s %s", (i == sel) ? ">" : " ", labels[i]);
            attroff(attrs);
        }
        attron(COLOR_PAIR(CP_HUD));
        mvprintw(top + 3 + n + 1, left, "%s", hint);
        attroff(COLOR_PAIR(CP_HUD));
        refresh();

        int ch = getch();
        switch (ch) {
            case KEY_UP: case 'k':
                sel = (sel - 1 + n) % n;
                break;
            case KEY_DOWN: case 'j':
                sel = (sel + 1) % n;
                break;
            case '\n': case ' ': case KEY_ENTER:
                if (sel == 4) return MENU_QUIT;
                if (sel == 3) {
                    int w, h, m;
                    int prow = top + 3 + n + 3;
                    prompt_int("Width",  prow,     left, 5, MAX_W, 16, &w);
                    prompt_int("Height", prow + 1, left, 5, MAX_H, 16, &h);
                    int max_mines = w * h - 9;
                    if (max_mines < 1) max_mines = 1;
                    prompt_int("Mines",  prow + 2, left, 1, max_mines, (w * h) / 6, &m);
                    custom_out->w = w;
                    custom_out->h = h;
                    custom_out->mines = m;
                    return MENU_CUSTOM;
                }
                return (MenuChoice)sel;
            case 'q': case 'Q':
                return MENU_QUIT;
            default:
                break;
        }
    }
}

int main(void)
{
    srand((unsigned)time(NULL));

    initscr();
    if (has_colors())
        setup_colors();
    cbreak();
    noecho();
    keypad(stdscr, TRUE);
    curs_set(0);

    int min_lines = 20, min_cols = 40;
    if (LINES < min_lines || COLS < min_cols) {
        endwin();
        fprintf(stderr, "Terminal too small. Need at least %dx%d, got %dx%d.\n",
                min_cols, min_lines, COLS, LINES);
        return 1;
    }

    bool running = true;
    while (running) {
        Difficulty custom = { 0, 0, 0 };
        MenuChoice choice = menu(&custom);
        Difficulty d;

        switch (choice) {
            case MENU_BEGINNER: d = PRESETS[0]; break;
            case MENU_INTERMEDIATE: d = PRESETS[1]; break;
            case MENU_EXPERT: d = PRESETS[2]; break;
            case MENU_CUSTOM: d = custom; break;
            case MENU_QUIT:
            default:
                running = false;
                continue;
        }

        /* Make sure the board fits the terminal; clamp if needed. */
        int max_board_w = (COLS - 4) / 2;
        int max_board_h = LINES - 10;
        if (d.w > max_board_w) d.w = max_board_w;
        if (d.h > max_board_h) d.h = max_board_h;
        if (d.w < 4) d.w = 4;
        if (d.h < 4) d.h = 4;
        int max_mines = d.w * d.h - 9;
        if (d.mines > max_mines) d.mines = max_mines > 0 ? max_mines : 1;

        bool play_more = true;
        while (play_more) {
            AfterGame after = play_game(d.w, d.h, d.mines);
            switch (after) {
                case AFTER_RESTART:
                    continue;
                case AFTER_MENU:
                    play_more = false;
                    break;
                case AFTER_QUIT:
                    play_more = false;
                    running = false;
                    break;
            }
        }
    }

    endwin();
    return 0;
}
