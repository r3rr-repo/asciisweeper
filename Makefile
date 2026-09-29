CC       := cc
CFLAGS   := -Wall -Wextra -std=c11 -O2
SSL_CFLAGS := $(shell pkg-config --cflags openssl)
SSL_LIBS   := $(shell pkg-config --libs openssl)

COMMON_SRC  := src/board.c src/net_io.c
CLIENT_SRC  := src/main.c src/client_net.c $(COMMON_SRC)
SERVER_SRC  := src/server.c $(COMMON_SRC)

CLIENT_BIN := asciisweeper
SERVER_BIN := asciisweeper-server

.PHONY: all clean run run-server

all: $(CLIENT_BIN) $(SERVER_BIN)

$(CLIENT_BIN): $(CLIENT_SRC)
	$(CC) $(CFLAGS) $(SSL_CFLAGS) -o $(CLIENT_BIN) $(CLIENT_SRC) -lncurses $(SSL_LIBS)

$(SERVER_BIN): $(SERVER_SRC)
	$(CC) $(CFLAGS) $(SSL_CFLAGS) -o $(SERVER_BIN) $(SERVER_SRC) $(SSL_LIBS) -lpthread

run: $(CLIENT_BIN)
	./$(CLIENT_BIN)

run-server: $(SERVER_BIN)
	./$(SERVER_BIN)

clean:
	rm -f $(CLIENT_BIN) $(SERVER_BIN)
