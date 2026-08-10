const form = document.getElementById("form");
const chipbox = document.getElementById("chipbox");
const userInput = document.getElementById("userInput");
const turnstileEl = document.getElementById("turnstile-widget");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const goBtn = document.getElementById("go");

// one script for / and /randomizer
const IS_RANDOMIZER = document.body.dataset.page === "randomizer";
const MIN_USERS = 1;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const users = [];
const MAX_USERS = 8;
const TURNSTILE_SITE_KEY = "0x4AAAAAADjsPKC6CkKDJNLj";
// onload is required: cloudflare calls it when render is ready
const TURNSTILE_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__wmTurnstileReady";
const API_ORIGIN = location.protocol === "file:" ? "http://localhost:3018" : "";

window.__wmTurnstileReady = () => {
  window.__wmTurnstileLoaded = true;
  window.dispatchEvent(new Event("wm-turnstile-ready"));
};

// accepts username, @username, or a profile url
function extractUsername(input) {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/letterboxd\.com\/([^\/\s?#]+)/i);
  if (urlMatch) return urlMatch[1].toLowerCase();
  return trimmed.replace(/^@/, "").split("/")[0].toLowerCase();
}

function addUser(raw) {
  const u = extractUsername(raw);
  if (!u || !/^[a-z0-9_]{1,30}$/.test(u) || users.includes(u)) return;
  if (users.length >= MAX_USERS) {
    setStatus(`Compare up to ${MAX_USERS} usernames at once.`, { error: true });
    return;
  }
  users.push(u);
  setStatus("");
  renderChips();
}

function removeUser(u) {
  const i = users.indexOf(u);
  if (i !== -1) users.splice(i, 1);
  renderChips();
}

function editLastChipFromBackspace() {
  const last = users.pop();
  if (!last) return;
  renderChips();
  userInput.value = last.slice(0, -1);
  userInput.focus();
  userInput.setSelectionRange(userInput.value.length, userInput.value.length);
}

function renderChips() {
  chipbox.querySelectorAll(".chip").forEach((c) => c.remove());
  for (const u of users) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const name = document.createElement("span");
    name.textContent = u;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "x";
    x.setAttribute("aria-label", `Remove ${u}`);
    x.textContent = "×";
    x.addEventListener("click", () => removeUser(u));
    chip.append(name, x);
    chipbox.insertBefore(chip, userInput);
  }
}

chipbox.addEventListener("click", () => userInput.focus());

userInput.addEventListener("keydown", (e) => {
  if (e.key === "," || e.key === "Enter") {
    e.preventDefault();
    if (userInput.value.trim()) {
      addUser(userInput.value);
      userInput.value = "";
    } else if (e.key === "Enter" && users.length >= MIN_USERS) {
      runSearch();
    }
  } else if (e.key === "Backspace" && !userInput.value && users.length) {
    e.preventDefault();
    editLastChipFromBackspace();
  }
});

// swipe typing inserts commas without key events
userInput.addEventListener("input", () => {
  if (userInput.value.includes(",")) {
    const parts = userInput.value.split(",");
    userInput.value = parts.pop();
    parts.forEach(addUser);
  }
});

userInput.addEventListener("paste", (e) => {
  const text = (e.clipboardData || window.clipboardData).getData("text");
  if (/[,\s]/.test(text.trim())) {
    e.preventDefault();
    text.split(/[,\s]+/).forEach(addUser);
  }
});

userInput.addEventListener("blur", () => {
  if (userInput.value.trim()) {
    addUser(userInput.value);
    userInput.value = "";
  }
});

function setStatus(text, { loading = false, error = false } = {}) {
  statusEl.classList.toggle("error", error);
  statusEl.innerHTML = loading
    ? `<span class="loader"><i></i><i></i><i></i></span> ${escapeHtml(text)}`
    : escapeHtml(text);
}

// cache in localstorage
const DAY = 24 * 60 * 60 * 1000;
const WATCHLIST_TTL = 60 * 60 * 1000;
const RATING_TTL_OLD = 90 * DAY;
const RATING_TTL_NEW = 7 * DAY;
const THIS_YEAR = new Date().getFullYear();

function isNewRelease(film) {
  const m = film.name.match(/\((\d{4})\)$/);
  return m ? Number(m[1]) >= THIS_YEAR : false;
}

function cacheGet(key, ttl) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const { t, v } = JSON.parse(raw);
    if (Date.now() - t > ttl) {
      localStorage.removeItem(key);
      return undefined;
    }
    return v;
  } catch {
    return undefined;
  }
}
function cacheSet(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), v }));
  } catch {}
}

// every request needs a pass from /api/token
function leadingZeroBits(bytes) {
  let bits = 0;
  for (const b of bytes) {
    if (b === 0) { bits += 8; continue; }
    bits += Math.clz32(b) - 24;
    break;
  }
  return bits;
}

async function solveChallenge(challenge, difficulty) {
  const encoder = new TextEncoder();
  const BATCH = 128;
  for (let start = 0; ; start += BATCH) {
    const digests = await Promise.all(
      Array.from({ length: BATCH }, (_, i) =>
        crypto.subtle.digest("SHA-256", encoder.encode(`${challenge}.${start + i}`))
      )
    );
    for (let i = 0; i < BATCH; i++) {
      if (leadingZeroBits(new Uint8Array(digests[i])) >= difficulty) return start + i;
    }
  }
}

let pass = { token: null, exp: 0 };
let tokenPromise = null;
let turnstileScriptPromise = null;
let turnstileWidgetId = null;
let turnstilePromise = null;
let turnstileResolve = null;
let turnstileReject = null;

function isLocalDev() {
  return (
    location.protocol === "file:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1"
  );
}

function turnstileReady() {
  return window.turnstile && typeof window.turnstile.render === "function";
}

function loadTurnstile() {
  if (isLocalDev()) return Promise.resolve();
  if (turnstileReady()) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;

  turnstileScriptPromise = new Promise((resolve, reject) => {
    let settled = false;
    const onReady = () => { if (turnstileReady()) finish(true); };
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("wm-turnstile-ready", onReady);
      clearInterval(poll);
      clearTimeout(timer);
      ok ? resolve() : reject(new Error("turnstile-unavailable"));
    };
    window.addEventListener("wm-turnstile-ready", onReady);
    const poll = setInterval(() => { if (turnstileReady()) finish(true); }, 150);
    const timer = setTimeout(() => finish(false), 15000);

    if (!document.querySelector("script[data-wm-turnstile]")) {
      const script = document.createElement("script");
      script.src = TURNSTILE_URL;
      script.async = true;
      script.setAttribute("data-wm-turnstile", "");
      script.onerror = () => finish(false);
      document.head.append(script);
    }
  });
  return turnstileScriptPromise;
}

function turnstileAttempt(ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), ms);
    turnstileResolve = (token) => finish(token);
    turnstileReject = (code) => { console.warn("[turnstile]", code); finish(null); };

    try {
      if (turnstileWidgetId != null) {
        window.turnstile.reset(turnstileWidgetId);
      } else {
        turnstileWidgetId = window.turnstile.render(turnstileEl, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: "dark",
          appearance: "interaction-only",
          "before-interactive-callback": () => turnstileEl.classList.add("show"),
          "after-interactive-callback": () => turnstileEl.classList.remove("show"),
          callback: (token) => turnstileResolve && turnstileResolve(token),
          "error-callback": (code) => turnstileReject && turnstileReject(code || "error"),
          "expired-callback": () => turnstileReject && turnstileReject("expired"),
          "timeout-callback": () => turnstileReject && turnstileReject("timeout"),
          "unsupported-callback": () => turnstileReject && turnstileReject("unsupported"),
        });
        if (turnstileWidgetId == null) finish(null);
      }
    } catch (err) {
      console.warn("[turnstile]", err);
      finish(null);
    }
  });
}

async function getTurnstileToken() {
  if (isLocalDev()) return "local-dev";
  if (turnstilePromise) return turnstilePromise;

  turnstilePromise = (async () => {
    await loadTurnstile();
    if (!turnstileReady()) throw new Error("turnstile-unavailable");

    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await turnstileAttempt(30000);
      if (token) return token;
    }
    throw new Error("turnstile-failed");
  })();

  try {
    return await turnstilePromise;
  } finally {
    turnstilePromise = null;
  }
}

async function getToken() {
  if (pass.token && Date.now() < pass.exp) return pass.token;
  if (tokenPromise) return tokenPromise;

  tokenPromise = (async () => {
    const chRes = await fetch(`${API_ORIGIN}/api/token`);
    if (!chRes.ok) throw new Error("Couldn't start a session. Refresh and try again.");
    const { challenge, difficulty } = await chRes.json();
    const nonce = await solveChallenge(challenge, difficulty);
    let turnstile;
    try {
      turnstile = await getTurnstileToken();
    } catch {
      throw new Error("Couldn't verify your browser. Refresh and try again.");
    }
    const res = await fetch(
      `${API_ORIGIN}/api/token?challenge=${encodeURIComponent(challenge)}&nonce=${nonce}&turnstile=${encodeURIComponent(turnstile)}`
    );
    if (!res.ok) throw new Error("Couldn't start a session. Refresh and try again.");
    const { token, ttl } = await res.json();
    pass = { token, exp: Date.now() + ttl - 30000 };
    return token;
  })();

  try {
    return await tokenPromise;
  } finally {
    tokenPromise = null;
  }
}

async function apiFetch(path) {
  let res = await fetch(`${API_ORIGIN}${path}`, { headers: { "x-wm-token": await getToken() } });
  if (res.status === 401) {
    pass = { token: null, exp: 0 };
    res = await fetch(`${API_ORIGIN}${path}`, { headers: { "x-wm-token": await getToken() } });
  }
  return res;
}

async function getWatchlist(user) {
  const cached = cacheGet(`wl:${user}`, WATCHLIST_TTL);
  if (cached) return cached;
  const res = await apiFetch(`/api/watchlist?user=${encodeURIComponent(user)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Couldn't load ${user}'s watchlist.`);
  cacheSet(`wl:${user}`, data);
  return data;
}

async function getRatings(films) {
  const ratings = {};
  const missing = [];
  for (const f of films) {
    const ttl = isNewRelease(f) ? RATING_TTL_NEW : RATING_TTL_OLD;
    const r = cacheGet(`rt2:${f.slug}`, ttl);
    if (r !== undefined) ratings[f.slug] = r;
    else missing.push(f);
  }
  const requests = [];
  for (const fresh of [false, true]) {
    const group = missing.filter((f) => isNewRelease(f) === fresh).map((f) => f.slug);
    for (let i = 0; i < group.length; i += 60) {
      const slugs = group.slice(i, i + 60).join(",");
      requests.push(
        apiFetch(`/api/ratings?slugs=${slugs}${fresh ? "&fresh=1" : ""}`).then((r) =>
          r.ok ? r.json() : {}
        )
      );
    }
  }
  for (const r of await Promise.all(requests)) Object.assign(ratings, r);
  for (const f of missing) cacheSet(`rt2:${f.slug}`, ratings[f.slug] ?? null);
  return ratings;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function safeSlug(slug) {
  return /^[a-z0-9-]+$/.test(slug) ? slug : "";
}

function animateCount(el, n) {
  const start = performance.now();
  const duration = 700;
  function tick(now) {
    const p = Math.min((now - start) / duration, 1);
    el.textContent = Math.round(n * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function splitName(f) {
  const m = f.name.match(/^(.*)\s\((\d{4})\)$/);
  return { title: m ? m[1] : f.name, year: m ? m[2] : "" };
}

function filmCardHtml(f, { pick = false, delay = 0 } = {}) {
  const { title, year } = splitName(f);
  const stars =
    f.rating != null ? `<span class="rate"> · ★ ${f.rating.toFixed(2)}</span>` : "";
  const genres = f.genres && f.genres.length
    ? `<span class="genres">${escapeHtml(f.genres.join(" · "))}</span>`
    : "";
  const slug = safeSlug(f.slug);
  return `<a class="film${pick ? " pick" : ""}" style="--d:${delay}s"
    href="https://letterboxd.com/film/${slug}/" target="_blank" rel="noopener noreferrer">
    <span class="title">${escapeHtml(title)}</span>
    <span class="meta"><span class="year">${year}${stars}</span>${genres}</span>
  </a>`;
}

function ensureZones() {
  let pickZone = document.getElementById("pickZone");
  if (!pickZone) {
    resultsEl.innerHTML =
      '<div class="strip"></div><div id="pickZone"></div><div id="listZone"></div>';
    pickZone = document.getElementById("pickZone");
  }
  return { pickZone, listZone: document.getElementById("listZone") };
}

function renderList(matches, lists, { countUp = false } = {}) {
  const { listZone } = ensureZones();
  const counts = lists.map((l) => `${escapeHtml(l.user)}: ${l.films.length}`).join(" · ");
  if (matches.length === 0) {
    listZone.innerHTML = `
      <p class="summary">No matches 🎬</p>
      <p class="sub">${counts}, no films on every list.</p>`;
    return;
  }
  const cards = matches
    .map((f, i) => filmCardHtml(f, { delay: Math.min(i, 24) * 0.03 }))
    .join("");
  listZone.innerHTML = `
    <p class="summary"><span class="n" id="count">${matches.length}</span> film${matches.length === 1 ? "" : "s"} on ${lists.length > 2 ? "all" : "both"} watchlists</p>
    <p class="sub">${counts}</p>
    <div class="grid">${cards}</div>`;
  if (countUp) animateCount(document.getElementById("count"), matches.length);
}

let pool = [];
let poolLists = [];
let listExpanded = false;

const ROW_H = 56; // must match .reelrow height in css

function sample(arr, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(Math.random() * arr.length)]);
  return out;
}

function reelRowHtml(f) {
  const { title, year } = splitName(f);
  return `<div class="reelrow"><span class="rt">${escapeHtml(title)}</span>${
    year ? `<span class="ry">${year}</span>` : ""
  }</div>`;
}

function slotRoll(target, host, { fast = false } = {}) {
  if (REDUCED_MOTION) return Promise.resolve();
  const rows = fast ? 12 : 24;
  const strip = [...sample(pool, rows), target, sample(pool, 1)[0]];
  host.innerHTML = `<div class="reel"><div class="reelstrip${fast ? " fast" : ""}">${strip
    .map(reelRowHtml)
    .join("")}</div></div>`;
  const stripEl = host.querySelector(".reelstrip");
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    // double rAF so the strip paints at 0 first
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        stripEl.style.transform = `translateY(${-(rows * ROW_H)}px)`;
      })
    );
    stripEl.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, (fast ? 1100 : 2300) + 600);
  });
}

function confettiBurst(anchor) {
  if (REDUCED_MOTION || typeof anchor.animate !== "function") return;
  const colors = ["#ff5c8a", "#b07cf7", "#4f9cf9", "#00e054", "#ff8000"];
  const rect = anchor.getBoundingClientRect();
  const holder = document.createElement("div");
  holder.className = "confetti";
  holder.style.left = `${rect.left + rect.width / 2}px`;
  holder.style.top = `${rect.top + rect.height / 2}px`;
  document.body.append(holder);
  for (let i = 0; i < 36; i++) {
    const p = document.createElement("i");
    const size = 5 + Math.random() * 5;
    p.style.background = colors[i % colors.length];
    p.style.width = `${size}px`;
    p.style.height = `${Math.random() < 0.5 ? size : size * 0.4}px`;
    holder.append(p);
    const angle = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 140;
    p.animate(
      [
        { transform: "translate(0, 0) rotate(0)", opacity: 1 },
        {
          transform: `translate(${Math.cos(angle) * dist}px, ${
            Math.sin(angle) * dist + 90
          }px) rotate(${360 + Math.random() * 360}deg)`,
          opacity: 0,
        },
      ],
      { duration: 900 + Math.random() * 600, easing: "cubic-bezier(0.15, 0.6, 0.35, 1)", fill: "forwards" }
    );
  }
  setTimeout(() => holder.remove(), 1800);
}

function buzz(pattern) {
  try {
    if (typeof navigator.vibrate === "function") navigator.vibrate(pattern);
  } catch {}
}

async function withRating(f) {
  if (f.rating === undefined) {
    try {
      const meta = await getRatings([f]);
      const m = meta[f.slug];
      f.rating = m && m.r != null ? m.r : null;
      f.genres = (m && m.g) || [];
    } catch {}
  }
  return f;
}

function pickCaption() {
  const single = poolLists.length === 1;
  if (pool.length === 1) {
    return single
      ? `The only film on ${escapeHtml(poolLists[0].user)}&#39;s watchlist.`
      : "The only film on every watchlist.";
  }
  return single
    ? `Picked from the ${pool.length} films on ${escapeHtml(poolLists[0].user)}&#39;s watchlist.`
    : `Picked from the ${pool.length} films on ${
        poolLists.length === 2 ? "both" : `all ${poolLists.length}`
      } watchlists.`;
}

function renderPickCard(f) {
  const { pickZone } = ensureZones();
  const again =
    pool.length > 1
      ? '<p class="pickrow"><button type="button" class="pickbtn" data-pick>🎲 Spin again</button></p>'
      : "";
  pickZone.innerHTML = `
    <p class="summary">Tonight&#39;s pick 🎬</p>
    <div class="pickslot">${filmCardHtml(f, { pick: true })}</div>
    <p class="sub">${pickCaption()}</p>
    ${again}`;
}

async function rollAndReveal({ fast = false } = {}) {
  const { pickZone } = ensureZones();
  const f = pool[Math.floor(Math.random() * pool.length)];
  const ratingReady = withRating(f);
  if (pool.length > 1) {
    pickZone.innerHTML =
      '<p class="summary">🎰 Rolling…</p><div class="reelhost"></div>';
    await slotRoll(f, pickZone.querySelector(".reelhost"), { fast });
  }
  await ratingReady;
  renderPickCard(f);
  const card = pickZone.querySelector(".pickslot .film");
  if (card) confettiBurst(card);
  buzz([12, 40, 18]);
}

const LIST_CAP = 60;

function renderPoolList() {
  const { listZone } = ensureZones();
  const single = poolLists.length === 1;
  const shown = listExpanded ? pool : pool.slice(0, LIST_CAP);
  const cards = shown
    .map((f, i) => filmCardHtml(f, { delay: Math.min(i, 24) * 0.03 }))
    .join("");
  const heading = single
    ? `Everything on ${escapeHtml(poolLists[0].user)}&#39;s watchlist`
    : `Every film on ${poolLists.length === 2 ? "both" : "all"} watchlists`;
  const sub = single
    ? `${pool.length} film${pool.length === 1 ? "" : "s"} in the draw`
    : poolLists.map((l) => `${escapeHtml(l.user)}: ${l.films.length}`).join(" · ");
  const more =
    pool.length > shown.length
      ? `<p class="pickrow"><button type="button" class="pickbtn" data-more>Show all ${pool.length} films</button></p>`
      : "";
  listZone.innerHTML = `
    <p class="summary">${heading}</p>
    <p class="sub">${sub}</p>
    <div class="grid">${cards}</div>
    ${more}`;
}

resultsEl.addEventListener("click", (e) => {
  if (e.target.closest("[data-more]")) {
    listExpanded = true;
    renderPoolList();
    return;
  }
  if (e.target.closest("[data-pick]")) rollAndReveal({ fast: true });
});

userInput.addEventListener("focus", () => getToken().catch(() => {}), { once: true });

form.addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch();
});

async function runSearch() {
  if (userInput.value.trim()) {
    addUser(userInput.value);
    userInput.value = "";
  }
  if (users.length < MIN_USERS) {
    setStatus("Add a Letterboxd username first.", { error: true });
    return;
  }

  resultsEl.innerHTML = "";
  listExpanded = false;
  goBtn.disabled = true;

  try {
    if (!(pass.token && Date.now() < pass.exp)) {
      setStatus("Checking your browser…", { loading: true });
      await getToken();
    }
    setStatus(
      users.length === 1 ? "Reading the watchlist…" : `Reading ${users.length} watchlists…`,
      { loading: true }
    );
    const lists = await Promise.all(users.map(getWatchlist));
    let matches = lists[0].films;
    for (const list of lists.slice(1)) {
      const slugs = new Set(list.films.map((f) => f.slug));
      matches = matches.filter((f) => slugs.has(f.slug));
    }
    matches = [...matches].sort((x, y) => x.name.localeCompare(y.name));

    pool = matches;
    poolLists = lists;
    setStatus("");

    if (!matches.length) {
      renderList([], lists);
      return;
    }

    if (IS_RANDOMIZER || users.length === 1) {
      await rollAndReveal();
      renderPoolList();
      return;
    }

    const ratingsDone = getRatings(matches)
      .then((meta) => {
        for (const f of matches) {
          const m = meta[f.slug];
          f.rating = m && m.r != null ? m.r : null;
          f.genres = (m && m.g) || [];
        }
        matches.sort(
          (x, y) => (y.rating ?? -1) - (x.rating ?? -1) || x.name.localeCompare(y.name)
        );
      })
      .catch(() => {});

    await rollAndReveal();
    await ratingsDone;
    renderList(matches, lists, { countUp: true });
  } catch (err) {
    setStatus(err.message, { error: true });
  } finally {
    goBtn.disabled = false;
  }
}
