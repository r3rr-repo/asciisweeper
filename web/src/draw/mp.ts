/*
 * Ports of draw_mp_hud, draw_mp_footer, draw_avatar_panels, draw_chat and
 * render_multiplayer, src/main.c:418-616.
 */
import type { Surface } from "../term/surface";
import { CP_HUD, CP_TITLE } from "./colors";
import { drawAvatar, type Avatar } from "./avatar";
import { drawBoard, drawBoardFrame, pad3, type BoardView } from "./board";
import { AVATAR_GUTTER, AVATAR_HEIGHT_CHARS, AVATAR_WIDTH_CHARS } from "../game/layout";
import type { Blink } from "../game/blink";

/** src/main.c:382 */
export const CHAT_LOG_LINES = 3;

export interface MpView {
  board: BoardView;
  sidePanelsFit: boolean;
  matched: boolean;
  myPlayerId: number;
  playerToMove: number;
  myName: string;
  opponentName: string;
  myAvatar: Avatar;
  opponentAvatar: Avatar;
  scores: [number, number];
  minesLeft: number;
  statusLine: string;
  chatLog: string[];
  chatMode: boolean;
  chatInput: string;
}

/** src/main.c:418-448 */
export function drawMpHud(s: Surface, v: MpView): void {
  const { top, left, w } = v.board;
  const boardWidth = w * 2;

  const title = "ASCIISWEEPER - MULTIPLAYER";
  s.withAttrs(CP_TITLE, true, () => {
    s.print(top - 4, s.centreCol(left, boardWidth, title), title);
  });

  const yourTurn = v.playerToMove === v.myPlayerId;
  const turnLine = yourTurn ? "YOUR TURN" : "Opponent's turn...";
  s.withAttrs(yourTurn ? CP_TITLE : CP_HUD, true, () => {
    s.print(top - 3, s.centreCol(left, boardWidth, turnLine), turnLine);
  });

  const statusLine =
    `You: ${v.myName} (${v.scores[v.myPlayerId]})    ` +
    `Opponent: ${v.opponentName} (${v.scores[1 - v.myPlayerId]})    ` +
    `Mines: ${pad3(v.minesLeft)}`;
  s.withAttrs(CP_HUD, false, () => {
    s.print(top - 2, s.centreCol(left, boardWidth, statusLine), statusLine);
  });
}

/** src/main.c:450-467 - note 'r' is absent here; multiplayer has no restart. */
export function drawMpFooter(s: Surface, v: MpView): void {
  const line1 = "Move: arrows/hjkl  |  Reveal: space/enter  |  Flag: f";
  const line2 = "Chord: c  |  Chat: t  |  Menu: n  |  Quit: q";
  s.withAttrs(CP_HUD, false, () => {
    s.print(v.board.top + v.board.h + 2, s.centreCol(0, s.cols, line1), line1);
    s.print(v.board.top + v.board.h + 3, s.centreCol(0, s.cols, line2), line2);
  });
}

/**
 * src/main.c:543-570.
 *
 * Only the player being WAITED ON blinks - it is an idle animation, so it reads
 * as the person whose turn it is not. Each avatar has its own schedule so they
 * never blink in lockstep.
 */
export function drawAvatarPanels(
  s: Surface, v: MpView, blinks: [Blink, Blink], nowMs: number,
): void {
  if (!v.sidePanelsFit) return;

  const leftAvatarLeft = v.board.left - 1 - AVATAR_GUTTER - AVATAR_WIDTH_CHARS;
  const rightAvatarLeft = v.board.left + v.board.w * 2 + 1 + AVATAR_GUTTER;
  const avatarTop = v.board.top + Math.floor((v.board.h - AVATAR_HEIGHT_CHARS) / 2);

  const waitingForMe = v.matched && v.playerToMove !== v.myPlayerId;
  const waitingForOpponent = v.matched && v.playerToMove === v.myPlayerId;

  drawAvatar(s, avatarTop, leftAvatarLeft, v.myAvatar,
    !waitingForMe || !blinks[0].closed(nowMs));
  drawAvatar(s, avatarTop, rightAvatarLeft, v.opponentAvatar,
    !waitingForOpponent || !blinks[1].closed(nowMs));

  const nameRow = avatarTop + AVATAR_HEIGHT_CHARS + 1;
  s.withAttrs(CP_HUD, false, () => {
    s.print(nameRow, Math.max(leftAvatarLeft,
      leftAvatarLeft + Math.floor((AVATAR_WIDTH_CHARS - v.myName.length) / 2)), v.myName);
    s.print(nameRow, Math.max(rightAvatarLeft,
      rightAvatarLeft + Math.floor((AVATAR_WIDTH_CHARS - v.opponentName.length) / 2)), v.opponentName);
  });
}

/**
 * src/main.c:572-599.
 *
 * `rowOffset` shifts the log down on the end-of-match screen, which draws two
 * lines of its own at +5..+6 where the log would otherwise start.
 */
export function drawChat(s: Surface, v: MpView, rowOffset = 0): void {
  const row = v.board.top + v.board.h + 6 + rowOffset;
  s.withAttrs(CP_HUD, false, () => {
    v.chatLog.forEach((line, i) => {
      if (row + i < s.rows) {
        s.print(row + i, v.board.left, line);
        s.clrtoeol(row + i, v.board.left + line.length);
      }
    });
  });
  if (v.chatMode) {
    const inputRow = row + v.chatLog.length;
    if (inputRow < s.rows) {
      s.withAttrs(CP_HUD, true, () => {
        s.print(inputRow, v.board.left, `Chat> ${v.chatInput}_`);
      });
    }
  }
}

/** src/main.c:601-616 */
export function renderMultiplayer(
  s: Surface, v: MpView, blinks: [Blink, Blink], nowMs: number, chatRowOffset = 0,
): void {
  s.erase();
  drawMpHud(s, v);
  drawBoardFrame(s, v.board);
  drawBoard(s, v.board);
  drawAvatarPanels(s, v, blinks, nowMs);
  drawMpFooter(s, v);
  if (v.statusLine) {
    s.withAttrs(CP_HUD, true, () => {
      s.print(v.board.top + v.board.h + 5, v.board.left, v.statusLine);
      s.clrtoeol(v.board.top + v.board.h + 5, v.board.left + v.statusLine.length);
    });
  }
  drawChat(s, v, chatRowOffset);
}
