// Apps keep no key: every write goes to the person's wallet through
// `window.lattice.writeRecords`, which shows it, picks the nonce, signs with
// the connected account and sends it.

/** The wallet request for `actions` on `chainPath`. */
export function writeRequest(chainPath, { actions }, fee) {
  if (actions.length === 0) throw new Error("Nothing to write");
  return { chainPath: [...chainPath], actions, fee: String(fee) };
}

/**
 * The same write as a transaction body signed for by `owner`, who pays the
 * fee: for scripts and tests that hold a key themselves.
 */
export function transaction({ owner, actions, fee, nonce, chainPath }) {
  return {
    accountActions: fee > 0n ? [{ owner, delta: -fee }] : [],
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [owner],
    nonce,
    chainPath: [...chainPath],
  };
}
