#ifndef ASCIISWEEPER_NETADDR_H
#define ASCIISWEEPER_NETADDR_H

#include <netinet/in.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/socket.h>

/* A peer address of either family, small enough to copy around and compare
 * directly - unlike sockaddr_storage, which is 128 bytes and carries ports and
 * scope ids the server has no use for. */
typedef struct {
    sa_family_t family;   /* AF_INET or AF_INET6 */
    union {
        struct in_addr v4;
        struct in6_addr v6;
    } addr;
} PeerAddr;

/* Returns false for any family the server does not handle. */
bool peer_from_sockaddr(const struct sockaddr *sa, PeerAddr *out);

/* Writes the printable form; `len` should be at least INET6_ADDRSTRLEN. Always
 * leaves `buf` NUL-terminated, falling back to "?" if anything goes wrong, so
 * callers can log it unconditionally. */
void peer_to_str(const PeerAddr *p, char *buf, size_t len);

/*
 * What the rate limiter matches on.
 *
 * IPv4 is keyed on the whole address, IPv6 on the first 64 bits. A single IPv6
 * subscriber is normally handed an entire /64, so keying on the full address
 * would let one person cycle through 2^64 of them and make MAX_QUEUED_PER_IP
 * purely decorative.
 */
typedef struct {
    sa_family_t family;
    uint8_t bytes[8];     /* 4 significant for IPv4, 8 for IPv6 */
} RateKey;

RateKey rate_key_of(const PeerAddr *p);
bool rate_key_eq(const RateKey *a, const RateKey *b);

#endif
