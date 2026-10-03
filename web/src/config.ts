/*
 * localStorage replacement for src/config.c's ~/.config/asciisweeper/config.
 *
 * Differences from the C, all forced by the browser:
 *   - last_host + last_port + last_ca_file collapse into one optional wsUrl.
 *     null means "same origin", which is the normal case when the bridge is
 *     served at /ws next to the static files, so there is nothing to type. A
 *     different default can be baked in with WS_URL at build time, and a player
 *     can override it from the multiplayer menu.
 *   - The CA file is gone: a browser cannot pin a certificate authority. The
 *     bridge does the upstream pinning instead.
 *
 * Kept from the C: the first-run behaviour at src/config.c:41, where a freshly
 * generated random avatar is persisted immediately so it does not re-roll on
 * every load, and the per-field fallback for a partially-corrupt store.
 */
const KEY = "asciisweeper.config.v1";

/** Injected by vite.config.ts from the WS_URL build variable; null = same origin. */
declare const __WS_URL__: string | null;
const BUILD_WS_URL: string | null = typeof __WS_URL__ === "string" ? __WS_URL__ : null;

import { DEFAULT_TARGET_ROWS, clampTargetRows } from "./term/sizing";

export interface Config {
  v: 1;
  /**
   * Stable identity. `playerId` is the public UUIDv7 and `playerSecret` the
   * hex-encoded 32 bytes that prove it is yours - treat the latter like a
   * password. Scores follow this, not the nickname, so renaming is free.
   */
  playerId: string;
  playerSecret: string;
  avatar: { skin: number; hair: number };
  wsUrl: string | null;
  name: string;
  /**
   * The cell ASPECT, as a width:height pair. Only the ratio is used now - the
   * actual pixel size comes from targetRows via chooseGrid. Kept explicit
   * rather than derived from font metrics, because the board's "glyph plus a
   * trailing space" trick relies on a roughly 1:2 cell to look square.
   */
  baseCell: { w: number; h: number };
  /** Rows the grid aims for. The +/- zoom adjusts this; smaller = bigger cells. */
  targetRows: number;
  brightenBlack: boolean;
  fontFamily: string;
}

export const DEFAULT_FONT = 'Menlo, "SF Mono", "DejaVu Sans Mono", ui-monospace, monospace';

export interface IdentityGen {
  randomAvatar: () => { skin: number; hair: number };
  newIdentity: () => { id: string; secret: string };
}

function defaults(gen: IdentityGen): Config {
  const ident = gen.newIdentity();
  return {
    v: 1,
    playerId: ident.id,
    playerSecret: ident.secret,
    avatar: gen.randomAvatar(),
    wsUrl: BUILD_WS_URL,
    name: "Player",
    baseCell: { w: 10, h: 20 },
    targetRows: DEFAULT_TARGET_ROWS,
    brightenBlack: true,
    fontFamily: DEFAULT_FONT,
  };
}

const clamp07 = (n: unknown, fallback: number): number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 7 ? n : fallback;

export function loadConfig(gen: IdentityGen): Config {
  const d = defaults(gen);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return d; // private mode, blocked site data: run on defaults
  }
  if (!raw) {
    saveConfig(d);
    return d;
  }
  try {
    const p = JSON.parse(raw) as Partial<Config>;
    if (p.v !== 1) return d; // unknown version: reset rather than guess
    // Both halves must be present and well-formed: an id without its secret
    // cannot authenticate, and a secret without its id names nobody. A config
    // written before identities existed therefore gains a fresh pair rather
    // than being reset wholesale.
    const idOk = typeof p.playerId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p.playerId);
    const secretOk = typeof p.playerSecret === "string" && /^[0-9a-f]{64}$/.test(p.playerSecret);
    const ident = idOk && secretOk
      ? { id: p.playerId as string, secret: p.playerSecret as string }
      : gen.newIdentity();

    return {
      v: 1,
      playerId: ident.id,
      playerSecret: ident.secret,
      avatar: {
        skin: clamp07(p.avatar?.skin, d.avatar.skin),
        hair: clamp07(p.avatar?.hair, d.avatar.hair),
      },
      wsUrl: typeof p.wsUrl === "string" && p.wsUrl !== "" ? p.wsUrl : null,
      name: typeof p.name === "string" && p.name !== "" ? p.name : d.name,
      baseCell: {
        w: typeof p.baseCell?.w === "number" && p.baseCell.w > 0 ? p.baseCell.w : d.baseCell.w,
        h: typeof p.baseCell?.h === "number" && p.baseCell.h > 0 ? p.baseCell.h : d.baseCell.h,
      },
      targetRows: clampTargetRows(
        typeof p.targetRows === "number" ? p.targetRows : d.targetRows),
      brightenBlack: typeof p.brightenBlack === "boolean" ? p.brightenBlack : d.brightenBlack,
      fontFamily: typeof p.fontFamily === "string" && p.fontFamily !== "" ? p.fontFamily : d.fontFamily,
    };
  } catch {
    return d;
  }
}

export function saveConfig(c: Config): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // Nothing to do: the game is fully playable without persistence.
  }
}

/** wsUrl === null means the bridge sits at /ws on this same origin. */
export function resolveWsUrl(c: Config): string {
  if (c.wsUrl) return c.wsUrl;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws`;
}

/**
 * Validates a server URL typed into the multiplayer menu. Returns null when it
 * is acceptable, or a message to show.
 *
 * The mixed-content rule is the one worth catching early: a page served over
 * https can only open wss, never ws - the browser blocks it outright, and the
 * only symptom otherwise is a connection that fails for no stated reason.
 */
export function validateWsUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null; // blank is valid: it means this site
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "Not a valid URL. Example: wss://play.example.com/ws";
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") {
    return "Server URL must start with ws:// or wss://";
  }
  if (location.protocol === "https:" && u.protocol === "ws:") {
    return "This page is https, so the server must be wss:// (ws:// is blocked)";
  }
  return null;
}
