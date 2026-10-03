/*
 * Round-trip tests for the terminal client's config.
 *
 *   cmake --build build --target config-test && ./build/config-test
 *
 * The property that matters is that an identity SURVIVES: generated once on
 * first run, then loaded unchanged every time after. A config that quietly
 * regenerated would silently orphan a player's score history.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "config.h"
#include "uuid.h"

static int pass = 0, fail = 0;
static void check(bool c, const char *what)
{
    if (c) pass++; else { fail++; printf("FAIL: %s\n", what); }
}

int main(void)
{
    char tmpl[] = "/tmp/asciisweeper-cfg-XXXXXX";
    char *home = mkdtemp(tmpl);
    if (!home) { printf("could not make a temp HOME\n"); return 1; }
    setenv("HOME", home, 1);

    /* ---- first run generates and persists an identity ---- */
    Config a;
    config_load(&a);
    check(uuid_is_v7(a.player_uuid), "first run generates a v7 player id");

    bool secret_nonzero = false;
    for (int i = 0; i < NET_SECRET_LEN; i++)
        if (a.player_secret[i] != 0) { secret_nonzero = true; break; }
    check(secret_nonzero, "first run generates a non-zero secret");

    char path[512];
    snprintf(path, sizeof(path), "%s/.config/asciisweeper/config", home);
    check(access(path, R_OK) == 0, "the config file was written on first run");

    /* ---- a reload returns the SAME identity ---- */
    Config b;
    config_load(&b);
    check(memcmp(a.player_uuid, b.player_uuid, UUID_BYTES) == 0,
          "the player id survives a reload");
    check(memcmp(a.player_secret, b.player_secret, NET_SECRET_LEN) == 0,
          "the secret survives a reload");

    /* ---- and again, to be sure nothing rewrites on every load ---- */
    Config c;
    config_load(&c);
    check(memcmp(a.player_uuid, c.player_uuid, UUID_BYTES) == 0,
          "...and a second reload");

    /* ---- regenerating really does change it ---- */
    Config d = b;
    config_new_identity(&d);
    check(memcmp(a.player_uuid, d.player_uuid, UUID_BYTES) != 0,
          "regenerating produces a different id");
    check(uuid_is_v7(d.player_uuid), "the regenerated id is still v7");

    /* ---- a config with an id but no secret is replaced wholesale ---- */
    {
        FILE *f = fopen(path, "w");
        fprintf(f, "avatar_skin=3\navatar_hair=5\n");
        fprintf(f, "player_id=017f22e2-79b0-7cc3-98c4-dc0c0c07398f\n");
        fclose(f);

        Config e;
        config_load(&e);
        uint8_t half[UUID_BYTES];
        uuid_parse("017f22e2-79b0-7cc3-98c4-dc0c0c07398f", half);
        check(memcmp(e.player_uuid, half, UUID_BYTES) != 0,
              "an id with no secret cannot authenticate, so a fresh pair replaces it");
        check(uuid_is_v7(e.player_uuid), "and the replacement is valid");
    }

    /* ---- a garbage id is not accepted ---- */
    {
        FILE *f = fopen(path, "w");
        fprintf(f, "player_id=not-a-uuid\nplayer_secret=zz\n");
        fclose(f);

        Config g;
        config_load(&g);
        check(uuid_is_v7(g.player_uuid), "a malformed stored id is replaced with a valid one");
    }

    /* ---- a v4 id is rejected: the server only accepts v7 ---- */
    {
        FILE *f = fopen(path, "w");
        fprintf(f, "player_id=9b2b1a3e-1f4d-4c7a-8f21-2b7c9d0e5a63\n");
        fprintf(f, "player_secret=");
        for (int i = 0; i < NET_SECRET_LEN * 2; i++) fputc('a', f);
        fprintf(f, "\n");
        fclose(f);

        Config h;
        config_load(&h);
        check(uuid_is_v7(h.player_uuid), "a stored v4 id is replaced with a v7 one");
    }

    printf("%d passed, %d failed\n", pass, fail);
    return fail ? 1 : 0;
}
