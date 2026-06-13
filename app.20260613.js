const form = document.getElementById("form");
const chipbox = document.getElementById("chipbox");
const userInput = document.getElementById("userInput");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const goBtn = document.getElementById("go");

const users = [];

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
  users.push(u);
  renderChips();
}

function removeUser(u) {
  const i = users.indexOf(u);
  if (i !== -1) users.splice(i, 1);
  renderChips();
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
    } else if (e.key === "Enter" && users.length >= 2) {
      runSearch();
    }
  } else if (e.key === "Backspace" && !userInput.value && users.length) {
    removeUser(users[users.length - 1]);
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
async function getToken() {
  if (pass.token && Date.now() < pass.exp) return pass.token;
  if (tokenPromise) return tokenPromise;

  tokenPromise = (async () => {
    const chRes = await fetch("/api/token");
    if (!chRes.ok) throw new Error("Couldn't start a session. Refresh and try again.");
    const { challenge, difficulty } = await chRes.json();
    const nonce = await solveChallenge(challenge, difficulty);
    const res = await fetch(
      `/api/token?challenge=${encodeURIComponent(challenge)}&nonce=${nonce}`
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
  let res = await fetch(path, { headers: { "x-wm-token": await getToken() } });
  if (res.status === 401) {
    pass = { token: null, exp: 0 };
    res = await fetch(path, { headers: { "x-wm-token": await getToken() } });
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

function render(matches, lists, { countUp = false } = {}) {
  const counts = lists.map((l) => `${escapeHtml(l.user)}: ${l.films.length}`).join(" · ");
  if (matches.length === 0) {
    resultsEl.innerHTML = `
      <div class="strip"></div>
      <p class="summary">No matches 🎬</p>
      <p class="sub">${counts}, no films on every list.</p>`;
    return;
  }
  const cards = matches
    .map((f, i) => {
      const m = f.name.match(/^(.*)\s\((\d{4})\)$/);
      const title = escapeHtml(m ? m[1] : f.name);
      const year = m ? m[2] : "";
      const stars =
        f.rating != null ? `<span class="rate"> · ★ ${f.rating.toFixed(2)}</span>` : "";
      const genres = f.genres && f.genres.length
        ? `<span class="genres">${escapeHtml(f.genres.join(" · "))}</span>`
        : "";
      const slug = safeSlug(f.slug);
      return `<a class="film" style="--d:${Math.min(i, 24) * 0.03}s"
        href="https://letterboxd.com/film/${slug}/" target="_blank" rel="noopener">
        <span class="title">${title}</span>
        <span class="meta"><span class="year">${year}${stars}</span>${genres}</span>
      </a>`;
    })
    .join("");
  resultsEl.innerHTML = `
    <div class="strip"></div>
    <p class="summary"><span class="n" id="count">${matches.length}</span> film${matches.length === 1 ? "" : "s"} on ${lists.length > 2 ? "all" : "both"} watchlists</p>
    <p class="sub">${counts}</p>
    <div class="grid">${cards}</div>`;
  if (countUp) animateCount(document.getElementById("count"), matches.length);
}

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
  if (users.length < 2) {
    setStatus("Add at least two usernames to compare.", { error: true });
    return;
  }

  resultsEl.innerHTML = "";
  setStatus(`Reading ${users.length} watchlists…`, { loading: true });
  goBtn.disabled = true;

  try {
    const lists = await Promise.all(users.map(getWatchlist));
    let matches = lists[0].films;
    for (const list of lists.slice(1)) {
      const slugs = new Set(list.films.map((f) => f.slug));
      matches = matches.filter((f) => slugs.has(f.slug));
    }
    matches = [...matches].sort((x, y) => x.name.localeCompare(y.name));

    setStatus(matches.length ? "Fetching ratings…" : "", { loading: matches.length > 0 });
    render(matches, lists, { countUp: true });

    if (matches.length) {
      const meta = await getRatings(matches);
      for (const f of matches) {
        const m = meta[f.slug];
        f.rating = m && m.r != null ? m.r : null;
        f.genres = (m && m.g) || [];
      }
      matches.sort(
        (x, y) => (y.rating ?? -1) - (x.rating ?? -1) || x.name.localeCompare(y.name)
      );
      setStatus("");
      render(matches, lists);
    }
  } catch (err) {
    setStatus(err.message, { error: true });
  } finally {
    goBtn.disabled = false;
  }
}
