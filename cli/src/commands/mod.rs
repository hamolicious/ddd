//! The top-level command groups. Each group owns its subcommands and their arguments.

mod plugin;

use clap::Subcommand;

#[derive(Subcommand)]
pub enum Command {
    /// Create and maintain plugin projects.
    #[command(subcommand)]
    Plugin(plugin::PluginCommand),
}

impl Command {
    pub fn run(self) -> anyhow::Result<()> {
        match self {
            Command::Plugin(command) => command.run(),
        }
    }
}
