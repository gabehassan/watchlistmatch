// node scripts/test.mjs <username>
import { getWatchlist } from "../api/watchlist.js";

const user = process.argv[2] || "pop01";
const start = Date.now();
const data = await getWatchlist(user);
console.log(`${user}: header says ${data.count} films, scraped ${data.films.length}`);
console.log(`took ${Date.now() - start}ms`);
console.log("first 3:", data.films.slice(0, 3));
console.log("last 1:", data.films.at(-1));
