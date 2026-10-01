/*
 * Port of avatar_draw, src/avatar.c:43-65.
 *
 * The avatar is a 6x6 image whose "pixels" are pairs of blank characters; the
 * image is carried entirely in the BACKGROUND colour of each cell. Rows 0-1 are
 * hair, the rest is skin, and the eyes sit at row 2, columns 2 and 4.
 *
 * A blinking eye is an eye-coloured '-' on the skin background - an eyelid, not
 * a black square.
 */
import type { Surface } from "../term/surface";
import { AVATAR_BLINK_PAIR_BASE, AVATAR_EYE_COLOR, AVATAR_PAIR_BASE } from "./colors";
import { AVATAR_COLS, AVATAR_ROWS } from "../game/layout";

export interface Avatar {
  skin: number;
  hair: number;
}

export function drawAvatar(
  s: Surface, top: number, left: number, a: Avatar, eyesOpen: boolean,
): void {
  for (let row = 0; row < AVATAR_ROWS; row++) {
    for (let col = 0; col < AVATAR_COLS; col++) {
      const isHair = row < 2;
      const isEye = !isHair && row === 2 && (col === 2 || col === 4);
      const blinkingEye = isEye && !eyesOpen;
      const ch = blinkingEye ? "-" : " ";

      const pair = blinkingEye
        ? AVATAR_BLINK_PAIR_BASE + a.skin
        : AVATAR_PAIR_BASE + (isEye ? AVATAR_EYE_COLOR : isHair ? a.hair : a.skin);

      s.withAttrs(pair, false, () => {
        s.addch(top + row, left + col * 2, ch);
        s.addch(top + row, left + col * 2 + 1, ch);
      });
    }
  }
}
