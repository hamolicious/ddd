mod new;
mod types;

use clap::Subcommand;

#[derive(Subcommand)]
pub enum PluginCommand {
    New(new::NewArgs),
    Types(types::TypesArgs),
}

impl PluginCommand {
    pub fn run(self) -> anyhow::Result<()> {
        match self {
            PluginCommand::New(args) => new::run(args),
            PluginCommand::Types(args) => types::run(args),
        }
    }
}

pub fn is_valid_plugin_id(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= 64
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::is_valid_plugin_id;

    #[test]
    fn plugin_ids_follow_the_manifest_format() {
        assert!(is_valid_plugin_id("my-plugin"));
        assert!(is_valid_plugin_id("0day"));
        assert!(!is_valid_plugin_id(""));
        assert!(!is_valid_plugin_id("-lead"));
        assert!(!is_valid_plugin_id("Upper"));
        assert!(!is_valid_plugin_id("under_score"));
        assert!(!is_valid_plugin_id(&"a".repeat(65)));
    }
}
