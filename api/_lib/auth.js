// origin check + hmac signed tokens

import crypto from "node:crypto";

function configuredSecret(name, fallback) {
  const value = process.env[name];
  if (value && value !== '""' && value !== "''") return value;
  if (process.env.VERCEL) {
    throw new Error(`${name} is required in production.`);
  }
  return fallback;
}

const SECRET = configuredSecret("WM_TOKEN_SECRET", "dev-only-secret");
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

function sign(ip, exp, nonce = "") {
  return crypto.createHmac("sha256", SECRET).update(`${ip}|${exp}|${nonce}`).digest("hex");
}

function legacySign(ip, exp) {
  return crypto.createHmac("sha256", SECRET).update(`${ip}|${exp}`).digest("hex");
}

export function mintToken(ip) {
  const exp = Date.now() + TOKEN_TTL;
  const nonce = crypto.randomBytes(9).toString("base64url");
  return `${exp}.${nonce}.${sign(ip, exp, nonce)}`;
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
    const token = String(req.headers["x-wm-token"] || "");
    const parts = token.split(".");
    const [expStr, nonce, sig] =
      parts.length === 3 ? parts : [parts[0], "", parts[1]];
    const exp = Number(expStr);
    if (!exp || !sig || Date.now() > exp) return false;
    const expected = nonce ? sign(clientIp(req), exp, nonce) : legacySign(clientIp(req), exp);
    return (
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    );
  } catch {
    return false;
  }
}

const tokenUses = new Map();

function consumeToken(req, { scope, limit }) {
  const token = String(req.headers["x-wm-token"] || "");
  const exp = Number(token.split(".")[0]);
  if (!scope || !limit || !exp) return true;

  const now = Date.now();
  if (tokenUses.size > 10000) {
    for (const [key, entry] of tokenUses) {
      if (entry.exp <= now) tokenUses.delete(key);
    }
  }

  const key = `${scope}:${clientIp(req)}:${token}`;
  const entry = tokenUses.get(key) || { exp, count: 0 };
  if (entry.count >= limit) return false;
  entry.count += 1;
  tokenUses.set(key, entry);
  return true;
}

export function verifyTokenQuota(req, options) {
  return verifyToken(req) && consumeToken(req, options);
}

export function checkOrigin(req) {
  const origin = req.headers.origin;
  const isLocalFilePreview = origin === "null" && !process.env.VERCEL;

  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none" && !isLocalFilePreview) {
    return false;
  }

  if (origin) {
    if (isLocalFilePreview) return true;
    try {
      if (!ALLOWED_HOSTS.has(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}
