//! Non-Windows workspace encryption. Only the key is kept in the OS keyring;
//! SQLite and automatic backups retain authenticated ciphertext.
use ring::{aead, rand::{SecureRandom, SystemRandom}};

const NONCE_LENGTH: usize = 12;
const CONTEXT: &[u8] = b"reqmas:system-keyring-aes256gcm-v1";

fn crypt(bytes: &[u8], decrypt: bool, key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let key = aead::UnboundKey::new(&aead::AES_256_GCM, key)
        .map(aead::LessSafeKey::new).map_err(|_| "Unable to initialize workspace encryption")?;
    if decrypt {
        if bytes.len() < NONCE_LENGTH + aead::AES_256_GCM.tag_len() {
            return Err("Workspace secret ciphertext is truncated".into());
        }
        let nonce: [u8; NONCE_LENGTH] = bytes[..NONCE_LENGTH].try_into().unwrap();
        let mut plaintext = bytes[NONCE_LENGTH..].to_vec();
        let length = key.open_in_place(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(CONTEXT), &mut plaintext)
            .map_err(|_| "Unable to authenticate a workspace secret. Restore an exported backup if the key was lost.")?.len();
        plaintext.truncate(length);
        Ok(plaintext)
    } else {
        let mut nonce = [0; NONCE_LENGTH];
        SystemRandom::new().fill(&mut nonce).map_err(|_| "Unable to generate a secure workspace nonce")?;
        let mut ciphertext = bytes.to_vec();
        key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::from(CONTEXT), &mut ciphertext)
            .map_err(|_| "Unable to encrypt a workspace secret")?;
        let mut result = nonce.to_vec();
        result.extend(ciphertext);
        Ok(result)
    }
}

#[cfg(all(not(test), any(target_os = "macos", target_os = "linux")))]
pub fn protect_bytes(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use std::sync::Mutex;
    use zeroize::Zeroizing;
    // Workspace commands are serialized already. This also serializes OS keyring
    // access and keeps errors retryable (a locked keyring can be unlocked later).
    static KEY: Mutex<Option<Zeroizing<[u8; 32]>>> = Mutex::new(None);
    let mut cached = KEY.lock().map_err(|_| "Workspace encryption is busy")?;
    if cached.is_none() {
        let entry = keyring::Entry::new("com.reqdesk.desktop", "workspace-key-v1")
            .map_err(|_| "Unable to access the system keyring")?;
        let secret = match entry.get_secret() {
            Ok(secret) => Zeroizing::new(secret),
            Err(keyring::Error::NoEntry) if !decrypt => {
                let mut secret = Zeroizing::new(vec![0; 32]);
                SystemRandom::new().fill(&mut secret).map_err(|_| "Unable to generate a secure workspace key")?;
                entry.set_secret(&secret).map_err(|_| "Unable to save the workspace key. Unlock macOS Keychain or the Linux Secret Service keyring, then retry.")?;
                secret
            }
            Err(keyring::Error::NoEntry) => return Err("The workspace encryption key is missing. Restore a JSON backup exported with Include secrets; copying SQLite between computers does not transfer the key.".into()),
            Err(_) => return Err("Unable to read the workspace key. Unlock macOS Keychain or the Linux Secret Service keyring, then retry.".into()),
        };
        if secret.len() != 32 { return Err("The workspace key is invalid; it was not replaced. Restore an exported backup.".into()); }
        let mut key = Zeroizing::new([0; 32]);
        key.copy_from_slice(&secret);
        *cached = Some(key);
    }
    crypt(bytes, decrypt, cached.as_ref().unwrap())
}

// Headless unit tests never read or modify a user's Keychain/Secret Service.
#[cfg(all(test, not(windows)))]
pub fn protect_bytes(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    crypt(bytes, decrypt, &[42; 32])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticated_encryption_round_trips_empty_unicode_and_large_values() {
        for bytes in [Vec::new(), "secret-demo-😀".as_bytes().to_vec(), vec![7; 100_000]] {
            let ciphertext = crypt(&bytes, false, &[1; 32]).unwrap();
            assert_eq!(crypt(&ciphertext, true, &[1; 32]).unwrap(), bytes);
            assert_ne!(ciphertext, bytes);
        }
    }
    #[test]
    fn unique_nonces_and_wrong_keys_or_tampering_are_rejected() {
        let first = crypt(b"demo", false, &[1; 32]).unwrap();
        let second = crypt(b"demo", false, &[1; 32]).unwrap();
        assert_ne!(first[..NONCE_LENGTH], second[..NONCE_LENGTH]);
        assert!(crypt(&first, true, &[2; 32]).is_err());
        for index in [0, NONCE_LENGTH, first.len() - 1] {
            let mut tampered = first.clone(); tampered[index] ^= 1;
            assert!(crypt(&tampered, true, &[1; 32]).is_err());
        }
        for length in [0, 11, 12, 27] { assert!(crypt(&first[..length], true, &[1; 32]).is_err()); }
    }
}
