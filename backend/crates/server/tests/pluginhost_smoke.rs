use std::collections::BTreeMap;
use std::path::PathBuf;

use ddd_plugin_abi as abi;
use extism::{Function, Manifest, PluginBuilder, UserData, ValType, Wasm};
use serde_json::{Value, json};

fn fixture() -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../plugins/target/wasm32-unknown-unknown/release/hello_backend.wasm");
    path.exists().then_some(path)
}

#[derive(Debug, Default, Clone)]
struct FakeHost {
    kv: BTreeMap<String, Value>,
    logs: Vec<String>,
    calls: Vec<String>,
}

type Shared = UserData<FakeHost>;

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

    for name in [
        abi::names::GET_DOCUMENT,
        abi::names::QUERY_DOCUMENTS,
        abi::names::QUERY,
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

fn load(shared: &Shared) -> extism::Plugin {
    let path = fixture().expect("checked by the caller");
    let manifest = Manifest::new([Wasm::file(path)])
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

fn value_of(raw: &str) -> Value {
    let envelope: Value = serde_json::from_str(raw).expect("the export answered with JSON");
    assert_eq!(
        envelope["ok"],
        json!(true),
        "expected a successful envelope, got {raw}"
    );
    envelope.get("value").cloned().unwrap_or(Value::Null)
}

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
        .expect("ddd_abi_version is required of every backend half");
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
        .expect("ddd_call");
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
            .expect("ddd_cron");
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
        .expect("ddd_http");
    let response = value_of(&raw);
    assert_eq!(response["status"], json!(200));

    let body = abi::http::base64_decode(response["body_base64"].as_str().expect("a body"))
        .expect("base64");
    let body: Value = serde_json::from_slice(&body).expect("JSON body");
    assert_eq!(body["path"], json!("/webhook"));
    assert_eq!(body["public"], json!(true));
}
