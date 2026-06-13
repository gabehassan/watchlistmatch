// origin check + hmac signed tokens

import crypto from "node:crypto";

const SECRET = process.env.WM_TOKEN_SECRET || "dev-only-secret";
export const TOKEN_TTL = 15 * 60 * 1000;

const ALLOWED_HOSTS = new Set([
  "watchlistmatch.com",
  "www.watchlistmatch.com",
  "watchlist-match.vercel.app",
  "watchlist-match-projects-fd06b143.vercel.app",
  "watchlist-match-gabehassan-projects-fd06b143.vercel.app",
  "localhost",
]);

export function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
}

function sign(ip, exp) {
  return crypto.createHmac("sha256", SECRET).update(`${ip}|${exp}`).digest("hex");
}

export function mintToken(ip) {
  const exp = Date.now() + TOKEN_TTL;
  return `${exp}.${sign(ip, exp)}`;
}

// find a nonce where sha256(challenge.nonce) has DIFFICULTY leading zero bits
export const DIFFICULTY = 13;
const CHALLENGE_TTL = 2 * 60 * 1000;

function signChallenge(ip, exp) {
  return crypto.createHmac("sha256", SECRET).update(`chal|${ip}|${exp}`).digest("hex");
}

export function mintChallenge(ip) {
  const exp = Date.now() + CHALLENGE_TTL;
  return `${exp}.${signChallenge(ip, exp)}`;
}

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

export function verifyChallenge(req, challenge, nonce) {
  try {
    const [expStr, sig] = String(challenge || "").split(".");
    const exp = Number(expStr);
    if (!exp || !sig || Date.now() > exp) return false;
    const expected = signChallenge(clientIp(req), exp);
    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return false;
    }
    const digest = crypto.createHash("sha256").update(`${challenge}.${nonce}`).digest();
    return leadingZeroBits(digest) >= DIFFICULTY;
  } catch {
    return false;
  }
}

export function verifyToken(req) {
  try {
    const [expStr, sig] = String(req.headers["x-wm-token"] || "").split(".");
    const exp = Number(expStr);
    if (!exp || !sig || Date.now() > exp) return false;
    const expected = sign(clientIp(req), exp);
    return (
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    );
  } catch {
    return false;
  }
}

export function checkOrigin(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;

  const origin = req.headers.origin;
  if (origin) {
    try {
      if (!ALLOWED_HOSTS.has(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}
