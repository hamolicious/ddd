use std::sync::OnceLock;

use argon2::password_hash::Error as PhcError;
use argon2::{Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version};

use super::PasswordError;

pub const MEMORY_KIB: u32 = 19_456;
pub const TIME_COST: u32 = 2;
pub const PARALLELISM: u32 = 1;
pub const MIN_LENGTH: usize = 10;
pub const MAX_LENGTH: usize = 1024;

fn hasher() -> Result<&'static Argon2<'static>, PasswordError> {
    static HASHER: OnceLock<Option<Argon2<'static>>> = OnceLock::new();
    HASHER
        .get_or_init(|| {
            Params::new(MEMORY_KIB, TIME_COST, PARALLELISM, None)
                .ok()
                .map(|params| Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
        })
        .as_ref()
        .ok_or(PasswordError::Hashing)
}

pub fn hash(password: &str) -> Result<String, PasswordError> {
    let hashed = hasher()?
        .hash_password(password.as_bytes())
        .map_err(|_| PasswordError::Hashing)?;
    Ok(hashed.to_string())
}

pub fn verify(password: &str, phc: &str) -> Result<bool, PasswordError> {
    let parsed = PasswordHash::new(phc).map_err(|_| PasswordError::MalformedHash)?;
    match hasher()?.verify_password(password.as_bytes(), &parsed) {
        Ok(()) => Ok(true),
        Err(PhcError::PasswordInvalid) => Ok(false),
        Err(_) => Err(PasswordError::MalformedHash),
    }
}

pub fn verify_dummy(password: &str) {
    static DUMMY: OnceLock<Option<String>> = OnceLock::new();
    let dummy = DUMMY.get_or_init(|| hash("dummy-password-for-timing-equalization").ok());
    if let Some(phc) = dummy {
        let _ = verify(password, phc);
    }
}

pub fn validate(password: &str) -> Result<(), PasswordError> {
    if password.chars().count() < MIN_LENGTH {
        return Err(PasswordError::TooShort { min: MIN_LENGTH });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_parameters_match_the_spec() {
        let params = Params::new(MEMORY_KIB, TIME_COST, PARALLELISM, None).expect("valid params");
        assert_eq!(params.m_cost(), 19_456);
        assert_eq!(params.t_cost(), 2);
        assert_eq!(params.p_cost(), 1);
    }

    #[test]
    fn hash_roundtrip() {
        let phc = hash("correct-horse-battery").expect("hashing works");
        assert!(phc.starts_with("$argon2id$v=19$"), "unexpected PHC: {phc}");
        assert!(phc.contains("m=19456"), "memory cost not in hash: {phc}");
        assert!(phc.contains("t=2"), "time cost not in hash: {phc}");
        assert!(phc.contains("p=1"), "parallelism not in hash: {phc}");

        assert!(verify("correct-horse-battery", &phc).expect("verify works"));
        assert!(!verify("correct-horse-batterz", &phc).expect("verify works"));
    }

    #[test]
    fn hashes_are_salted() {
        let a = hash("the-same-password").expect("hashing works");
        let b = hash("the-same-password").expect("hashing works");
        assert_ne!(a, b, "two hashes of one password must differ (random salt)");
        assert!(verify("the-same-password", &a).expect("verify works"));
        assert!(verify("the-same-password", &b).expect("verify works"));
    }

    #[test]
    fn malformed_stored_hash_is_an_error() {
        assert!(matches!(
            verify("whatever", "not-a-phc-string"),
            Err(PasswordError::MalformedHash)
        ));
        assert!(matches!(
            verify("whatever", ""),
            Err(PasswordError::MalformedHash)
        ));
    }

    #[test]
    fn policy_enforces_minimum_length() {
        assert!(matches!(
            validate("short"),
            Err(PasswordError::TooShort { min: 10 })
        ));
        assert!(validate("0123456789").is_ok());
        assert!(matches!(
            validate("ééééé"),
            Err(PasswordError::TooShort { min: 10 })
        ));
        assert!(validate("éééééééééé").is_ok());
    }
}
