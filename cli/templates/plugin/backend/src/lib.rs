//! The backend half of `{{id}}`. The host ABI is documented in the SDK's crate docs and in
//! the ddd repository's `backend/HOST-ABI.md`.

use ddd_plugin_sdk as ddd;

// Required of every backend half: the host refuses a module without it.
ddd::abi_version!();

ddd::init!(init);
fn init(payload: ddd::InitPayload) -> ddd::Result<()> {
    ddd::log::info(&format!("{{id}} {} initialised", payload.version));
    Ok(())
}
