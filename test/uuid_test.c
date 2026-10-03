/*
 * Tests for the shared UUIDv7 implementation.
 *
 *   cmake --build build --target uuid-test && ./build/uuid-test
 *
 * uuid_v7 takes the clock and the entropy as arguments precisely so it can be
 * checked against RFC 9562's published vector rather than only against itself.
 */
#include <stdio.h>
#include <string.h>

#include "uuid.h"

static int pass = 0, fail = 0;

static void check(bool cond, const char *what)
{
    if (cond) pass++;
    else { fail++; printf("FAIL: %s\n", what); }
}

static void check_str(const char *got, const char *want, const char *what)
{
    if (strcmp(got, want) == 0) pass++;
    else { fail++; printf("FAIL: %s\n  got  %s\n  want %s\n", what, got, want); }
}

int main(void)
{
    uint8_t u[UUID_BYTES];
    char s[UUID_STR_LEN + 1];

    /* ---- RFC 9562 A.6, the worked UUIDv7 example ----
     * timestamp 2022-02-22 14:22:22.000 UTC = 0x017F22E279B0 ms,
     * rand_a = 0xCC3, rand_b starting 0x18C4DC0C0C07398F.
     * The spec's value is 017F22E2-79B0-7CC3-98C4-DC0C0C07398F. */
    {
        uint64_t ms = 0x017F22E279B0ULL;
        uint8_t rnd[10] = {
            0x0C, 0xC3,                                     /* rand_a: 0xCC3 */
            0x18, 0xC4, 0xDC, 0x0C, 0x0C, 0x07, 0x39, 0x8F, /* rand_b */
        };
        uuid_v7(u, ms, rnd);
        uuid_format(u, s);
        check_str(s, "017f22e2-79b0-7cc3-98c4-dc0c0c07398f",
                  "matches RFC 9562's worked UUIDv7 example");
        check(uuid_is_v7(u), "the RFC example is recognised as v7");
    }

    /* ---- version and variant are forced, whatever the entropy ---- */
    for (int fillv = 0; fillv < 256; fillv += 17) {
        uint8_t rnd[10];
        memset(rnd, (uint8_t)fillv, sizeof(rnd));
        uuid_v7(u, 0x0123456789ABULL, rnd);
        check((u[6] & 0xF0) == 0x70, "version nibble is always 7");
        check((u[8] & 0xC0) == 0x80, "variant bits are always 0b10");
        check(uuid_is_v7(u), "uuid_is_v7 agrees");
    }

    /* ---- the timestamp really is in the high 48 bits, big-endian ---- */
    {
        uint8_t rnd[10] = {0};
        uuid_v7(u, 0x0102030405A6ULL, rnd);
        check(u[0] == 0x01 && u[1] == 0x02 && u[2] == 0x03 &&
              u[3] == 0x04 && u[4] == 0x05 && u[5] == 0xA6,
              "the 48-bit timestamp lands big-endian in bytes 0-5");

        /* Anything above 48 bits is dropped, per the spec. */
        uuid_v7(u, 0xFFFF0102030405A6ULL, rnd);
        check(u[0] == 0x01 && u[5] == 0xA6, "bits above 48 are truncated, not wrapped in");
    }

    /* ---- v7 sorts by creation time, which is why it was chosen ---- */
    {
        uint8_t rnd[10];
        memset(rnd, 0xFF, sizeof(rnd));   /* worst case: max random bits */
        char earlier[UUID_STR_LEN + 1], later[UUID_STR_LEN + 1];
        uuid_v7(u, 1000, rnd);
        uuid_format(u, earlier);
        memset(rnd, 0x00, sizeof(rnd));   /* and min random bits for the later one */
        uuid_v7(u, 2000, rnd);
        uuid_format(u, later);
        check(strcmp(earlier, later) < 0,
              "an earlier timestamp sorts first even with maximal entropy against it");
    }

    /* ---- format and parse round-trip ---- */
    {
        uint8_t a[UUID_BYTES], b[UUID_BYTES];
        uint8_t rnd[10] = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 };
        uuid_v7(a, 1730000000000ULL, rnd);
        uuid_format(a, s);
        check(uuid_parse(s, b), "a formatted UUID parses back");
        check(memcmp(a, b, UUID_BYTES) == 0, "...to the same bytes");
        check(strlen(s) == UUID_STR_LEN, "formatted length is 36");
        check(s[8] == '-' && s[13] == '-' && s[18] == '-' && s[23] == '-',
              "dashes are in the 8-4-4-4-12 positions");
    }

    /* ---- parse rejects malformed input ---- */
    {
        uint8_t tmp[UUID_BYTES];
        check(!uuid_parse(NULL, tmp), "NULL is rejected");
        check(!uuid_parse("", tmp), "empty is rejected");
        check(!uuid_parse("017f22e2-79b0-7cc3-98c4-dc0c0c07398", tmp), "too short is rejected");
        check(!uuid_parse("017f22e2-79b0-7cc3-98c4-dc0c0c07398ff", tmp), "too long is rejected");
        check(!uuid_parse("017f22e2779b0-7cc3-98c4-dc0c0c07398f", tmp), "a missing dash is rejected");
        check(!uuid_parse("017f22e2-79b0-7cc3-98c4-dc0c0c0739gf", tmp), "a non-hex digit is rejected");
        check(uuid_parse("017F22E2-79B0-7CC3-98C4-DC0C0C07398F", tmp), "uppercase is accepted");
        char up[UUID_STR_LEN + 1];
        uuid_format(tmp, up);
        check_str(up, "017f22e2-79b0-7cc3-98c4-dc0c0c07398f", "...and normalises to lowercase");
    }

    /* ---- a v4 UUID must not pass the v7 check ---- */
    {
        uint8_t v4[UUID_BYTES];
        check(uuid_parse("9b2b1a3e-1f4d-4c7a-8f21-2b7c9d0e5a63", v4), "a v4 UUID parses");
        check(!uuid_is_v7(v4), "but is not accepted as v7");
    }

    /* ---- hex helpers, used for the 32-byte secret ---- */
    {
        uint8_t secret[32], back[32];
        char hex[65];
        for (int i = 0; i < 32; i++) secret[i] = (uint8_t)(i * 7 + 3);
        hex_encode(secret, 32, hex);
        check(strlen(hex) == 64, "32 bytes encode to 64 hex characters");
        check(hex_decode(hex, back, 32), "and decode back");
        check(memcmp(secret, back, 32) == 0, "...to the same bytes");
        check(!hex_decode("abc", back, 32), "a short hex string is rejected");
        check(!hex_decode("zz", back, 1), "a non-hex character is rejected");
        uint8_t one[1];
        check(hex_decode("ff", one, 1) && one[0] == 0xFF, "hex_decode handles the max byte");
    }

    printf("%d passed, %d failed\n", pass, fail);
    return fail ? 1 : 0;
}
