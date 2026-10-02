use std::io::BufRead;

use anyhow::{Context, Result, bail};
use clap::Args;

use crate::server::Server;

#[derive(Args)]
pub struct LoginArgs {
    #[arg(long, env = "DDD_SERVER")]
    server: Option<String>,
    #[arg(long)]
    email: String,
}

pub fn run(args: LoginArgs) -> Result<()> {
    let Some(url) = args.server.as_deref() else {
        bail!("which server? pass --server <url> or set DDD_SERVER");
    };
    eprint!("password for {}: ", args.email);
    let mut password = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut password)
        .context("reading the password from standard input")?;
    let password = password.trim_end_matches(['\r', '\n']);

    let answer = Server::new(url).post_json(
        "/api/auth/login",
        &serde_json::json!({ "email": args.email, "password": password, "bearer": true }),
        None,
    )?;
    let Some(token) = answer["token"].as_str() else {
        bail!("the server signed you in but sent no token");
    };
    eprintln!("signed in; set DDD_TOKEN to this (it is shown once):");
    println!("{token}");
    Ok(())
}
