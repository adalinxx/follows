// Follows: look someone up and see who follows them and whom they follow.
// Follows come from the Follows chain; names and photos from Moniker. Both
// are read from public nodes and checked by CID.
//
// Routes: #/                     the search
//         #/<who>                their followers (<who> is @handle or address)
//         #/<who>/following      whom they follow
//
// A link may carry `?node=` (nodes, comma-separated), `?chain=` (the Follows
// chain) and `?moniker=` (the Moniker chain) to read somewhere else.
import * as sdk from "../vendor/lattice-sdk.js";
import { createFollows } from "../src/index.mjs";
import { createMoniker } from "./vendor/moniker-sdk/src/index.mjs";
import { count, label, matches, parseWho, shortAddress, whoPath } from "./lib.mjs";

const params = new URLSearchParams(location.search);
const nodes = params.get("node")?.split(",");
const chainOf = (name) => params.get(name)?.split("/");
const graph = createFollows({ sdk, ...(nodes && { nodes }), ...(chainOf("chain") && { chain: chainOf("chain") }) });
const moniker = createMoniker({ sdk, app: "https://app.moniker.bio/", ...(nodes && { nodes }), ...(chainOf("moniker") && { chain: chainOf("moniker") }) });

const main = document.querySelector("main");
const search = document.querySelector("#search");
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The list on screen: `{ who, tab, people }`, kept so typing in the filter
// redraws it without reading again.
let shown = null;
let filter = "";

function route() {
  const [who, tab] = decodeURIComponent(location.hash.replace(/^#\/?/, "")).split("/");
  return { who: who || "", tab: tab === "following" ? "following" : "followers" };
}

async function render() {
  const { who, tab } = route();
  search.value = who;
  if (who === "") return home();
  const parsed = parseWho(who);
  if (!parsed) return message(`“${who}” isn't a handle or an address.`);
  if (shown?.who !== who || shown?.tab !== tab) filter = "";
  main.innerHTML = `<p class="status muted">Loading…</p>`;
  try {
    const address = parsed.address ?? (await moniker.resolve(parsed.handle));
    if (!address) return message(`No one holds @${parsed.handle}.`);
    const [person, followers, following] = await Promise.all([moniker.profile(address), graph.followers(address), graph.following(address)]);
    const listed = tab === "followers" ? followers : following;
    const people = await moniker.profiles(listed);
    if (route().who !== who || route().tab !== tab) return; // moved on meanwhile
    shown = { who, tab, people };
    page(person, followers.length, following.length);
  } catch (error) {
    console.error(error);
    main.innerHTML = `<div class="status"><p>Couldn't reach the Follows nodes.</p><button type="button" id="retry">Try again</button></div>`;
    main.querySelector("#retry").onclick = render;
  }
}

function home() {
  shown = null;
  main.innerHTML = `
    <section class="home">
      <h1>One follow list for every app.</h1>
      <p class="muted">Follow someone once and every app that reads Follows knows it. Search a @handle or an address to see who follows them.</p>
    </section>`;
  search.focus();
}

function message(text) {
  shown = null;
  main.innerHTML = `<p class="status">${esc(text)}</p>`;
}

function page(person, followers, following) {
  // The tabs keep how the person was reached: their @handle or their address.
  const { who, tab } = route();
  const base = `#/${encodeURIComponent(who)}`;
  main.innerHTML = `
    <section class="person">
      ${avatar(person, 72)}
      <div>
        <h1>${esc(label(person))}</h1>
        <p class="muted">${person.handle && person.name ? `@${esc(person.handle)} · ` : ""}<span class="mono">${esc(shortAddress(person.address))}</span>
          · <a href="${esc(moniker.pageURL(person.address))}" target="_blank" rel="noopener">Moniker page</a></p>
      </div>
    </section>
    <nav class="tabs" aria-label="Lists">
      <a href="${base}" ${tab === "followers" ? 'aria-current="page"' : ""}>${count(followers, "follower")}</a>
      <a href="${base}/following" ${tab === "following" ? 'aria-current="page"' : ""}>${count(following, "following", "following")}</a>
    </nav>
    <label class="filter"><span class="sr">Search ${tab}</span>
      <input id="filter" type="search" placeholder="Search ${tab === "followers" ? "followers" : "people they follow"}" autocomplete="off" value="${esc(filter)}">
    </label>
    <ul class="people" aria-live="polite"></ul>`;
  const input = main.querySelector("#filter");
  input.oninput = () => {
    filter = input.value;
    list();
  };
  if (followers + following === 0) input.closest("label").hidden = true;
  list();
}

function list() {
  const ul = main.querySelector(".people");
  const { tab, people } = shown;
  const kept = people.filter((p) => matches(p, filter));
  if (people.length === 0) {
    ul.innerHTML = `<li class="empty muted">${tab === "followers" ? "No followers yet." : "Not following anyone yet."}</li>`;
  } else if (kept.length === 0) {
    ul.innerHTML = `<li class="empty muted">No one here matches “${esc(filter.trim())}”.</li>`;
  } else {
    ul.innerHTML = kept
      .map(
        (p) => `<li><a href="#/${encodeURIComponent(whoPath(p))}">
          ${avatar(p, 40)}
          <span class="who"><strong>${esc(label(p))}</strong>
          <span class="muted small">${p.handle && p.name ? `@${esc(p.handle)} · ` : ""}<span class="mono">${esc(shortAddress(p.address))}</span></span></span>
        </a></li>`,
      )
      .join("");
  }
  photos();
}

/** An avatar: the Moniker photo once it loads, the first letter until then. */
function avatar(profile, size) {
  const letter = label(profile).replace(/^@/, "").charAt(0).toUpperCase();
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

document.querySelector("#find").onsubmit = (event) => {
  event.preventDefault();
  const who = parseWho(search.value);
  if (!who) return message(`“${search.value.trim()}” isn't a handle or an address.`);
  location.hash = `#/${encodeURIComponent(who.address ?? `@${who.handle}`)}`;
};
addEventListener("hashchange", render);
render();
