// per-ip counters in instance memory. over the limit is a shadowban, not a 429

import { clientIp } from "./auth.js";

const hits = new Map();

export function overLimit(req, { limit, windowMs = 60_000 }) {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);

  const over = recent.length >= limit;
  if (!over) recent.push(now);
  hits.set(ip, recent);

  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t > windowMs)) hits.delete(key);
    }
  }
  return over;
}

export function jitter(min = 120, max = 480) {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

export function requireGet(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed." });
    return false;
  }
  return true;
}
