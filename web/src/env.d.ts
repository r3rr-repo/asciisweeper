/// <reference types="vite/client" />

/**
 * Injected by vite.config.ts's `define` from the WS_URL build variable.
 * null means "the /ws path on whatever origin serves this page".
 */
declare const __WS_URL__: string | null;

/** Injected by vite.config.ts from package.json's version field. */
declare const __APP_VERSION__: string;
