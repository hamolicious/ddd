//! The top-level command groups. Each group owns its subcommands and their arguments.

mod login;
mod plugin;
mod query;

use clap::Subcommand;

#[derive(Subcommand)]
pub enum Command {
    /// Create and maintain plugin projects.
    #[command(subcommand)]
    Plugin(plugin::PluginCommand),
    /// Query a workspace's documents: `--filter title:text_contains:a --sort fm.key`.
    Query(query::QueryArgs),
    /// Sign in to a server and print a bearer token for `ddd query`.
    Login(login::LoginArgs),
}

impl Command {
    pub fn run(self) -> anyhow::Result<()> {
        match self {
            Command::Plugin(command) => command.run(),
            Command::Query(args) => query::run(args),
            Command::Login(args) => login::run(args),
        }
    }
}
