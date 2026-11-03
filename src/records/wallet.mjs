// Apps keep no key: every write goes to the person's wallet through
// `writeRecords`, which shows it, picks the nonce and the fee, signs with
// the connected account and sends it.

/** The wallet request for `actions` on `chainPath`; a `fee` given is proposed, else the wallet pays what the hosts ask. */
export function writeRequest(chainPath, { actions }, fee) {
  if (actions.length === 0) throw new Error("Nothing to write");
  return { chainPath: [...chainPath], actions, ...(fee !== undefined && { fee: String(fee) }) };
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
