// local dev server: node scripts/dev.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import watchlistHandler from "../api/watchlist.js";
import ratingsHandler from "../api/ratings.js";
import tokenHandler from "../api/token.js";

const handlers = {
  "/api/watchlist": watchlistHandler,
  "/api/ratings": ratingsHandler,
  "/api/token": tokenHandler,
};

const server = http.createServer(async (req, res) => {
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

  res.setHeader("Content-Type", "text/html");
  res.end(await readFile(new URL("../index.html", import.meta.url)));
});

server.listen(3000, () => console.log("Dev server: http://localhost:3000"));
