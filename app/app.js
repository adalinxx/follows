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
import { defineFollowButton } from "../src/element.mjs";
import { createMoniker } from "./vendor/moniker-sdk/src/index.mjs";
import { count, label, matches, parseWho, shortAddress, whoPath } from "./lib.mjs";

const params = new URLSearchParams(location.search);
const nodes = params.get("node")?.split(",");
const chainOf = (name) => params.get(name)?.split("/");
const graph = createFollows({ sdk, ...(nodes && { nodes }), ...(chainOf("chain") && { chain: chainOf("chain") }) });
defineFollowButton(graph);
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
    // A name's page lists who follows the name and shows whoever holds it now;
    // an account's lists who follows the account. Each links to the other.
    const followed = parsed.handle ? `@${parsed.handle}` : parsed.address;
    const address = parsed.address ?? (await moniker.resolve(parsed.handle));
    const person = address && (await moniker.profile(address));
    const handle = parsed.handle ?? person.handle;
    const other = parsed.handle ? address : handle && `@${handle}`;
    const [followers, following, others] = await Promise.all([
      graph.followers(followed),
      address ? graph.following(address) : [],
      other ? graph.followers(other) : [],
    ]);
    const rows = tab === "followers" ? await accounts(followers) : await targets(following);
    if (route().who !== who || route().tab !== tab) return; // moved on meanwhile
    const empty = tab === "followers" ? "No followers yet." : address ? "Not following anyone yet." : `No one holds @${handle}, so it follows no one.`;
    shown = { who, tab, rows, empty };
    page({ followed, person, address, handle, other, others: others.length }, followers.length, following.length);
  } catch (error) {
    console.error(error);
    main.innerHTML = `<div class="status"><p>Couldn't reach the Follows nodes.</p><button type="button" id="retry">Try again</button></div>`;
    main.querySelector("#retry").onclick = render;
  }
}

/** Rows for accounts: their Moniker cards, linked to the name they show, else their address. */
async function accounts(addresses) {
  return (await moniker.profiles(addresses)).map((p) => ({
    ...p,
    link: whoPath(p),
    detail: `${p.handle && p.name ? `@${p.handle} · ` : ""}${shortAddress(p.address)}`,
  }));
}

/**
 * Rows for what an account follows: an account as its card, and a name as
 * whoever holds it now, linked to the name.
 */
async function targets(followed) {
  const handles = followed.filter((t) => t.startsWith("@")).map((t) => t.slice(1));
  const holders = await Promise.all(handles.map((h) => moniker.resolve(h)));
  const addresses = followed.filter((t) => !t.startsWith("@"));
  const cards = new Map((await moniker.profiles([...new Set([...holders.filter(Boolean), ...addresses])])).map((p) => [p.address, p]));
  const holder = new Map(handles.map((h, i) => [h, holders[i] && cards.get(holders[i])]));
  return followed.map((t) => {
    if (!t.startsWith("@")) {
      const p = cards.get(t);
      return { ...p, link: whoPath(p), detail: `${p.handle && p.name ? `@${p.handle} · ` : ""}${shortAddress(p.address)}` };
    }
    const h = t.slice(1);
    const held = holder.get(h);
    return {
      handle: h,
      ...(held && { address: held.address, name: held.name, avatar: held.avatar }),
      link: t,
      detail: held ? `${t} · ${shortAddress(held.address)}` : `${t} · No one holds this name`,
    };
  });
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

function page({ followed, person, address, handle, other, others }, followers, following) {
  // The tabs keep how the page was reached: a @handle or an address.
  const { who, tab } = route();
  const base = `#/${encodeURIComponent(who)}`;
  const title = person ? (person.name ?? (handle ? `@${handle}` : shortAddress(address))) : `@${handle}`;
  // The other kind of follow: on a name's page, its holder's account; on an
  // account's page, the name it shows.
  const also = other ? ` · <a href="#/${encodeURIComponent(other)}">${count(others, "follower")} of ${other === address ? "the account" : esc(other)}</a>` : "";
  const detail = address
    ? `${handle && title !== `@${handle}` ? `@${esc(handle)} · ` : ""}<span class="mono">${esc(shortAddress(address))}</span>
       · <a href="${esc(moniker.pageURL(followed))}" target="_blank" rel="noopener">Moniker page</a>${also}`
    : "No one holds this name yet.";
  main.innerHTML = `
    <section class="person">
      ${avatar({ ...person, name: title }, 72)}
      <div>
        <h1>${esc(title)}</h1>
        <p class="muted">${detail}</p>
      </div>
    </section>
    <div class="follow">
      <follows-button target="${esc(followed)}" label="${esc(followed === address ? title : followed)}"></follows-button>
      <p class="muted small">${followed === address ? "You follow this account, whatever names it holds." : `You follow whoever owns ${esc(followed)}.`}</p>
    </div>
    <nav class="tabs" aria-label="Lists">
      <a href="${base}" ${tab === "followers" ? 'aria-current="page"' : ""}>${count(followers, "follower")}</a>
      <a href="${base}/following" ${tab === "following" ? 'aria-current="page"' : ""}>${count(following, "following", "following")}</a>
    </nav>
    <label class="filter"><span class="sr">Search ${tab}</span>
      <input id="filter" type="search" placeholder="Search ${tab === "followers" ? "followers" : "who they follow"}" autocomplete="off" value="${esc(filter)}">
    </label>
    <ul class="people" aria-live="polite"></ul>`;
  const input = main.querySelector("#filter");
  input.oninput = () => {
    filter = input.value;
    list();
  };
  if (shown.rows.length === 0) input.closest("label").hidden = true;
  list();
}

function list() {
  const ul = main.querySelector(".people");
  const { rows, empty } = shown;
  const kept = rows.filter((row) => matches(row, filter));
  if (rows.length === 0) {
    ul.innerHTML = `<li class="empty muted">${esc(empty)}</li>`;
  } else if (kept.length === 0) {
    ul.innerHTML = `<li class="empty muted">No one here matches “${esc(filter.trim())}”.</li>`;
  } else {
    ul.innerHTML = kept
      .map(
        (row) => `<li><a href="#/${encodeURIComponent(row.link)}">
          ${avatar(row, 40)}
          <span class="who"><strong>${esc(label(row))}</strong>
          <span class="muted small mono">${esc(row.detail)}</span></span>
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
// A follow or unfollow saved: redraw, so the counts include it.
addEventListener("follows:change", render);
render();
