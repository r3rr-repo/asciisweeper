#ifndef ASCIISWEEPER_UUID_H
#define ASCIISWEEPER_UUID_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define UUID_BYTES 16
#define UUID_STR_LEN 36   /* 8-4-4-4-12, without a terminator */

/*
 * UUIDv7, RFC 9562 section 5.7: a 48-bit big-endian millisecond timestamp
 * followed by random bits, so identifiers sort by creation time. That ordering
 * is the reason for choosing v7 over v4 here - a ranking table keyed by player
 * gets locality for free.
 *
 * Deliberately pure: the caller supplies the clock and the entropy, so the same
 * inputs always produce the same UUID and the function can be checked against
 * published vectors. `rnd` needs 10 bytes - 12 bits become rand_a and 62 bits
 * become rand_b, with the remaining 6 bits overwritten by the version and
 * variant fields.
 */
void uuid_v7(uint8_t out[UUID_BYTES], uint64_t unix_ms, const uint8_t rnd[10]);

/* Version nibble is 7 and the variant bits are 0b10. */
bool uuid_is_v7(const uint8_t u[UUID_BYTES]);

/* Canonical lowercase 8-4-4-4-12. `out` needs UUID_STR_LEN + 1 bytes. */
void uuid_format(const uint8_t u[UUID_BYTES], char *out);

/* Parses canonical form. Returns false on wrong length, bad characters or
 * misplaced dashes - it does NOT check the version, so a caller that cares
 * should also call uuid_is_v7. */
bool uuid_parse(const char *s, uint8_t out[UUID_BYTES]);

/* Lowercase hex helpers, used for the 32-byte secret in the config file.
 * hex_encode writes 2*len chars plus a terminator. */
void hex_encode(const uint8_t *in, size_t len, char *out);
bool hex_decode(const char *s, uint8_t *out, size_t len);

#endif
