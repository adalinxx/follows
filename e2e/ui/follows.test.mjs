// Acceptance tests for the Follows site: the real page (app/) in Chromium
// against a private Lattice stack (stack.mjs) with a Follows chain and a
// Moniker chain, seeded below. Handles follow handles; a follow counts only
// while the account that wrote it owns the following handle on Moniker. Each
// test is one thing a person does, checked by what the page then shows.
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
  for (const name of ["ada", "bob", "cara", "eve", "solo", "one", "narc", "swapA", "swapB", "popular", "tara", "two", "mallory"]) p[name] = newAccount();
  // Each claims its handle; Two claims two.
  await Promise.all(["ada", "bob", "cara", "eve", "solo", "one", "narc", "popular", "tara", "mallory"].map((name) => c.claim(p[name], name)));
  await Promise.all([c.claim(p.swapA, "swap"), c.claim(p.two, "twin_a")]);
  await c.claim(p.two, "twin_b");
  // Handles follow handles, each written by its owner.
  await Promise.all([
    c.follow(p.bob, "bob", "ada", "one"),
    c.follow(p.cara, "cara", "ada", "swap"),
    c.follow(p.eve, "eve", "ada"),
    c.follow(p.ada, "ada", "bob", "eve", "cara"),
    c.follow(p.narc, "narc", "narc"),
    c.follow(p.swapA, "swap", "one"),
  ]);
  // Many followers: each fan claims a handle and follows from it; sent together, then waited for.
  p.fans = Array.from({ length: FANS }, newAccount);
  const fanHandle = (i) => `fan_${String(i).padStart(3, "0")}`;
  for (const [i, fan] of p.fans.entries()) await c.submit(MONIKER, fan, await c.claimActions(fan, fanHandle(i)));
  await until("every fan's handle lands", async () => (await (await c.state.moniker()).get(`name/${fanHandle(FANS - 1)}`)) !== undefined && (await (await c.state.moniker()).get(`name/${fanHandle(0)}`)) !== undefined);
  for (const [i, fan] of p.fans.entries()) await c.submit(FOLLOWS, fan, await c.followActions(fan, fanHandle(i), "popular"));
  await until("every fan's follow lands", async () => {
    let n = 0;
    for await (const _ of (await c.state.follows()).list("followers/popular/")) n++;
    return n === FANS;
  });
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await stack?.stop();
});

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

/** Connects Selfhold from the front page's Your handles, as a person would. */
async function connect(page) {
  await page.goto(url("#/"));
  await page.getByRole("button", { name: "Connect Selfhold" }).click();
  await expect(page.locator(".mine h2")).toHaveText("Your handles");
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
const picker = (page) => page.locator("follows-button select");
const SAVING = "Saving… about a minute.";
/** Closes the page, which must not have thrown. */
async function close(page) {
  assert.deepEqual(page.errors, []);
  await page.context().close();
}
/** Whether `@h` follows `@t` by `who`'s keys on the chain. */
const keyed = async (who, h, t) => (await (await c.state.follows()).get(`follows/${h}/${t}/${who.address}`)) === "1";

// ---------------------------------------------------------------- finding people

test("the front page says what Follows is and puts the cursor in the search", async () => {
  const page = await open();
  await expect(title(page)).toHaveText("One follow list for every app.");
  await expect(page.locator("#search")).toBeFocused();
  await expect(page.locator("#search")).toHaveAttribute("placeholder", "Search @handle");
  await expect(page.locator(".recent")).toHaveCount(0);
  // No wallet: nothing about your handles.
  await expect(page.locator(".mine")).toBeHidden();
  await close(page);
});

test("a @handle opens its page: counts, Follow, and its Moniker page", async () => {
  const page = await open();
  await page.fill("#search", "@ada");
  await page.press("#search", "Enter");
  await expect(title(page)).toHaveText("@ada");
  await expect(counts(page)).toHaveText(["3 followers", "3 following"]);
  await expect(followButton(page)).toHaveText("Follow @ada");
  await expect(page.getByRole("link", { name: "Moniker page" })).toHaveAttribute("href", "https://app.moniker.bio/#/%40ada");
  // Accounts are never shown, and the search field is clear again.
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

test("a search that is not a handle says how to search, as text", async () => {
  const page = await open();
  await page.fill("#search", "ada lovelace");
  await page.press("#search", "Enter");
  await expect(page.locator("main")).toHaveText("“ada lovelace” isn't a @handle. Handles look like @name.");
  await page.fill("#search", HOSTILE);
  await page.press("#search", "Enter");
  await expect(page.locator("main")).toHaveText(`“${HOSTILE}” isn't a @handle. Handles look like @name.`);
  assert.equal(await page.locator('main img[src="x"]').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  await close(page);
});

test("a handle no one holds says so", async () => {
  const page = await open("#/@nobody_has_this");
  await expect(page.locator("main")).toHaveText("No one holds @nobody_has_this.");
  await close(page);
});

test("handles you visit are listed under Recently viewed", async () => {
  const page = await open("#/@ada");
  await expect(title(page)).toHaveText("@ada");
  await page.goto(url("#/@bob"));
  await expect(title(page)).toHaveText("@bob");
  await page.goto(url("#/"));
  await expect(page.locator(".recent strong")).toHaveText(["@bob", "@ada"]);
  await page.locator(".recent a").first().click();
  await expect(title(page)).toHaveText("@bob");
  await close(page);
});

// ---------------------------------------------------------------- lists

test("the followers count opens the list of handles, each linking to its page", async () => {
  const page = await open("#/@ada");
  await counts(page).first().click();
  assert.match(page.url(), /#\/%40ada\/followers$/);
  await expect(title(page)).toHaveText("@ada's followers");
  await expect(rows(page)).toHaveText(["@bob", "@cara", "@eve"]);
  // A short list needs no filter.
  await expect(page.locator("#filter")).toHaveCount(0);
  await page.getByRole("link", { name: "@bob" }).click();
  await expect(title(page)).toHaveText("@bob");
  await page.goBack();
  await expect(title(page)).toHaveText("@ada's followers");
  await page.getByRole("link", { name: "‹ @ada" }).click();
  await expect(title(page)).toHaveText("@ada");
  await close(page);
});

test("the following count lists the handles it follows", async () => {
  const page = await open("#/@ada/following");
  await expect(title(page)).toHaveText("@ada follows");
  await expect(rows(page)).toHaveText(["@bob", "@cara", "@eve"]);
  await expect(page.getByRole("link", { name: "@cara" })).toHaveAttribute("href", "#/%40cara");
  await close(page);
});

test("a handle with no follows either way shows both empty lists", async () => {
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

test("a handle that follows itself is on its own list", async () => {
  const page = await open("#/@narc/followers");
  await expect(rows(page)).toHaveText(["@narc"]);
  await close(page);
});

// ---------------------------------------------------------------- who counts

test("keys written as a handle the signer doesn't own count for no one", async () => {
  // Mallory writes a follow of @tara as @ada: the chain keeps it, no reader counts it.
  await c.follow(p.mallory, "ada", "tara");
  assert.ok(await keyed(p.mallory, "ada", "tara"));
  const page = await open("#/@tara");
  await expect(counts(page)).toHaveText(["0 followers", "0 following"]);
  await page.goto(url("#/@ada/following"));
  await expect(rows(page)).toHaveText(["@bob", "@cara", "@eve"]);
  await close(page);
});

test("a sold handle's follows lapse, its followers stay, and the new owner starts fresh", async () => {
  let page = await open("#/@one/followers");
  await expect(rows(page)).toHaveText(["@bob", "@swap"]);
  await close(page);
  await c.sell(p.swapA, "swap", p.swapB);
  page = await open("#/@one");
  await expect(counts(page)).toHaveText(["1 follower", "0 following"]);
  await counts(page).first().click();
  await expect(rows(page)).toHaveText(["@bob"]);
  // @swap still has its follower; what it followed under its old owner isn't counted.
  await page.goto(url("#/@swap"));
  await expect(counts(page)).toHaveText(["1 follower", "0 following"]);
  await page.goto(url("#/@swap/followers"));
  await expect(rows(page)).toHaveText(["@cara"]);
  await close(page);
  await c.follow(p.swapB, "swap", "one");
  page = await open("#/@one");
  await expect(counts(page)).toHaveText(["2 followers", "0 following"]);
  await close(page);
});

test("an unfollow shows on the next visit", async () => {
  const page = await open("#/@eve");
  await expect(counts(page).first()).toHaveText("1 follower");
  await c.unfollow(p.ada, "ada", "eve");
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
  for (const hash of ["#/", "#/@ada", "#/@popular/followers", "#/@ada/following"]) {
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
  await expect(page.locator("main")).toContainText("isn't a @handle");
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
    // One handle: no picker.
    await expect(picker(page)).toBeHidden();
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    // "Saved." only once the chain holds it.
    assert.ok(await keyed(fan, "fan_one", "tara"));
    await expect(counts(page).first()).toHaveText(`${before + 1} follower${before === 0 ? "" : "s"}`);
    assert.deepEqual(page.context().answers, ["Connect", "Sign write"]);
    await expect(note(page)).toHaveText("", { timeout: 10_000 });
  });
});

test("Following shows Unfollow under a mouse, and pressing it unfollows", async () => {
  const fan = newAccount();
  await c.claim(fan, "fan_two");
  await c.follow(fan, "fan_two", "tara");
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
    assert.ok(!(await keyed(fan, "fan_two", "tara")));
  });
});

test("an account with two handles picks which follows, and the choice is remembered", async () => {
  await asPerson(p.two, async (page) => {
    await connect(page);
    await page.goto(url("#/@tara"));
    await expect(picker(page)).toBeVisible();
    await expect(picker(page).locator("option")).toHaveText(["as @twin_a", "as @twin_b"]);
    await expect(picker(page)).toHaveAccessibleName("Who follows");
    await picker(page).selectOption({ label: "as @twin_b" });
    await expect(followButton(page)).toHaveText("Follow @tara");
    await followButton(page).click();
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    assert.ok(await keyed(p.two, "twin_b", "tara"));
    assert.ok(!(await keyed(p.two, "twin_a", "tara")));
    await page.reload();
    await expect(picker(page)).toHaveValue("twin_b");
    await expect(followButton(page)).toHaveText("Following @tara");
    // @twin_a follows nothing yet.
    await picker(page).selectOption({ label: "as @twin_a" });
    await expect(followButton(page)).toHaveText("Follow @tara");
  });
});

test("an account with no handle is told to get one on Moniker, and nothing is sent", async () => {
  await asPerson(newAccount(), async (page) => {
    await page.goto(url("#/@tara"));
    await expect(followButton(page)).toHaveText("Follow @tara");
    await followButton(page).click();
    await expect(note(page)).toHaveText("To follow, get a handle on Moniker first.");
    await expect(note(page).locator("a")).toHaveAttribute("href", "https://app.moniker.bio/");
    await expect(followButton(page)).toHaveText("Follow @tara");
    assert.deepEqual(page.context().answers, ["Connect"]);
    // The front page says the same under Your handles.
    await page.goto(url("#/"));
    await expect(page.locator(".mine")).toContainText("To follow, get a handle on Moniker first.");
    await expect(page.locator(".mine a")).toHaveAttribute("href", "https://app.moniker.bio/");
  });
});

test("your handles are on the front page, each with its counts and lists", async () => {
  await asPerson(p.two, async (page) => {
    await connect(page);
    const mine = page.locator(".mine .handle-row");
    await expect(mine.locator("strong")).toHaveText(["@twin_a", "@twin_b"]);
    await expect(mine.nth(1).locator(".row-counts a")).toHaveText(["0 followers", /^\d+ following$/]);
    await mine.nth(1).getByRole("link", { name: /following$/ }).click();
    await expect(title(page)).toHaveText("@twin_b follows");
    await page.goto(url("#/"));
    await page.locator(".mine .handle-row").first().locator("a").first().click();
    await expect(title(page)).toHaveText("@twin_a");
    // Your own handle has no Follow button.
    await expect(page.locator("follows-button")).toBeHidden();
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
    assert.ok(!(await keyed(fan, "fan_three", "tara")));
  });
});

test("on your own handle there is no Follow button, on others there is", async () => {
  await asPerson(p.tara, async (page) => {
    await connect(page);
    await page.goto(url("#/@tara"));
    await expect(counts(page).first()).toHaveText(/follower/);
    await expect(page.locator("follows-button")).toBeHidden();
    await page.goto(url("#/@ada"));
    await expect(followButton(page)).toHaveText("Follow @ada");
  });
});

test("connecting during the click as the page's own handle follows nothing", async () => {
  await asPerson(p.solo, async (page) => {
    await page.goto(url("#/@solo"));
    await expect(followButton(page)).toHaveText("Follow @solo");
    await followButton(page).click();
    await expect(page.locator("follows-button")).toBeHidden();
    assert.deepEqual(page.context().answers, ["Connect"]);
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
      await c.submit(FOLLOWS, fan, await c.followActions(fan, "fan_four", "tara"));
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
  await c.follow(x, "switch_x", "tara");
  await asPerson(x, async (page) => {
    await connect(page);
    await page.goto(url("#/@tara"));
    await expect(followButton(page)).toHaveText("Following @tara");
    await walletSwitchesTo(page.context(), y);
    // Unfollow pressed as Y: X's follow is not Y's to undo.
    await followButton(page).click();
    await expect(note(page)).toHaveText("Selfhold is connected to another account now. Check, then press again.");
    await expect(followButton(page)).toHaveText("Follow @tara");
    assert.ok(await keyed(x, "switch_x", "tara"));
    assert.deepEqual(page.context().answers, ["Connect"]);
    // Pressed again, it follows as Y's handle.
    await followButton(page).click();
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    assert.ok(await keyed(y, "switch_y", "tara"));
    // Switched to the account that owns @tara: no Follow button on its own handle.
    await walletSwitchesTo(page.context(), p.tara);
    await expect(note(page)).toHaveText("", { timeout: 10_000 });
    await followButton(page).click();
    await expect(page.locator("follows-button")).toBeHidden();
  });
});

test("a chosen handle sold elsewhere: the press sends nothing and says it isn't yours anymore", async () => {
  const owner = newAccount();
  await c.claim(owner, "sold_a");
  await c.claim(owner, "sold_b");
  await asPerson(owner, async (page) => {
    await connect(page);
    await page.goto(url("#/@tara"));
    await picker(page).selectOption({ label: "as @sold_a" });
    await expect(followButton(page)).toHaveText("Follow @tara");
    await c.sell(owner, "sold_a", newAccount());
    await followButton(page).click();
    await expect(note(page)).toHaveText("@sold_a isn't yours anymore. Check, then press again.");
    // Only @sold_b is left: no picker.
    await expect(picker(page)).toBeHidden();
    assert.deepEqual(page.context().answers, ["Connect"]);
    await followButton(page).click();
    await expect(note(page)).toHaveText("Saved.", { timeout: 180_000 });
    assert.ok(await keyed(owner, "sold_b", "tara"));
    assert.ok(!(await keyed(owner, "sold_a", "tara")));
  });
});
