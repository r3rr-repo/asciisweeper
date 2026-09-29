/*
 * asciisweeper - a Minesweeper clone for the terminal, rendered in ASCII
 * with ncurses.
 */

#include <ncurses.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <stdbool.h>
#include <unistd.h>
#include <sys/select.h>

#include "board.h"
#include "net_proto.h"
#include "net_io.h"
#include "client_net.h"
#include "version.h"
#include "avatar.h"
#include "config.h"

typedef struct {
    Board board;
    int cursor_x, cursor_y;
    time_t start_time;
    int elapsed;
    int top, left; /* screen origin of the board, for centering */
    bool side_panels_fit; /* multiplayer: is there room for avatar panels? */
} Game;

typedef enum { MENU_BEGINNER, MENU_INTERMEDIATE, MENU_EXPERT, MENU_MULTIPLAYER, MENU_AVATAR, MENU_CUSTOM, MENU_QUIT } MenuChoice;

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
    init_pair(CP_EMPTY, -1, COLOR_BLUE);
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

#define AVATAR_GUTTER 2

static void game_init(Game *g, int w, int h, int mines, bool want_side_panels)
{
    memset(g, 0, sizeof(*g));
    board_init(&g->board, w, h, mines);
    g->cursor_x = w / 2;
    g->cursor_y = h / 2;

    int scr_h, scr_w;
    getmaxyx(stdscr, scr_h, scr_w);
    int block_h = h + 8;   /* title, blank, hud, border*2, board rows, blank, footer*2 */
    int board_block_w = w * 2 + 2;
    int panel_extra = 2 * (AVATAR_WIDTH_CHARS + AVATAR_GUTTER);
    g->side_panels_fit = want_side_panels && (scr_w >= board_block_w + panel_extra);
    int block_w = board_block_w + (g->side_panels_fit ? panel_extra : 0);
    int origin_y = (scr_h - block_h) / 2;
    int origin_x = (scr_w - block_w) / 2;
    if (origin_y < 0) origin_y = 0;
    if (origin_x < 0) origin_x = 0;
    g->top = origin_y + 4;
    g->left = origin_x + 1 + (g->side_panels_fit ? (AVATAR_WIDTH_CHARS + AVATAR_GUTTER) : 0);
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

#define AUTO_RESTART_SECONDS 2

/* Returns what to do after the game ends: restart / back to menu / quit. */
static AfterGame play_game(int w, int h, int mines)
{
    Game g;
    game_init(&g, w, h, mines, false);
    wtimeout(stdscr, 200);
    clear(); /* force a full physical redraw when coming from a differently-shaped screen */

    time_t game_over_at = 0;

    while (1) {
        if (!g.board.first_move && g.board.status == STATE_PLAYING)
            g.elapsed = (int)(time(NULL) - g.start_time);

        render(&g);

        if (g.board.status != STATE_PLAYING) {
            if (game_over_at == 0)
                game_over_at = time(NULL);
            int remaining = AUTO_RESTART_SECONDS - (int)(time(NULL) - game_over_at);
            if (remaining < 0) remaining = 0;

            attron(COLOR_PAIR(g.board.status == STATE_WON ? CP_WIN : CP_LOSE) | A_BOLD);
            mvprintw(g.top + g.board.h + 5, g.left,
                     g.board.status == STATE_WON ? "YOU WIN! Time: %ds" : "BOOM! Game Over.", g.elapsed);
            attroff(COLOR_PAIR(g.board.status == STATE_WON ? CP_WIN : CP_LOSE) | A_BOLD);
            attron(COLOR_PAIR(CP_HUD));
            mvprintw(g.top + g.board.h + 6, g.left,
                     "[R]estart  [N]ew game  [Q]uit  -  new game in %ds", remaining);
            attroff(COLOR_PAIR(CP_HUD));
            refresh();

            if (remaining == 0)
                return AFTER_RESTART;
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

static void prompt_str(const char *label, int row, int col, const char *def, char *out, size_t outsz)
{
    char buf[128];
    echo();
    curs_set(1);
    attron(COLOR_PAIR(CP_HUD));
    if (def[0])
        mvprintw(row, col, "%s [default: %s]: ", label, def);
    else
        mvprintw(row, col, "%s: ", label);
    attroff(COLOR_PAIR(CP_HUD));
    clrtoeol();
    refresh();
    getnstr(buf, sizeof(buf) - 1);
    noecho();
    curs_set(0);

    const char *src = buf[0] ? buf : def;
    strncpy(out, src, outsz - 1);
    out[outsz - 1] = '\0';
}

typedef struct {
    char host[128];
    int port;
    char name[NET_MAX_NAME_LEN + 1];
} MPConnectInfo;

#define CHAT_LOG_LINES 3

/* Multiplayer session state. Reuses Game for the board/cursor/screen-origin
 * fields shared with single-player rendering; the multiplayer client never
 * mutates g.board itself - it only ever applies server-pushed snapshots. */
typedef struct {
    Game g;
    NetConn *nc;
    char my_name[NET_MAX_NAME_LEN + 1];
    char opponent_name[NET_MAX_NAME_LEN + 1];
    Avatar my_avatar;
    Avatar opponent_avatar;
    int my_player_id;
    int player_to_move;
    int scores[2];
    int mines_left;
    uint8_t session_token[NET_TOKEN_LEN];
    char status_line[96];

    bool chat_mode; /* true while composing an outgoing line */
    char chat_input[NET_CHAT_MSG_LEN + 1];
    int chat_input_len;
    char chat_log[CHAT_LOG_LINES][NET_MAX_NAME_LEN + NET_CHAT_MSG_LEN + 4]; /* ring buffer */
    int chat_log_next;
    int chat_log_count;
} MPState;

static void chat_log_push(MPState *mp, const char *from, const char *text)
{
    snprintf(mp->chat_log[mp->chat_log_next], sizeof(mp->chat_log[0]), "%s: %s", from, text);
    mp->chat_log_next = (mp->chat_log_next + 1) % CHAT_LOG_LINES;
    if (mp->chat_log_count < CHAT_LOG_LINES)
        mp->chat_log_count++;
}

static void draw_mp_hud(MPState *mp)
{
    int top = mp->g.top, left = mp->g.left;
    int board_width = mp->g.board.w * 2;

    const char *title = "ASCIISWEEPER - MULTIPLAYER";
    int title_col = left + (board_width - (int)strlen(title)) / 2;
    if (title_col < 0) title_col = 0;
    attron(COLOR_PAIR(CP_TITLE) | A_BOLD);
    mvprintw(top - 4, title_col, "%s", title);
    attroff(COLOR_PAIR(CP_TITLE) | A_BOLD);

    bool your_turn = (mp->player_to_move == mp->my_player_id);
    const char *turn_line = your_turn ? "YOUR TURN" : "Opponent's turn...";
    int turn_col = left + (board_width - (int)strlen(turn_line)) / 2;
    if (turn_col < 0) turn_col = 0;
    attron(COLOR_PAIR(your_turn ? CP_TITLE : CP_HUD) | A_BOLD);
    mvprintw(top - 3, turn_col, "%s", turn_line);
    attroff(COLOR_PAIR(your_turn ? CP_TITLE : CP_HUD) | A_BOLD);

    char status_line[96];
    snprintf(status_line, sizeof(status_line), "You: %s (%d)    Opponent: %s (%d)    Mines: %03d",
             mp->my_name, mp->scores[mp->my_player_id],
             mp->opponent_name, mp->scores[1 - mp->my_player_id],
             mp->mines_left < 0 ? 0 : mp->mines_left);
    int status_col = left + (board_width - (int)strlen(status_line)) / 2;
    if (status_col < 0) status_col = 0;
    attron(COLOR_PAIR(CP_HUD));
    mvprintw(top - 2, status_col, "%s", status_line);
    attroff(COLOR_PAIR(CP_HUD));
}

static void draw_mp_footer(MPState *mp)
{
    const char *line1 = "Move: arrows/hjkl  |  Reveal: space/enter  |  Flag: f";
    const char *line2 = "Chord: c  |  Chat: t  |  Menu: n  |  Quit: q";
    int scr_h, scr_w;
    getmaxyx(stdscr, scr_h, scr_w);
    (void)scr_h;

    int col1 = (scr_w - (int)strlen(line1)) / 2;
    int col2 = (scr_w - (int)strlen(line2)) / 2;
    if (col1 < 0) col1 = 0;
    if (col2 < 0) col2 = 0;

    attron(COLOR_PAIR(CP_HUD));
    mvprintw(mp->g.top + mp->g.board.h + 2, col1, "%s", line1);
    mvprintw(mp->g.top + mp->g.board.h + 3, col2, "%s", line2);
    attroff(COLOR_PAIR(CP_HUD));
}

static void draw_avatar_panels(MPState *mp)
{
    if (!mp->g.side_panels_fit)
        return;

    int left_avatar_left = mp->g.left - 1 - AVATAR_GUTTER - AVATAR_WIDTH_CHARS;
    int right_avatar_left = mp->g.left + mp->g.board.w * 2 + 1 + AVATAR_GUTTER;
    int avatar_top = mp->g.top + (mp->g.board.h - AVATAR_HEIGHT_CHARS) / 2;

    avatar_draw(stdscr, avatar_top, left_avatar_left, &mp->my_avatar);
    avatar_draw(stdscr, avatar_top, right_avatar_left, &mp->opponent_avatar);

    int name_row = avatar_top + AVATAR_HEIGHT_CHARS + 1;
    int my_name_col = left_avatar_left + (AVATAR_WIDTH_CHARS - (int)strlen(mp->my_name)) / 2;
    int opp_name_col = right_avatar_left + (AVATAR_WIDTH_CHARS - (int)strlen(mp->opponent_name)) / 2;
    if (my_name_col < left_avatar_left) my_name_col = left_avatar_left;
    if (opp_name_col < right_avatar_left) opp_name_col = right_avatar_left;

    attron(COLOR_PAIR(CP_HUD));
    mvprintw(name_row, my_name_col, "%s", mp->my_name);
    mvprintw(name_row, opp_name_col, "%s", mp->opponent_name);
    attroff(COLOR_PAIR(CP_HUD));
}

static void draw_chat(MPState *mp)
{
    int scr_h, scr_w;
    getmaxyx(stdscr, scr_h, scr_w);
    (void)scr_w;

    int row = mp->g.top + mp->g.board.h + 6;
    int start = (mp->chat_log_next - mp->chat_log_count + CHAT_LOG_LINES) % CHAT_LOG_LINES;

    attron(COLOR_PAIR(CP_HUD));
    for (int i = 0; i < mp->chat_log_count; i++) {
        int idx = (start + i) % CHAT_LOG_LINES;
        if (row + i < scr_h)
            mvprintw(row + i, mp->g.left, "%s", mp->chat_log[idx]);
    }
    attroff(COLOR_PAIR(CP_HUD));

    if (mp->chat_mode) {
        int input_row = row + mp->chat_log_count;
        if (input_row < scr_h) {
            attron(COLOR_PAIR(CP_HUD) | A_BOLD);
            mvprintw(input_row, mp->g.left, "Chat> %s_", mp->chat_input);
            attroff(COLOR_PAIR(CP_HUD) | A_BOLD);
        }
    }
}

static void render_multiplayer(MPState *mp)
{
    erase();
    draw_mp_hud(mp);
    draw_board_frame(&mp->g);
    draw_board(&mp->g);
    draw_avatar_panels(mp);
    draw_mp_footer(mp);
    if (mp->status_line[0]) {
        attron(COLOR_PAIR(CP_HUD) | A_BOLD);
        mvprintw(mp->g.top + mp->g.board.h + 5, mp->g.left, "%s", mp->status_line);
        attroff(COLOR_PAIR(CP_HUD) | A_BOLD);
    }
    draw_chat(mp);
    refresh();
}

/* Shows a message and waits briefly for a keypress or a short timeout. */
static void mp_show_message(MPState *mp, const char *msg)
{
    strncpy(mp->status_line, msg, sizeof(mp->status_line) - 1);
    render_multiplayer(mp);
    wtimeout(stdscr, 3000);
    getch();
}

static AfterGame mp_show_end_screen(MPState *mp, MatchEndReason reason)
{
    wtimeout(stdscr, -1);
    while (1) {
        render_multiplayer(mp);

        const char *msg;
        int color;
        if (reason == END_CLEAN_CLEAR) {
            msg = "BOARD CLEARED! Both players scored.";
            color = CP_WIN;
        } else if (reason == END_BOMB) {
            bool you_lost = mp->scores[mp->my_player_id] < 0;
            msg = you_lost ? "BOOM! You hit a mine." : "Opponent hit a mine - you're safe!";
            color = you_lost ? CP_LOSE : CP_WIN;
        } else {
            msg = "Match ended: opponent left.";
            color = CP_HUD;
        }

        attron(COLOR_PAIR(color) | A_BOLD);
        mvprintw(mp->g.top + mp->g.board.h + 5, mp->g.left, "%s", msg);
        attroff(COLOR_PAIR(color) | A_BOLD);
        attron(COLOR_PAIR(CP_HUD));
        mvprintw(mp->g.top + mp->g.board.h + 6, mp->g.left, "[N]ew match  [Q]uit");
        attroff(COLOR_PAIR(CP_HUD));
        refresh();

        int ch = getch();
        if (ch == 'n' || ch == 'N') { net_close(mp->nc); return AFTER_MENU; }
        if (ch == 'q' || ch == 'Q') { net_close(mp->nc); return AFTER_QUIT; }
    }
}

static AfterGame play_multiplayer(const char *host, int port, const char *name, Config *cfg)
{
    MPState mp;
    memset(&mp, 0, sizeof(mp));
    game_init(&mp.g, MP_BOARD_W, MP_BOARD_H, MP_MINES, true);
    strncpy(mp.my_name, name, NET_MAX_NAME_LEN);
    mp.my_avatar = cfg->avatar;
    strncpy(mp.status_line, "Connecting...", sizeof(mp.status_line) - 1);
    clear();
    wtimeout(stdscr, -1);
    render_multiplayer(&mp);

    mp.nc = net_connect(host, port, NULL);
    if (!mp.nc) {
        mp_show_message(&mp, "Could not connect, or the server's certificate could not be verified.");
        return AFTER_MENU;
    }

    strncpy(cfg->last_host, host, CONFIG_HOST_LEN - 1);
    cfg->last_host[CONFIG_HOST_LEN - 1] = '\0';
    cfg->last_port = port;
    config_save(cfg);

    MsgHello hello = { .protocol_version = NET_PROTO_VERSION,
                        .avatar_skin = cfg->avatar.skin_color,
                        .avatar_hair = cfg->avatar.hair_color };
    strncpy(hello.name, name, NET_MAX_NAME_LEN);
    uint8_t buf[NET_MAX_PAYLOAD];
    size_t n = pack_hello(buf, &hello);
    net_send_frame(mp.nc->ssl, MSG_HELLO, buf, n);

    strncpy(mp.status_line, "Waiting for an opponent...", sizeof(mp.status_line) - 1);
    bool matched = false;

    while (1) {
        render_multiplayer(&mp);

        int term_fd = STDIN_FILENO;
        int sock_fd = net_get_fd(mp.nc);
        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(term_fd, &rfds);
        FD_SET(sock_fd, &rfds);
        int maxfd = sock_fd > term_fd ? sock_fd : term_fd;
        struct timeval tv = { 1, 0 };
        int r = select(maxfd + 1, &rfds, NULL, NULL, &tv);
        if (r < 0)
            continue;

        if (r > 0 && FD_ISSET(sock_fd, &rfds)) {
            NetFrame frame;
            if (!net_recv_frame(mp.nc->ssl, &frame)) {
                if (!matched) {
                    net_close(mp.nc);
                    mp.nc = NULL;
                    mp_show_message(&mp, "Lost connection while waiting in the queue.");
                    return AFTER_MENU;
                }

                net_close(mp.nc);
                mp.nc = NULL;
                bool recovered = false;
                for (int attempt = 0; attempt < 20 && !recovered; attempt++) {
                    snprintf(mp.status_line, sizeof(mp.status_line),
                             "Connection lost. Reconnecting (attempt %d)...", attempt + 1);
                    render_multiplayer(&mp);
                    sleep(3);

                    NetConn *nc2 = net_connect(host, port, NULL);
                    if (!nc2)
                        continue;
                    net_send_frame(nc2->ssl, MSG_RECONNECT, mp.session_token, NET_TOKEN_LEN);
                    NetFrame rf;
                    if (net_recv_frame(nc2->ssl, &rf) && rf.type == MSG_RECONNECT_OK) {
                        MsgReconnectOk ok;
                        if (unpack_reconnect_ok(rf.payload, rf.len, &ok)) {
                            mp.nc = nc2;
                            mp.my_player_id = ok.your_player_id;
                            strncpy(mp.opponent_name, ok.opponent_name, NET_MAX_NAME_LEN);
                            mp.opponent_avatar.skin_color = ok.opponent_avatar_skin;
                            mp.opponent_avatar.hair_color = ok.opponent_avatar_hair;
                            mp.status_line[0] = '\0';
                            recovered = true;
                            continue;
                        }
                    }
                    net_close(nc2);
                }
                if (!recovered) {
                    mp_show_message(&mp, "Could not reconnect. Returning to menu.");
                    return AFTER_MENU;
                }
                continue;
            }

            switch (frame.type) {
                case MSG_MATCH_START: {
                    MsgMatchStart ms;
                    if (unpack_match_start(frame.payload, frame.len, &ms)) {
                        matched = true;
                        mp.my_player_id = ms.your_player_id;
                        mp.player_to_move = ms.first_to_move ? ms.your_player_id : (1 - ms.your_player_id);
                        strncpy(mp.opponent_name, ms.opponent_name, NET_MAX_NAME_LEN);
                        mp.opponent_avatar.skin_color = ms.opponent_avatar_skin;
                        mp.opponent_avatar.hair_color = ms.opponent_avatar_hair;
                        memcpy(mp.session_token, ms.session_token, NET_TOKEN_LEN);
                        board_init(&mp.g.board, ms.w, ms.h, ms.mines);
                        mp.status_line[0] = '\0';
                    }
                    break;
                }
                case MSG_BOARD_STATE: {
                    MsgBoardState ws;
                    if (unpack_board_state(frame.payload, frame.len, &ws)) {
                        wire_to_board(&ws, &mp.g.board);
                        mp.mines_left = ws.mines_left;
                        mp.scores[0] = ws.scores[0];
                        mp.scores[1] = ws.scores[1];
                    }
                    break;
                }
                case MSG_TURN: {
                    MsgTurn t;
                    if (unpack_turn(frame.payload, frame.len, &t))
                        mp.player_to_move = t.player_id_to_move;
                    break;
                }
                case MSG_OPPONENT_STATUS: {
                    MsgOpponentStatus st;
                    if (unpack_opponent_status(frame.payload, frame.len, &st)) {
                        if (st.state == OPP_DISCONNECTED)
                            snprintf(mp.status_line, sizeof(mp.status_line),
                                     "%s disconnected - waiting up to %ds...",
                                     mp.opponent_name, st.grace_seconds);
                        else
                            mp.status_line[0] = '\0';
                    }
                    break;
                }
                case MSG_MATCH_END: {
                    MsgMatchEnd me;
                    if (unpack_match_end(frame.payload, frame.len, &me)) {
                        mp.scores[0] = me.scores[0];
                        mp.scores[1] = me.scores[1];
                        return mp_show_end_screen(&mp, (MatchEndReason)me.reason);
                    }
                    break;
                }
                case MSG_CHAT_RECV: {
                    MsgChatRecv cr;
                    if (unpack_chat_recv(frame.payload, frame.len, &cr))
                        chat_log_push(&mp, mp.opponent_name, cr.text);
                    break;
                }
                case MSG_ERROR: {
                    MsgError em;
                    if (unpack_error(frame.payload, frame.len, &em))
                        snprintf(mp.status_line, sizeof(mp.status_line), "Server: %s", em.message);
                    break;
                }
                default:
                    break;
            }
        }

        if (r > 0 && FD_ISSET(term_fd, &rfds)) {
            int ch = getch();

            if (mp.chat_mode) {
                /* While composing, every key is text (or a control key for
                 * this input line) - none of it should fall through to the
                 * quit/menu/game bindings below. */
                if (ch == 27) {
                    mp.chat_mode = false;
                } else if (ch == '\n' || ch == KEY_ENTER) {
                    if (mp.chat_input_len > 0) {
                        MsgChat cm;
                        strncpy(cm.text, mp.chat_input, NET_CHAT_MSG_LEN);
                        cm.text[NET_CHAT_MSG_LEN] = '\0';
                        uint8_t cbuf[NET_MAX_PAYLOAD];
                        size_t cn = pack_chat(cbuf, &cm);
                        net_send_frame(mp.nc->ssl, MSG_CHAT, cbuf, cn);
                        chat_log_push(&mp, mp.my_name, mp.chat_input);
                    }
                    mp.chat_mode = false;
                } else if (ch == KEY_BACKSPACE || ch == 127 || ch == 8) {
                    if (mp.chat_input_len > 0)
                        mp.chat_input[--mp.chat_input_len] = '\0';
                } else if (ch >= 32 && ch < 127 && mp.chat_input_len < NET_CHAT_MSG_LEN) {
                    mp.chat_input[mp.chat_input_len++] = (char)ch;
                    mp.chat_input[mp.chat_input_len] = '\0';
                }
                continue;
            }

            if (ch == 'q' || ch == 'Q') { net_close(mp.nc); return AFTER_QUIT; }
            if (ch == 'n' || ch == 'N') { net_close(mp.nc); return AFTER_MENU; }
            if (!matched)
                continue; /* ignore game keys while still queued */

            switch (ch) {
                case 't': case 'T':
                    mp.chat_mode = true;
                    mp.chat_input[0] = '\0';
                    mp.chat_input_len = 0;
                    break;
                case KEY_UP: case 'k':
                    if (mp.g.cursor_y > 0) mp.g.cursor_y--;
                    break;
                case KEY_DOWN: case 'j':
                    if (mp.g.cursor_y < mp.g.board.h - 1) mp.g.cursor_y++;
                    break;
                case KEY_LEFT: case 'h':
                    if (mp.g.cursor_x > 0) mp.g.cursor_x--;
                    break;
                case KEY_RIGHT: case 'l':
                    if (mp.g.cursor_x < mp.g.board.w - 1) mp.g.cursor_x++;
                    break;
                case ' ': case '\n': case KEY_ENTER: {
                    bool revealed = mp.g.board.cells[mp.g.cursor_y][mp.g.cursor_x].revealed;
                    uint8_t abuf[2] = { (uint8_t)mp.g.cursor_x, (uint8_t)mp.g.cursor_y };
                    net_send_frame(mp.nc->ssl, revealed ? MSG_ACTION_CHORD : MSG_ACTION_REVEAL, abuf, 2);
                    break;
                }
                case 'f': case 'F': {
                    Cell *c = &mp.g.board.cells[mp.g.cursor_y][mp.g.cursor_x];
                    uint8_t abuf[3] = { (uint8_t)mp.g.cursor_x, (uint8_t)mp.g.cursor_y, (uint8_t)(c->flagged ? 0 : 1) };
                    net_send_frame(mp.nc->ssl, MSG_ACTION_FLAG, abuf, 3);
                    break;
                }
                case 'c': case 'C': {
                    uint8_t abuf[2] = { (uint8_t)mp.g.cursor_x, (uint8_t)mp.g.cursor_y };
                    net_send_frame(mp.nc->ssl, MSG_ACTION_CHORD, abuf, 2);
                    break;
                }
                default:
                    break;
            }
        }
    }
}

static void avatar_screen(Config *cfg)
{
    wtimeout(stdscr, -1);
    const char *hint = "[G] Generate new avatar   [Enter/Esc] Save and back";

    while (1) {
        erase();
        int scr_h, scr_w;
        getmaxyx(stdscr, scr_h, scr_w);

        int block_h = AVATAR_HEIGHT_CHARS + 4;
        int top = (scr_h - block_h) / 2;
        int left = (scr_w - AVATAR_WIDTH_CHARS) / 2;
        if (top < 0) top = 0;
        if (left < 0) left = 0;

        attron(COLOR_PAIR(CP_TITLE) | A_BOLD);
        mvprintw(top, left + (AVATAR_WIDTH_CHARS - 6) / 2, "AVATAR");
        attroff(COLOR_PAIR(CP_TITLE) | A_BOLD);

        avatar_draw(stdscr, top + 2, left, &cfg->avatar);

        attron(COLOR_PAIR(CP_HUD));
        mvprintw(top + block_h - 1, left + (AVATAR_WIDTH_CHARS - (int)strlen(hint)) / 2, "%s", hint);
        attroff(COLOR_PAIR(CP_HUD));
        refresh();

        int ch = getch();
        if (ch == 'g' || ch == 'G') {
            avatar_random(&cfg->avatar);
        } else if (ch == '\n' || ch == ' ' || ch == KEY_ENTER || ch == 27 || ch == 'q' || ch == 'Q') {
            config_save(cfg);
            return;
        }
    }
}

static MenuChoice menu(Difficulty *custom_out, MPConnectInfo *mp_out, Config *cfg)
{
    const char *title = "ASCIISWEEPER";
    const char *subtitle = "a terminal minesweeper  -  " ASCIISWEEPER_VERSION;
    const char *labels[] = {
        "Beginner     (9x9, 10 mines)",
        "Intermediate (16x16, 40 mines)",
        "Expert       (30x16, 99 mines)",
        "Multiplayer  (16x16, 40 mines, online)",
        "Avatar...",
        "Custom...",
        "Quit"
    };
    const char *hint = "Move: up/down or j/k   Select: enter/space   Quit: q";
    int n = 7;
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
            case '\n': case ' ': case KEY_ENTER: {
                MenuChoice choice = (MenuChoice)sel;
                if (choice == MENU_QUIT) return MENU_QUIT;
                if (choice == MENU_AVATAR) {
                    avatar_screen(cfg);
                    clear();
                    break;
                }
                if (choice == MENU_CUSTOM) {
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
                if (choice == MENU_MULTIPLAYER) {
                    int prow = top + 3 + n + 3;
                    int port;
                    prompt_str("Server host", prow, left, cfg->last_host, mp_out->host, sizeof(mp_out->host));
                    prompt_int("Port", prow + 1, left, 1, 65535, cfg->last_port, &port);
                    mp_out->port = port;
                    prompt_str("Your name", prow + 2, left, "Player", mp_out->name, sizeof(mp_out->name));
                    return MENU_MULTIPLAYER;
                }
                return choice;
            }
            case 'q': case 'Q':
                return MENU_QUIT;
            default:
                break;
        }
    }
}

int main(int argc, char **argv)
{
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-v") == 0 || strcmp(argv[i], "--version") == 0) {
            printf("asciisweeper %s\n", ASCIISWEEPER_VERSION);
            return 0;
        }
    }

    srand((unsigned)time(NULL));

    Config cfg;
    config_load(&cfg);

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
        MPConnectInfo mpinfo = { .port = 4443 };
        MenuChoice choice = menu(&custom, &mpinfo, &cfg);

        if (choice == MENU_MULTIPLAYER) {
            AfterGame after = play_multiplayer(mpinfo.host, mpinfo.port, mpinfo.name, &cfg);
            if (after == AFTER_QUIT)
                running = false;
            continue;
        }

        Difficulty d;

        switch (choice) {
            case MENU_BEGINNER: d = PRESETS[0]; break;
            case MENU_INTERMEDIATE: d = PRESETS[1]; break;
            case MENU_EXPERT: d = PRESETS[2]; break;
            case MENU_CUSTOM: d = custom; break;
            case MENU_MULTIPLAYER: /* handled above */
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
