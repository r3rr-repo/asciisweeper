#ifndef ASCIISWEEPER_CONFIG_H
#define ASCIISWEEPER_CONFIG_H

#include "avatar.h"

#define CONFIG_HOST_LEN 128

typedef struct {
    Avatar avatar;
    char last_host[CONFIG_HOST_LEN];
    int last_port;
} Config;

/* Loads ~/.config/asciisweeper/config. On any failure (missing file,
 * missing HOME, missing/malformed keys) fills in sensible defaults for
 * whatever wasn't found: a freshly randomized avatar (also saved
 * immediately, so the very first run doesn't re-roll every launch) and
 * last_host="localhost"/last_port=4443. Always succeeds from the caller's
 * point of view - there's no failure return, just defaults. */
void config_load(Config *cfg);

/* Writes cfg to ~/.config/asciisweeper/config, creating the directory if
 * needed. Best-effort: silently does nothing if $HOME is unset or the
 * directory/file can't be created (e.g. read-only filesystem) - losing a
 * saved preference isn't worth crashing the game over. */
void config_save(const Config *cfg);

#endif
