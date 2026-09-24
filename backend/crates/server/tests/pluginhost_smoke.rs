//! Does a plugin written against `life-manager-plugin-sdk` actually load and run?
//!
//! This suite answers that with a build and a call rather than an opinion, and it is the
//! one M4 test that needs neither Mongo nor a router: a **minimal** Extism host, the real
//! `hello-backend` module, and the real ABI types on both sides.
//!
//! What it pins, and why each one has been a real mistake in a plugin system before:
//!
//! 1. **The module instantiates with the host-function set registered by name.** A typo in
//!    an import name is an instantiation failure with an opaque message; here it is a named
//!    assertion.
//! 2. **`lm_abi_version` answers the version this server speaks.** The host's independent
//!    re-check of a stale `.wasm` (SPEC §6.4) is only as good as the export being there.
//! 3. **Input reaches the plugin and a value comes back through the envelope** (`lm_call`
//!    `echo`), so the JSON-in/JSON-out contract is verified end to end rather than assumed.
//! 4. **Host functions work in both directions** — `lm_cron` reads KV, writes KV and logs,
//!    and the second run sees the first run's value.
//! 5. **A plugin's refusal is a successful call with `ok: false`** (`lm_call` on an unknown
//!    function), which is the distinction the circuit breaker depends on.
//!
//! Run it after building the fixture:
//!
//! ```text
//! mise run plugin-smoke      # builds plugins/examples/hello-backend, then runs this
//! ```
//!
//! With no built fixture the suite **skips** with a message rather than failing, so a clean
//! checkout of the Rust workspace stays green without the wasm toolchain — the same
//! contract the Mongo-backed suites use for `MONGO_URI`.

use std::collections::BTreeMap;
use std::path::PathBuf;

use extism::{Function, Manifest, PluginBuilder, UserData, ValType, Wasm};
use life_manager_plugin_abi as abi;
use serde_json::{Value, json};

/// Where `mise run wasm-plugins` leaves the fixture.
fn fixture() -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../plugins/target/wasm32-unknown-unknown/release/hello_backend.wasm");
    path.exists().then_some(path)
}

/// The miniature host: what every host function did, and the KV it wrote.
#[derive(Debug, Default, Clone)]
struct FakeHost {
    kv: BTreeMap<String, Value>,
    logs: Vec<String>,
    calls: Vec<String>,
}

/// Extism's own `UserData` is the sharing mechanism — it already wraps the value in a
/// reference-counted mutex, so a second layer of `Arc<Mutex<…>>` would only add a lock the
/// test has to remember to take in the right order.
type Shared = UserData<FakeHost>;

/// One host function: read the JSON handle, answer with an envelope handle.
///
/// This is deliberately the same shape the real host uses (`crates/server/src/pluginhost/
/// host_fns.rs`): one `i64` in, one `i64` out, a refusal is a value and never a trap.
fn host_fn<F>(name: &'static str, shared: Shared, body: F) -> Function
where
    F: Fn(&mut FakeHost, Value) -> Result<Value, abi::HostError> + Send + Sync + 'static,
{
    Function::new(
        name,
        [ValType::I64],
        [ValType::I64],
        shared,
        move |plugin, inputs, outputs, user| {
            let raw: String = plugin.memory_get_val(&inputs[0])?;
            let shared = user.get()?;
            let mut host = shared.lock().expect("fake host poisoned");
            host.calls.push(name.to_string());

            let envelope = match serde_json::from_str::<Value>(&raw) {
                Ok(input) => match body(&mut host, input) {
                    Ok(value) => json!({ "ok": true, "value": value }),
                    Err(error) => json!({ "ok": false, "error": error }),
                },
                Err(err) => json!({
                    "ok": false,
                    "error": { "code": "invalid_argument", "message": err.to_string() }
                }),
            };
            drop(host);

            let handle = plugin.memory_new(envelope.to_string())?;
            outputs[0] = plugin.memory_to_val(handle);
            Ok(())
        },
    )
}

/// Every host function the ABI defines, so instantiation cannot fail on a missing import
/// whatever the plugin happens to reference.
fn functions(shared: &Shared) -> Vec<Function> {
    let mut functions = Vec::new();

    functions.push(host_fn(
        abi::names::KV_GET,
        shared.clone(),
        |host, input| {
            let key = input["key"].as_str().unwrap_or_default().to_string();
            let found = host.kv.get(&key).cloned();
            Ok(json!({ "key": key, "value": found, "found": found.is_some() }))
        },
    ));

    functions.push(host_fn(
        abi::names::KV_SET,
        shared.clone(),
        |host, input| {
            let key = input["key"].as_str().unwrap_or_default().to_string();
            let existed = host.kv.contains_key(&key);
            if input["remove"].as_bool().unwrap_or(false) {
                host.kv.remove(&key);
            } else {
                host.kv.insert(key.clone(), input["value"].clone());
            }
            Ok(json!({ "key": key, "existed": existed, "keys": host.kv.len() }))
        },
    ));

    functions.push(host_fn(abi::names::LOG, shared.clone(), |host, input| {
        host.logs.push(format!(
            "{}: {}",
            input["level"].as_str().unwrap_or("info"),
            input["message"].as_str().unwrap_or_default()
        ));
        Ok(Value::Null)
    }));

    // The rest answer `capability_denied`, which is exactly what the real host's erroring
    // stubs do for a plugin without the capability (SPEC §6.2) — and `hello-backend`
    // declares none of them, so this is the faithful behaviour, not a shortcut.
    for name in [
        abi::names::GET_DOCUMENT,
        abi::names::QUERY_DOCUMENTS,
        abi::names::CREATE_DOCUMENT,
        abi::names::SPLICE_SECTION,
        abi::names::REWRITE_DOCUMENT,
        abi::names::CONFIG_GET,
        abi::names::EMIT,
        abi::names::EMIT_CLIENT,
        abi::names::CALL_PLUGIN,
        abi::names::HTTP_REQUEST,
    ] {
        functions.push(host_fn(name, shared.clone(), move |_host, _input| {
            Err(abi::HostError::capability_denied(name))
        }));
    }

    functions
}

/// Build the plugin, with the limits the real host applies.
fn load(shared: &Shared) -> extism::Plugin {
    let path = fixture().expect("checked by the caller");
    let manifest = Manifest::new([Wasm::file(path)])
        // No `allowed_hosts`: the PDK's built-in HTTP must refuse, because outbound
        // requests are the *host's* business (allowlist, IP policy, pinning).
        .with_memory_max(u32::try_from(abi::limits::MEMORY_BYTES / (64 * 1024)).unwrap())
        .with_timeout(std::time::Duration::from_millis(
            abi::limits::CALL_TIMEOUT_MS,
        ));

    PluginBuilder::new(manifest)
        .with_wasi(false)
        .with_functions(functions(shared))
        .build()
        .expect("the hello-backend module should instantiate")
}

/// Unwrap an envelope the way the real host does.
fn value_of(raw: &str) -> Value {
    let envelope: Value = serde_json::from_str(raw).expect("the export answered with JSON");
    assert_eq!(
        envelope["ok"],
        json!(true),
        "expected a successful envelope, got {raw}"
    );
    envelope.get("value").cloned().unwrap_or(Value::Null)
}

/// A copy of what the host recorded, so assertions never hold its lock.
fn snapshot(shared: &Shared) -> FakeHost {
    shared
        .get()
        .expect("user data")
        .lock()
        .expect("fake host poisoned")
        .clone()
}

fn skip() -> bool {
    if fixture().is_none() {
        eprintln!(
            "skipping: plugins/target/wasm32-unknown-unknown/release/hello_backend.wasm \
             is not built — run `mise run wasm-plugins`"
        );
        return true;
    }
    false
}

#[test]
fn the_module_reports_the_abi_version_this_server_speaks() {
    if skip() {
        return;
    }
    let shared: Shared = UserData::new(FakeHost::default());
    let mut plugin = load(&shared);

    let raw: String = plugin
        .call(abi::names::ABI_VERSION, "")
        .expect("lm_abi_version is required of every backend half");
    assert_eq!(value_of(&raw), json!(abi::ABI_VERSION));
}

#[test]
fn a_payload_reaches_the_plugin_and_a_value_comes_back() {
    if skip() {
        return;
    }
    let shared: Shared = UserData::new(FakeHost::default());
    let mut plugin = load(&shared);

    let payload = json!({
        "function": "echo",
        "payload": { "hello": "world", "n": 7 },
        "caller": "test",
        "depth": 1,
        "deadline_ms": 5000
    });
    let raw: String = plugin
        .call(abi::names::CALL, payload.to_string())
        .expect("lm_call");
    assert_eq!(value_of(&raw), json!({ "hello": "world", "n": 7 }));
}

#[test]
fn a_plugin_refusal_is_a_successful_call_with_an_error_envelope() {
    if skip() {
        return;
    }
    let shared: Shared = UserData::new(FakeHost::default());
    let mut plugin = load(&shared);

    let payload = json!({
        "function": "nope",
        "payload": null,
        "caller": "test",
        "depth": 1,
        "deadline_ms": 5000
    });
    // The Extism call succeeds — that is the point. A refusal must not be a trap, or the
    // instance would be poisoned and the circuit breaker would count a working plugin's
    // honest "no" as a failure.
    let raw: String = plugin
        .call(abi::names::CALL, payload.to_string())
        .expect("a refusal is still a successful call");
    let envelope: Value = serde_json::from_str(&raw).expect("JSON");
    assert_eq!(envelope["ok"], json!(false));
    assert_eq!(envelope["error"]["code"], json!("not_found"));
}

#[test]
fn host_functions_work_in_both_directions_across_two_calls() {
    if skip() {
        return;
    }
    let shared: Shared = UserData::new(FakeHost::default());
    let mut plugin = load(&shared);

    let cron = json!({
        "expression": "*/15 * * * *",
        "index": 0,
        "scheduled_for": "2026-09-24T06:00:00Z",
        "fired_at": "2026-09-24T06:00:01Z",
        "last_run": null,
        "missed": 0,
        "deadline_ms": 60000
    });

    for expected in 1..=2u64 {
        let raw: String = plugin
            .call(abi::names::CRON, cron.to_string())
            .expect("lm_cron");
        assert_eq!(value_of(&raw), Value::Null, "a cron run returns no value");

        let host = snapshot(&shared);
        assert_eq!(
            host.kv.get("runs"),
            Some(&json!(expected)),
            "the plugin should have read its own previous value and incremented it"
        );
    }

    let host = snapshot(&shared);
    assert!(
        host.logs.iter().any(|line| line.contains("tick 2")),
        "the plugin's log line should reach the host: {:?}",
        host.logs
    );
    assert!(
        host.calls.iter().any(|call| call == abi::names::KV_GET),
        "kv_get should have been called"
    );
}

#[test]
fn an_http_route_answers_through_the_envelope() {
    if skip() {
        return;
    }
    let shared: Shared = UserData::new(FakeHost::default());
    let mut plugin = load(&shared);

    let request = json!({
        "method": "POST",
        "path": "/webhook",
        "query": {},
        "headers": {},
        "body_base64": null,
        "public": true,
        "user": null,
        "request_id": "01JREQUEST"
    });
    let raw: String = plugin
        .call(abi::names::HTTP, request.to_string())
        .expect("lm_http");
    let response = value_of(&raw);
    assert_eq!(response["status"], json!(200));

    let body = abi::http::base64_decode(response["body_base64"].as_str().expect("a body"))
        .expect("base64");
    let body: Value = serde_json::from_slice(&body).expect("JSON body");
    assert_eq!(body["path"], json!("/webhook"));
    assert_eq!(body["public"], json!(true));
}
