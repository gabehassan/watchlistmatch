// GET /api/ratings?slugs=film-one,film-two
// letterboxd blocks the json endpoint, so parse the rating out of the page head

import { overLimit, jitter, requireGet } from "./_lib/ratelimit.js";
import { checkOrigin, verifyToken } from "./_lib/auth.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CONCURRENCY = 12;
const MAX_SLUGS = 60;
const MAX_BYTES = 160_000;

async function fetchFilmMeta(slug) {
  try {
    const res = await fetch(`https://letterboxd.com/film/${slug}/`, {
      headers: { "User-Agent": UA, Accept: "text/html" },
    });
    if (!res.ok || !res.body) return null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    let rating = null;
    let genresAt = -1;
    while (html.length < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (rating === null) {
        // e.g. <meta name="twitter:data2" content="3.92 out of 5" />
        const m = html.match(/twitter:data2"\s+content="([\d.]+) out of 5/);
        if (m) rating = Number(m[1]);
      }
      if (genresAt === -1) genresAt = html.indexOf('id="tab-panel-genres"');
      if (genresAt !== -1 && html.length >= genresAt + 4096) break;
    }
    reader.cancel().catch(() => {});

    const genres = [];
    if (genresAt !== -1) {
      const section = html.slice(genresAt, genresAt + 4096);
      for (const m of section.matchAll(/href="\/films\/genre\/[a-z-]+\/?"[^>]*>([^<]+)</g)) {
        genres.push(m[1]);
        if (genres.length === 3) break;
      }
    }
    if (rating === null && genres.length === 0) return null;
    return { r: rating, g: genres };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (!requireGet(req, res)) return;
  if (!checkOrigin(req) || !verifyToken(req)) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }

  const slugs = (req.query.slugs || "")
    .toString()
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9-]+$/.test(s))
    .slice(0, MAX_SLUGS);

  if (slugs.length === 0) {
    res.status(400).json({ error: "No film slugs given." });
    return;
  }

  // over the limit: return empty, not a 429
  if (overLimit(req, { limit: 20 })) {
    await jitter();
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).json({});
    return;
  }

  const ratings = {};
  for (let i = 0; i < slugs.length; i += CONCURRENCY) {
    const batch = slugs.slice(i, i + CONCURRENCY);
    const values = await Promise.all(batch.map(fetchFilmMeta));
    batch.forEach((slug, j) => {
      if (values[j] != null) ratings[slug] = values[j];
    });
  }

  // old films cache for 90 days, current year for 7
  const fresh = req.query.fresh === "1";
  res.setHeader(
    "Cache-Control",
    fresh
      ? "s-maxage=604800, stale-while-revalidate=86400"
      : "s-maxage=7776000, stale-while-revalidate=2592000"
  );
  res.status(200).json(ratings);
}
