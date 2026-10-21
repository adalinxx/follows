//! Transaction-scope validity policy for Follows, the follow graph Lattice
//! apps share.
//!
//! An account follows a target: another account, by its address, or a name,
//! a Moniker handle written `@<h>`, which means whoever holds it. A follow of
//! `<t>` by account `<a>` is two keys, so that both ends read by prefix:
//!
//! - `user/<a>/follows/<t>`: what `<a>` follows.
//! - `followers/<t>/<a>`: who follows `<t>`.
//!
//! `<a>` is an account address and must sign: only an account writes or
//! deletes its own follows. `<h>` is a handle as Moniker spells them,
//! lowercase letters, digits and `_`; who holds it is Moniker's business, not
//! this chain's. A transaction that writes one key writes its twin to the same
//! new value, or deletes both. The chain starts with neither, so the two
//! always agree. Values mean nothing else to the chain.
//!
//! Coin actions pass untouched.
#![cfg_attr(not(test), no_std)]

use lattice_policy_rules::{is_address, transaction_body, Body};

lattice_policy_rules::lattice_policy_abi!(crate::validate);

/// The verdict for one policy context. Anything malformed is a rejection.
pub fn validate(context: &[u8]) -> bool {
    transaction_body(context).and_then(check_body).is_some()
}

/// A follow key read: which account follows what, and which of the two keys
/// it is.
#[derive(PartialEq)]
struct Follow<'a> {
    follower: &'a [u8],
    followed: &'a [u8],
    by_follower: bool,
}

fn check_body(bytes: &[u8]) -> Option<()> {
    let body = Body::parse(bytes)?;
    for action in body.actions()? {
        let action = action?;
        let follow = parse(action.key)?;
        body.is_signer(follow.follower)?;
        let twin = Follow { by_follower: !follow.by_follower, ..follow };
        let mut paired = false;
        for other in body.actions()? {
            let other = other?;
            if parse(other.key).is_some_and(|key| key == twin) {
                if other.new_value != action.new_value {
                    return None;
                }
                paired = true;
            }
        }
        if !paired {
            return None;
        }
    }
    Some(())
}

fn parse(key: &[u8]) -> Option<Follow<'_>> {
    let mut segments = key.split(|&byte| byte == b'/');
    let follow = match segments.next()? {
        b"user" => {
            let follower = segments.next()?;
            if segments.next()? != b"follows" {
                return None;
            }
            Follow { follower, followed: segments.next()?, by_follower: true }
        }
        b"followers" => {
            let followed = segments.next()?;
            Follow { follower: segments.next()?, followed, by_follower: false }
        }
        _ => return None,
    };
    // The follower must sign, so it is an address.
    let well_formed = segments.next().is_none() && (is_address(follow.followed) || is_name(follow.followed));
    well_formed.then_some(follow)
}

/// `@` and a handle: lowercase letters, digits and `_`.
fn is_name(text: &[u8]) -> bool {
    matches!(text, [b'@', handle @ ..] if !handle.is_empty() && handle.iter().all(|&byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_')))
}
