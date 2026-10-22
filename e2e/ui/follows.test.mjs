// Acceptance tests for the Follows site: the real page (app/) in Chromium
// against a private Lattice stack (stack.mjs) with a Follows chain and a
// Moniker chain, seeded below. An account follows an account, or a handle;
// a person shows by the handle they show on Moniker, or their account's
// tail. Each test is one thing a person does, checked by what the page then
// shows.
// Following goes through the real Selfhold wallet extension, holding the
// person's key, its node the stack's.
//
//   (cd policy && cargo build --release --target wasm32-unknown-unknown)
//   cd e2e/ui && npm install && \
//   LATTICE=<lattice-node>/.build/debug/lattice LATTICE_WALLET=<selfhold>/dist npm test
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium, expect as baseExpect } from "playwright/test";
import { client, newAccount, until } from "./helpers.mjs";
import { FOLLOWS, MONIKER, start } from "./stack.mjs";

const built = process.env.LATTICE_WALLET && fileURLToPath(new URL(process.env.LATTICE_WALLET, `file://${process.cwd()}/`));
if (!built) throw new Error("LATTICE_WALLET: the built Selfhold extension (its dist/ directory)");
// Selfhold as installed by someone whose node runs on this machine: allowed
// to reach it (what Chrome's Allow prompt would grant).
const installed = mkdtempSync(`${tmpdir()}/follows-ui-wallet-`);
cpSync(built, installed, { recursive: true });
const manifest = JSON.parse(readFileSync(`${installed}/manifest.json`, "utf8"));
const scripts = [manifest.background?.service_worker, ...(manifest.content_scripts ?? []).flatMap((c) => c.js ?? [])].filter(Boolean);
const absent = scripts.filter((file) => !existsSync(`${installed}/${file}`));
if (absent.length) throw new Error(`LATTICE_WALLET is an incomplete build, missing ${absent.join(", ")}`);
manifest.host_permissions = [...manifest.host_permissions, "http://127.0.0.1/*"];
writeFileSync(`${installed}/manifest.json`, JSON.stringify(manifest));

// Reads walk the trie node by node, and writes wait for a block: generous waits.
const expect = baseExpect.configure({ timeout: 60_000 });

const HOSTILE = '<img src=x onerror="window.pwned=1">';
const FANS = 60;

let stack;
let c;
let browser;
const p = {}; // the seeded accounts, by name

before(async () => {
  stack = await start();
  c = client(stack.info.node);
  for (const name of ["ada", "bob", "cara", "eve", "solo", "popular", "tara", "swapA", "swapB", "drift", "anon", "quiet"]) p[name] = newAccount();
  // Each claims and shows its handle; Anon and Quiet show none.
  await Promise.all(["ada", "bob", "cara", "eve", "solo", "popular", "tara", "drift"].map((name) => c.claim(p[name], name)));
  await c.claim(p.swapA, "swap");
  // Following someone who shows a handle follows the handle; Quiet, who shows none, by account.
  await Promise.all([
    c.follow(p.bob, "@ada", p.quiet.address),
    c.follow(p.cara, "@ada", "@swap"),
    c.follow(p.eve, "@ada"),
    c.follow(p.ada, "@bob", "@eve", "@cara", "@drift"),
    c.follow(p.anon, "@ada"),
  ]);
  // Bob also follows Swap's account by account, which stays with it when @swap moves.
  await c.followAccount(p.bob, p.swapA.address);
  // Many followers: each fan claims a handle, then follows @popular; sent together, then waited for.
  p.fans = Array.from({ length: FANS }, newAccount);
  const fanHandle = (i) => `fan_${String(i).padStart(3, "0")}`;
  for (const [i, fan] of p.fans.entries()) await c.submit(MONIKER, fan, await c.claimActions(fan, fanHandle(i)));
  await until("every fan's handle lands", async () => (await (await c.state.moniker()).get(`name/${fanHandle(FANS - 1)}`)) !== undefined && (await (await c.state.moniker()).get(`name/${fanHandle(0)}`)) !== undefined);
  for (const fan of p.fans) await c.submit(FOLLOWS, fan, await c.followActions(fan, "@popular"));
  await until("every fan's follow lands", async () => {
    let n = 0;
    for await (const _ of (await c.state.follows()).list("followers/@popular/")) n++;
    return n === FANS;
  });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await stack?.stop();
});

/** An account's tail, as the page shows a person with no handle. */
const tail = (who) => `…${who.address.slice(-4)}`;
const query = (nodes = [stack.info.node]) => `?node=${nodes.join(",")}&chain=${FOLLOWS.join("/")}&moniker=${MONIKER.join("/")}`;
const url = (hash, nodes) => `${stack.info.app}${query(nodes)}${hash}`;

/** The page at `hash` for a visitor with no wallet, with what went wrong in it collected on `page.errors`. */
async function open(hash = "#/", { width = 1100, colorScheme = "light", nodes, before } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme });
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(String(error)));
  await before?.(page);
  await page.goto(url(hash, nodes));
  return page;
}

/**
 * A browser with Selfhold holding `who`'s key, its node the stack's, and a
 * page on it. Every wallet window is answered once its button wakes:
 * approved, or declined while `context.decline` is set. Answers are kept on
 * `context.answers`.
 */
async function withWallet(who) {
  const context = await chromium.launchPersistentContext(mkdtempSync(`${tmpdir()}/follows-ui-browser-`), {
    headless: false,
    viewport: { width: 1100, height: 800 },
    args: ["--headless=new", `--disable-extensions-except=${installed}`, `--load-extension=${installed}`],
  });
  const [worker] = context.serviceWorkers().length ? context.serviceWorkers() : [await context.waitForEvent("serviceworker")];
  const origin = worker.url().split("/").slice(0, 3).join("/");
  context.walletOrigin = origin;
  context.answers = [];
  context.notes = [];
  context.on("page", async (opened) => {
    await opened.waitForLoadState().catch(() => {});
    if (!opened.url().includes("/approve/index.html")) return;
    // The approving button wakes only in a focused window, once everything that decides the request has been seen.
    await opened.bringToFront();
    const approve = opened.getByRole("button", { name: /^(Connect|Sign write|Pay .+)$/ });
    const rest = opened.getByRole("button", { name: /^See the rest/ });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(await approve.isEnabled().catch(() => false))) {
      if (await rest.isVisible().catch(() => false)) await rest.click().catch(() => {});
      await opened.waitForTimeout(250);
    }
    if (!(await approve.isEnabled().catch(() => false))) {
      context.notes.push((await opened.locator("body").innerText().catch(() => "?")).replace(/\s+/g, " ").slice(0, 400));
      return;
    }
    const label = (await approve.textContent()).trim();
    if (context.decline && label !== "Connect") {
      await opened.getByRole("button", { name: "Decline" }).click();
      context.answers.push(`declined ${label}`);
      return;
    }
    await approve.click();
    context.answers.push(label);
  });
  const setup = await context.newPage();
  await setup.goto(`${origin}/popup/index.html`);
  const created = await setup.evaluate((privHex) => chrome.runtime.sendMessage({ type: "createWallet", password: "follows-test-pass", privHex }), who.keyHex);
  if (!created?.ok) throw new Error(`wallet setup: ${created?.error}`);
  await setup.evaluate(async (url) => {
    const { settings } = await chrome.storage.local.get("settings");
    const endpoints = { ...(settings?.endpoints ?? {}), Nexus: { url, acceptsSubmit: true, source: "user" } };
    await chrome.storage.local.set({ settings: { ...settings, nodeMode: "custom", endpoints } });
  }, stack.info.node);
  await setup.close();
  const page = context.pages()[0] ?? (await context.newPage());
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(String(error)));
  return page;
}

/** Connects Selfhold from the front page's You, as a person would. */
async function connect(page) {
  await page.goto(url("#/"));
  await page.getByRole("button", { name: "Connect Selfhold" }).click();
  await expect(page.locator(".mine .handle-row")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Selfhold" })).toHaveCount(0);
}

/** In Selfhold, the person adds `who`'s key and connects this site to it instead. */
async function walletSwitchesTo(context, who) {
  const popup = await context.newPage();
  await popup.goto(`${context.walletOrigin}/popup/index.html`);
  const imported = await popup.evaluate((privHex) => chrome.runtime.sendMessage({ type: "importKey", privHex }), who.keyHex);
  if (!imported?.ok) throw new Error(`wallet import: ${imported?.error}`);
  await popup.evaluate(async ({ origin, address }) => {
    const { connections = {} } = await chrome.storage.local.get("connections");
    await chrome.storage.local.set({ connections: { ...connections, [origin]: address } });
  }, { origin: new URL(stack.info.app).origin, address: who.address });
  await popup.close();
}

/** Runs `body` with a page in a browser holding `who`'s key; on failure, says what the wallet saw. */
async function asPerson(who, body) {
  const page = await withWallet(who);
  try {
    await body(page);
    assert.deepEqual(page.errors, []);
  } catch (error) {
    error.message += `\n--- wallet answered: [${page.context().answers}] ${page.context().notes.join(" || ")}`;
    throw error;
  } finally {
    await page.context().close();
  }
}

const title = (page) => page.locator("main h1");
const counts = (page) => page.locator(".counts a");
const rows = (page) => page.locator(".people li a strong");
const followButton = (page) => page.locator("follows-button button");
const note = (page) => page.locator("follows-button .note");
/** The list shows exactly `expected`, in any order: a list is in key order, which follows accounts' addresses. */
async function listed(page, expected) {
  await expect(rows(page)).toHaveCount(expected.length);
  assert.deepEqual((await rows(page).allTextContents()).sort(), [...expected].sort());
}
const SAVING = "Saving… about a minute.";
/** Closes the page, which must not have thrown. */
async function close(page) {
  assert.deepEqual(page.errors, []);
  await page.context().close();
}
/** Whether `who` holds a follow key for `t` on the chain: an address, or `@h`. */
const keyed = (who, t) => c.keyed(who, t);

// ---------------------------------------------------------------- finding people

test("the front page says what Follows is and puts the cursor in the search", async () => {
  const page = await open();
  await expect(title(page)).toHaveText("One follow list for every app.");
  await expect(page.locator("#search")).toBeFocused();
  await expect(page.locator("#search")).toHaveAttribute("placeholder", "Search @handle");
  await expect(page.locator(".recent")).toHaveCount(0);
  // No wallet: nothing about you.
  await expect(page.locator(".mine")).toBeHidden();
  await close(page);
});

test("a @handle opens its page: counts, Follow, and its Moniker page", async () => {
  const page = await open();
  await page.fill("#search", "@ada");
  await page.press("#search", "Enter");
  await expect(title(page)).toHaveText("@ada");
  await expect(counts(page)).toHaveText(["4 followers", "4 following"]);
  await expect(followButton(page)).toHaveText("Follow @ada");
  await expect(page.getByRole("link", { name: "Moniker page" })).toHaveAttribute("href", "https://app.moniker.bio/#/%40ada");
  // A person with a handle shows by it, and the search field is clear again.
  await expect(page.locator("main")).not.toContainText("bafyrei");
  await expect(page.locator("#search")).toHaveValue("");
  assert.match(page.url(), /#\/%40ada$/);
  await close(page);
});

test("a handle may be typed without @ and in capitals", async () => {
  for (const typed of ["ada", "ADA", "  @Ada "]) {
    const page = await open();
    await page.fill("#search", typed);
    await page.press("#search", "Enter");
    await expect(title(page)).toHaveText("@ada");
    await close(page);
  }
});

test("an account is found by its address, and one that shows a handle opens by its handle", async () => {
  let page = await open();
  await page.fill("#search", p.quiet.address);
  await page.press("#search", "Enter");
  await expect(title(page)).toHaveText(`Account ${tail(p.quiet)}`);
  await expect(counts(page)).toHaveText(["1 follower", "0 following"]);
  // Someone with no handle is followed by account: the button names no one.
  await expect(followButton(page)).toHaveText("Follow");
  await expect(page.getByRole("link", { name: "Moniker page" })).toHaveCount(0);
  await close(page);
  page = await open(`#/${p.ada.address}`);
  await expect(title(page)).toHaveText("@ada");
  await expect(counts(page)).toHaveText(["4 followers", "4 following"]);
  await close(page);
});

test("a search that is neither a handle nor an account says how to search, as text", async () => {
  const page = await open();
  await page.fill("#search", "ada lovelace");
  await page.press("#search", "Enter");
  await expect(page.locator("main")).toHaveText("“ada lovelace” isn't a @handle or an account. Handles look like @name.");
  await page.fill("#search", HOSTILE);
  await page.press("#search", "Enter");
  await expect(page.locator("main")).toHaveText(`“${HOSTILE}” isn't a @handle or an account. Handles look like @name.`);
  assert.equal(await page.locator('main img[src="x"]').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  await close(page);
});

test("a handle no one holds says so", async () => {
  const page = await open("#/@nobody_has_this");
  await expect(page.locator("main")).toHaveText("No one holds @nobody_has_this.");
  await close(page);
});

test("people you visit are listed under Recently viewed, by handle or account", async () => {
  const page = await open("#/@ada");
  await expect(title(page)).toHaveText("@ada");
  await page.goto(url(`#/${p.quiet.address}`));
  await expect(title(page)).toHaveText(`Account ${tail(p.quiet)}`);
  await page.goto(url("#/"));
  await expect(page.locator(".recent strong")).toHaveText([tail(p.quiet), "@ada"]);
  await page.locator(".recent a").first().click();
  await expect(title(page)).toHaveText(`Account ${tail(p.quiet)}`);
  await close(page);
});

// ---------------------------------------------------------------- lists

test("the followers count opens the list of people, each linking to their page", async () => {
  const page = await open("#/@ada");
  await counts(page).first().click();
  assert.match(page.url(), /#\/%40ada\/followers$/);
  await expect(title(page)).toHaveText("@ada's followers");
  // Anon follows with no handle of its own: shown by its account's tail.
  await listed(page, ["@bob", "@cara", "@eve", tail(p.anon)]);
  // A short list needs no filter.
  await expect(page.locator("#filter")).toHaveCount(0);
  await page.getByRole("link", { name: "@bob" }).click();
  await expect(title(page)).toHaveText("@bob");
  await page.goBack();
  await expect(title(page)).toHaveText("@ada's followers");
  await page.getByRole("link", { name: tail(p.anon) }).click();
  await expect(title(page)).toHaveText(`Account ${tail(p.anon)}`);
  assert.match(page.url(), new RegExp(`#/${p.anon.address}$`));
  await page.goBack();
  await page.getByRole("link", { name: "‹ @ada" }).click();
  await expect(title(page)).toHaveText("@ada");
  await close(page);
});

test("the following count lists whom they follow, a handle no one shows included", async () => {
  await c.stopShowing(p.drift);
  const page = await open("#/@ada/following");
  await expect(title(page)).toHaveText("@ada follows");
  await listed(page, ["@bob", "@cara", "@drift", "@eve"]);
  await expect(page.getByRole("link", { name: "@cara" })).toHaveAttribute("href", "#/%40cara");
  // @drift's page: no one shows it, and it can still be followed.
  await page.getByRole("link", { name: "@drift" }).click();
  await expect(title(page)).toHaveText("@drift");
  await expect(page.locator(".person")).toContainText("No account shows @drift now. Follow it, and you follow whoever shows it next.");
  await expect(counts(page)).toHaveText(["1 follower", "0 following"]);
  await expect(followButton(page)).toHaveText("Follow @drift");
  // Drift's account, showing no handle, keeps no followers of @drift.
  await page.goto(url(`#/${p.drift.address}`));
  await expect(title(page)).toHaveText(`Account ${tail(p.drift)}`);
  await expect(counts(page)).toHaveText(["0 followers", "0 following"]);
  await close(page);
});

test("someone with no follows either way shows both empty lists", async () => {
  let page = await open("#/@solo");
  await expect(counts(page)).toHaveText(["0 followers", "0 following"]);
  await counts(page).first().click();
  await expect(page.locator(".people")).toHaveText("No followers yet.");
  await close(page);
  page = await open("#/@solo/following");
  await expect(page.locator(".people")).toHaveText("Not following anyone yet.");
  await close(page);
});

test(`a long list (${FANS} followers) shows 50 at a time, and its filter looks through everyone`, async () => {
  const page = await open("#/@popular/followers");
  await expect(page.locator(".people li")).toHaveCount(50);
  await page.getByRole("button", { name: `Show ${FANS - 50} more` }).click();
  await expect(page.locator(".people li")).toHaveCount(FANS);
  await page.reload();
  await expect(page.locator(".people li")).toHaveCount(50);
  // The filter looks past the 50 shown.
  await page.fill("#filter", "@FAN_059");
  await expect(rows(page)).toHaveText(["@fan_059"]);
  await expect(page.getByRole("button", { name: /^Show \d+ more$/ })).toBeHidden();
  await expect(page.locator("#results")).toHaveText("1 result");
  await page.fill("#filter", "fan_00");
  await expect(rows(page)).toHaveCount(10);
  await page.fill("#filter", "zz_zz");
  await expect(page.locator(".people")).toHaveText("No one here matches “zz_zz”.");
  await page.fill("#filter", "");
  await expect(page.locator(".people li")).toHaveCount(50);
  await close(page);
});

test("counts read naturally", async () => {
  const page = await open("#/@eve");
  await expect(counts(page)).toHaveText(["1 follower", "1 following"]);
  await close(page);
});

// ---------------------------------------------------------------- handles that move

test("a handle given to another key: its followers follow that key, and the old account keeps its own", async () => {
  let page = await open("#/@swap/followers");
  await listed(page, ["@bob", "@cara"]);
  await close(page);
  await c.give(p.swapA, "swap", p.swapB);
  page = await open("#/@swap");
  await expect(counts(page)).toHaveText(["1 follower", "0 following"]);
  await counts(page).first().click();
  await expect(rows(page)).toHaveText(["@cara"]);
  // Swap A's account, showing no handle now, keeps Bob, who followed it by account.
  await page.goto(url(`#/${p.swapA.address}`));
  await expect(title(page)).toHaveText(`Account ${tail(p.swapA)}`);
  await expect(counts(page)).toHaveText(["1 follower", "0 following"]);
  await page.goto(url(`#/${p.swapA.address}/followers`));
  await expect(rows(page)).toHaveText(["@bob"]);
  // Bob's list shows Swap A's account by its tail now.
  await page.goto(url("#/@bob/following"));
  await listed(page, ["@ada", tail(p.quiet), tail(p.swapA)]);
  await close(page);
});

test("an unfollow shows on the next visit", async () => {
  const page = await open("#/@eve");
  await expect(counts(page).first()).toHaveText("1 follower");
  await c.unfollow(p.ada, "@eve");
  await page.reload();
  await expect(counts(page).first()).toHaveText("0 followers");
  await close(page);
});

// ---------------------------------------------------------------- reading from nodes

test("moving on before a page loads shows the newer one, not the slower one", async () => {
  const held = [];
  let hold = true;
  const page = await open("#/", {
    before: (page) => page.route(`${stack.info.node}/**`, (route) => (hold ? held.push(route) : route.continue())),
  });
  await page.evaluate(() => (location.hash = "#/@ada"));
  await until("@ada's page asks the node", async () => held.length > 0, 10);
  await page.evaluate(() => (location.hash = "#/@bob"));
  hold = false;
  for (const route of held.splice(0)) await route.continue();
  await expect(title(page)).toHaveText("@bob");
  await page.waitForTimeout(3000);
  await expect(title(page)).toHaveText("@bob");
  await close(page);
});

test("when the first node is down, the page reads from the next", async () => {
  const page = await open("#/@ada", { nodes: ["http://127.0.0.1:9", stack.info.node] });
  await expect(title(page)).toHaveText("@ada");
  await expect(counts(page).first()).toHaveText(/\d+ followers?/);
  await close(page);
});

test("when no node answers, the page says so, and Try again works once one does", async () => {
  let down = true;
  const page = await open("#/@ada", {
    before: (page) => page.route(`${stack.info.node}/**`, (route) => (down ? route.abort() : route.continue())),
  });
  await expect(page.locator("main")).toContainText("Couldn't reach Follows.");
  down = false;
  await page.click("text=Try again");
  await expect(title(page)).toHaveText("@ada");
  await close(page);
});

test("on a phone, nothing scrolls sideways", async () => {
  for (const hash of ["#/", "#/@ada", "#/@popular/followers", "#/@ada/following", `#/${p.quiet.address}`]) {
    const page = await open(hash, { width: 360 });
    if (hash !== "#/") await expect(title(page)).not.toHaveText("");
    await page.waitForTimeout(500);
    const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.ok(scroll <= width, `${hash}: ${scroll} > ${width}`);
    await close(page);
  }
});

test("in dark mode the page is dark, and the Follow button readable", async () => {
  const page = await open("#/@ada", { colorScheme: "dark" });
  await expect(title(page)).toHaveText("@ada");
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(18, 20, 24)");
  await expect(followButton(page)).toHaveText("Follow @ada");
  assert.equal(await followButton(page).evaluate((b) => getComputedStyle(b).color), "rgb(18, 20, 24)");
  await close(page);
});

test("a malformed link shows a message, not a blank page", async () => {
  const page = await open("#/%E0");
  await expect(page.locator("main")).toContainText("isn't a @handle or an account");
  await close(page);
});

// ---------------------------------------------------------------- following, with Selfhold

test("without a wallet, Follow says how to get one; on a phone, to use a computer", async () => {
  let page = await open("#/@tara");
  await followButton(page).click();
  await expect(note(page)).toContainText("To follow, add Selfhold, a free browser extension");
  await expect(note(page).locator("a")).toHaveAttribute("href", /chromewebstore\.google\.com/);
  await close(page);
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" });
  page = await phone.newPage();
  page.errors = [];
  await page.goto(url("#/@tara"));
  await followButton(page).click();
  await expect(note(page)).toHaveText("Following needs Selfhold, a Chrome extension for computers. Open this page on a computer to follow.");
  await close(page);
});

test("following: Selfhold connects and signs, the button turns at once, the note says saving, then Saved", async () => {
  const fan = newAccount();
  await c.claim(fan, "fan_one");
  await asPerson(fan, async (page) => {
    await page.goto(url("#/@tara"));
    await expect(counts(page).first()).toHaveText(/^\d+ followers?$/);
    const before = Number((await counts(page).first().textContent()).match(/\d+/)[0]);
    await expect(followButton(page)).toHaveText("Follow @tara");
    await expect(followButton(page)).toHaveAccessibleName("Follow @tara");
    await followButton(page).click();
    await expect(followButton(page)).toHaveText("Following @tara");
    await expect(followButton(page)).toHaveAccessibleName("Following @tara");
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    // "Saved." only once the chain holds it: the handle, followed by the account.
    assert.ok(await keyed(fan, "@tara"));
    await expect(counts(page).first()).toHaveText(`${before + 1} follower${before === 0 ? "" : "s"}`);
    assert.deepEqual(page.context().answers, ["Connect", "Sign write"]);
    await expect(note(page)).toHaveText("", { timeout: 10_000 });
  });
});

test("no handle is needed to follow", async () => {
  const fan = newAccount();
  await asPerson(fan, async (page) => {
    await page.goto(url("#/@tara"));
    await expect(followButton(page)).toHaveText("Follow @tara");
    await followButton(page).click();
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    assert.ok(await keyed(fan, "@tara"));
    assert.deepEqual(page.context().answers, ["Connect", "Sign write"]);
    await page.goto(url("#/@tara/followers"));
    await expect(rows(page).filter({ hasText: tail(fan) })).toHaveCount(1);
  });
});

test("someone with no handle is followed by account, from their page", async () => {
  const fan = newAccount();
  await c.claim(fan, "fan_acct");
  await asPerson(fan, async (page) => {
    await connect(page);
    await page.goto(url(`#/${p.quiet.address}`));
    await expect(counts(page)).toHaveText(["1 follower", "0 following"]);
    await expect(followButton(page)).toHaveText("Follow");
    await followButton(page).click();
    await expect(followButton(page)).toHaveText("Following");
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    assert.ok(await keyed(fan, p.quiet.address));
    await expect(counts(page)).toHaveText(["2 followers", "0 following"]);
    // Quiet shows a handle later: the follow by account still counts.
    await c.claim(p.quiet, "quiet");
    // A new visit: the page reuses a read of Moniker for a few seconds.
    await page.goto(url("#/@quiet"));
    await page.reload();
    await expect(counts(page)).toHaveText(["2 followers", "0 following"]);
    await expect(followButton(page)).toHaveText("Following @quiet");
  });
});

test("Following shows Unfollow under a mouse, and pressing it unfollows", async () => {
  const fan = newAccount();
  await c.claim(fan, "fan_two");
  await c.follow(fan, "@tara");
  await asPerson(fan, async (page) => {
    await connect(page);
    await page.goto(url("#/@tara"));
    await expect(followButton(page)).toHaveText("Following @tara");
    await followButton(page).hover();
    await expect(followButton(page).locator(".now")).toBeHidden();
    assert.equal(await followButton(page).evaluate((b) => getComputedStyle(b, "::after").content), '"Unfollow @tara"');
    await followButton(page).click();
    await expect(followButton(page)).toHaveText("Follow @tara");
    await expect(note(page)).toHaveText(SAVING);
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    assert.ok(!(await keyed(fan, "@tara")));
  });
});

test("unfollowing someone followed both ways deletes both", async () => {
  const fan = newAccount();
  await c.claim(fan, "fan_both");
  await c.follow(fan, "@tara");
  await c.followAccount(fan, p.tara.address);
  await asPerson(fan, async (page) => {
    await connect(page);
    await page.goto(url("#/@tara"));
    await expect(followButton(page)).toHaveText("Following @tara");
    await followButton(page).click();
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    assert.ok(!(await keyed(fan, "@tara")));
    assert.ok(!(await keyed(fan, p.tara.address)));
    assert.deepEqual(page.context().answers, ["Connect", "Sign write"]);
  });
});

test("you are on the front page: your handle, your counts and your lists", async () => {
  await asPerson(p.ada, async (page) => {
    await connect(page);
    const mine = page.locator(".mine .handle-row");
    await expect(page.locator(".mine h2")).toHaveText("You");
    await expect(mine.locator("strong")).toHaveText("@ada");
    await expect(mine.locator(".row-counts a")).toHaveText([/^\d+ followers?$/, /^\d+ following$/]);
    await expect(page.locator(".mine #pick")).toHaveCount(0);
    await mine.getByRole("link", { name: /following$/ }).click();
    await expect(title(page)).toHaveText("@ada follows");
    await page.goto(url("#/"));
    await page.locator(".mine .handle-row a").first().click();
    await expect(title(page)).toHaveText("@ada");
    // Your own page has no Follow button.
    await expect(page.locator("follows-button")).toBeHidden();
  });
});

test("showing no handle, you see your account's tail, and Show a handle claims one in the page", async () => {
  const fresh = newAccount();
  await asPerson(fresh, async (page) => {
    await connect(page);
    await expect(page.locator(".mine .handle-row strong")).toHaveText(tail(fresh));
    await expect(page.locator(".mine")).toContainText("You show no @handle, so apps show your account's tail.");
    await page.getByRole("button", { name: "Show a handle" }).click();
    const dialog = page.locator("moniker-handle-picker dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Or claim a free one").fill("fresh_one");
    await dialog.getByRole("button", { name: "Use handle" }).click();
    // Once Moniker shows it, You shows it.
    await expect(page.locator(".mine .handle-row strong")).toHaveText("@fresh_one", { timeout: 180_000 });
    await expect(page.locator(".mine #pick")).toHaveCount(0);
    assert.deepEqual(page.context().answers, ["Connect", "Sign write"]);
  });
});

test("declining in Selfhold sends nothing and says so", async () => {
  const fan = newAccount();
  await c.claim(fan, "fan_three");
  await asPerson(fan, async (page) => {
    await connect(page);
    page.context().decline = true;
    await page.goto(url("#/@tara"));
    await followButton(page).click();
    await expect(note(page)).toHaveText("Canceled in Selfhold. Nothing was sent.");
    await expect(followButton(page)).toHaveText("Follow @tara");
    assert.ok(!(await keyed(fan, "@tara")));
  });
});

test("on your own page, by handle or account, there is no Follow button; on others there is", async () => {
  await asPerson(p.tara, async (page) => {
    await connect(page);
    await page.goto(url("#/@tara"));
    await expect(counts(page).first()).toHaveText(/follower/);
    await expect(page.locator("follows-button")).toBeHidden();
    await page.goto(url(`#/${p.tara.address}`));
    await expect(title(page)).toHaveText("@tara");
    await expect(page.locator("follows-button")).toBeHidden();
    await page.goto(url("#/@ada"));
    await expect(followButton(page)).toHaveText("Follow @ada");
  });
});

test("connecting during the click as the page's own account follows nothing", async () => {
  await asPerson(p.solo, async (page) => {
    await page.goto(url("#/@solo"));
    await expect(followButton(page)).toHaveText("Follow @solo");
    await followButton(page).click();
    await expect(page.locator("follows-button")).toBeHidden();
    assert.deepEqual(page.context().answers, ["Connect"]);
  });
});

test("connecting during the click when already following shows Following and sends nothing", async () => {
  const fan = newAccount();
  await c.follow(fan, "@tara");
  await asPerson(fan, async (page) => {
    await page.goto(url("#/@tara"));
    await expect(followButton(page)).toHaveText("Follow @tara");
    await followButton(page).click();
    await expect(followButton(page)).toHaveText("Following @tara");
    assert.deepEqual(page.context().answers, ["Connect"]);
    assert.ok(await keyed(fan, "@tara"));
  });
});

test("a follow still waiting for a block, sent from anywhere, shows as saving until it lands", async () => {
  const fan = newAccount();
  await c.claim(fan, "fan_four");
  const mining = (verb) => execFileSync(process.env.LATTICE, ["mine", verb, "--root", stack.info.root], { stdio: "pipe" });
  await asPerson(fan, async (page) => {
    await connect(page);
    mining("stop");
    try {
      // Sent by another app: this page never asked the wallet for it.
      await c.submit(FOLLOWS, fan, await c.followActions(fan, "@tara"));
      await page.goto(url("#/@tara"));
      await expect(followButton(page)).toHaveText("Following @tara");
      await expect(note(page)).toHaveText(SAVING);
      mining("start");
      await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
      assert.deepEqual(page.context().answers, ["Connect"]);
    } finally {
      // Started again however the test went; already running is fine.
      try {
        mining("start");
      } catch {}
    }
  });
});

test("after Selfhold switches account, a press sends nothing, shows that account's follow, and says so", async () => {
  const [x, y] = [newAccount(), newAccount()];
  await Promise.all([c.claim(x, "switch_x"), c.claim(y, "switch_y")]);
  await c.follow(x, "@tara");
  await asPerson(x, async (page) => {
    await connect(page);
    await page.goto(url("#/@tara"));
    await expect(followButton(page)).toHaveText("Following @tara");
    await walletSwitchesTo(page.context(), y);
    // Unfollow pressed as Y: X's follow is not Y's to undo.
    await followButton(page).click();
    await expect(note(page)).toHaveText("Selfhold is connected to another account now. Check, then press again.");
    await expect(followButton(page)).toHaveText("Follow @tara");
    assert.ok(await keyed(x, "@tara"));
    assert.deepEqual(page.context().answers, ["Connect"]);
    // Pressed again, Y follows.
    await followButton(page).click();
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    assert.ok(await keyed(y, "@tara"));
    // Switched to Tara's own account: no Follow button on her page.
    await walletSwitchesTo(page.context(), p.tara);
    await expect(note(page)).toHaveText("", { timeout: 10_000 });
    await followButton(page).click();
    await expect(page.locator("follows-button")).toBeHidden();
  });
});

// ---------------------------------------------------------------- in another app: <follows-who>

/** Another app's page (who.html) showing `who`, with `card` as that app's card for them. */
const otherApp = (who, card) =>
  `${new URL("../e2e/ui/who.html", stack.info.app)}${query()}&address=${who.address}${card ? `&card=${encodeURIComponent(JSON.stringify(card))}` : ""}`;

test("in another app, a name opens the same card: the app's name for them, their handle, counts, Follow, links", async () => {
  const fan = newAccount();
  await asPerson(fan, async (page) => {
    await page.goto(otherApp(p.tara, { name: "@Tara <b>Okafor</b>", bio: "Eats @ noon" }));
    const name = page.locator("follows-who moniker-name");
    await expect(name).toContainText("@tara");
    const opener = page.locator("follows-who button.open");
    await expect(opener).toHaveAttribute("aria-expanded", "false");
    await opener.click();
    const card = page.locator("follows-who [popover]");
    await expect(card).toBeVisible();
    await expect(opener).toHaveAttribute("aria-expanded", "true");
    // The app's name, as text, with no @: only the verified handle has one.
    await expect(card.locator(".name")).toHaveText("Tara <b>Okafor</b>");
    await expect(card.locator(".handle")).toHaveText("@tara");
    await expect(card.locator(".bio")).toHaveText("Eats  noon");
    await expect(card.locator(".counts")).toHaveText(/^\d+ followers?\s*\d+ following$/);
    await expect(card.getByRole("link", { name: "Follows page" })).toHaveAttribute("href", /#\/%40tara$/);
    await expect(card.getByRole("link", { name: "Moniker page" })).toHaveAttribute("href", /#\/%40tara$/);
    assert.equal(await page.locator("b", { hasText: "Okafor" }).count(), 0);
    // On screen, under the name.
    const [box, view] = [await card.boundingBox(), page.viewportSize()];
    assert.ok(box.x >= 0 && box.x + box.width <= view.width && box.y >= 0 && box.y + box.height <= view.height, JSON.stringify(box));
    // Follow works from the card.
    const follow = card.locator("follows-button button");
    await expect(follow).toHaveText("Follow @tara");
    await follow.click();
    await expect(card.locator("follows-button .note")).toHaveText("Saved.", { timeout: 180_000 });
    assert.ok(await keyed(fan, "@tara"));
    // Escape closes it, and focus goes back to the name.
    await follow.focus();
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(opener).toHaveAttribute("aria-expanded", "false");
  });
});

test("in another app, someone with no handle and no card shows by their account's tail", async () => {
  const page = await open();
  await page.goto(otherApp(p.anon));
  await page.locator("follows-who button.open").click();
  const card = page.locator("follows-who [popover]");
  await expect(card.locator(".id")).toHaveText(tail(p.anon));
  await expect(card.locator(".handle")).toHaveCount(0);
  await expect(card).toHaveAttribute("aria-label", `Account ${tail(p.anon)}`);
  await expect(card.getByRole("link", { name: "Follows page" })).toHaveAttribute("href", new RegExp(`#/${p.anon.address}$`));
  await expect(card.getByRole("link", { name: "Moniker page" })).toHaveCount(0);
  await expect(card.locator("follows-button button")).toHaveText("Follow");
  // A press outside closes it.
  await page.mouse.click(5, 300);
  await expect(card).toBeHidden();
  await close(page);
});

test("a link's ?node=, ?chain= and ?moniker= apply to that visit only: nothing about them is stored", async () => {
  const page = await open("#/@ada");
  await expect(title(page)).toHaveText("@ada");
  await page.goto(url("#/"));
  await expect(page.locator(".recent strong")).toHaveText(["@ada"]);
  const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  assert.deepEqual(Object.keys(stored), ["follows.recent.v2"]);
  for (const value of Object.values(stored)) assert.ok(!value.includes("127.0.0.1") && !value.includes("Nexus"), value);
  // The same page without the params reads the default nodes, not the link's.
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(`${stack.info.app}#/@ada`);
  await page.waitForTimeout(1500);
  assert.ok(!requests.some((r) => r.startsWith(stack.info.node)), "read from the link's node after it was left");
  await page.context().close();
});
