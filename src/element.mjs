// <follows-button target="@ada"> for any page: Follow / Following for a
// handle, followed by a handle of the account connected in the person's
// Selfhold wallet. Register it once with a graph from createFollows:
//
//   defineFollowButton(graph);
//   <follows-button target="@ada"></follows-button>
//
// It says what it follows: "Follow @ada". The follower is one of the
// account's handles on Moniker; with several, a picker beside the button says
// which ("as @bob"), remembered in this browser; with none, the note says to
// get one on Moniker first. It hides on the account's own handles.
//
// A follow takes about a block to save: the button shows the new state at
// once, and its note says it is saving until the chain shows it, then
// "Saved."; then it fires `follows:change` ({ target, as, following }). One
// still waiting in a node's mempool, sent from this page or anywhere else,
// shows as saving too. With no wallet it fires `follows:needs-wallet`
// ({ target }); a page that handles it (preventDefault) shows its own help,
// else the button says how to get one.
// Style it from outside with --follows-accent, --follows-accent-ink,
// --follows-ink, --follows-line, --follows-muted, --follows-width and
// --follows-note-align.

const WALLET_URL = "https://chromewebstore.google.com/detail/amcobhbipbblfjonmoiicihhfglkhpce";
const MONIKER_URL = "https://app.moniker.bio/";
const SAVING = "Saving… about a minute.";
const phone = () => /Android|iPhone|iPad|iPod|Mobile/i.test(globalThis.navigator?.userAgent ?? "");

const style = `
  :host { display: inline-flex; flex-direction: column; gap: 6px; width: var(--follows-width, 14em); max-width: 100%; font: inherit; }
  :host([hidden]) { display: none; }
  button { box-sizing: border-box; width: 100%; min-height: 44px; padding: 0 16px;
    border-radius: 999px; font: inherit; font-weight: 700; cursor: pointer; white-space: nowrap;
    border: 1px solid transparent; background: var(--follows-accent, #3346D3); color: var(--follows-accent-ink, #fff); }
  button.on { background: transparent; color: var(--follows-ink, inherit); border-color: var(--follows-line, #c9ccd4); }
  button[aria-disabled="true"] { cursor: progress; }
  /* Saving: where it is going, but not there yet. */
  button.saving { opacity: 0.7; }
  .now { display: block; overflow: hidden; text-overflow: ellipsis; }
  button:focus-visible { outline: 2px solid var(--follows-accent, #3346D3); outline-offset: 2px; }
  /* Under a mouse, Following offers what a press does. Drawn, not text: the name stays "Following". */
  @media (hover: hover) {
    button.on.ready:hover .now { display: none; }
    button.on.ready:hover::after { content: attr(data-unfollow); }
    button.on.ready:hover { border-color: currentColor; }
  }
  select { box-sizing: border-box; width: 100%; min-height: 44px; padding: 0 12px; border-radius: 8px; font: inherit;
    border: 1px solid var(--follows-line, #c9ccd4); background: transparent; color: var(--follows-ink, inherit); }
  select:focus-visible { outline: 2px solid var(--follows-accent, #3346D3); outline-offset: 2px; }
  .note { text-align: var(--follows-note-align, center); font-size: 0.85em; line-height: 1.35; color: var(--follows-muted, #5f6470); }
  .note a { color: inherit; }
  .note:empty { display: none; }
`;

const escape = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** What went wrong, for a person. */
function problem(error) {
  const text = String(error?.message ?? error);
  if (/declined|rejected|denied|cancel/i.test(text)) return "Canceled in Selfhold. Nothing was sent.";
  if (/locked/i.test(text)) return "Unlock Selfhold, then try again.";
  // Sold or given away since it was chosen: say so, not a vague failure.
  const gone = text.match(/@[a-z0-9_]+ isn't yours/);
  if (gone) return `${gone[0]} anymore. Check, then press again.`;
  return "Couldn't save. Try again.";
}

/** The follower last chosen in this browser, where there is one. */
function chosen() {
  try {
    return localStorage.getItem("follows.as");
  } catch {
    return null;
  }
}
function choose(p) {
  try {
    localStorage.setItem("follows.as", p);
  } catch {}
}

export function defineFollowButton(graph, { tag = "follows-button", walletURL = WALLET_URL, monikerURL = MONIKER_URL, wallet = () => globalThis.lattice } = {}) {
  if (customElements.get(tag)) return;

  customElements.define(
    tag,
    class extends HTMLElement {
      static observedAttributes = ["target"];
      #drawn = 0;
      #state = "loading"; // loading | follow | following | saving
      #want = true;
      #me = null; // the account #mine was read for
      #mine = null; // the connected account's handles, once read
      #as; // the handle that follows
      #button;
      #now;
      #picker;
      #note;
      constructor() {
        super();
        const root = this.attachShadow({ mode: "open", delegatesFocus: true });
        this.#button = document.createElement("button");
        this.#button.type = "button";
        this.#now = Object.assign(document.createElement("span"), { className: "now" });
        this.#button.append(this.#now);
        this.#picker = Object.assign(document.createElement("select"), { hidden: true });
        this.#picker.setAttribute("aria-label", "Who follows");
        this.#note = Object.assign(document.createElement("span"), { className: "note" });
        this.#note.setAttribute("role", "status");
        // Who follows comes first: it is chosen before Follow is pressed.
        root.append(Object.assign(document.createElement("style"), { textContent: style }), this.#picker, this.#button, this.#note);
        this.#button.addEventListener("click", () => this.#press());
        this.#picker.addEventListener("change", () => {
          choose(this.#picker.value);
          this.#read();
        });
      }
      connectedCallback() {
        this.#read();
      }
      attributeChangedCallback() {
        if (this.isConnected) this.#read();
      }
      get #target() {
        return (this.getAttribute("target") ?? "").replace(/^@/, "");
      }
      #show(state, note = "") {
        this.#state = state;
        // While saving, the button already shows where it is going; the note says it is saving.
        const on = state === "following" || (state === "saving" && this.#want);
        const shown = ` @${this.#target}`;
        const verb = on ? "Following" : "Follow";
        this.#now.textContent = state === "loading" ? "" : `${verb}${shown}`;
        this.#button.className = `${on ? "on" : ""} ${state === "following" ? "ready" : ""} ${state === "saving" ? "saving" : ""}`;
        this.#button.dataset.unfollow = `Unfollow${shown}`;
        // The name read out begins with the words shown (WCAG 2.5.3).
        this.#button.setAttribute("aria-label", `${verb}${shown}`);
        // Never disabled: a disabled button drops keyboard focus.
        this.#button.setAttribute("aria-disabled", String(state === "loading" || state === "saving"));
        this.#button.toggleAttribute("aria-busy", state === "loading");
        this.#note.innerHTML = note;
      }
      /**
       * Whether the connected account's handle follows the target, if a
       * wallet says which account that is, and whether a change to it is
       * still saving.
       */
      async #read() {
        const ticket = ++this.#drawn;
        this.hidden = false;
        this.#show("loading");
        try {
          const target = this.#target;
          const me = await wallet()?.address?.();
          if (ticket !== this.#drawn) return;
          if (me && !(await this.#follower(me))) return;
          if (ticket !== this.#drawn) return;
          const as = this.#as;
          const following = as ? await graph.follows(as, target) : false;
          if (ticket !== this.#drawn) return;
          this.#show(following ? "following" : "follow");
          if (!as) return;
          // Then, without holding the button, whether a change to it is still saving.
          const pending = await graph.pending(me).catch(() => ({}));
          const key = `${as}/${target}`;
          if (ticket !== this.#drawn || !(key in pending) || pending[key] === following) return;
          this.#want = pending[key];
          this.#show("saving", SAVING);
          await this.#landed(ticket, as, target);
        } catch {
          if (ticket === this.#drawn) this.#show("follow", "Couldn't check whether you follow. Reload to try again.");
        }
      }
      /**
       * Which of `me`'s handles follows: its one, or the one chosen in the
       * picker. False when the button hides, on one of `me`'s own handles.
       */
      async #follower(me, { fresh = false } = {}) {
        const mine = await graph.handlesOf(me, { fresh });
        this.#me = me;
        this.#mine = mine;
        // Nobody follows themselves here: hidden on your own handles.
        if (mine.includes(this.#target)) {
          this.hidden = true;
          return false;
        }
        const picked = [this.#picker.value, chosen()].find((h) => mine.includes(h));
        this.#as = picked ?? mine[0];
        this.#picker.hidden = mine.length < 2;
        this.#picker.replaceChildren(
          ...mine.map((h) => Object.assign(document.createElement("option"), { value: h, textContent: `as @${h}`, selected: h === this.#as })),
        );
        return true;
      }
      /** Waits until the chain shows the change this button is saving, then says so. */
      async #landed(ticket, as, target) {
        const started = Date.now();
        const landed = async () => {
          await graph.state({ fresh: true });
          return (await graph.follows(as, target)) === this.#want;
        };
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          if (ticket !== this.#drawn) return;
          // A failed read is a blip, not a failed save: keep waiting.
          if (await landed().catch(() => false)) break;
          if (Date.now() - started < 3 * 60_000) continue;
          // Long enough to ask whether it is still on its way at all.
          const me = await wallet()?.address?.();
          const waiting = await graph.pending(me).then((pending) => `${as}/${target}` in pending, () => true);
          if (ticket !== this.#drawn) return;
          if (!waiting && !(await landed().catch(() => false))) {
            // Dropped before any block took it: back as it was, and free to try again.
            this.#show(this.#want ? "follow" : "following", "It didn't save. Try again.");
            return;
          }
          if (!waiting) break;
          this.#show("saving", "Still saving. This can take a few minutes.");
        }
        if (ticket !== this.#drawn) return;
        this.#show(this.#want ? "following" : "follow", "Saved.");
        setTimeout(() => {
          if (ticket === this.#drawn && this.#note.textContent === "Saved.") this.#note.textContent = "";
        }, 4000);
        this.dispatchEvent(new CustomEvent("follows:change", { bubbles: true, composed: true, detail: { target, as, following: this.#want } }));
      }
      async #press() {
        if (this.#state === "loading" || this.#state === "saving") return;
        const target = this.#target;
        if (!wallet()?.writeRecords) {
          const asked = new CustomEvent("follows:needs-wallet", { bubbles: true, composed: true, cancelable: true, detail: { target } });
          if (this.dispatchEvent(asked)) {
            this.#show(this.#state, phone()
              ? "Following needs Selfhold, a Chrome extension for computers. Open this page on a computer to follow."
              : `To follow, add <a href="${escape(walletURL)}" target="_blank" rel="noopener">Selfhold</a>, a free browser extension, then reload this page.`);
          }
          return;
        }
        const ticket = ++this.#drawn;
        this.#want = this.#state !== "following";
        const before = this.#state;
        try {
          // Selfhold answers connect only within a click: ask before any other wait.
          const me = (await wallet().address?.()) ?? (await wallet().connect());
          // Read the account's handles again on every press: Selfhold may
          // now connect another account, or a handle may have been sold.
          const known = this.#mine !== null;
          const [wasMe, wasAs] = [this.#me, this.#as];
          if (!(await this.#follower(me, { fresh: true }))) return;
          if (ticket !== this.#drawn) return;
          if (known && wasAs && this.#as && (me !== wasMe || this.#as !== wasAs)) {
            // What the button showed was for another follower: show this one's, and send nothing.
            const following = await graph.follows(this.#as, target);
            if (ticket !== this.#drawn) return;
            this.#show(following ? "following" : "follow", me !== wasMe
              ? "Selfhold is connected to another account now. Check, then press again."
              : `@${escape(wasAs)} isn't yours anymore. Check, then press again.`);
            return;
          }
          if (!this.#as) {
            // Read again on the next press: a handle may be got meanwhile.
            this.#mine = null;
            // On Moniker itself, the link stays on the page.
            this.#show(before, monikerURL.startsWith("#")
              ? `To follow, <a href="${escape(monikerURL)}">get a handle</a> first.`
              : `To follow, get a handle on <a href="${escape(monikerURL)}" target="_blank" rel="noopener">Moniker</a> first.`);
            return;
          }
          if (!known && this.#mine.length > 1) {
            this.#show(before, "Choose which handle follows, then press Follow.");
            return;
          }
          const as = this.#as;
          const sent = await (this.#want ? graph.follow(as, target, { wallet: wallet() }) : graph.unfollow(as, target, { wallet: wallet() }));
          if (ticket !== this.#drawn) return;
          if (sent === undefined) {
            // Already as asked: nothing to save.
            this.#show(this.#want ? "following" : "follow");
            return;
          }
          this.#show("saving", SAVING);
          await this.#landed(ticket, as, target);
        } catch (error) {
          // Read the account's handles again on the next press.
          if (/isn't yours/.test(String(error?.message))) this.#mine = null;
          if (ticket === this.#drawn) this.#show(before, problem(error));
        }
      }
    },
  );
}
