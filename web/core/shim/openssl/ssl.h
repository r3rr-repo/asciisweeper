/*
 * Fake <openssl/ssl.h> for the wasm build ONLY.
 *
 * src/net_io.c mixes two unrelated things: the pure wire codec
 * (pack_* / unpack_*, board_to_wire, wire_to_board) which the browser client
 * needs, and five TLS framing functions which it does not. The TLS half
 * touches exactly nine OpenSSL symbols, all of them above line 106 of
 * net_io.c; everything from line 107 down is pure.
 *
 * Declaring those nine here lets net_io.c compile for wasm WITHOUT EDITING IT,
 * so src/ stays byte-for-byte identical to the terminal game. No definitions
 * are needed: nothing in core_api.c's exported surface references the framing
 * functions, so wasm-ld garbage-collects them and these declarations never
 * resolve to anything.
 *
 * If net_io.c ever grows real OpenSSL use *inside the codec half*, the wasm
 * build breaks loudly at link time. That is the intended failure mode - fix it
 * by splitting the file, not by fleshing this header out.
 *
 * This directory is on the include path only via build-web.sh. The native
 * CMake build never sees it and continues to use the real OpenSSL.
 */
#ifndef ASCIISWEEPER_WASM_SHIM_OPENSSL_SSL_H
#define ASCIISWEEPER_WASM_SHIM_OPENSSL_SSL_H

typedef struct ssl_st SSL;

#define SSL_ERROR_WANT_READ  2
#define SSL_ERROR_WANT_WRITE 3
#define SSL_ERROR_SYSCALL    5

int SSL_read(SSL *ssl, void *buf, int num);
int SSL_write(SSL *ssl, const void *buf, int num);
int SSL_get_error(const SSL *ssl, int ret);
int SSL_get_fd(const SSL *ssl);
int SSL_pending(const SSL *ssl);

#endif
