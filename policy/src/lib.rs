//! Transaction-scope validity policy for Follows, the follow graph Lattice
//! apps share.
//!
//! A profile follows a profile. Profiles live on Moniker, the profile chain:
//! an account owns them, and may name admins who act as one. A follow of
//! profile `<t>` by profile `<p>`, written by account `<a>`, is two keys, so
//! that both ends read by prefix:
//!
//! - `follows/<p>/<t>/<a>`: what `<p>` follows.
//! - `followers/<t>/<p>/<a>`: who follows `<t>`.
//!
//! `<a>` is an account address and must sign: only an account writes or
//! deletes its own keys. `<p>` and `<t>` are profile ids, 16 characters of
//! `a`–`z` and `2`–`7`. This chain can't see Moniker, so it can't check that
//! `<a>` acts for `<p>`: readers count a follow only while it does. A
//! transaction that writes one key writes its twin to the same new value, or
//! deletes both. The chain starts with neither, so the two always agree.
//! Values mean nothing else to the chain.
//!
//! Coin actions pass untouched.
#![cfg_attr(not(test), no_std)]

use lattice_policy_rules::{is_address, transaction_body, Body};

lattice_policy_rules::lattice_policy_abi!(crate::validate);

/// The verdict for one policy context. Anything malformed is a rejection.
pub fn validate(context: &[u8]) -> bool {
    transaction_body(context).and_then(check_body).is_some()
}

/// A follow key read: which profile follows which, written by which account,
/// and which of the two keys it is.
#[derive(PartialEq)]
struct Follow<'a> {
    follower: &'a [u8],
    followed: &'a [u8],
    account: &'a [u8],
    by_follower: bool,
}

fn check_body(bytes: &[u8]) -> Option<()> {
    let body = Body::parse(bytes)?;
    for action in body.actions()? {
        let action = action?;
        let follow = parse(action.key)?;
        body.is_signer(follow.account)?;
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
    let by_follower = match segments.next()? {
        b"follows" => true,
        b"followers" => false,
        _ => return None,
    };
    let (first, second, account) = (segments.next()?, segments.next()?, segments.next()?);
    let (follower, followed) = if by_follower { (first, second) } else { (second, first) };
    let well_formed = segments.next().is_none() && is_profile(follower) && is_profile(followed) && is_address(account);
    well_formed.then_some(Follow { follower, followed, account, by_follower })
}

/// A Moniker profile id: 16 characters of `a`–`z` and `2`–`7`.
fn is_profile(text: &[u8]) -> bool {
    text.len() == 16 && text.iter().all(|&byte| matches!(byte, b'a'..=b'z' | b'2'..=b'7'))
}
