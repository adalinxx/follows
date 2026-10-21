// <follows-button target="@ada"> for any page: Follow / Following for the
// account connected in the person's Selfhold wallet. A target is a name
// (`@ada`: whoever holds it) or an account address. Register it once with a
// graph from createFollows:
//
//   defineFollowButton(graph);
//   <follows-button target="@ada"></follows-button>
//   <follows-button target="bafyrei…" label="Ada's account"></follows-button>
//
// A follow takes about a block to save: the button says "saving…" until the
// chain shows it, then fires `follows:change` ({ target, following }). One
// still waiting in a node's mempool, sent from this page or anywhere else,
// shows as saving too. With no
// wallet it fires `follows:needs-wallet` ({ target }); a page that handles it
// (preventDefault) shows its own help, else the button shows a short note.
// Style it from outside with --follows-accent, --follows-ink, --follows-line.

const WALLET_URL = "https://chromewebstore.google.com/detail/amcobhbipbblfjonmoiicihhfglkhpce";

const style = `
  :host { display: inline-flex; flex-direction: column; align-items: stretch; gap: 6px; font: inherit; }
  button { min-height: 44px; padding: 0 18px; border-radius: 999px; font: inherit; font-weight: 700; cursor: pointer;
    border: 1px solid transparent; background: var(--follows-accent, #3346D3); color: #fff; }
  button[aria-pressed="true"] { background: transparent; color: var(--follows-ink, inherit); border-color: var(--follows-line, #c9ccd4); }
  button:disabled { cursor: progress; opacity: 0.85; }
  button:focus-visible { outline: 2px solid var(--follows-accent, #3346D3); outline-offset: 2px; }
  .note { font-size: 0.85em; line-height: 1.35; color: var(--follows-muted, #5f6470); }
  .note a { color: var(--follows-accent, #3346D3); }
  .note[hidden] { display: none; }
`;

const SAVING = "Saving takes about a minute. You can leave this page.";
const escape = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** What a wallet's error says to a person. */
function message(error) {
  const text = String(error?.message ?? error);
  if (/declined|rejected|denied/i.test(text)) return "You declined it in Selfhold. Nothing was sent.";
  if (/locked/i.test(text)) return "Unlock Selfhold, then try again.";
  return text;
}

export function defineFollowButton(graph, { tag = "follows-button", walletURL = WALLET_URL, wallet = () => globalThis.lattice } = {}) {
  if (customElements.get(tag)) return;

  customElements.define(
    tag,
    class extends HTMLElement {
      static observedAttributes = ["target", "label"];
      #drawn = 0;
      #state = "loading"; // loading | follow | following | saving
      #button;
      #note;
      constructor() {
        super();
        const root = this.attachShadow({ mode: "open" });
        this.#button = document.createElement("button");
        this.#button.type = "button";
        this.#note = Object.assign(document.createElement("span"), { className: "note", hidden: true });
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
      get #name() {
        return this.getAttribute("label") ?? this.#target;
      }
      #show(state, note = "") {
        this.#state = state;
        const following = state === "following" || (state === "saving" && this.#want);
        this.#button.textContent = state === "saving" ? (this.#want ? "Following · saving…" : "Unfollowing…") : following ? "Following" : "Follow";
        this.#button.setAttribute("aria-pressed", String(following));
        this.#button.setAttribute("aria-label", `Follow ${this.#name}`);
        this.#button.disabled = state === "loading" || state === "saving";
        this.#note.hidden = !note;
        this.#note.innerHTML = note;
      }
      #want = true;
      /**
       * Whether the connected account follows the target, if a wallet says
       * which account that is, and whether a change to it is still saving.
       */
      async #read() {
        const ticket = ++this.#drawn;
        this.#show("loading");
        try {
          const target = this.#target;
          const me = await wallet()?.address?.();
          const [following, pending] = me ? await Promise.all([graph.follows(me, target), graph.pending(me)]) : [false, {}];
          if (ticket !== this.#drawn) return;
          if (target in pending && pending[target] !== following) {
            this.#want = pending[target];
            this.#show("saving", SAVING);
            await this.#landed(ticket, me, target);
          } else this.#show(following ? "following" : "follow");
        } catch (error) {
          if (ticket === this.#drawn) this.#show("follow", error?.landing ? escape(error.message) : "");
        }
      }
      /** Waits until the chain shows the change this button is saving, then says so. */
      async #landed(ticket, me, target) {
        const deadline = Date.now() + 5 * 60_000;
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          if (ticket !== this.#drawn) return;
          await graph.state({ fresh: true });
          if ((await graph.follows(me, target)) === this.#want) break;
          if (Date.now() > deadline) throw Object.assign(new Error("Sent, but it hasn't shown up yet. It may still land; check again later."), { landing: true });
        }
        if (ticket !== this.#drawn) return;
        this.#show(this.#want ? "following" : "follow");
        this.dispatchEvent(new CustomEvent("follows:change", { bubbles: true, composed: true, detail: { target, following: this.#want } }));
      }
      async #press() {
        const target = this.#target;
        if (!wallet()?.writeRecords) {
          const asked = new CustomEvent("follows:needs-wallet", { bubbles: true, composed: true, cancelable: true, detail: { target } });
          if (this.dispatchEvent(asked)) {
            this.#show(this.#state, `To follow, add <a href="${walletURL}" target="_blank" rel="noopener">Selfhold</a>, a free browser extension that keeps your account. Then reload this page.`);
          }
          return;
        }
        const ticket = ++this.#drawn;
        this.#want = this.#state !== "following";
        try {
          // Selfhold answers connect only within a click: ask before any other wait.
          const me = (await wallet().address?.()) ?? (await wallet().connect());
          const sent = await (this.#want ? graph.follow(target, { wallet: wallet() }) : graph.unfollow(target, { wallet: wallet() }));
          if (ticket !== this.#drawn) return;
          if (sent === undefined) {
            // Already as asked: nothing to save.
            this.#show(this.#want ? "following" : "follow");
            return;
          }
          this.#show("saving", SAVING);
          await this.#landed(ticket, me, target);
        } catch (error) {
          if (ticket !== this.#drawn) return;
          this.#show(this.#want ? "follow" : "following", escape(error?.landing ? error.message : message(error)));
        }
      }
    },
  );
}
