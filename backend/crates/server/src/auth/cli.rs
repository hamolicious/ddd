use anyhow::{Context, anyhow};

use super::{audit, reset};
use crate::config::Config;
use crate::domain::Actor;
use crate::state::AppState;

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
