#include "netaddr.h"

#include <arpa/inet.h>
#include <string.h>

bool peer_from_sockaddr(const struct sockaddr *sa, PeerAddr *out)
{
    memset(out, 0, sizeof(*out));
    if (sa->sa_family == AF_INET) {
        out->family = AF_INET;
        out->addr.v4 = ((const struct sockaddr_in *)(const void *)sa)->sin_addr;
        return true;
    }
    if (sa->sa_family == AF_INET6) {
        out->family = AF_INET6;
        out->addr.v6 = ((const struct sockaddr_in6 *)(const void *)sa)->sin6_addr;
        return true;
    }
    return false;
}

void peer_to_str(const PeerAddr *p, char *buf, size_t len)
{
    const void *src = (p->family == AF_INET)
        ? (const void *)&p->addr.v4
        : (const void *)&p->addr.v6;
    if (len == 0)
        return;
    if ((p->family != AF_INET && p->family != AF_INET6) ||
        !inet_ntop(p->family, src, buf, (socklen_t)len)) {
        /* Never leave a caller logging uninitialised memory. */
        buf[0] = '?';
        if (len > 1) buf[1] = '\0';
        else buf[0] = '\0';
    }
}

RateKey rate_key_of(const PeerAddr *p)
{
    RateKey k;
    memset(&k, 0, sizeof(k));
    k.family = p->family;
    if (p->family == AF_INET) {
        memcpy(k.bytes, &p->addr.v4, 4);
    } else if (p->family == AF_INET6) {
        /* The /64 prefix: the network half, which is what one subscriber
         * actually controls. */
        memcpy(k.bytes, &p->addr.v6, 8);
    }
    return k;
}

bool rate_key_eq(const RateKey *a, const RateKey *b)
{
    /* The family is part of the key, so an IPv4 address can never collide with
     * an IPv6 prefix that happens to start with the same bytes. */
    return a->family == b->family && memcmp(a->bytes, b->bytes, sizeof(a->bytes)) == 0;
}
