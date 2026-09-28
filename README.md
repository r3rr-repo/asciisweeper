# asciisweeper

A classic game of Minesweeper, rendered entirely in ASCII as a terminal UI
(TUI) using `ncurses`. Centered board, colored numbers, flood-fill reveal,
flagging, chording, and a live timer — all in your terminal.

```
                                    ASCIISWEEPER

                                    Mines: 007        Time: 042
                                  +------------------+
                                  |1 1          1 1  |
                                  |. 1          1 . 1|
                                  |. 2 1      1 2 . 1|
                                  |. . 1      . 1 1  |
                                  |1 1 1      1 1     |
                                  |F . . 1 1 1 . .   |
                                  |. . . 1 F 1 . .   |
                                  |. . . 1 1 1 . .   |
                                  +------------------+

                     Move: arrows/hjkl  |  Reveal: space/enter  |  Flag: f
                        Chord: c  |  Restart: r  |  Menu: n  |  Quit: q
```

## Features

- Classic Minesweeper rules: flood-fill reveal of empty areas, numbered
  clues, flagging, and win/loss detection
- **First-click safety** — you'll never hit a mine on your first move
- **Chording** — reveal all neighbors of a satisfied number in one keypress
- Live mine counter and timer
- Beginner / Intermediate / Expert presets, plus a custom board size and
  mine count
- Board and menu automatically center in your terminal window
- Color-coded numbers, just like the original

## Requirements

- A C compiler (`cc`/`gcc`/`clang`)
- `ncurses` development headers
  - macOS: included with Xcode Command Line Tools, or `brew install ncurses`
  - Debian/Ubuntu: `sudo apt install libncurses-dev`
  - Fedora: `sudo dnf install ncurses-devel`

## Build & run

```sh
make
./asciisweeper
```

or in one step:

```sh
make run
```

## Controls

| Key(s)              | Action                                   |
|----------------------|-------------------------------------------|
| Arrow keys / `hjkl`  | Move the cursor                           |
| `Space` / `Enter`    | Reveal the selected cell                  |
| `f`                  | Flag / unflag the selected cell           |
| `c`                  | Chord: reveal neighbors of a satisfied number |
| `r`                  | Restart with the same settings            |
| `n`                  | Return to the menu                        |
| `q`                  | Quit                                      |

Reveal (`Space`/`Enter`) also chords automatically when used on an
already-revealed number.

## Difficulty presets

| Preset       | Size   | Mines |
|--------------|--------|-------|
| Beginner     | 9x9    | 10    |
| Intermediate | 16x16  | 40    |
| Expert       | 30x16  | 99    |
| Custom       | your choice | your choice |

## How it works

The whole game lives in [`src/main.c`](src/main.c): a `Game` struct holding
the board state, an iterative flood-fill for revealing empty regions, and
an `ncurses`-based render loop that redraws the board, HUD, and footer each
frame. Mines are placed only after your first move, avoiding the clicked
cell and its neighbors, so the opening reveal is always safe.
