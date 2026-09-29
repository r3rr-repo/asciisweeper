#include "client_net.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdbool.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netdb.h>
#include <arpa/inet.h>

static bool host_is_ip_literal(const char *host)
{
    struct in_addr a4;
    struct in6_addr a6;
    return inet_pton(AF_INET, host, &a4) == 1 || inet_pton(AF_INET6, host, &a6) == 1;
}

NetConn *net_connect(const char *host, int port, const char *ca_file)
{
    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    char port_str[16];
    snprintf(port_str, sizeof(port_str), "%d", port);
    if (getaddrinfo(host, port_str, &hints, &res) != 0)
        return NULL;

    int fd = -1;
    for (struct addrinfo *rp = res; rp; rp = rp->ai_next) {
        fd = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
        if (fd < 0) continue;
        if (connect(fd, rp->ai_addr, rp->ai_addrlen) == 0) break;
        close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    if (fd < 0) return NULL;

    SSL_CTX *ctx = SSL_CTX_new(TLS_client_method());
    if (!ctx) { close(fd); return NULL; }
    SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);
    SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, NULL);

    bool trust_ok = ca_file ? (SSL_CTX_load_verify_locations(ctx, ca_file, NULL) == 1)
                            : (SSL_CTX_set_default_verify_paths(ctx) == 1);
    if (!trust_ok) {
        SSL_CTX_free(ctx);
        close(fd);
        return NULL;
    }

    SSL *ssl = SSL_new(ctx);
    SSL_set_fd(ssl, fd);
    if (host_is_ip_literal(host)) {
        /* IP literals verify against the cert's iPAddress SAN entries, not
         * its dNSName entries - SNI doesn't apply to them either. */
        SSL_set1_ipaddr(ssl, host);
    } else {
        SSL_set1_dnsname(ssl, host);
        SSL_set_tlsext_host_name(ssl, host);
    }

    /* SSL_VERIFY_PEER plus the hostname/IP check above together make
     * SSL_connect fail on a bad chain or a mismatch, so success here means
     * the server's certificate was fully verified against the chosen
     * trust anchor. */
    if (SSL_connect(ssl) != 1) {
        SSL_free(ssl);
        SSL_CTX_free(ctx);
        close(fd);
        return NULL;
    }

    NetConn *nc = calloc(1, sizeof(*nc));
    nc->ctx = ctx;
    nc->ssl = ssl;
    nc->fd = fd;
    return nc;
}

void net_close(NetConn *nc)
{
    if (!nc) return;
    if (nc->ssl) {
        SSL_shutdown(nc->ssl);
        SSL_free(nc->ssl);
    }
    if (nc->fd >= 0)
        close(nc->fd);
    if (nc->ctx)
        SSL_CTX_free(nc->ctx);
    free(nc);
}

int net_get_fd(NetConn *nc)
{
    return nc->fd;
}
