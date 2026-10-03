/*
 * Ports of menu() and avatar_screen(), src/main.c:981-1119.
 *
 * The blocking getch() loop becomes a Screen with onKey/render, but the drawn
 * output and the key bindings are the C's. The one removal is the CA-file prompt:
 * a browser cannot pin a certificate authority, so showing the field would be
 * showing something that cannot work. With the same-origin default for the
 * bridge, that takes the multiplayer prompts from four down to one - your name.
 */
import type { Surface } from "../term/surface";
import { CP_HUD, CP_TITLE } from "./colors";
import { drawAvatar, type Avatar } from "./avatar";
import { AVATAR_HEIGHT_CHARS, AVATAR_WIDTH_CHARS } from "../game/layout";

export const MENU_ITEMS = [
  "Beginner      9x9,  10 mines",
  "Intermediate  16x16, 40 mines",
  "Expert        30x16, 99 mines",
  "Multiplayer...",
  "Avatar...",
  "Custom...",
  "Quit",
] as const;

export const MENU_BEGINNER = 0, MENU_INTERMEDIATE = 1, MENU_EXPERT = 2,
             MENU_MULTIPLAYER = 3, MENU_AVATAR = 4, MENU_CUSTOM = 5, MENU_QUIT = 6;

/** src/main.c:323-327 */
export const PRESETS = [
  { w: 9, h: 9, mines: 10 },
  { w: 16, h: 16, mines: 40 },
  { w: 30, h: 16, mines: 99 },
] as const;

const TITLE = "ASCIISWEEPER";
const SUB = "a game of Minesweeper in ASCII";

export interface MenuGeometry {
  top: number;
  left: number;
  itemRow(i: number): number;
}

export function menuGeometry(s: Surface): MenuGeometry {
  const widest = MENU_ITEMS.reduce((a, b) => Math.max(a, b.length), 0);
  const blockH = MENU_ITEMS.length + 6;
  const top = Math.max(0, Math.floor((s.rows - blockH) / 2));
  const left = Math.max(0, Math.floor((s.cols - (widest + 2)) / 2));
  return { top, left, itemRow: (i) => top + 4 + i };
}

export function drawMenu(s: Surface, sel: number, version: string): void {
  s.erase();
  const g = menuGeometry(s);

  s.withAttrs(CP_TITLE, true, () => {
    s.print(g.top, s.centreCol(0, s.cols, TITLE), TITLE);
  });
  s.withAttrs(CP_HUD, false, () => {
    s.print(g.top + 1, s.centreCol(0, s.cols, SUB), SUB);
  });

  for (let i = 0; i < MENU_ITEMS.length; i++) {
    const marker = i === sel ? ">" : " ";
    const line = `${marker} ${MENU_ITEMS[i]}`;
    s.withAttrs(i === sel ? CP_TITLE : CP_HUD, i === sel, () => {
      s.print(g.itemRow(i), g.left, line);
    });
  }

  // Web-only help text, so the zoom hint belongs here rather than in the game
  // footers, which are line-for-line ports of draw_footer / draw_mp_footer.
  const help = "Move: arrows/jk   Select: enter   Zoom: +/-   Quit: q";
  s.withAttrs(CP_HUD, false, () => {
    s.print(g.itemRow(MENU_ITEMS.length) + 1, s.centreCol(0, s.cols, help), help);
    s.print(s.rows - 1, 1, version);
  });
}

/** Maps a clicked grid row back to a menu index, or -1. Mouse is a web addition. */
export function menuHitTest(s: Surface, row: number): number {
  const g = menuGeometry(s);
  const i = row - (g.top + 4);
  return i >= 0 && i < MENU_ITEMS.length ? i : -1;
}

/** src/main.c:981-1016 */
export function drawAvatarScreen(s: Surface, a: Avatar): void {
  s.erase();
  const title = "YOUR AVATAR";
  const top = Math.max(0, Math.floor((s.rows - (AVATAR_HEIGHT_CHARS + 8)) / 2));
  const left = Math.max(0, Math.floor((s.cols - AVATAR_WIDTH_CHARS) / 2));

  s.withAttrs(CP_TITLE, true, () => {
    s.print(top, s.centreCol(0, s.cols, title), title);
  });
  drawAvatar(s, top + 2, left, a, true);

  const l1 = "Reroll: r      Accept: enter / esc";
  const l2 = `skin ${a.skin}   hair ${a.hair}`;
  s.withAttrs(CP_HUD, false, () => {
    s.print(top + AVATAR_HEIGHT_CHARS + 3, s.centreCol(0, s.cols, l2), l2);
    s.print(top + AVATAR_HEIGHT_CHARS + 5, s.centreCol(0, s.cols, l1), l1);
  });
}

/** A centred prompt, as prompt_int/prompt_str drew them (src/main.c:329-373). */
export function drawPrompt(
  s: Surface, title: string, lines: { label: string; value: string }[], activeIndex: number,
): void {
  s.erase();
  const blockH = lines.length + 6;
  const top = Math.max(0, Math.floor((s.rows - blockH) / 2));
  const widest = lines.reduce((a, l) => Math.max(a, l.label.length), 0);
  const left = Math.max(0, Math.floor((s.cols - (widest + 24)) / 2));

  s.withAttrs(CP_TITLE, true, () => {
    s.print(top, s.centreCol(0, s.cols, title), title);
  });
  lines.forEach((l, i) => {
    const active = i === activeIndex;
    s.withAttrs(CP_HUD, active, () => {
      s.print(top + 2 + i, left, `${l.label.padEnd(widest)} : ${l.value}`);
      s.clrtoeol(top + 2 + i, left + widest + 3 + l.value.length);
    });
  });
  const help = "Enter: next   Esc: back";
  s.withAttrs(CP_HUD, false, () => {
    s.print(top + 2 + lines.length + 1, s.centreCol(0, s.cols, help), help);
  });
}
