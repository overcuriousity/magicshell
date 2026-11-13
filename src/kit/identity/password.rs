use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};

use crate::kit::error::OcError;

fn argon() -> Result<Argon2<'static>, OcError> {
    let params = Params::new(19_456, 2, 1, None).map_err(OcError::internal)?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

pub fn hash(secret: &str) -> Result<String, OcError> {
    let salt = SaltString::generate(&mut OsRng);
    Ok(argon()?.hash_password(secret.as_bytes(), &salt).map_err(OcError::internal)?.to_string())
}

pub fn verify(secret: &str, stored: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(stored) else {
        return false;
    };
    argon().is_ok_and(|a| a.verify_password(secret.as_bytes(), &parsed).is_ok())
}

/// A hash of a random value, verified against when the user is unknown so timing does not reveal it.
pub(crate) fn dummy_hash() -> &'static str {
    static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DUMMY.get_or_init(|| hash("dummy-password-for-timing").unwrap_or_default())
}

pub fn generate(len: usize) -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::rng();
    (0..len).map(|_| char::from(ALPHABET[rng.random_range(0..ALPHABET.len())])).collect()
}

/// Argon2 costs tens of milliseconds of CPU, so it runs off the async worker threads.
pub async fn hash_blocking(secret: &str) -> Result<String, OcError> {
    let secret = secret.to_owned();
    tokio::task::spawn_blocking(move || hash(&secret)).await.map_err(OcError::internal)?
}

/// With no stored hash it still verifies against a dummy, so timing does not reveal the account.
pub async fn verify_blocking(secret: &str, stored: Option<&str>) -> bool {
    let secret = secret.to_owned();
    let (stored, real) = match stored {
        Some(h) => (h.to_owned(), true),
        None => (dummy_hash().to_owned(), false),
    };
    tokio::task::spawn_blocking(move || verify(&secret, &stored) && real).await.unwrap_or(false)
}
