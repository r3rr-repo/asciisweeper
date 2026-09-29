#ifndef ASCIISWEEPER_CLIENT_NET_H
#define ASCIISWEEPER_CLIENT_NET_H

#include <openssl/ssl.h>

typedef struct {
    SSL_CTX *ctx;
    SSL *ssl;
    int fd;
} NetConn;

/* Connects and completes the TLS handshake with certificate and hostname
 * verification. If ca_file is non-NULL, it's loaded as an additional
 * trust anchor (for local/private-CA testing or a self-hosted server's
 * own CA); otherwise the system trust store is used, which is what a
 * real publicly-trusted certificate needs. Returns NULL on any failure -
 * this never falls back to an unverified connection. */
NetConn *net_connect(const char *host, int port, const char *ca_file);
void net_close(NetConn *nc);
int net_get_fd(NetConn *nc);

#endif
