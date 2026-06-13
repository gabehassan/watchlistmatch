// local dev server: node scripts/dev.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize, join } from "node:path";
import watchlistHandler from "../api/watchlist.js";
import ratingsHandler from "../api/ratings.js";
import tokenHandler from "../api/token.js";

const handlers = {
  "/api/watchlist": watchlistHandler,
  "/api/ratings": ratingsHandler,
  "/api/token": tokenHandler,
};

const root = new URL("..", import.meta.url);
const vercelConfig = JSON.parse(
  await readFile(new URL("../vercel.json", import.meta.url), "utf8")
);
const securityHeaders =
  vercelConfig.headers.find((entry) => entry.source === "/(.*)")?.headers || [];
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function applySecurityHeaders(res) {
  for (const { key, value } of securityHeaders) res.setHeader(key, value);
}

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);

  const url = new URL(req.url, "http://localhost");
  const handler = handlers[url.pathname];

  if (handler) {
    req.query = Object.fromEntries(url.searchParams);
    res.status = (code) => ((res.statusCode = code), res);
    res.json = (obj) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(obj));
    };
    try {
      await handler(req, res);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
    return;
  }

  if (url.pathname === "/_vercel/insights/script.js") {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.end("window.va = window.va || function () {};");
    return;
  }

  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(root.pathname, pathname));
  if (!filePath.startsWith(root.pathname)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  try {
    res.setHeader("Content-Type", types[extname(filePath)] || "application/octet-stream");
    res.end(await readFile(filePath));
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`Dev server: http://localhost:${port}`));
