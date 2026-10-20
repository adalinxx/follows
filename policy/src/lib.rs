//! Transaction-scope validity policy for Follows, the follow graph Lattice
//! apps share.
//!
//! One shape of key: `user/<a>/follows/<b>`, present while `<a>` follows
//! `<b>`. Both are account addresses, and `<a>` must sign: only an account
//! writes or deletes its own follows. Values mean nothing to the chain.
//!
//! Coin actions pass untouched.
#![cfg_attr(not(test), no_std)]

use lattice_policy_rules::{is_address, transaction_body, Action, Body};

lattice_policy_rules::lattice_policy_abi!(crate::validate);

/// The verdict for one policy context. Anything malformed is a rejection.
pub fn validate(context: &[u8]) -> bool {
    transaction_body(context).and_then(check_body).is_some()
}

fn check_body(bytes: &[u8]) -> Option<()> {
    let body = Body::parse(bytes)?;
    for action in body.actions()? {
        check_follow(&body, &action?)?;
    }
    Some(())
}

fn check_follow(body: &Body, action: &Action) -> Option<()> {
    let mut segments = action.key.split(|&byte| byte == b'/');
    let (user, follower, follows, followed) = (segments.next()?, segments.next()?, segments.next()?, segments.next()?);
    if user != b"user" || follows != b"follows" || segments.next().is_some() || !is_address(followed) {
        return None;
    }
    body.is_signer(follower)
}
