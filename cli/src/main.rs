//! `lm` — developer tooling for Life Manager.
//!
//! Commands are grouped by the thing they act on (`lm plugin new`, `lm plugin types`), one
//! module per group under `commands/`. A new job is a new variant in [`commands::Command`]
//! (or in a group's own enum) plus the module that implements it; nothing else changes.

mod commands;
mod repo;
mod scaffold;
mod server;

use std::process::ExitCode;

use clap::Parser;

#[derive(Parser)]
#[command(name = "lm", version, about = "Developer tooling for Life Manager")]
struct Cli {
    #[command(subcommand)]
    command: commands::Command,
}

fn main() -> ExitCode {
    match Cli::parse().command.run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error:#}");
            ExitCode::FAILURE
        }
    }
}
