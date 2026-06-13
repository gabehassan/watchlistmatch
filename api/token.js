// GET /api/token -> challenge, or a signed pass if solved

import { overLimit, jitter, requireGet } from "./_lib/ratelimit.js";
import {
  mintToken,
  mintChallenge,
  verifyChallenge,
  clientIp,
  checkOrigin,
  TOKEN_TTL,
  DIFFICULTY,
} from "./_lib/auth.js";

async function verifyTurnstile(req, token) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return !process.env.VERCEL;
  if (!token) return false;

  try {
    const body = new URLSearchParams({
      secret,
      response: String(token),
      remoteip: clientIp(req),
    });
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }
    );
    if (!response.ok) return false;
    const data = await response.json();
    return data.success === true;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (!requireGet(req, res)) return;
  if (!checkOrigin(req)) {
    res.status(403).json({ error: "Forbidden." });
    return;
  }

  res.setHeader("Cache-Control", "private, no-store");

  const { challenge, nonce, turnstile } = req.query;
  const limited = overLimit(req, { limit: 14, scope: "token" });
  if (challenge === undefined) {
    if (limited) await jitter(300, 900);
    res.status(200).json({
      challenge: mintChallenge(limited ? `limited:${clientIp(req)}` : clientIp(req)),
      difficulty: limited ? DIFFICULTY + 3 : DIFFICULTY,
    });
    return;
  }
  if (limited) {
    await jitter(300, 900);
    res.status(401).json({ error: "Bad challenge solution." });
    return;
  }
  if (!verifyChallenge(req, challenge, nonce)) {
    res.status(401).json({ error: "Bad challenge solution." });
    return;
  }
  if (!(await verifyTurnstile(req, turnstile))) {
    res.status(401).json({ error: "Browser check failed." });
    return;
  }
  res.status(200).json({ token: mintToken(clientIp(req)), ttl: TOKEN_TTL });
}
