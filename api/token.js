// GET /api/token -> challenge, or a signed pass if solved

import { requireGet } from "./_lib/ratelimit.js";
import {
  mintToken,
  mintChallenge,
  verifyChallenge,
  clientIp,
  checkOrigin,
  TOKEN_TTL,
  DIFFICULTY,
} from "./_lib/auth.js";

export default function handler(req, res) {
  if (!requireGet(req, res)) return;
  if (!checkOrigin(req)) {
    res.status(403).json({ error: "Forbidden." });
    return;
  }

  res.setHeader("Cache-Control", "private, no-store");

  const { challenge, nonce } = req.query;
  if (challenge === undefined) {
    res.status(200).json({ challenge: mintChallenge(clientIp(req)), difficulty: DIFFICULTY });
    return;
  }
  if (!verifyChallenge(req, challenge, nonce)) {
    res.status(401).json({ error: "Bad challenge solution." });
    return;
  }
  res.status(200).json({ token: mintToken(clientIp(req)), ttl: TOKEN_TTL });
}
