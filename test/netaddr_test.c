/*
 * Tests for peer addresses and the rate-limit key.
 *
 *   cmake --build build --target netaddr-test && ./build/netaddr-test
 *
 * The /64 rule is the part worth pinning down: keyed on a full IPv6 address,
 * MAX_QUEUED_PER_IP would be meaningless, because one subscriber normally
 * holds an entire /64 and could cycle through 2^64 addresses.
 */
#include <arpa/inet.h>
#include <stdio.h>
#include <string.h>

#include "netaddr.h"

static int pass = 0, fail = 0;
static void check(bool c, const char *what)
{
    if (c) pass++; else { fail++; printf("FAIL: %s\n", what); }
}

static PeerAddr v4(const char *s)
{
    PeerAddr p; memset(&p, 0, sizeof(p));
    p.family = AF_INET;
    inet_pton(AF_INET, s, &p.addr.v4);
    return p;
}
static PeerAddr v6(const char *s)
{
    PeerAddr p; memset(&p, 0, sizeof(p));
    p.family = AF_INET6;
    inet_pton(AF_INET6, s, &p.addr.v6);
    return p;
}
static bool same_key(PeerAddr a, PeerAddr b)
{
    RateKey ka = rate_key_of(&a), kb = rate_key_of(&b);
    return rate_key_eq(&ka, &kb);
}
static const char *fmt(PeerAddr p, char *buf, size_t n)
{
    peer_to_str(&p, buf, n);
    return buf;
}

int main(void)
{
    char b[INET6_ADDRSTRLEN];

    /* ---- formatting both families ---- */
    check(strcmp(fmt(v4("192.0.2.17"), b, sizeof(b)), "192.0.2.17") == 0,
          "an IPv4 address formats as a dotted quad");
    check(strcmp(fmt(v6("2001:db8::1"), b, sizeof(b)), "2001:db8::1") == 0,
          "an IPv6 address formats in its compressed form");
    check(strcmp(fmt(v6("::1"), b, sizeof(b)), "::1") == 0, "loopback formats as ::1");
    check(strcmp(fmt(v6("2001:0db8:0000:0000:0000:0000:0000:0001"), b, sizeof(b)),
                 "2001:db8::1") == 0, "a long form is normalised when printed");

    /* An unset family must not print uninitialised memory. */
    {
        PeerAddr junk; memset(&junk, 0, sizeof(junk)); junk.family = AF_UNSPEC;
        peer_to_str(&junk, b, sizeof(b));
        check(b[0] == '?' && b[1] == '\0', "an unknown family prints a placeholder, not garbage");
    }

    /* ---- sockaddr conversion ---- */
    {
        struct sockaddr_in sa4; memset(&sa4, 0, sizeof(sa4));
        sa4.sin_family = AF_INET;
        inet_pton(AF_INET, "198.51.100.9", &sa4.sin_addr);
        PeerAddr p;
        check(peer_from_sockaddr((struct sockaddr *)&sa4, &p), "an IPv4 sockaddr converts");
        check(strcmp(fmt(p, b, sizeof(b)), "198.51.100.9") == 0, "...keeping its address");

        struct sockaddr_in6 sa6; memset(&sa6, 0, sizeof(sa6));
        sa6.sin6_family = AF_INET6;
        inet_pton(AF_INET6, "2001:db8:dead:beef::5", &sa6.sin6_addr);
        check(peer_from_sockaddr((struct sockaddr *)&sa6, &p), "an IPv6 sockaddr converts");
        check(strcmp(fmt(p, b, sizeof(b)), "2001:db8:dead:beef::5") == 0, "...keeping its address");

        /* sockaddr_storage rather than a hand-rolled struct: on BSD and macOS a
         * sockaddr begins with sa_len, so a stub with sa_family first would
         * land on the wrong byte and test nothing. */
        struct sockaddr_storage other; memset(&other, 0, sizeof(other));
        other.ss_family = AF_UNIX;
        check(!peer_from_sockaddr((struct sockaddr *)&other, &p),
              "an unsupported family is refused rather than mis-read");
    }

    /* ---- IPv4 keys on the exact address ---- */
    check(same_key(v4("192.0.2.1"), v4("192.0.2.1")), "the same IPv4 address shares a key");
    check(!same_key(v4("192.0.2.1"), v4("192.0.2.2")),
          "a neighbouring IPv4 address does NOT - IPv4 is keyed exactly");

    /* ---- IPv6 keys on the /64 ---- */
    check(same_key(v6("2001:db8:1:2::1"), v6("2001:db8:1:2::ffff")),
          "two addresses in one /64 share a key");
    check(same_key(v6("2001:db8:1:2::1"), v6("2001:db8:1:2:ffff:ffff:ffff:ffff")),
          "...however different the host half is");
    check(!same_key(v6("2001:db8:1:2::1"), v6("2001:db8:1:3::1")),
          "a different /64 does not share a key");

    /* The boundary itself: byte 7 is inside the prefix, byte 8 is outside. */
    check(!same_key(v6("2001:db8:1:2::1"), v6("2001:db8:1:3::1")),
          "a change in the last prefix byte separates the keys");
    check(same_key(v6("2001:db8:1:2:8000::"), v6("2001:db8:1:2::")),
          "a change in the first host byte does not");

    /* ---- the two families never collide ---- */
    {
        /* An IPv6 address whose first four bytes equal an IPv4 address. */
        PeerAddr a = v4("32.1.13.184");          /* 20 01 0d b8 */
        PeerAddr c = v6("2001:db8::");           /* same leading bytes */
        check(!same_key(a, c), "an IPv4 address never collides with an IPv6 prefix");
    }

    /* ---- IPv4-mapped IPv6 ----
     * V6ONLY on the listening socket means these should not arrive, but if one
     * ever does it must be handled consistently rather than crashing. */
    {
        PeerAddr m = v6("::ffff:192.0.2.1");
        peer_to_str(&m, b, sizeof(b));
        check(b[0] != '\0', "an IPv4-mapped address still formats");
        check(!same_key(m, v4("192.0.2.1")),
              "and is treated as IPv6, not silently merged with the IPv4 address");
    }

    /* ---- a short buffer must not overflow ---- */
    {
        char tiny[4];
        PeerAddr p = v6("2001:db8::1");
        peer_to_str(&p, tiny, sizeof(tiny));
        check(strlen(tiny) < sizeof(tiny), "a too-small buffer is left terminated, not overrun");
    }

    printf("%d passed, %d failed\n", pass, fail);
    return fail ? 1 : 0;
}
