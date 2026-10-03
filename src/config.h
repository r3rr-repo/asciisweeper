#ifndef ASCIISWEEPER_CONFIG_H
#define ASCIISWEEPER_CONFIG_H

#include "avatar.h"
#include "uuid.h"
#include "net_proto.h"

#define CONFIG_HOST_LEN 128
#define CONFIG_CA_FILE_LEN 256

typedef struct {
    Avatar avatar;
    /* Stable identity. The UUID is public; the secret proves it is ours and
     * must be treated like a password. Generated on first run and then never
     * changed unless the player explicitly regenerates or imports. */
    uint8_t player_uuid[UUID_BYTES];
    uint8_t player_secret[NET_SECRET_LEN];
    char last_host[CONFIG_HOST_LEN];
    int last_port;
    char last_name[NET_MAX_NAME_LEN + 1];
    char last_ca_file[CONFIG_CA_FILE_LEN]; /* empty means: use the system trust store */
} Config;

/* Loads ~/.config/asciisweeper/config. On any failure (missing file,
 * missing HOME, missing/malformed keys) fills in sensible defaults for
 * whatever wasn't found: a freshly randomized avatar (also saved
 * immediately, so the very first run doesn't re-roll every launch),
 * last_host="localhost"/last_port=4443, last_name="Player", and an empty
 * last_ca_file (system trust store). Always
 * succeeds from the caller's point of view - there's no failure return,
 * just defaults. */
void config_load(Config *cfg);

/* Writes cfg to ~/.config/asciisweeper/config, creating the directory if
 * needed. Best-effort: silently does nothing if $HOME is unset or the
 * directory/file can't be created (e.g. read-only filesystem) - losing a
 * saved preference isn't worth crashing the game over. */
void config_save(const Config *cfg);

/* Replaces the stored identity with a freshly generated one. Abandons the old
 * one irrecoverably, so callers should confirm first. */
void config_new_identity(Config *cfg);

#endif
