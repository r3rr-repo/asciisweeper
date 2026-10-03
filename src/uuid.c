#include "uuid.h"

#include <string.h>

void uuid_v7(uint8_t out[UUID_BYTES], uint64_t unix_ms, const uint8_t rnd[10])
{
    /* 48-bit timestamp, big-endian. Truncating to 48 bits is per the spec and
     * does not wrap until the year 10889. */
    out[0] = (uint8_t)((unix_ms >> 40) & 0xFF);
    out[1] = (uint8_t)((unix_ms >> 32) & 0xFF);
    out[2] = (uint8_t)((unix_ms >> 24) & 0xFF);
    out[3] = (uint8_t)((unix_ms >> 16) & 0xFF);
    out[4] = (uint8_t)((unix_ms >> 8) & 0xFF);
    out[5] = (uint8_t)(unix_ms & 0xFF);

    /* Version 7 in the high nibble of byte 6, then 12 bits of rand_a. */
    out[6] = (uint8_t)(0x70 | (rnd[0] & 0x0F));
    out[7] = rnd[1];

    /* Variant 0b10 in the top two bits of byte 8, then 62 bits of rand_b. */
    out[8] = (uint8_t)(0x80 | (rnd[2] & 0x3F));
    for (int i = 0; i < 7; i++)
        out[9 + i] = rnd[3 + i];
}

bool uuid_is_v7(const uint8_t u[UUID_BYTES])
{
    return ((u[6] & 0xF0) == 0x70) && ((u[8] & 0xC0) == 0x80);
}

static const char HEX[] = "0123456789abcdef";

void uuid_format(const uint8_t u[UUID_BYTES], char *out)
{
    static const int dash_after[] = { 4, 6, 8, 10 };
    int o = 0, d = 0;
    for (int i = 0; i < UUID_BYTES; i++) {
        out[o++] = HEX[(u[i] >> 4) & 0x0F];
        out[o++] = HEX[u[i] & 0x0F];
        if (d < 4 && i + 1 == dash_after[d]) { out[o++] = '-'; d++; }
    }
    out[o] = '\0';
}

static int hex_val(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

bool uuid_parse(const char *s, uint8_t out[UUID_BYTES])
{
    if (!s || strlen(s) != UUID_STR_LEN)
        return false;
    static const int dash_at[] = { 8, 13, 18, 23 };
    int di = 0, byte = 0;
    for (int i = 0; i < UUID_STR_LEN; ) {
        if (di < 4 && i == dash_at[di]) {
            if (s[i] != '-') return false;
            i++; di++;
            continue;
        }
        int hi = hex_val(s[i]), lo = hex_val(s[i + 1]);
        if (hi < 0 || lo < 0) return false;
        out[byte++] = (uint8_t)((hi << 4) | lo);
        i += 2;
    }
    return byte == UUID_BYTES;
}

void hex_encode(const uint8_t *in, size_t len, char *out)
{
    for (size_t i = 0; i < len; i++) {
        out[i * 2] = HEX[(in[i] >> 4) & 0x0F];
        out[i * 2 + 1] = HEX[in[i] & 0x0F];
    }
    out[len * 2] = '\0';
}

bool hex_decode(const char *s, uint8_t *out, size_t len)
{
    if (!s || strlen(s) != len * 2)
        return false;
    for (size_t i = 0; i < len; i++) {
        int hi = hex_val(s[i * 2]), lo = hex_val(s[i * 2 + 1]);
        if (hi < 0 || lo < 0) return false;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return true;
}
