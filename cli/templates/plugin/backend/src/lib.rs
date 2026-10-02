use ddd_plugin_sdk as ddd;

ddd::abi_version!();

ddd::init!(init);
fn init(payload: ddd::InitPayload) -> ddd::Result<()> {
    ddd::log::info(&format!("{{id}} {} initialised", payload.version));
    Ok(())
}
