//! The `life-manager reset-password --email …` break-glass path (SPEC §5.1).
//!
//! This is the recovery route when no admin can sign in. It needs the database,
//! not an HTTP server, so it runs the whole command and exits — `main.rs` only
//! forwards to [`reset_password`].

use anyhow::{Context, anyhow};

use super::{audit, reset};
use crate::config::Config;
use crate::domain::Actor;
use crate::state::AppState;

/// Issue a one-time reset token for `email` and print it.
///
/// Prints to stdout on purpose: the operator running the command is the delivery
/// channel. The token is never logged through `tracing` (log aggregation would
/// then hold a live credential).
pub async fn reset_password(config: Config, email: &str) -> anyhow::Result<()> {
    let state = AppState::new(config)
        .await
        .context("connecting to MongoDB for the reset-password command")?;

    let user = reset::user_by_email(&state, email)
        .await?
        .ok_or_else(|| anyhow!("no account with email {email}"))?;

    let (issued, token) = reset::issue(&state, &user.id, Some(&Actor::System)).await?;

    audit::record_simple(
        &state,
        "user.password_reset_issue",
        Some(&Actor::System),
        audit::TARGET_USER,
        Some(user.id.clone()),
        None,
    )
    .await;

    println!("Reset token issued for {} ({})", user.email, user.id);
    println!("Expires at: {}", issued.expires_at);
    println!();
    println!("{token}");
    println!();
    println!("Redeem it once, then it is dead:");
    println!(
        "  curl -X POST <base-url>/api/auth/password/reset \\\n    \
         -H 'Content-Type: application/json' \\\n    \
         -d '{{\"token\":\"{token}\",\"new_password\":\"<new password>\"}}'"
    );

    Ok(())
}
