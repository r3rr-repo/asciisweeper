#include "config.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <sys/stat.h>

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

static void set_defaults(Config *cfg)
{
    avatar_random(&cfg->avatar);
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
    }
    fclose(f);

    /* A partially-written or hand-edited file might be missing the avatar
     * entirely; fall back to keeping the freshly-generated default for
     * whichever half is absent rather than leaving it zeroed. */
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
    fclose(f);
}
