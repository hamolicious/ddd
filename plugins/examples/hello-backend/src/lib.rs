//! The smallest legal backend plugin, and the host's fixture.
//!
//! It exists to answer one question with a build rather than an opinion: *does a plugin
//! written against `life-manager-plugin-sdk` compile to `wasm32-unknown-unknown` and load
//! in the server's Extism host?* `crates/server/tests/pluginhost_smoke.rs` builds this
//! crate, instantiates it with the real host-function set, and calls every export;
//! `crates/server/tests/pluginhost_runtime.rs` loads it in the **real** host and drives the
//! limits, the breaker and the capability gates through it.
//!
//! It is also the shortest thing to read when you are about to write a real one — up to
//! `dispatch`, which is a test harness rather than an example: everything after `"runs"`
//! exists so the host's tests can reach a code path they otherwise could not, and the
//! comment on each says which one.

use life_manager_plugin_sdk as lm;

// Required of every backend half. The host refuses a module without it.
lm::abi_version!();

/// What `lm_init` was told, remembered **per instance** in a static.
///
/// The realistic shape of the pattern HOST-ABI.md §4.1 exists for: a plugin caches the approved
/// capability set once and degrades deliberately, rather than discovering denials per call. It is
/// also what makes "`lm_init` ran on this instance" observable to a host test — the host used to
/// skip it on the instance activation warmed, so the first call of every plugin saw this as
/// `None` and a real plugin silently ran with its defaults.
static INITIALISED: std::sync::Mutex<Option<lm::abi::Capabilities>> = std::sync::Mutex::new(None);

lm::init!(init);
fn init(payload: lm::InitPayload) -> lm::Result<()> {
    lm::log::info(&format!(
        "hello-backend {} initialised (documents:read={})",
        payload.version,
        payload.capabilities.can_read_documents()
    ));
    if let Ok(mut slot) = INITIALISED.lock() {
        *slot = Some(payload.capabilities);
    }
    Ok(())
}

lm::cron!(tick);
fn tick(schedule: lm::abi::cron::CronPayload) -> lm::Result<()> {
    // KV needs no capability, so this works in a plugin with none at all — the
    // cron-and-KV plugin SPEC §6.3 names as the archetype.
    let runs: u64 = lm::kv::get::<u64>("runs")?.unwrap_or(0) + 1;
    lm::kv::set("runs", &runs)?;
    lm::log::info(&format!(
        "tick {} for `{}` (missed {})",
        runs, schedule.expression, schedule.missed
    ));
    Ok(())
}

lm::calls!(dispatch);
fn dispatch(call: lm::abi::call::CallPayload) -> lm::Result<serde_json::Value> {
    match call.function.as_str() {
        // The smoke test asserts on this: it proves input reaches the plugin and a value
        // comes back through the envelope.
        "echo" => Ok(call.payload),
        "runs" => Ok(serde_json::json!(lm::kv::get::<u64>("runs")?.unwrap_or(0))),

        // What `lm_init` left behind on *this* instance. The host test for "the first call runs
        // on an initialised instance" reads this; a plugin that got no `lm_init` reports
        // `initialised: false` and an empty grant, which is exactly the silent degradation the
        // promise exists to prevent.
        "caps" => {
            let recorded = INITIALISED.lock().ok().and_then(|slot| slot.clone());
            Ok(serde_json::json!({
                "initialised": recorded.is_some(),
                "documents": recorded
                    .as_ref()
                    .map(|caps| caps.documents.clone())
                    .unwrap_or_default(),
                "http_hosts": recorded
                    .as_ref()
                    .map(|caps| caps.http_hosts.clone())
                    .unwrap_or_default(),
            }))
        }

        // ---- from here on: paths the host's own tests need to reach ----

        // What does a capability the plugin does not have actually *return*? SPEC §6.2
        // says a refusal, never a trap, and this reports the code so a test can assert it
        // rather than inferring it from a crash.
        "probe" => {
            let target = call.payload.get("host_fn").and_then(|v| v.as_str());
            let code = match target {
                Some("get_document") => {
                    code_of(lm::documents::get_metadata("01J0000000000000000000000O"))
                }
                Some("query_documents") => code_of(lm::documents::query(
                    &lm::abi::documents::QueryDocumentsInput::default(),
                )),
                Some("create_document") => {
                    code_of(lm::documents::create("---\ntitle: probe\n---\n"))
                }
                Some("http_request") => code_of(lm::http::get("https://example.test/")),
                Some("config_get") => code_of(lm::config::all()),
                Some("kv_get") => code_of(lm::kv::get::<serde_json::Value>("probe")),
                other => {
                    return Err(lm::HostError::new(
                        lm::ErrorCode::InvalidArgument,
                        format!("probe does not know `{other:?}`"),
                    ));
                }
            };
            Ok(serde_json::json!(code))
        }

        // The write paths, so the host's document host functions are exercised by a real
        // plugin rather than by a unit test calling them directly.
        "create" => {
            let text = call
                .payload
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("---\ntitle: from hello-backend\n---\n");
            let written = lm::documents::create(text)?;
            Ok(serde_json::json!({ "id": written.id, "title": written.title }))
        }
        "splice" => {
            let id = require_str(&call.payload, "id")?;
            let key = require_str(&call.payload, "key")?;
            let value = call
                .payload
                .get("value")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let out = lm::documents::set_section(&id, &key, value)?;
            Ok(serde_json::json!({
                "edits_applied": out.edits_applied,
                "changed": out.changed,
            }))
        }
        "rewrite" => {
            let id = require_str(&call.payload, "id")?;
            let text = require_str(&call.payload, "text")?;
            let out = lm::documents::rewrite(&id, &text)?;
            Ok(serde_json::json!({ "id": out.id, "title": out.title }))
        }
        "read" => {
            let id = require_str(&call.payload, "id")?;
            let doc = lm::documents::get(&id)?;
            Ok(serde_json::json!({
                "title": doc.title,
                "content": doc.content,
                "created_by": doc.created_by,
                "plugins": doc.plugins,
            }))
        }

        // Outbound HTTP, so the host's allowlist, IP policy, pinning, redirect re-check and
        // response cap can be driven from the outside rather than asserted about.
        "fetch" => {
            let url = require_str(&call.payload, "url")?;
            let mut headers = lm::abi::JsonMap::new();
            if let Some(extra) = call.payload.get("headers").and_then(|v| v.as_object()) {
                for (name, value) in extra {
                    headers.insert(name.clone(), value.clone());
                }
            }
            let response = lm::http::get_with_headers(&url, headers)?;
            Ok(serde_json::json!({
                "status": response.status(),
                "headers": response.0.headers,
                "body_bytes": response.0.body_bytes,
                "final_url": response.0.final_url,
                // A test asserting on the *stripped* headers needs the names, and one
                // asserting on the body needs the text.
                "body": response.text().unwrap_or_default(),
            }))
        }

        // `call_plugin`'s three refusals need a plugin that makes the call.
        "call" => {
            let plugin = require_str(&call.payload, "plugin")?;
            let function = require_str(&call.payload, "function")?;
            let value: serde_json::Value = lm::plugins::call(
                &plugin,
                &function,
                &call
                    .payload
                    .get("payload")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )?;
            Ok(value)
        }

        // The log-line cap: 150 lines against a cap of 100, so a test can see that the
        // extra ones are dropped and the call still succeeds.
        "log_flood" => {
            for line in 0..150u32 {
                lm::log::info(&format!("flood {line}"));
            }
            Ok(serde_json::json!("logged"))
        }

        // A trap. `panic = "abort"` in this workspace's release profile turns it into an
        // `unreachable`, which is what the host must count on the breaker and what must
        // poison the instance rather than being reused.
        "trap" => panic!("hello-backend was asked to trap"),

        // A Wasm loop that never returns to the host — the only case the host's own
        // deadline logic cannot see, and therefore the one that proves the epoch
        // interruption works. `black_box` keeps the optimiser from removing it.
        "spin" => {
            let mut spun = 0u64;
            loop {
                spun = std::hint::black_box(spun.wrapping_add(1));
            }
        }

        // Bounded work with many Wasm instruction boundaries in it, for the host test that
        // a *sibling* call timing out must not trap this one.
        //
        // Extism cancellation is engine-wide (`engine.increment_epoch()` trips every store on
        // it), so while all of a plugin's instances shared one engine, one call hitting its
        // deadline trapped every other call of the same plugin at its next instruction — mid
        // write, misreported as a trap rather than a timeout, and counted on the breaker. A
        // test for that needs a call that is *still running* when the sibling is cancelled and
        // that finishes cleanly if nothing interferes; `steps` is how long it runs.
        "busy" => {
            let steps = call
                .payload
                .get("steps")
                .and_then(|value| value.as_u64())
                .unwrap_or(200);
            let mut spun = 0u64;
            for step in 0..steps {
                // A host call per step, so the loop is interruptible at many points and its
                // duration is dominated by real work rather than by the optimiser.
                let _: Option<u64> = lm::kv::get("runs")?;
                for _ in 0..50_000u32 {
                    spun = std::hint::black_box(spun.wrapping_add(step));
                }
            }
            Ok(serde_json::json!({ "steps": steps }))
        }

        other => Err(lm::HostError::new(
            lm::ErrorCode::NotFound,
            format!("hello-backend has no function `{other}`"),
        )),
    }
}

/// The error code of a call, or `"ok"` — so a test can assert on a refusal instead of on a
/// message.
fn code_of<T>(result: lm::Result<T>) -> &'static str {
    match result {
        Ok(_) => "ok",
        Err(error) => error.code.as_str(),
    }
}

fn require_str(payload: &serde_json::Value, key: &str) -> lm::Result<String> {
    payload
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| {
            lm::HostError::new(
                lm::ErrorCode::InvalidArgument,
                format!("`{key}` is missing or not a string"),
            )
        })
}

lm::http_routes!(route);
fn route(request: lm::abi::http::HttpRouteRequest) -> lm::Result<lm::abi::http::HttpRouteResponse> {
    // `/refuse` answers with a refusal rather than a status, so the host's route dispatcher
    // can be checked on the path where a plugin's own error code becomes the HTTP status.
    if request.path == "/refuse" {
        return Err(lm::HostError::new(
            lm::ErrorCode::NotFound,
            "hello-backend has nothing at /refuse",
        ));
    }
    // A response a plugin is not allowed to send: `set-cookie` must be stripped on the way
    // out, or a plugin could mint a session for this origin.
    if request.path == "/cookie" {
        let mut headers = lm::abi::JsonMap::new();
        headers.insert(
            "set-cookie".to_string(),
            serde_json::Value::String("lm_session=forged".to_string()),
        );
        headers.insert(
            "x-from-plugin".to_string(),
            serde_json::Value::String("yes".to_string()),
        );
        return Ok(lm::abi::http::HttpRouteResponse {
            status: 200,
            headers,
            body_base64: None,
        });
    }
    Ok(lm::abi::http::HttpRouteResponse::json(
        200,
        &serde_json::json!({
            "method": request.method,
            "path": request.path,
            "public": request.public,
            "user": request.user.map(|user| user.id),
            // The host strips `cookie` and `authorization` on the way in; echoing the header
            // names back is how a test sees that they are gone.
            "headers": request.headers.keys().cloned().collect::<Vec<_>>(),
        }),
    ))
}

lm::hook_document_changed!(on_changed);
fn on_changed(event: lm::abi::hooks::DocumentEvent) -> lm::Result<()> {
    // `origin` is never this plugin — the host does not deliver a plugin its own changes.
    lm::log::debug(&format!(
        "document {} changed at seq {} ({:?})",
        event.id, event.seq, event.origin
    ));
    Ok(())
}
