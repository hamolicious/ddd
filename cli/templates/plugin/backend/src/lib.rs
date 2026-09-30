//! The backend half of `{{id}}`. The host ABI is documented in the SDK's crate docs and in
//! the Life Manager repository's `backend/HOST-ABI.md`.

use life_manager_plugin_sdk as lm;

// Required of every backend half: the host refuses a module without it.
lm::abi_version!();

lm::init!(init);
fn init(payload: lm::InitPayload) -> lm::Result<()> {
    lm::log::info(&format!("{{id}} {} initialised", payload.version));
    Ok(())
}
