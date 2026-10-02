import { defineConfig, type Plugin } from "vite";
import { applySiteUrl, normaliseSiteUrl, robotsTxt, sitemapXml } from "./seo";

/**
 * Fills in the absolute-URL metadata, or strips it when SITE_URL is unset.
 *
 * robots.txt and sitemap.xml are emitted only alongside a SITE_URL, since both
 * need absolute URLs. Note they are only honoured at a DOMAIN ROOT - in a
 * subdirectory deploy a crawler never looks for them.
 */
function siteMetadata(): Plugin {
  let siteUrl: string | null = null;
  return {
    name: "asciisweeper:site-metadata",
    configResolved(config) {
      siteUrl = normaliseSiteUrl(process.env.SITE_URL);
      if (!siteUrl) {
        config.logger.warn(
          "[asciisweeper] SITE_URL is not set: canonical and og:image are omitted, " +
          "so links to this build will not unfurl. Build with " +
          "SITE_URL=https://your.domain ./build-web.sh to enable them.",
        );
      }
    },
    transformIndexHtml: {
      order: "post",
      handler: (html) => applySiteUrl(html, siteUrl),
    },
    generateBundle() {
      if (!siteUrl) return;
      const lastmod = new Date().toISOString().slice(0, 10);
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robotsTxt(siteUrl) });
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemapXml(siteUrl, lastmod) });
    },
  };
}

export default defineConfig({
  // Relative asset paths, so web/dist can be copied to a domain root OR into any
  // subdirectory (https://host/games/sweeper/) with no rebuild.
  base: "./",
  plugins: [siteMetadata()],
  define: {
    // The default multiplayer endpoint, baked at build time. null means "the /ws
    // path on whatever origin serves this page", which is the usual deployment.
    __WS_URL__: JSON.stringify(process.env.WS_URL?.trim() || null),
  },
  build: {
    target: "es2022",
    assetsInlineLimit: 0, // keep core.wasm a real file, not a base64 data: URI
    rollupOptions: {
      output: { assetFileNames: "assets/[name]-[hash][extname]" },
    },
  },
  server: { port: 5173 },
});
