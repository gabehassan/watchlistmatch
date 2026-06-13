// GET /api/watchlist?user=<username>

import { overLimit, jitter, requireGet } from "./_lib/ratelimit.js";
import { checkOrigin, verifyToken } from "./_lib/auth.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const FILMS_PER_PAGE = 28;
const MAX_PAGES = 100;
const CONCURRENCY = 8;

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function fetchPage(user, page) {
  const url = `https://letterboxd.com/${user}/watchlist/page/${page}/`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "follow",
  });
  if (res.status === 404) {
    const err = new Error("not_found");
    err.code = 404;
    throw err;
  }
  if (!res.ok) throw new Error(`letterboxd_status_${res.status}`);
  return res.text();
}

// each film is a div.react-component with data-item-slug
function parseFilms(html) {
  const tags =
    html.match(/<div class="react-component"[^>]*data-item-slug="[^"]*"[^>]*>/g) || [];
  return tags.flatMap((tag) => {
    const attr = (name) => {
      const m = tag.match(new RegExp(`${name}="([^"]*)"`));
      return m ? decodeEntities(m[1]) : null;
    };
    const slug = attr("data-item-slug");
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) return [];
    return [{
      slug,
      name: attr("data-item-full-display-name") || attr("data-item-name") || slug,
    }];
  });
}

function parseCount(html) {
  const m = html.match(/watchlist-count">([\d,]+)/);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
}

export async function getWatchlist(user) {
  const firstPage = await fetchPage(user, 1);
  const films = parseFilms(firstPage);
  const count = parseCount(firstPage);

  const totalPages = Math.min(
    count ? Math.ceil(count / FILMS_PER_PAGE) : 1,
    MAX_PAGES
  );

  const remaining = [];
  for (let p = 2; p <= totalPages; p++) remaining.push(p);
  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batch = remaining.slice(i, i + CONCURRENCY);
    const pages = await Promise.all(batch.map((p) => fetchPage(user, p)));
    for (const html of pages) films.push(...parseFilms(html));
  }

  const bySlug = new Map();
  for (const f of films) if (f.slug && !bySlug.has(f.slug)) bySlug.set(f.slug, f);
  return { count: count ?? bySlug.size, films: [...bySlug.values()] };
}

export default async function handler(req, res) {
  if (!requireGet(req, res)) return;
  if (!checkOrigin(req) || !verifyToken(req)) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }

  const raw = (req.query.user || "").toString().trim().toLowerCase();
  if (!/^[a-z0-9_]{1,30}$/.test(raw)) {
    res.status(400).json({ error: "That doesn't look like a Letterboxd username." });
    return;
  }

  // over the limit: hand back an empty list, not a 429
  if (overLimit(req, { limit: 40 })) {
    await jitter();
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).json({ user: raw, count: 0, films: [] });
    return;
  }

  try {
    const data = await getWatchlist(raw);
    if (data.films.length === 0) {
      res.status(404).json({
        error: `Couldn't read ${raw}'s watchlist, it may be empty or private.`,
      });
      return;
    }
    // cache on the cdn for an hour
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({ user: raw, ...data });
  } catch (e) {
    if (e.code === 404) {
      res.status(404).json({ error: `No Letterboxd user named "${raw}".` });
    } else {
      res.status(502).json({
        error: "Letterboxd didn't respond properly. Try again in a minute.",
      });
    }
  }
}
