// Follows: look someone up by @handle or account, see who follows them and
// whom they follow, and follow them. Follows come from the Follows chain;
// handles from Moniker. Both are read from public nodes and checked by CID.
//
// Routes: #/                       the search, and you
//         #/@<h>                   a handle's page: the account that shows it
//         #/<address>              an account's page
//         #/<who>/followers        the accounts that follow them
//         #/<who>/following        whom they follow
//
// An account follows an account, or a handle. A person shows by the handle
// they show on Moniker, or by their account's tail when they show none.
//
// A link may carry `?node=` (nodes, comma-separated), `?chain=` (the Follows
// chain) and `?moniker=` (the Moniker chain) to read somewhere else.
import * as sdk from "../vendor/lattice-sdk.js";
import { createFollows } from "../src/index.mjs";
import { defineFollowButton } from "../src/element.mjs";
import { createMoniker } from "./vendor/moniker-sdk/src/index.mjs";
import { defineHandlePicker } from "./vendor/moniker-sdk/src/picker.mjs";
import { count, labelOf, matches, parseWho, pathOf } from "./lib.mjs";

const MONIKER_APP = "https://app.moniker.bio/";
const params = new URLSearchParams(location.search);
const nodes = params.get("node")?.split(",");
const chainOf = (name) => params.get(name)?.split("/");
const moniker = createMoniker({ sdk, app: MONIKER_APP, ...(nodes && { nodes }), ...(chainOf("moniker") && { chain: chainOf("moniker") }) });
const graph = createFollows({ sdk, moniker, ...(nodes && { nodes }), ...(chainOf("chain") && { chain: chainOf("chain") }) });
defineFollowButton(graph);
defineHandlePicker(moniker, { app: MONIKER_APP });
const wallet = () => globalThis.lattice;

const main = document.querySelector("main");
const search = document.querySelector("#search");
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const link = (p) => `#/${encodeURIComponent(pathOf(p))}`;
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
  if (!parsed) return message(`“${who}” isn't a @handle or an account.`);
  if (shown?.who !== who || shown?.list !== list) filter = "";
  main.innerHTML = `<p class="status muted">Loading…</p>`;
  try {
    const p = await graph.person(parsed.account ?? `@${parsed.handle}`);
    if (route().who !== who || route().list !== list) return; // moved on meanwhile
    if (p.account === undefined && !(await moniker.name(p.handle))) return message(`No one holds @${p.handle}.`);
    if (route().who !== who || route().list !== list) return;
    if (list) await listPage(who, list, p);
    else await personPage(who, p);
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
        <ul class="people">${recent().map((p) => row(p)).join("")}</ul>
      </section>` : ""}`;
  search.focus();
  await yours();
}

/**
 * You, under the search: your handle (or account), your counts, linked to
 * your lists, and a way to show a handle if you show none. Shown only once
 * Selfhold is connected; with Selfhold there but not yet connected, a button
 * connects it.
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
    section.innerHTML = `<h2>You</h2><button type="button" id="connect">Connect Selfhold</button>`;
    section.querySelector("#connect").onclick = async () => {
      try {
        await wallet().connect();
        await yours();
      } catch {} // declined: the button stays
    };
    return;
  }
  try {
    const p = await graph.person(me);
    const n = await graph.counts(me);
    if (!main.contains(section)) return;
    section.hidden = false;
    section.innerHTML = `<h2>You</h2>
      <ul class="people"><li class="handle-row">
        <a href="${esc(link(p))}">${avatar(p, 40)}<span class="who"><strong>${esc(labelOf(p))}</strong></span></a>
        <span class="row-counts small">
          <a href="${esc(link(p))}/followers">${esc(count(n.followers, "follower"))}</a>
          <a href="${esc(link(p))}/following">${esc(count(n.following, "following", "following"))}</a>
        </span></li></ul>
      ${p.handle === undefined ? `<p class="muted small">You show no @handle, so apps show your account's tail. <button type="button" class="link" id="pick">Show a handle</button></p>
        <moniker-handle-picker></moniker-handle-picker>` : ""}`;
    const pick = section.querySelector("#pick");
    if (pick) {
      pick.onclick = async () => {
        const handle = await section.querySelector("moniker-handle-picker").open();
        if (handle && main.contains(section)) await yours();
      };
    }
  } catch {
    section.hidden = true; // the search still works; the next visit reads again
  }
}

function message(text) {
  shown = null;
  main.innerHTML = `<p class="status">${esc(text)}</p>`;
}

const many = (n, one, other) => `<strong>${n.toLocaleString("en-US")}</strong> ${n === 1 ? one : other}`;
const countLinks = (p, n) => `
  <a href="${esc(link(p))}/followers">${many(n.followers, "follower", "followers")}</a>
  <a href="${esc(link(p))}/following">${many(n.following, "following", "following")}</a>`;

/** What a page's heading calls a person. */
const title = (p) => (p.handle !== undefined ? `@${p.handle}` : `Account ${labelOf(p)}`);

async function personPage(who, p) {
  const n = await graph.counts(pathOf(p));
  if (route().who !== who || route().list) return; // moved on meanwhile
  shown = { who, list: "" };
  remember(p);
  const nobody = p.account === undefined;
  main.innerHTML = `
    <section class="person">
      ${avatar(p, 72)}
      <div>
        <h1>${esc(title(p))}</h1>
        ${nobody ? `<p class="muted small">No account shows @${esc(p.handle)} now. Follow it, and you follow whoever shows it next.</p>` : ""}
        ${p.handle !== undefined ? `<p class="links"><a href="${esc(moniker.pageURL(`@${p.handle}`))}" target="_blank" rel="noopener">Moniker page</a></p>` : ""}
      </div>
    </section>
    <p class="counts" data-who="${esc(pathOf(p))}">${countLinks(p, n)}</p>
    <div class="follow"><follows-button target="${esc(pathOf(p))}"></follows-button></div>`;
}

async function listPage(who, list, p) {
  let all;
  if (list === "followers") {
    const accounts = await graph.followers(pathOf(p));
    const handles = await moniker.handlesOf(accounts);
    all = accounts.map((account, i) => (handles[i] === undefined ? { account } : { account, handle: handles[i] }));
  } else {
    all = await graph.following(pathOf(p));
  }
  if (route().who !== who || route().list !== list) return; // moved on meanwhile
  const empty = list === "followers" ? "No followers yet." : "Not following anyone yet.";
  shown = { who, list, all, rows: all.slice(0, PAGE), empty };
  main.innerHTML = `
    <a class="back" href="${esc(link(p))}">‹ ${esc(title(p))}</a>
    <h1 class="list-title">${esc(list === "followers" ? `${title(p)}'s followers` : `${title(p)} follows`)}</h1>
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

/** A person's row, linked to their page. */
const row = (p) => `<li><a href="${esc(link(p))}">${avatar(p, 40)}<span class="who"><strong>${esc(labelOf(p))}</strong></span></a></li>`;

function draw() {
  const ul = main.querySelector(".people");
  const { rows, all, empty } = shown;
  // A filter looks through everyone.
  const kept = filter.trim() ? all.filter((p) => matches(p, filter)) : rows;
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
    ul.innerHTML = kept.map(row).join("");
  }
}

/** An avatar: the handle's first letter, or a dot for an account with none. */
const avatar = (p, size) => `<span class="avatar" style="--size:${size}px" aria-hidden="true">${esc(p.handle?.charAt(0).toUpperCase() ?? "·")}</span>`;

// ---------------------------------------------------------------- recently viewed (this browser only)

function recent() {
  try {
    const kept = JSON.parse(localStorage.getItem("follows.recent.v2") ?? "[]");
    return Array.isArray(kept) ? kept.flatMap((path) => {
      const p = parseWho(path);
      return p && pathOf(p) === path ? [p] : [];
    }) : [];
  } catch {
    return [];
  }
}
function remember(p) {
  try {
    const path = pathOf(p);
    const next = [path, ...recent().map(pathOf).filter((x) => x !== path)].slice(0, 6);
    localStorage.setItem("follows.recent.v2", JSON.stringify(next));
  } catch {}
}

// ---------------------------------------------------------------- events

document.querySelector("#find").onsubmit = (event) => {
  event.preventDefault();
  const typed = search.value.trim();
  const who = parseWho(typed);
  if (!who) return message(`“${typed}” isn't a @handle or an account. Handles look like @name.`);
  location.hash = link(who);
};
addEventListener("hashchange", render);
// A follow or unfollow saved: update the counts in place, keeping the button (and its "Saved.").
addEventListener("follows:change", async () => {
  const shownCounts = main.querySelector(".counts");
  if (!shownCounts) return;
  try {
    const { who } = shownCounts.dataset;
    shownCounts.innerHTML = countLinks(parseWho(who), await graph.counts(who));
  } catch {} // the counts stay as they were; the next visit reads them again
});
render();
