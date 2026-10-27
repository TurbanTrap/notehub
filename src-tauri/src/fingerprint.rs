//! Content fingerprints: a short string that says which version of a file we saw.
//!
//! Two things rely on these. A save compares the fingerprint the editor loaded with
//! the one on disk now, and refuses to overwrite a file that has moved on. The folder
//! watcher compares the fingerprint of a changed file with what this app last wrote
//! there, so it can tell a sync client's write apart from its own.
//!
//! SHA-256 rather than something cheap and cheerful: a collision here would mean
//! deciding a file had not changed when it had, and quietly writing over an edit that
//! arrived from the other machine. That is the exact failure this module exists to
//! prevent, so the hash should not be the weak link. Notes are a few kilobytes, so the
//! cost does not show up next to the disk write that follows.

use sha2::{Digest, Sha256};
use std::path::Path;

pub fn of_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest.iter() {
        // Hand-rolled rather than pulling in a hex crate for four lines.
        out.push(nibble(byte >> 4));
        out.push(nibble(byte & 0x0f));
    }
    out
}

/// The fingerprint of a file's contents, or `None` if it could not be read — which
/// for our callers means "not there", and is never treated as "unchanged".
pub fn of_file(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|bytes| of_bytes(&bytes))
}

fn nibble(value: u8) -> char {
    char::from_digit(value as u32, 16).unwrap_or('0')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_answer_for_the_empty_input() {
        // The published SHA-256 of zero bytes; catches a hex-formatting slip as much
        // as a wrong algorithm.
        assert_eq!(
            of_bytes(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn a_single_changed_character_changes_the_fingerprint() {
        assert_ne!(of_bytes(b"mov eax, 1"), of_bytes(b"mov eax, 2"));
    }

    #[test]
    fn same_bytes_give_the_same_fingerprint() {
        assert_eq!(of_bytes(b"xor eax, eax"), of_bytes(b"xor eax, eax"));
    }

    #[test]
    fn is_lowercase_hex_of_the_expected_length() {
        let hash = of_bytes(b"anything");
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }

    #[test]
    fn a_missing_file_has_no_fingerprint() {
        assert!(of_file(Path::new("/nope/not/here.md")).is_none());
    }
}
