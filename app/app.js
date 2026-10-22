// Follows: look up a @handle, see who follows it and whom it follows, and
// follow it as one of your handles. Follows come from the Follows chain;
// who owns each handle from Moniker. Both are read from public nodes and
// checked by CID.
//
// Routes: #/                       the search, and your handles
//         #/@<h>                   a handle's page
//         #/@<h>/followers         the handles that follow it
//         #/@<h>/following         the handles it follows
//
// A handle follows handles. Accounts are never shown; a follow counts only
// while the account that wrote it owns the following handle now.
//
// A link may carry `?node=` (nodes, comma-separated), `?chain=` (the Follows
// chain) and `?moniker=` (the Moniker chain) to read somewhere else.
import * as sdk from "../vendor/lattice-sdk.js";
import { createFollows } from "../src/index.mjs";
import { defineFollowButton } from "../src/element.mjs";
import { createMoniker } from "./vendor/moniker-sdk/src/index.mjs";
import { count, matches, parseWho } from "./lib.mjs";

const MONIKER_APP = "https://app.moniker.bio/";
const params = new URLSearchParams(location.search);
const nodes = params.get("node")?.split(",");
const chainOf = (name) => params.get(name)?.split("/");
const moniker = createMoniker({ sdk, app: MONIKER_APP, ...(nodes && { nodes }), ...(chainOf("moniker") && { chain: chainOf("moniker") }) });
const graph = createFollows({ sdk, moniker, ...(nodes && { nodes }), ...(chainOf("chain") && { chain: chainOf("chain") }) });
defineFollowButton(graph, { monikerURL: MONIKER_APP });
const wallet = () => globalThis.lattice;

const main = document.querySelector("main");
const search = document.querySelector("#search");
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const link = (h) => `#/${encodeURIComponent(`@${h}`)}`;
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

// ---------------------------------------------------------------- views

let pages = 0; // pages shown so far

async function render() {
  const { who, list } = route();
  search.value = "";
  if (who === "") return home();
  const parsed = parseWho(who);
  if (!parsed) return message(`“${who}” isn't a @handle. Handles look like @name.`);
  const { handle } = parsed;
  if (shown?.who !== who || shown?.list !== list) filter = "";
  main.innerHTML = `<p class="status muted">Loading…</p>`;
  try {
    const held = await moniker.name(handle);
    if (route().who !== who || route().list !== list) return; // moved on meanwhile
    if (!held) return message(`No one holds @${handle}.`);
    if (list) await listPage(who, list, handle);
    else await handlePage(who, handle);
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

async function home() {
  shown = null;
  main.innerHTML = `
    <section class="home">
      <h1>One follow list for every app.</h1>
      <p class="muted">Follow someone once and every app that reads Follows knows it. Search a @handle to see who follows them.</p>
    </section>
    <section class="mine" hidden></section>
    ${recent().length ? `
      <section class="recent">
        <h2>Recently viewed</h2>
        <ul class="people">${recent().map((h) => `<li><a href="${esc(link(h))}">${avatar(h, 40)}<span class="who"><strong>@${esc(h)}</strong></span></a></li>`).join("")}</ul>
      </section>` : ""}`;
  search.focus();
  await yours();
}

/**
 * Your handles, under the search: each with its counts, linked to its lists.
 * Shown only once Selfhold is connected; with Selfhold there but not yet
 * connected, a button connects it.
 */
async function yours() {
  const section = main.querySelector(".mine");
  if (!section || !wallet()?.writeRecords) return;
  let me;
  try {
    me = await wallet().address?.();
  } catch {}
  if (!main.contains(section)) return; // moved on meanwhile
  if (!me) {
    section.hidden = false;
    section.innerHTML = `<h2>Your handles</h2><button type="button" id="connect">Connect Selfhold</button>`;
    section.querySelector("#connect").onclick = async () => {
      try {
        await wallet().connect();
        await yours();
      } catch {} // declined: the button stays
    };
    return;
  }
  try {
    const handles = await graph.handlesOf(me);
    const counted = await Promise.all(handles.map((h) => graph.counts(h)));
    if (!main.contains(section)) return;
    section.hidden = false;
    section.innerHTML = `<h2>Your handles</h2>${
      handles.length === 0
        ? `<p class="muted">To follow, get a handle on <a href="${esc(MONIKER_APP)}" target="_blank" rel="noopener">Moniker</a> first.</p>`
        : `<ul class="people">${handles.map((h, i) => `<li class="handle-row">
            <a href="${esc(link(h))}">${avatar(h, 40)}<span class="who"><strong>@${esc(h)}</strong></span></a>
            <span class="row-counts small">
              <a href="${esc(link(h))}/followers">${esc(count(counted[i].followers, "follower"))}</a>
              <a href="${esc(link(h))}/following">${esc(count(counted[i].following, "following", "following"))}</a>
            </span></li>`).join("")}</ul>`
    }`;
  } catch {
    section.hidden = true; // the search still works; the next visit reads again
  }
}

function message(text) {
  shown = null;
  main.innerHTML = `<p class="status">${esc(text)}</p>`;
}

const many = (n, one, other) => `<strong>${n.toLocaleString("en-US")}</strong> ${n === 1 ? one : other}`;
const countLinks = (handle, n) => `
  <a href="${esc(link(handle))}/followers">${many(n.followers, "follower", "followers")}</a>
  <a href="${esc(link(handle))}/following">${many(n.following, "following", "following")}</a>`;

async function handlePage(who, handle) {
  const n = await graph.counts(handle);
  if (route().who !== who || route().list) return; // moved on meanwhile
  shown = { who, list: "" };
  remember(handle);
  main.innerHTML = `
    <section class="person">
      ${avatar(handle, 72)}
      <div>
        <h1>@${esc(handle)}</h1>
        <p class="links"><a href="${esc(moniker.pageURL(`@${handle}`))}" target="_blank" rel="noopener">Moniker page</a></p>
      </div>
    </section>
    <p class="counts" data-handle="${esc(handle)}">${countLinks(handle, n)}</p>
    <div class="follow"><follows-button target="${esc(handle)}"></follows-button></div>`;
}

async function listPage(who, list, handle) {
  const all = list === "followers" ? await graph.followers(handle) : await graph.following(handle);
  if (route().who !== who || route().list !== list) return; // moved on meanwhile
  const empty = list === "followers" ? "No followers yet." : "Not following anyone yet.";
  shown = { who, list, all, rows: all.slice(0, PAGE), empty };
  main.innerHTML = `
    <a class="back" href="${esc(link(handle))}">‹ @${esc(handle)}</a>
    <h1 class="list-title">${esc(list === "followers" ? `@${handle}'s followers` : `@${handle} follows`)}</h1>
    ${all.length > FILTER_FROM ? `
      <label class="filter"><span class="sr">Filter this list</span>
        <input id="filter" type="search" placeholder="Filter by @handle" autocomplete="off" value="${esc(filter)}">
      </label>` : ""}
    <p class="muted small" role="status" id="results"></p>
    <ul class="people"></ul>
    <button type="button" class="more" id="more" hidden></button>`;
  const input = main.querySelector("#filter");
  if (input) {
    input.oninput = () => {
      filter = input.value;
      draw();
    };
  }
  main.querySelector("#more").onclick = () => {
    shown.rows = shown.all.slice(0, shown.rows.length + PAGE);
    draw();
  };
  draw();
}

function draw() {
  const ul = main.querySelector(".people");
  const { rows, all, empty } = shown;
  // A filter looks through everyone.
  const kept = filter.trim() ? all.filter((h) => matches(h, filter)) : rows;
  main.querySelector("#results").textContent = filter.trim() ? count(kept.length, "result") : "";
  const moreButton = main.querySelector("#more");
  const left = all.length - rows.length;
  moreButton.hidden = left === 0 || Boolean(filter.trim());
  moreButton.textContent = `Show ${Math.min(left, PAGE)} more`;
  if (all.length === 0) {
    ul.innerHTML = `<li class="empty muted">${esc(empty)}</li>`;
  } else if (kept.length === 0) {
    ul.innerHTML = `<li class="empty muted">No one here matches “${esc(filter.trim())}”.</li>`;
  } else {
    ul.innerHTML = kept.map((h) => `<li><a href="${esc(link(h))}">${avatar(h, 40)}<span class="who"><strong>@${esc(h)}</strong></span></a></li>`).join("");
  }
}

/** An avatar: the handle's first letter. */
const avatar = (handle, size) => `<span class="avatar" style="--size:${size}px" aria-hidden="true">${esc(handle.charAt(0).toUpperCase())}</span>`;

// ---------------------------------------------------------------- recently viewed (this browser only)

function recent() {
  try {
    const kept = JSON.parse(localStorage.getItem("follows.recent") ?? "[]");
    return Array.isArray(kept) ? kept.filter((h) => parseWho(h)?.handle === h) : [];
  } catch {
    return [];
  }
}
function remember(handle) {
  try {
    const next = [handle, ...recent().filter((h) => h !== handle)].slice(0, 6);
    localStorage.setItem("follows.recent", JSON.stringify(next));
  } catch {}
}

// ---------------------------------------------------------------- events

document.querySelector("#find").onsubmit = (event) => {
  event.preventDefault();
  const typed = search.value.trim();
  const who = parseWho(typed);
  if (!who) return message(`“${typed}” isn't a @handle. Handles look like @name.`);
  location.hash = link(who.handle);
};
addEventListener("hashchange", render);
// A follow or unfollow saved: update the counts in place, keeping the button (and its "Saved.").
addEventListener("follows:change", async () => {
  const shownCounts = main.querySelector(".counts");
  if (!shownCounts) return;
  try {
    const { handle } = shownCounts.dataset;
    shownCounts.innerHTML = countLinks(handle, await graph.counts(handle));
  } catch {} // the counts stay as they were; the next visit reads them again
});
render();
