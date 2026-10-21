// Follows: look someone up, see who follows them and whom they follow, and
// follow them. Follows come from the Follows chain; names and photos from
// Moniker. Both are read from public nodes and checked by CID.
//
// Routes: #/                       the search
//         #/<who>                  their page (<who> is @handle or address)
//         #/<who>/followers        who follows them
//         #/<who>/following        whom they follow
//
// A name's page is about the name: its followers follow whoever owns it.
// An account's page is about the account, and lists the names it owns.
//
// A link may carry `?node=` (nodes, comma-separated), `?chain=` (the Follows
// chain) and `?moniker=` (the Moniker chain) to read somewhere else.
import * as sdk from "../vendor/lattice-sdk.js";
import { createFollows } from "../src/index.mjs";
import { defineFollowButton } from "../src/element.mjs";
import { createMoniker } from "./vendor/moniker-sdk/src/index.mjs";
import { count, label, matches, parseWho, shortID } from "./lib.mjs";

const params = new URLSearchParams(location.search);
const nodes = params.get("node")?.split(",");
const chainOf = (name) => params.get(name)?.split("/");
const graph = createFollows({ sdk, ...(nodes && { nodes }), ...(chainOf("chain") && { chain: chainOf("chain") }) });
defineFollowButton(graph);
const moniker = createMoniker({ sdk, app: "https://app.moniker.bio/", ...(nodes && { nodes }), ...(chainOf("moniker") && { chain: chainOf("moniker") }) });

const main = document.querySelector("main");
const search = document.querySelector("#search");
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const link = (who) => `#/${encodeURIComponent(who)}`;
// A list longer than this gets a filter.
const FILTER_FROM = 20;
// Rows shown at first, and added by Show more.
const PAGE = 50;

// The list on screen, kept so typing in the filter redraws it without reading again.
let shown = null;
let filter = "";

function route() {
  let hash;
  try {
    hash = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  } catch {
    hash = location.hash.replace(/^#\/?/, ""); // a malformed link: shown as typed, which no handle matches
  }
  const [who = "", list = ""] = hash.split("/");
  return { who, list: list === "followers" || list === "following" ? list : "" };
}

// ---------------------------------------------------------------- reading

/**
 * Whom `who` names: for a name, the name, whoever owns it now and its card;
 * for an account, the account. The card belongs to the name, not the account.
 */
async function lookUp(parsed) {
  if (parsed.handle) {
    const card = await moniker.card(parsed.handle);
    return { followed: `@${parsed.handle}`, handle: parsed.handle, address: card?.address, person: card };
  }
  return { followed: parsed.address, address: parsed.address };
}

/** Rows for accounts: their Moniker cards. */
async function accountRows(addresses, { marked = false } = {}) {
  return (await moniker.profiles(addresses)).map((p) => ({
    ...p,
    href: link(p.handle ? `@${p.handle}` : p.address),
    detail: marked ? (p.handle ? `@${p.handle}'s account` : "") : p.handle ? `@${p.handle}` : "",
  }));
}

/** Rows for what an account follows: names, as whoever owns them now, and accounts, marked as such. */
async function followedRows(targets) {
  const names = targets.filter((t) => t.startsWith("@"));
  const cards = await Promise.all(names.map((t) => moniker.card(t)));
  const owner = new Map(names.map((t, i) => [t, cards[i]]));
  const accounts = new Map((await accountRows(targets.filter((t) => !t.startsWith("@")), { marked: true })).map((row) => [row.address, row]));
  return targets.map((t) => {
    if (!t.startsWith("@")) return accounts.get(t);
    const held = owner.get(t);
    return {
      handle: t.slice(1),
      ...(held && { address: held.address, name: held.name, avatar: held.avatar }),
      href: link(t),
      detail: held ? t : "No one owns it yet",
    };
  });
}

// ---------------------------------------------------------------- views

let pages = 0; // pages shown so far

async function render() {
  const { who, list } = route();
  search.value = "";
  if (who === "") return home();
  const parsed = parseWho(who);
  if (!parsed) return message(`“${who}” isn't a @handle. Handles look like @name.`);
  if (shown?.who !== who || shown?.list !== list) filter = "";
  main.innerHTML = `<p class="status muted">Loading…</p>`;
  try {
    const found = await lookUp(parsed);
    if (list) await listPage(who, list, found);
    else await profilePage(who, found);
    // A new page: focus its heading, so keyboard and screen reader users start there.
    if (pages++ > 0 && route().who === who && !main.contains(document.activeElement)) {
      const heading = main.querySelector("h1");
      heading?.setAttribute("tabindex", "-1");
      heading?.focus({ preventScroll: true });
    }
  } catch (error) {
    console.error(error);
    main.innerHTML = `<div class="status"><p>Couldn't reach Follows.</p><button type="button" id="retry">Try again</button></div>`;
    main.querySelector("#retry").onclick = render;
  }
}

function home() {
  shown = null;
  main.innerHTML = `
    <section class="home">
      <h1>One follow list for every app.</h1>
      <p class="muted">Follow someone once and every app that reads Follows knows it. Search a @handle to see who follows them.</p>
    </section>
    ${recent().length ? `
      <section class="recent">
        <h2>Recently viewed</h2>
        <ul class="people">${recent().map((r) => `<li><a href="${esc(link(r.who))}"><span class="who"><strong>${esc(r.title)}</strong><span class="muted small">${esc(r.detail)}</span></span></a></li>`).join("")}</ul>
      </section>` : ""}`;
  search.focus();
}

function message(text) {
  shown = null;
  main.innerHTML = `<p class="status">${esc(text)}</p>`;
}

/** What a page is called, and how its lists are titled. */
function naming({ handle, person, address }) {
  if (handle) return { title: person?.name ?? `@${handle}`, short: `@${handle}` };
  return { title: `Account ${shortID(address)}`, short: `Account ${shortID(address)}` };
}

async function counts({ followed, address }) {
  const [followers, following] = await Promise.all([graph.followers(followed), address ? graph.following(address) : []]);
  return { followers: followers.length, following: following.length };
}

const many = (n, one, other) => `<strong>${n.toLocaleString("en-US")}</strong> ${n === 1 ? one : other}`;
const countLinks = (who, n, owned) => `
  <a href="${esc(link(who))}/followers">${many(n.followers, "follower", "followers")}</a>
  ${owned ? `<a href="${esc(link(who))}/following">${many(n.following, "following", "following")}</a>` : ""}`;

async function profilePage(who, found) {
  const { followed, handle, address, person } = found;
  const [n, owns, by] = await Promise.all([
    counts(found),
    handle ? [] : namesOwned(address).then((held) => Promise.all(held.map(async (h) => (await moniker.card(h)) ?? { handle: h }))),
    handle ? undefined : moniker.who(address).then((p) => p.handle),
  ]);
  // The default first: it is the one apps show.
  owns.sort((a, b) => (b.handle === by) - (a.handle === by));
  if (route().who !== who || route().list) return; // moved on meanwhile
  shown = { who, list: "" };
  const { title } = naming(found);
  remember(who, title, handle ? `@${handle}` : "Account");
  // A name's page is its card, and says which account owns it. An account's
  // page is the account: its ID, and the names it owns, each with its card.
  const links = [
    handle && address && `<a href="${esc(link(address))}">Owned by <span class="id">${esc(shortID(address))}</span></a>`,
    address && `<a href="${esc(moniker.pageURL(followed))}" target="_blank" rel="noopener">Moniker page</a>`,
  ].filter(Boolean).join("");
  const head = handle
    ? `${avatar(person ?? { handle }, 72)}
      <div>
        <h1>${esc(title)}</h1>
        <p class="muted names">${address ? `@${esc(handle)}` : `@${esc(handle)} · No one owns this name yet`}</p>
        ${person?.description ? `<p class="bio">${esc(person.description)}</p>` : ""}
        ${links ? `<p class="links">${links}</p>` : ""}
      </div>`
    : `<div>
        <h1>Account <span class="id" title="${esc(address)}">${esc(shortID(address))}</span></h1>
        <p class="links"><button type="button" class="copy" data-copy="${esc(address)}">Copy ID</button>${links}</p>
        <p class="sr" role="status" id="copied"></p>
      </div>`;
  const names = handle ? "" : `
    <h2 class="section">${owns.length === 1 ? "Name" : "Names"}</h2>
    <ul class="people owned">${owns.length
      ? owns.map((card) => `<li><a href="${esc(link(`@${card.handle}`))}">${avatar(card, 40)}<span class="who"><strong>${esc(label(card))}</strong>${card.name || (owns.length > 1 && card.handle === by) ? `<span class="muted small">${[card.name && `@${esc(card.handle)}`, owns.length > 1 && card.handle === by && "default"].filter(Boolean).join(" · ")}</span>` : ""}</span></a></li>`).join("")
      : `<li class="empty muted">No names.</li>`}</ul>`;
  main.innerHTML = `
    <section class="person">${head}</section>
    <p class="counts" data-followed="${esc(followed)}">${countLinks(who, n, Boolean(address))}</p>
    <div class="follow"><follows-button target="${esc(followed)}" label="${esc(handle ? title : shortID(address))}" ${handle && address ? `owner="${esc(address)}"` : ""}></follows-button></div>
    ${names}`;
  const copy = main.querySelector(".copy");
  if (copy) {
    copy.onclick = () => navigator.clipboard?.writeText(copy.dataset.copy).then(() => {
      copy.textContent = "Copied";
      main.querySelector("#copied").textContent = "Account ID copied";
      setTimeout(() => (copy.textContent = "Copy ID"), 2000);
    });
  }
  photos();
}

/** The names an account owns, as Moniker records them. */
async function namesOwned(address) {
  const state = await moniker.state();
  const { heldBy } = await import("./vendor/moniker-sdk/src/records/profile.mjs");
  return (await heldBy(state, address)).map((entry) => entry.handle);
}

async function listPage(who, list, found) {
  const { followed, address } = found;
  // The list itself is one prefix read; each row's card is another read, so
  // cards are read a page at a time.
  const all = list === "followers" ? await graph.followers(followed) : address ? await graph.following(address) : [];
  const toRows = list === "followers" ? accountRows : followedRows;
  const rows = await toRows(all.slice(0, PAGE));
  if (route().who !== who || route().list !== list) return; // moved on meanwhile
  const { short, title } = naming(found);
  const empty = list === "followers" ? "No followers yet." : address ? "Not following anyone yet." : `No one owns ${followed} yet.`;
  shown = { who, list, all, rows, toRows, empty };
  main.innerHTML = `
    <a class="back" href="${esc(link(who))}">‹ ${esc(title)}</a>
    <h1 class="list-title">${esc(list === "followers" ? `${short}'s followers` : `${short} follows`)}</h1>
    ${all.length > FILTER_FROM ? `
      <label class="filter"><span class="sr">Filter this list</span>
        <input id="filter" type="search" placeholder="Filter by name or @handle" autocomplete="off" value="${esc(filter)}">
      </label>` : ""}
    <p class="muted small" role="status" id="results"></p>
    <ul class="people"></ul>
    <button type="button" class="more" id="more" hidden></button>`;
  const input = main.querySelector("#filter");
  if (input) {
    input.oninput = async () => {
      filter = input.value;
      // A filter looks through everyone: read the cards not read yet, once.
      if (filter.trim() && shown.rows.length < shown.all.length) await more(Infinity);
      draw();
    };
  }
  main.querySelector("#more").onclick = () => more(PAGE);
  draw();
}

/** Reads the next `n` rows' cards and shows them. */
async function more(n) {
  const view = shown;
  if (view.loading) return view.loading;
  main.querySelector("#results").textContent = "Loading…";
  view.loading = (async () => {
    const next = await view.toRows(view.all.slice(view.rows.length, view.rows.length + n));
    if (shown !== view) return;
    view.rows = [...view.rows, ...next];
    view.loading = null;
    draw();
  })();
  return view.loading;
}

function draw() {
  const ul = main.querySelector(".people");
  const { rows, all, empty } = shown;
  const kept = rows.filter((row) => matches(row, filter));
  main.querySelector("#results").textContent = filter.trim() ? count(kept.length, "result") : "";
  const moreButton = main.querySelector("#more");
  const left = all.length - rows.length;
  moreButton.hidden = left === 0 || Boolean(filter.trim());
  moreButton.textContent = `Show ${Math.min(left, PAGE)} more`;
  if (rows.length === 0) {
    ul.innerHTML = `<li class="empty muted">${esc(empty)}</li>`;
  } else if (kept.length === 0) {
    ul.innerHTML = `<li class="empty muted">No one here matches “${esc(filter.trim())}”.</li>`;
  } else {
    ul.innerHTML = kept
      .map(
        (row) => `<li><a href="${esc(row.href)}">
          ${avatar(row, 40)}
          <span class="who"><strong>${esc(label(row))}</strong>${row.detail ? `<span class="muted small">${esc(row.detail)}</span>` : ""}</span>
        </a></li>`,
      )
      .join("");
  }
  photos();
}

/** An avatar: the Moniker photo once it loads, the first letter until then, "?" with no name. */
function avatar(profile, size) {
  const letter = profile.name || profile.handle ? label(profile).replace(/^@/, "").charAt(0).toUpperCase() : "";
  return `<span class="avatar" style="--size:${size}px" ${profile.avatar ? `data-cid="${esc(profile.avatar)}"` : ""} aria-hidden="true">${esc(letter)}</span>`;
}

function photos() {
  for (const span of main.querySelectorAll(".avatar[data-cid]")) {
    const cid = span.dataset.cid;
    delete span.dataset.cid;
    moniker.photo(cid).then((url) => {
      if (url) span.innerHTML = `<img src="${url}" alt="">`;
    });
  }
}

// ---------------------------------------------------------------- recently viewed (this browser only)

function recent() {
  try {
    return JSON.parse(localStorage.getItem("follows.recent") ?? "[]");
  } catch {
    return [];
  }
}
function remember(who, title, detail) {
  try {
    const next = [{ who, title, detail }, ...recent().filter((r) => r.who !== who)].slice(0, 6);
    localStorage.setItem("follows.recent", JSON.stringify(next));
  } catch {}
}

// ---------------------------------------------------------------- events

document.querySelector("#find").onsubmit = (event) => {
  event.preventDefault();
  const typed = search.value.trim();
  const who = parseWho(typed);
  if (!who) return message(`“${typed}” isn't a @handle. Handles look like @name.`);
  location.hash = link(who.address ?? `@${who.handle}`);
};
addEventListener("hashchange", render);
// A follow or unfollow saved: update the counts in place, keeping the button (and its "Saved.").
addEventListener("follows:change", async () => {
  const shownCounts = main.querySelector(".counts");
  const parsed = parseWho(route().who);
  if (!shownCounts || !parsed) return;
  try {
    const found = await lookUp(parsed);
    shownCounts.innerHTML = countLinks(route().who, await counts(found), Boolean(found.address));
  } catch {} // the counts stay as they were; the next visit reads them again
});
render();
