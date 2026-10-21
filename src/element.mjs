// <follows-button target="@ada"> for any page: Follow / Following for the
// account connected in the person's Selfhold wallet. A target is a name
// (`@ada`: whoever owns it) or an account address. Register it once with a
// graph from createFollows:
//
//   defineFollowButton(graph);
//   <follows-button target="@ada"></follows-button>
//
// A follow takes about a block to save: the button says "saving…" until the
// chain shows it, then says "Saved." and fires `follows:change` ({ target,
// following }). One still waiting in a node's mempool, sent from this page or
// anywhere else, shows as saving too. With no wallet it fires
// `follows:needs-wallet` ({ target }); a page that handles it
// (preventDefault) shows its own help, else the button says how to get one.
// It hides itself on the connected account's own page.
// Style it from outside with --follows-accent, --follows-accent-ink,
// --follows-ink, --follows-line, --follows-muted and --follows-width.

const WALLET_URL = "https://chromewebstore.google.com/detail/amcobhbipbblfjonmoiicihhfglkhpce";
const SAVING = "Saves in about a minute. You can leave this page.";
const phone = () => /Android|iPhone|iPad|iPod|Mobile/i.test(globalThis.navigator?.userAgent ?? "");

const style = `
  :host { display: inline-flex; flex-direction: column; align-items: center; gap: 6px; font: inherit; }
  :host([hidden]) { display: none; }
  button { box-sizing: border-box; width: var(--follows-width, 12em); max-width: 100%; min-height: 44px; padding: 0 16px;
    border-radius: 999px; font: inherit; font-weight: 700; cursor: pointer; white-space: nowrap;
    border: 1px solid transparent; background: var(--follows-accent, #3346D3); color: var(--follows-accent-ink, #fff); }
  button.on { background: transparent; color: var(--follows-ink, inherit); border-color: var(--follows-line, #c9ccd4); }
  button[aria-disabled="true"] { cursor: progress; }
  button:focus-visible { outline: 2px solid var(--follows-accent, #3346D3); outline-offset: 2px; }
  /* Under a mouse, Following offers what a press does. Drawn, not text: the name stays "Following". */
  @media (hover: hover) {
    button.on.ready:hover .now { display: none; }
    button.on.ready:hover::after { content: "Unfollow"; }
    button.on.ready:hover { border-color: currentColor; }
  }
  .note { max-width: 22em; text-align: center; font-size: 0.85em; line-height: 1.35; color: var(--follows-muted, #5f6470); }
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
        const name = this.#target;
        const on = state === "following" || (state === "saving" && this.#want);
        const [text, label] =
          state === "loading" ? ["", `Follow ${name}`]
          : state === "saving" ? (this.#want ? ["Following · saving…", `Following ${name}, saving`] : ["Unfollowing…", `Unfollowing ${name}`])
          : on ? ["Following", `Following ${name}`]
          : ["Follow", `Follow ${name}`];
        this.#now.textContent = text;
        this.#button.className = `${on ? "on" : ""} ${state === "following" ? "ready" : ""}`;
        this.#button.setAttribute("aria-label", label);
        // Never disabled: a disabled button drops keyboard focus.
        this.#button.setAttribute("aria-disabled", String(state === "loading" || state === "saving"));
        this.#button.toggleAttribute("aria-busy", state === "loading");
        this.#note.innerHTML = note;
      }
      /**
       * Whether the connected account follows the target, if a wallet says
       * which account that is, and whether a change to it is still saving.
       */
      async #read() {
        const ticket = ++this.#drawn;
        this.hidden = false;
        this.#show("loading");
        try {
          const target = this.#target;
          const me = await wallet()?.address?.();
          if (ticket !== this.#drawn) return;
          // Nobody follows themselves here.
          if (me && me === target) {
            this.hidden = true;
            return;
          }
          const [following, pending] = me ? await Promise.all([graph.follows(me, target), graph.pending(me)]) : [false, {}];
          if (ticket !== this.#drawn) return;
          if (target in pending && pending[target] !== following) {
            this.#want = pending[target];
            this.#show("saving", SAVING);
            await this.#landed(ticket, me, target);
          } else this.#show(following ? "following" : "follow");
        } catch {
          if (ticket === this.#drawn) this.#show("follow");
        }
      }
      /** Waits until the chain shows the change this button is saving, then says so. */
      async #landed(ticket, me, target) {
        const started = Date.now();
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          if (ticket !== this.#drawn) return;
          await graph.state({ fresh: true });
          if ((await graph.follows(me, target)) === this.#want) break;
          if (Date.now() - started > 3 * 60_000) this.#show("saving", "Still saving. This can take a few minutes.");
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
        this.#want = this.#state !== "following";
        const before = this.#state;
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
          if (ticket === this.#drawn) this.#show(before, problem(error));
        }
      }
    },
  );
}
