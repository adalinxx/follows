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
import { count, label, matches, parseWho } from "./lib.mjs";

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

// The list on screen, kept so typing in the filter redraws it without reading again.
let shown = null;
let filter = "";

function route() {
  const [who = "", list = ""] = decodeURIComponent(location.hash.replace(/^#\/?/, "")).split("/");
  return { who, list: list === "followers" || list === "following" ? list : "" };
}

// ---------------------------------------------------------------- reading

/**
 * Whom `who` names: for a name, the name and whoever owns it now; for an
 * account, the account and the names it owns.
 */
async function lookUp(parsed) {
  if (parsed.handle) {
    const address = await moniker.resolve(parsed.handle);
    return { followed: `@${parsed.handle}`, handle: parsed.handle, address, person: address && (await moniker.profile(address)) };
  }
  const person = await moniker.profile(parsed.address);
  return { followed: parsed.address, address: parsed.address, person };
}

/** Rows for accounts: their Moniker cards. */
async function accountRows(addresses, { marked = false } = {}) {
  return (await moniker.profiles(addresses)).map((p) => ({
    ...p,
    href: link(p.handle ? `@${p.handle}` : p.address),
    detail: [p.handle && `@${p.handle}`, marked && (p.handle ? "account" : "Account")].filter(Boolean).join(" · "),
  }));
}

/** Rows for what an account follows: names, as whoever owns them now, and accounts, marked as such. */
async function followedRows(targets) {
  const names = targets.filter((t) => t.startsWith("@"));
  const owners = await Promise.all(names.map((t) => moniker.resolve(t.slice(1))));
  const cards = new Map((await moniker.profiles(owners.filter(Boolean))).map((p) => [p.address, p]));
  const owner = new Map(names.map((t, i) => [t, owners[i] && cards.get(owners[i])]));
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
  return { title: label(person ?? { address }), short: person?.name ?? "This account" };
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
  const [n, owns] = await Promise.all([counts(found), handle ? [] : namesOwned(address)]);
  if (route().who !== who || route().list) return; // moved on meanwhile
  shown = { who, list: "" };
  const { title } = naming(found);
  remember(who, title, handle ? `@${handle}` : "Account");
  const sub = handle
    ? address ? `@${esc(handle)}` : `@${esc(handle)} · No one owns this name yet`
    : owns.length ? owns.map((h) => `<a href="${esc(link(`@${h}`))}">@${esc(h)}</a>`).join(" ") : "";
  const links = [
    address && `<a href="${esc(moniker.pageURL(followed))}" target="_blank" rel="noopener">Moniker page</a>`,
    handle && address && `<a href="${esc(link(address))}">Owner's page</a>`,
  ].filter(Boolean).join("");
  main.innerHTML = `
    <section class="person">
      ${avatar(person ?? { handle }, 72)}
      <div>
        <h1>${esc(title)}</h1>
        ${sub ? `<p class="muted names">${sub}</p>` : ""}
        ${links ? `<p class="links">${links}</p>` : ""}
      </div>
    </section>
    <p class="counts" data-followed="${esc(followed)}">${countLinks(who, n, Boolean(address))}</p>
    <div class="follow"><follows-button target="${esc(followed)}" label="${esc(title)}" ${handle && address ? `owner="${esc(address)}"` : ""}></follows-button></div>`;
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
  const rows =
    list === "followers"
      ? await accountRows(await graph.followers(followed))
      : address ? await followedRows(await graph.following(address)) : [];
  if (route().who !== who || route().list !== list) return; // moved on meanwhile
  const { short } = naming(found);
  const empty = list === "followers" ? "No followers yet." : address ? "Not following anyone yet." : `No one owns ${followed} yet.`;
  shown = { who, list, rows, empty };
  main.innerHTML = `
    <a class="back" href="${esc(link(who))}">‹ ${esc(naming(found).title)}</a>
    <h1 class="list-title">${esc(list === "followers" ? `${short}'s followers` : `${short} follows`)}</h1>
    ${rows.length > FILTER_FROM ? `
      <label class="filter"><span class="sr">Filter this list</span>
        <input id="filter" type="search" placeholder="Filter by name or @handle" autocomplete="off" value="${esc(filter)}">
      </label>` : ""}
    <p class="sr" role="status" id="results"></p>
    <ul class="people"></ul>`;
  const input = main.querySelector("#filter");
  if (input) {
    input.oninput = () => {
      filter = input.value;
      draw();
    };
  }
  draw();
}

function draw() {
  const ul = main.querySelector(".people");
  const { rows, empty } = shown;
  const kept = rows.filter((row) => matches(row, filter));
  main.querySelector("#results").textContent = filter.trim() ? count(kept.length, "result") : "";
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
  const letter = profile.name || profile.handle ? label(profile).replace(/^@/, "").charAt(0).toUpperCase() : "?";
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
  const found = await lookUp(parsed);
  shownCounts.innerHTML = countLinks(route().who, await counts(found), Boolean(found.address));
});
render();
