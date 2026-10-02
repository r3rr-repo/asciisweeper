/*
 * Build-time site metadata.
 *
 * dist/ is deliberately host-agnostic (base: "./"), so it can be copied to a
 * domain root or a subdirectory unchanged. Social metadata is the one thing that
 * cannot work that way: og:image and canonical must be ABSOLUTE, because
 * Facebook, X, Slack and Discord all ignore or mishandle relative ones.
 *
 * So the absolute tags live inside a <!--SITE_URL_ONLY--> block, and this fills
 * them in when SITE_URL is set or removes the block entirely when it is not. A
 * missing preview is recoverable; a preview pointing at a URL that does not
 * exist gets cached by the scrapers and is not.
 *
 * Exported as plain functions so test/seo.test.ts can exercise them without
 * running a build.
 */

const BLOCK = /[ \t]*<!--SITE_URL_ONLY[\s\S]*?<!--\/SITE_URL_ONLY-->[ \t]*\r?\n?/g;

/** Trailing slashes off, so `${siteUrl}/social-card.png` never doubles up. */
export function normaliseSiteUrl(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) {
    throw new Error(`SITE_URL must start with http:// or https:// (got "${v}")`);
  }
  return v.replace(/\/+$/, "");
}

export function applySiteUrl(html: string, siteUrl: string | null): string {
  if (siteUrl === null) return html.replace(BLOCK, "");
  return html
    .replace(/<!--SITE_URL_ONLY[\s\S]*?-->/, "")
    .replace(/<!--\/SITE_URL_ONLY-->/, "")
    .replaceAll("%SITE_URL%", siteUrl);
}

export function robotsTxt(siteUrl: string): string {
  return [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${siteUrl}/sitemap.xml`,
    "",
  ].join("\n");
}

export function sitemapXml(siteUrl: string, lastmod: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${siteUrl}/</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
  </url>
</urlset>
`;
}
