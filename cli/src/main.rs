mod commands;
mod repo;
mod scaffold;
mod server;

use std::process::ExitCode;

use clap::Parser;

#[derive(Parser)]
#[command(name = "ddd", version, about = "Developer tooling for ddd")]
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
