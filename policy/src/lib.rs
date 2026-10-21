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
//! transaction that writes `follows/` writes its `followers/` twin directly
//! after, to the same new value, or deletes both. The chain starts with
//! neither, so the two always agree, and the policy reads each pair once.
//! Values mean nothing else to the chain.
//!
//! Coin actions pass untouched.
#![cfg_attr(not(test), no_std)]

use lattice_policy_rules::{is_address, transaction_body, Body};

lattice_policy_rules::lattice_policy_abi!(crate::validate);

/// The verdict for one policy context, with `scratch` for the signer tree.
/// Anything malformed is a rejection.
pub fn validate(context: &[u8], scratch: &mut [u32]) -> bool {
    transaction_body(context).and_then(|body| check_body(body, scratch)).is_some()
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

fn check_body(bytes: &[u8], scratch: &mut [u32]) -> Option<()> {
    let body = Body::parse(bytes)?;
    let signers = body.signers(scratch)?;
    let mut actions = body.actions()?;
    while let Some(action) = actions.next() {
        let action = action?;
        let follow = parse(action.key)?;
        if !follow.by_follower {
            return None;
        }
        signers.is_signer(follow.account)?;
        let twin = actions.next()??;
        let same = parse(twin.key)? == Follow { by_follower: false, ..follow } && twin.new_value == action.new_value;
        same.then_some(())?;
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
