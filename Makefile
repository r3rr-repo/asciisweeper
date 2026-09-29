CC       := cc
CFLAGS   := -Wall -Wextra -std=c11 -O2
LDLIBS   := -lncurses
SRC      := src/main.c src/board.c
BIN      := asciisweeper

.PHONY: all clean run

all: $(BIN)

$(BIN): $(SRC) src/board.h
	$(CC) $(CFLAGS) -o $(BIN) $(SRC) $(LDLIBS)

run: $(BIN)
	./$(BIN)

clean:
	rm -f $(BIN)
