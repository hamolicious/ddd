mod login;
mod plugin;
mod query;

use clap::Subcommand;

#[derive(Subcommand)]
pub enum Command {
    #[command(subcommand)]
    Plugin(plugin::PluginCommand),
    Query(query::QueryArgs),
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
