/*
 * Tests for the build-time site metadata.
 *
 * A wrong og:image fails silently in production and gets CACHED by the scrapers,
 * so the cases worth pinning down are the ones with no visible symptom: a
 * surviving %SITE_URL% placeholder, a doubled slash, or absolute tags left in a
 * build that has no site URL.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applySiteUrl, normaliseSiteUrl, robotsTxt, sitemapXml } from "../seo";

// esbuild bundles this into a temporary directory before it runs, so the web
// root is passed in rather than derived from import.meta.url.
const WEB = resolve(process.argv[2] ?? process.cwd());
const SRC = readFileSync(join(WEB, "index.html"), "utf8");

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };
const eq = <T>(a: T, b: T, m: string) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// --------------------------------------------------------------- normalisation
eq(normaliseSiteUrl(undefined), null, "unset SITE_URL is null");
eq(normaliseSiteUrl(""), null, "empty SITE_URL is null");
eq(normaliseSiteUrl("   "), null, "whitespace SITE_URL is null");
eq(normaliseSiteUrl("https://a.example"), "https://a.example", "plain URL passes through");
eq(normaliseSiteUrl("https://a.example/"), "https://a.example", "one trailing slash stripped");
eq(normaliseSiteUrl("https://a.example///"), "https://a.example", "several trailing slashes stripped");
eq(normaliseSiteUrl("  https://a.example/  "), "https://a.example", "surrounding whitespace trimmed");
try {
  normaliseSiteUrl("a.example");
  ok(false, "a scheme-less SITE_URL should throw");
} catch { ok(true, "a scheme-less SITE_URL throws rather than producing a broken tag"); }

// ------------------------------------------------------------- with a site URL
{
  const out = applySiteUrl(SRC, "https://sweeper.example");
  ok(!out.includes("%SITE_URL%"), "no placeholder survives");
  ok(!out.includes("SITE_URL_ONLY"), "the marker comments are removed");
  ok(out.includes('<link rel="canonical" href="https://sweeper.example/" />'), "canonical is absolute");
  ok(out.includes('content="https://sweeper.example/social-card.png"'), "og:image is absolute");
  ok(!out.includes("https://sweeper.example//"), "no doubled slash in any URL");

  for (const tag of [
    'property="og:type"', 'property="og:site_name"', 'property="og:title"',
    'property="og:description"', 'property="og:url"', 'property="og:image"',
    'property="og:image:width"', 'property="og:image:height"', 'property="og:image:alt"',
    'name="twitter:card"', 'name="twitter:title"', 'name="twitter:description"',
    'name="twitter:image"', 'name="twitter:image:alt"',
  ]) ok(out.includes(tag), `present: ${tag}`);

  eq((out.match(/content="1200"/g) ?? []).length, 1, "og:image:width declared once");
  eq((out.match(/content="630"/g) ?? []).length, 1, "og:image:height declared once");

  // Icons must stay relative even when a site URL exists - the opposite rule to
  // og:image, because dist/ still has to work in a subdirectory.
  ok(out.includes('href="./favicon.svg"'), "favicon stays relative");
  ok(out.includes('href="./site.webmanifest"'), "manifest stays relative");
  ok(out.includes('src="./src/main.ts"'), "the entry script stays relative");
}

// A trailing slash on the input must not produce "//social-card.png".
{
  const out = applySiteUrl(SRC, normaliseSiteUrl("https://sweeper.example/")!);
  ok(out.includes('content="https://sweeper.example/social-card.png"'), "trailing slash handled");
  ok(!out.includes("example//social-card"), "no doubled slash from a trailing-slash SITE_URL");
}

// ---------------------------------------------------------- without a site URL
{
  const out = applySiteUrl(SRC, null);
  ok(!out.includes("%SITE_URL%"), "no placeholder left behind");
  ok(!out.includes("SITE_URL_ONLY"), "the marker comments are gone");
  // Match the TAGS, not the bare words: the comment above the icon links
  // mentions og:image and canonical while explaining why they differ.
  ok(!out.includes('rel="canonical"'), "canonical omitted rather than left broken");
  ok(!out.includes('property="og:image"'), "og:image omitted rather than left broken");
  ok(!out.includes('name="twitter:image"'), "twitter:image omitted");
  ok(!out.includes("<link rel=\"canonical\""), "no canonical link element at all");

  // The tags that do not need an absolute URL must survive.
  ok(out.includes('property="og:title"'), "og:title still present");
  ok(out.includes('name="twitter:card"'), "twitter:card still present");
  ok(out.includes('href="./favicon.svg"'), "icons still present");
  ok(out.includes("application/ld+json"), "structured data still present");
  ok(out.includes("asciisweeper did not start"), "the boot guard is untouched");
  ok(out.includes('src="./src/main.ts"'), "the entry script is untouched");
}

// -------------------------------------------------------- robots and sitemap
{
  const r = robotsTxt("https://sweeper.example");
  ok(r.includes("User-agent: *"), "robots allows all agents");
  ok(r.includes("Sitemap: https://sweeper.example/sitemap.xml"), "robots points at an absolute sitemap");

  const x = sitemapXml("https://sweeper.example", "2026-10-02");
  ok(x.startsWith("<?xml"), "sitemap has an XML declaration");
  ok(x.includes("<loc>https://sweeper.example/</loc>"), "sitemap lists the absolute root");
  ok(x.includes("<lastmod>2026-10-02</lastmod>"), "sitemap carries lastmod");
  ok(!x.includes("undefined"), "no undefined leaked into the sitemap");
}

// ------------------------------------------------- the source page itself
// These guard the input to everything above.
ok(SRC.includes("<!--SITE_URL_ONLY"), "source has an opening marker");
ok(SRC.includes("<!--/SITE_URL_ONLY-->"), "source has a closing marker");
eq((SRC.match(/<!--SITE_URL_ONLY/g) ?? []).length, 1, "exactly one opening marker");
eq((SRC.match(/<!--\/SITE_URL_ONLY-->/g) ?? []).length, 1, "exactly one closing marker");
ok(SRC.indexOf("<!--SITE_URL_ONLY") < SRC.indexOf("<!--/SITE_URL_ONLY-->"), "markers are in order");
// Every placeholder must be inside the block, or stripping would leave one behind.
{
  const start = SRC.indexOf("<!--SITE_URL_ONLY");
  const end = SRC.indexOf("<!--/SITE_URL_ONLY-->");
  const inside = SRC.slice(start, end);
  eq((inside.match(/%SITE_URL%/g) ?? []).length, (SRC.match(/%SITE_URL%/g) ?? []).length,
    "every %SITE_URL% sits inside the strippable block");
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
