// <follows-button target="@ada"> for any page: Follow / Following for a
// person, followed by the account connected in the person's Selfhold
// wallet. `target` is a handle (with or without @) or an account address.
// Register it once with a graph from createFollows:
//
//   defineFollowButton(graph);
//   <follows-button target="@ada"></follows-button>
//   <follows-button target="bafyrei…"></follows-button>
//
// It says whom it follows, "Follow @ada", when they show a handle, and
// follows that handle; for someone with none it says "Follow" and follows
// their account. No handle is needed to follow. It hides on the connected
// account itself.
//
// A follow takes about a block to save: the button shows the new state at
// once, and its note says it is saving until the chain shows it, then
// "Saved."; then it fires `follows:change` ({ target, following }). One
// still waiting in a node's mempool, sent from this page or anywhere else,
// shows as saving too. With no wallet it fires `follows:needs-wallet`
// ({ target }); a page that handles it (preventDefault) shows its own help,
// else the button says how to get one.
// Style it from outside with --follows-accent, --follows-accent-ink,
// --follows-ink, --follows-line, --follows-muted, --follows-width and
// --follows-note-align.

const WALLET_URL = "https://chromewebstore.google.com/detail/amcobhbipbblfjonmoiicihhfglkhpce";
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
  return "Couldn't save. Try again.";
}

export function defineFollowButton(graph, { tag = "follows-button", walletURL = WALLET_URL, wallet = () => globalThis.lattice } = {}) {
  if (customElements.get(tag)) return;

  customElements.define(
    tag,
    class extends HTMLElement {
      static observedAttributes = ["target"];
      #drawn = 0;
      #state = "loading"; // loading | follow | following | saving
      #want = true;
      #me = null; // the account the button was read for
      #who = null; // whom the target names: { account, handle } or { handle }
      #button;
      #now;
      #note;
      constructor() {
        super();
        const root = this.attachShadow({ mode: "open", delegatesFocus: true });
        this.#button = document.createElement("button");
        this.#button.type = "button";
        this.#now = Object.assign(document.createElement("span"), { className: "now" });
        this.#button.append(this.#now);
        this.#note = Object.assign(document.createElement("span"), { className: "note" });
        this.#note.setAttribute("role", "status");
        root.append(Object.assign(document.createElement("style"), { textContent: style }), this.#button, this.#note);
        this.#button.addEventListener("click", () => this.#press());
      }
      connectedCallback() {
        this.#read();
      }
      attributeChangedCallback() {
        if (this.isConnected) this.#read();
      }
      get #target() {
        return this.getAttribute("target") ?? "";
      }
      #show(state, note = "") {
        this.#state = state;
        // While saving, the button already shows where it is going; the note says it is saving.
        const on = state === "following" || (state === "saving" && this.#want);
        const shown = this.#who?.handle === undefined ? "" : ` @${this.#who.handle}`;
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
      /** The keys a change to this person's follow is saved under: their account and their handle. */
      #forms() {
        return [this.#who?.account, this.#who?.handle === undefined ? undefined : `@${this.#who.handle}`].filter(Boolean);
      }
      /** Whether a change to this follow waits in a mempool, and which way: true, false, or undefined. */
      async #waiting(me) {
        const pending = await graph.pending(me).catch(() => ({}));
        const found = this.#forms().filter((t) => t in pending);
        return found.length === 0 ? undefined : found.some((t) => pending[t]);
      }
      /**
       * Whom the target names, and whether the connected account follows
       * them, if a wallet says which account that is, and whether a change
       * to it is still saving.
       */
      async #read() {
        const ticket = ++this.#drawn;
        this.hidden = false;
        this.#show("loading");
        try {
          const [who, me] = await Promise.all([graph.person(this.#target), wallet()?.address?.()]);
          if (ticket !== this.#drawn) return;
          this.#who = who;
          this.#me = me ?? null;
          // Nobody follows themselves here.
          if (me && who.account === me) {
            this.hidden = true;
            return;
          }
          const following = me ? await graph.follows(me, this.#target) : false;
          if (ticket !== this.#drawn) return;
          this.#show(following ? "following" : "follow");
          if (!me) return;
          // Then, without holding the button, whether a change to it is still saving.
          const waiting = await this.#waiting(me);
          if (ticket !== this.#drawn || waiting === undefined || waiting === following) return;
          this.#want = waiting;
          this.#show("saving", SAVING);
          await this.#landed(ticket, me);
        } catch {
          if (ticket === this.#drawn) this.#show("follow", "Couldn't check whether you follow. Reload to try again.");
        }
      }
      /** Waits until the chain shows the change this button is saving, then says so. */
      async #landed(ticket, me) {
        const target = this.#target;
        const started = Date.now();
        const landed = async () => {
          await graph.state({ fresh: true });
          return (await graph.follows(me, target)) === this.#want;
        };
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          if (ticket !== this.#drawn) return;
          // A failed read is a blip, not a failed save: keep waiting.
          if (await landed().catch(() => false)) break;
          if (Date.now() - started < 3 * 60_000) continue;
          // Long enough to ask whether it is still on its way at all.
          const waiting = await this.#waiting(me).then((w) => w !== undefined, () => true);
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
        this.dispatchEvent(new CustomEvent("follows:change", { bubbles: true, composed: true, detail: { target, following: this.#want } }));
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
        const before = this.#state;
        try {
          // Selfhold answers connect only within a click: ask before any other wait.
          const me = (await wallet().address?.()) ?? (await wallet().connect());
          if (ticket !== this.#drawn) return;
          if (this.#me !== null && me !== this.#me) {
            // What the button showed was for another account: show this one's, and send nothing.
            this.#me = me;
            if (this.#who?.account === me) {
              this.hidden = true;
              return;
            }
            const following = await graph.follows(me, target);
            if (ticket !== this.#drawn) return;
            this.#show(following ? "following" : "follow", "Selfhold is connected to another account now. Check, then press again.");
            return;
          }
          if (this.#me === null) {
            // Connected just now: show where this account stands before changing anything.
            this.#me = me;
            if (this.#who?.account === me) {
              this.hidden = true;
              return;
            }
            if (await graph.follows(me, target)) {
              if (ticket === this.#drawn) this.#show("following");
              return;
            }
          }
          this.#want = before !== "following";
          const sent = await (this.#want ? graph.follow(target, { wallet: wallet() }) : graph.unfollow(target, { wallet: wallet() }));
          if (ticket !== this.#drawn) return;
          if (sent === undefined) {
            // Already as asked: nothing to save.
            this.#show(this.#want ? "following" : "follow");
            return;
          }
          this.#show("saving", SAVING);
          await this.#landed(ticket, me);
        } catch (error) {
          if (ticket === this.#drawn) this.#show(before, problem(error));
        }
      }
    },
  );
}
