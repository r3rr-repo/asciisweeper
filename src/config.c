#include "config.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <sys/stat.h>
#include <time.h>
#include <openssl/rand.h>

#include "uuid.h"

#define CONFIG_DIR_FMT  "%s/.config/asciisweeper"
#define CONFIG_FILE_FMT "%s/.config/asciisweeper/config"

static bool config_path(char *buf, size_t len, const char *fmt)
{
    const char *home = getenv("HOME");
    if (!home || !home[0])
        return false;
    snprintf(buf, len, fmt, home);
    return true;
}

/* A fresh identity: a UUIDv7 stamped with the current time plus a secret that
 * proves it. OpenSSL's RAND_bytes is already a dependency of this binary and is
 * the right source for both - a predictable secret would be no secret. */
void config_new_identity(Config *cfg)
{
    uint8_t rnd[10];
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    uint64_t ms = (uint64_t)ts.tv_sec * 1000u + (uint64_t)(ts.tv_nsec / 1000000);

    if (RAND_bytes(rnd, sizeof(rnd)) != 1 ||
        RAND_bytes(cfg->player_secret, NET_SECRET_LEN) != 1) {
        /* Without real entropy an identity would be guessable, and a guessable
         * identity is worse than none once scores are attached to it. */
        fprintf(stderr, "asciisweeper: no secure randomness available for a player id\n");
        exit(1);
    }
    uuid_v7(cfg->player_uuid, ms, rnd);
}

static void set_defaults(Config *cfg)
{
    avatar_random(&cfg->avatar);
    config_new_identity(cfg);
    strncpy(cfg->last_host, "localhost", CONFIG_HOST_LEN - 1);
    cfg->last_host[CONFIG_HOST_LEN - 1] = '\0';
    cfg->last_port = 4443;
    strncpy(cfg->last_name, "Player", NET_MAX_NAME_LEN);
    cfg->last_name[NET_MAX_NAME_LEN] = '\0';
    cfg->last_ca_file[0] = '\0';
}

void config_load(Config *cfg)
{
    set_defaults(cfg);

    char path[512];
    if (!config_path(path, sizeof(path), CONFIG_FILE_FMT))
        return;

    FILE *f = fopen(path, "r");
    if (!f) {
        config_save(cfg); /* first run: persist the freshly-generated defaults */
        return;
    }

    bool have_skin = false, have_hair = false;
    bool have_id = false, have_secret = false;
    char line[256];
    while (fgets(line, sizeof(line), f)) {
        char key[64], value[192];
        if (sscanf(line, "%63[^=]=%191[^\n]", key, value) != 2)
            continue;
        if (strcmp(key, "avatar_skin") == 0) { cfg->avatar.skin_color = (uint8_t)atoi(value); have_skin = true; }
        else if (strcmp(key, "avatar_hair") == 0) { cfg->avatar.hair_color = (uint8_t)atoi(value); have_hair = true; }
        else if (strcmp(key, "last_host") == 0) { strncpy(cfg->last_host, value, CONFIG_HOST_LEN - 1); cfg->last_host[CONFIG_HOST_LEN - 1] = '\0'; }
        else if (strcmp(key, "last_port") == 0) { cfg->last_port = atoi(value); }
        else if (strcmp(key, "last_name") == 0) { strncpy(cfg->last_name, value, NET_MAX_NAME_LEN); cfg->last_name[NET_MAX_NAME_LEN] = '\0'; }
        else if (strcmp(key, "last_ca_file") == 0) { strncpy(cfg->last_ca_file, value, CONFIG_CA_FILE_LEN - 1); cfg->last_ca_file[CONFIG_CA_FILE_LEN - 1] = '\0'; }
        else if (strcmp(key, "player_id") == 0) { have_id = uuid_parse(value, cfg->player_uuid) && uuid_is_v7(cfg->player_uuid); }
        else if (strcmp(key, "player_secret") == 0) { have_secret = hex_decode(value, cfg->player_secret, NET_SECRET_LEN); }
    }
    fclose(f);

    /* A partially-written or hand-edited file might be missing the avatar
     * entirely; fall back to keeping the freshly-generated default for
     * whichever half is absent rather than leaving it zeroed. */
    /* A config predating identities, or one that was hand-edited into an
     * inconsistent state, gets a fresh pair. Both halves must be present and
     * valid: a UUID without its secret cannot authenticate, and a secret
     * without its UUID names nobody. */
    if (!have_id || !have_secret) {
        config_new_identity(cfg);
        config_save(cfg);
    }

    if (!have_skin || !have_hair) {
        Avatar fallback;
        avatar_random(&fallback);
        if (!have_skin) cfg->avatar.skin_color = fallback.skin_color;
        if (!have_hair) cfg->avatar.hair_color = fallback.hair_color;
    }
    if (cfg->last_port <= 0 || cfg->last_port > 65535)
        cfg->last_port = 4443;
}

void config_save(const Config *cfg)
{
    const char *home = getenv("HOME");
    if (!home || !home[0])
        return;

    char config_home[512], dir[512], path[512];
    snprintf(config_home, sizeof(config_home), "%s/.config", home);
    mkdir(config_home, 0755); /* mkdir isn't recursive - ~/.config may not exist yet */

    if (!config_path(dir, sizeof(dir), CONFIG_DIR_FMT))
        return;
    if (!config_path(path, sizeof(path), CONFIG_FILE_FMT))
        return;

    mkdir(dir, 0755); /* ignore EEXIST and any other failure - best effort */

    FILE *f = fopen(path, "w");
    if (!f)
        return;
    fprintf(f, "avatar_skin=%d\n", cfg->avatar.skin_color);
    fprintf(f, "avatar_hair=%d\n", cfg->avatar.hair_color);
    fprintf(f, "last_host=%s\n", cfg->last_host);
    fprintf(f, "last_port=%d\n", cfg->last_port);
    fprintf(f, "last_name=%s\n", cfg->last_name);
    fprintf(f, "last_ca_file=%s\n", cfg->last_ca_file);
    {
        char id[UUID_STR_LEN + 1], secret[NET_SECRET_LEN * 2 + 1];
        uuid_format(cfg->player_uuid, id);
        hex_encode(cfg->player_secret, NET_SECRET_LEN, secret);
        fprintf(f, "player_id=%s\n", id);
        fprintf(f, "player_secret=%s\n", secret);
    }
    fclose(f);
}
