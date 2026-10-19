//! dropcode's PAKE module: a thin, allocation-light C ABI over
//! RustCrypto's `spake2` (Ed25519 group, asymmetric A/B roles).
//!
//! The module imports nothing from its host. Randomness is supplied by the
//! host (Web Crypto `getRandomValues` in browsers, `crypto/rand` in Go) as a
//! 32-byte seed for a ChaCha20 CSPRNG that is used once per handshake.
//!
//! Exports:
//!   pake_alloc(len) -> ptr            pake_free(ptr, len)
//!   pake_start(side, pw, pw_len, id_a, id_a_len, id_b, id_b_len, seed32, out33) -> handle | -1
//!   pake_finish(handle, msg, msg_len, out32) -> 0 | -1     (consumes the handle)
//!   pake_drop(handle)

use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use spake2::{Ed25519Group, Identity, Password, Spake2};
use std::cell::RefCell;

pub const MSG_LEN: usize = 33;
pub const KEY_LEN: usize = 32;
const MAX_INPUT: usize = 1024;
const MAX_HANDLES: usize = 64;

thread_local! {
    static STATES: RefCell<Vec<Option<Spake2<Ed25519Group>>>> = RefCell::new(Vec::new());
}

unsafe fn slice<'a>(ptr: *const u8, len: usize) -> Option<&'a [u8]> {
    if len > MAX_INPUT || (ptr.is_null() && len > 0) {
        return None;
    }
    Some(if len == 0 { &[] } else { std::slice::from_raw_parts(ptr, len) })
}

#[no_mangle]
pub extern "C" fn pake_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` must come from `pake_alloc(len)`.
#[no_mangle]
pub unsafe extern "C" fn pake_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        // Wipe before freeing: buffers may have held the password or key.
        std::ptr::write_bytes(ptr, 0, len.max(1));
        drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
    }
}

/// Start a handshake. `side` is 0 for A (sender) and 1 for B (receiver).
/// Writes the 33-byte outbound message to `out` and returns a handle.
///
/// # Safety
/// All pointers must be valid for their lengths; `seed` for 32 bytes, `out` for 33.
#[no_mangle]
pub unsafe extern "C" fn pake_start(
    side: u32,
    pw: *const u8,
    pw_len: usize,
    id_a: *const u8,
    id_a_len: usize,
    id_b: *const u8,
    id_b_len: usize,
    seed: *const u8,
    out: *mut u8,
) -> i32 {
    let (Some(pw), Some(id_a), Some(id_b), Some(seed)) =
        (slice(pw, pw_len), slice(id_a, id_a_len), slice(id_b, id_b_len), slice(seed, 32))
    else {
        return -1;
    };
    if out.is_null() || seed.len() != 32 {
        return -1;
    }
    let mut seed_arr = [0u8; 32];
    seed_arr.copy_from_slice(seed);
    let rng = ChaCha20Rng::from_seed(seed_arr);
    seed_arr.fill(0);
    let (pw, a, b) = (Password::new(pw), Identity::new(id_a), Identity::new(id_b));
    let (state, msg) = match side {
        0 => Spake2::<Ed25519Group>::start_a_with_rng(&pw, &a, &b, rng),
        1 => Spake2::<Ed25519Group>::start_b_with_rng(&pw, &a, &b, rng),
        _ => return -1,
    };
    if msg.len() != MSG_LEN {
        return -1;
    }
    std::ptr::copy_nonoverlapping(msg.as_ptr(), out, MSG_LEN);
    STATES.with(|s| {
        let mut s = s.borrow_mut();
        if let Some(i) = s.iter().position(|x| x.is_none()) {
            s[i] = Some(state);
            i as i32
        } else if s.len() < MAX_HANDLES {
            s.push(Some(state));
            (s.len() - 1) as i32
        } else {
            -1
        }
    })
}

/// Finish a handshake with the peer's message. Writes the 32-byte shared key
/// to `out`. Returns 0 on success, -1 on any error (bad handle, malformed or
/// reflected message). The handle is consumed either way.
///
/// # Safety
/// `msg` must be valid for `msg_len` bytes and `out` for 32 bytes.
#[no_mangle]
pub unsafe extern "C" fn pake_finish(handle: i32, msg: *const u8, msg_len: usize, out: *mut u8) -> i32 {
    let Some(state) = take(handle) else { return -1 };
    let Some(msg) = slice(msg, msg_len) else { return -1 };
    if out.is_null() {
        return -1;
    }
    match state.finish(msg) {
        Ok(key) if key.len() == KEY_LEN => {
            std::ptr::copy_nonoverlapping(key.as_ptr(), out, KEY_LEN);
            0
        }
        _ => -1,
    }
}

#[no_mangle]
pub extern "C" fn pake_drop(handle: i32) {
    take(handle);
}

fn take(handle: i32) -> Option<Spake2<Ed25519Group>> {
    if handle < 0 {
        return None;
    }
    STATES.with(|s| s.borrow_mut().get_mut(handle as usize).and_then(|x| x.take()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(pw_a: &[u8], pw_b: &[u8]) -> (i32, i32, [u8; 32], [u8; 32]) {
        let (ia, ib) = (b"dropcode-sender", b"dropcode-receiver");
        let (mut ma, mut mb) = ([0u8; 33], [0u8; 33]);
        unsafe {
            let ha = pake_start(0, pw_a.as_ptr(), pw_a.len(), ia.as_ptr(), ia.len(), ib.as_ptr(), ib.len(), [1u8; 32].as_ptr(), ma.as_mut_ptr());
            let hb = pake_start(1, pw_b.as_ptr(), pw_b.len(), ia.as_ptr(), ia.len(), ib.as_ptr(), ib.len(), [2u8; 32].as_ptr(), mb.as_mut_ptr());
            let (mut ka, mut kb) = ([0u8; 32], [0u8; 32]);
            let ra = pake_finish(ha, mb.as_ptr(), 33, ka.as_mut_ptr());
            let rb = pake_finish(hb, ma.as_ptr(), 33, kb.as_mut_ptr());
            (ra, rb, ka, kb)
        }
    }

    #[test]
    fn same_password_same_key() {
        let (ra, rb, ka, kb) = run(b"4-apple-river", b"4-apple-river");
        assert_eq!((ra, rb), (0, 0));
        assert_eq!(ka, kb);
    }

    #[test]
    fn wrong_password_different_key() {
        let (ra, rb, ka, kb) = run(b"4-apple-river", b"4-apple-rivet");
        assert_eq!((ra, rb), (0, 0));
        assert_ne!(ka, kb);
    }

    #[test]
    fn reflected_message_rejected() {
        let (ia, ib) = (b"a", b"b");
        let mut m = [0u8; 33];
        unsafe {
            let h = pake_start(0, b"pw".as_ptr(), 2, ia.as_ptr(), 1, ib.as_ptr(), 1, [3u8; 32].as_ptr(), m.as_mut_ptr());
            let mut k = [0u8; 32];
            assert_eq!(pake_finish(h, m.as_ptr(), 33, k.as_mut_ptr()), -1);
            assert_eq!(pake_finish(h, m.as_ptr(), 33, k.as_mut_ptr()), -1, "handle is single-use");
        }
    }
}
