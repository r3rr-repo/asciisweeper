/*
 * localStorage replacement for src/config.c's ~/.config/asciisweeper/config.
 *
 * Differences from the C, all forced by the browser:
 *   - last_host + last_port + last_ca_file collapse into one optional wsUrl.
 *     null means "same origin", which is the normal case when the bridge is
 *     served at /ws next to the static files, so there is nothing to type.
 *   - The CA file is gone: a browser cannot pin a certificate authority. The
 *     bridge does the upstream pinning instead.
 *
 * Kept from the C: the first-run behaviour at src/config.c:41, where a freshly
 * generated random avatar is persisted immediately so it does not re-roll on
 * every load, and the per-field fallback for a partially-corrupt store.
 */
const KEY = "asciisweeper.config.v1";

export interface Config {
  v: 1;
  avatar: { skin: number; hair: number };
  wsUrl: string | null;
  name: string;
  /** Explicit, NOT derived from font metrics - see the plan's risk list. */
  baseCell: { w: number; h: number };
  brightenBlack: boolean;
  fontFamily: string;
}

export const DEFAULT_FONT = 'Menlo, "SF Mono", "DejaVu Sans Mono", ui-monospace, monospace';

function defaults(randomAvatar: () => { skin: number; hair: number }): Config {
  return {
    v: 1,
    avatar: randomAvatar(),
    wsUrl: null,
    name: "Player",
    baseCell: { w: 10, h: 20 },
    brightenBlack: true,
    fontFamily: DEFAULT_FONT,
  };
}

const clamp07 = (n: unknown, fallback: number): number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 7 ? n : fallback;

export function loadConfig(randomAvatar: () => { skin: number; hair: number }): Config {
  const d = defaults(randomAvatar);
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
    return {
      v: 1,
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
