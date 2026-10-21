// Follows: look someone up, see who follows them and whom they follow, and
// follow them. Follows come from the Follows chain; names and photos from
// Moniker. Both are read from public nodes and checked by CID.
//
// Routes: #/                       the search
//         #/<who>                  a profile's page (<who> is @handle or profile id)
//         #/<who>/followers        the profiles that follow it
//         #/<who>/following        the profiles it follows
//
// A profile follows profiles: a @handle is read as the profile holding it
// now. Accounts are never shown; a follow counts while the account that
// wrote it acts for the following profile.
//
// A link may carry `?node=` (nodes, comma-separated), `?chain=` (the Follows
// chain) and `?moniker=` (the Moniker chain) to read somewhere else.
import * as sdk from "../vendor/lattice-sdk.js";
import { createFollows } from "../src/index.mjs";
import { defineFollowButton } from "../src/element.mjs";
import { createMoniker } from "./vendor/moniker-sdk/src/index.mjs";
import { count, matches, parseWho } from "./lib.mjs";

const params = new URLSearchParams(location.search);
const nodes = params.get("node")?.split(",");
const chainOf = (name) => params.get(name)?.split("/");
const moniker = createMoniker({ sdk, app: "https://app.moniker.bio/", ...(nodes && { nodes }), ...(chainOf("moniker") && { chain: chainOf("moniker") }) });
const graph = createFollows({ sdk, moniker, ...(nodes && { nodes }), ...(chainOf("chain") && { chain: chainOf("chain") }) });
defineFollowButton(graph);
const label = moniker.label;

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

/** The profile `who` names, by its @handle or its id; undefined when there is none. */
async function lookUp(parsed) {
  const id = parsed.handle ? await moniker.resolve(parsed.handle) : parsed.id;
  return id && moniker.profile(id);
}

/** Rows for profiles: their Moniker cards, each linked by the name it shows, or its id. */
async function profileRows(ids) {
  return (await moniker.profiles(ids)).map((p) => ({
    ...p,
    href: link(p.handle ? `@${p.handle}` : p.id),
    detail: p.handle && p.name ? `@${p.handle}` : "",
  }));
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
    if (route().who !== who || route().list !== list) return; // moved on meanwhile
    if (!found) return message(parsed.handle ? `No one holds @${parsed.handle}.` : "There's no profile with this ID.");
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

/** How a profile's lists are titled: by the name it shows, else as its page is. */
const short = (profile) => (profile.handle ? `@${profile.handle}` : label(profile));

async function counts({ id }) {
  const [followers, following] = await Promise.all([graph.followers(id), graph.following(id)]);
  return { followers: followers.length, following: following.length };
}

const many = (n, one, other) => `<strong>${n.toLocaleString("en-US")}</strong> ${n === 1 ? one : other}`;
const countLinks = (who, n) => `
  <a href="${esc(link(who))}/followers">${many(n.followers, "follower", "followers")}</a>
  <a href="${esc(link(who))}/following">${many(n.following, "following", "following")}</a>`;

async function profilePage(who, profile) {
  const n = await counts(profile);
  if (route().who !== who || route().list) return; // moved on meanwhile
  shown = { who, list: "" };
  const title = label(profile);
  remember(who, title, profile.handle ? `@${profile.handle}` : "");
  main.innerHTML = `
    <section class="person">
      ${avatar(profile, 72)}
      <div>
        <h1>${esc(title)}</h1>
        ${profile.handle && profile.name ? `<p class="muted names">@${esc(profile.handle)}</p>` : ""}
        ${profile.description ? `<p class="bio">${esc(profile.description)}</p>` : ""}
        <p class="links">
          <button type="button" class="copy" data-copy="${esc(profile.id)}">Copy profile ID</button>
          <a href="${esc(moniker.pageURL(profile.handle ? `@${profile.handle}` : profile.id))}" target="_blank" rel="noopener">Moniker page</a>
        </p>
        <p class="sr" role="status" id="copied"></p>
      </div>
    </section>
    <p class="counts" data-id="${esc(profile.id)}">${countLinks(who, n)}</p>
    <div class="follow"><follows-button target="${esc(profile.id)}" label="${esc(title)}"></follows-button></div>`;
  const copy = main.querySelector(".copy");
  copy.onclick = () => navigator.clipboard?.writeText(copy.dataset.copy).then(() => {
    copy.textContent = "Copied";
    main.querySelector("#copied").textContent = "Profile ID copied";
    setTimeout(() => (copy.textContent = "Copy profile ID"), 2000);
  });
  photos();
}

async function listPage(who, list, profile) {
  // The list itself is one prefix read; each row's card is another read, so
  // cards are read a page at a time.
  const all = list === "followers" ? await graph.followers(profile.id) : await graph.following(profile.id);
  const rows = await profileRows(all.slice(0, PAGE));
  if (route().who !== who || route().list !== list) return; // moved on meanwhile
  const empty = list === "followers" ? "No followers yet." : "Not following anyone yet.";
  shown = { who, list, all, rows, empty };
  main.innerHTML = `
    <a class="back" href="${esc(link(who))}">‹ ${esc(label(profile))}</a>
    <h1 class="list-title">${esc(list === "followers" ? `${short(profile)}'s followers` : `${short(profile)} follows`)}</h1>
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
    const next = await profileRows(view.all.slice(view.rows.length, view.rows.length + n));
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

/** An avatar: the Moniker photo once it loads, the first letter until then, blank with no name. */
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
  location.hash = link(who.id ?? `@${who.handle}`);
};
addEventListener("hashchange", render);
// A follow or unfollow saved: update the counts in place, keeping the button (and its "Saved.").
addEventListener("follows:change", async () => {
  const shownCounts = main.querySelector(".counts");
  if (!shownCounts) return;
  try {
    shownCounts.innerHTML = countLinks(route().who, await counts({ id: shownCounts.dataset.id }));
  } catch {} // the counts stay as they were; the next visit reads them again
});
render();
