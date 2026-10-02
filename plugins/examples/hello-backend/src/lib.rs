use ddd_plugin_sdk as ddd;

ddd::abi_version!();

static INITIALISED: std::sync::Mutex<Option<ddd::abi::Capabilities>> = std::sync::Mutex::new(None);

ddd::init!(init);
fn init(payload: ddd::InitPayload) -> ddd::Result<()> {
    ddd::log::info(&format!(
        "hello-backend {} initialised (documents:read={})",
        payload.version,
        payload.capabilities.can_read_documents()
    ));
    if let Ok(mut slot) = INITIALISED.lock() {
        *slot = Some(payload.capabilities);
    }
    Ok(())
}

ddd::cron!(tick);
fn tick(schedule: ddd::abi::cron::CronPayload) -> ddd::Result<()> {
    let runs: u64 = ddd::kv::get::<u64>("runs")?.unwrap_or(0) + 1;
    ddd::kv::set("runs", &runs)?;
    ddd::log::info(&format!(
        "tick {} for `{}` (missed {})",
        runs, schedule.expression, schedule.missed
    ));
    Ok(())
}

ddd::calls!(dispatch);
fn dispatch(call: ddd::abi::call::CallPayload) -> ddd::Result<serde_json::Value> {
    match call.function.as_str() {
        "echo" => Ok(call.payload),
        "runs" => Ok(serde_json::json!(ddd::kv::get::<u64>("runs")?.unwrap_or(0))),

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

        "probe" => {
            let target = call.payload.get("host_fn").and_then(|v| v.as_str());
            let code = match target {
                Some("get_document") => {
                    code_of(ddd::documents::get_metadata("01J0000000000000000000000O"))
                }
                Some("query_documents") => code_of(ddd::documents::query(
                    &ddd::abi::documents::QueryDocumentsInput::default(),
                )),
                Some("query") => code_of(ddd::documents::run(
                    ddd::documents::Query::new()
                        .filter("title", ddd::documents::Op::TextContains, "probe")
                        .sort("fm.key")
                        .limit(5),
                )),
                Some("create_document") => {
                    code_of(ddd::documents::create("---\ntitle: probe\n---\n"))
                }
                Some("http_request") => code_of(ddd::http::get("https://example.test/")),
                Some("config_get") => code_of(ddd::config::all()),
                Some("kv_get") => code_of(ddd::kv::get::<serde_json::Value>("probe")),
                other => {
                    return Err(ddd::HostError::new(
                        ddd::ErrorCode::InvalidArgument,
                        format!("probe does not know `{other:?}`"),
                    ));
                }
            };
            Ok(serde_json::json!(code))
        }

        "create" => {
            let text = call
                .payload
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("---\ntitle: from hello-backend\n---\n");
            let written = ddd::documents::create(text)?;
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
            let out = ddd::documents::set_section(&id, &key, value)?;
            Ok(serde_json::json!({
                "edits_applied": out.edits_applied,
                "changed": out.changed,
            }))
        }
        "rewrite" => {
            let id = require_str(&call.payload, "id")?;
            let text = require_str(&call.payload, "text")?;
            let out = ddd::documents::rewrite(&id, &text)?;
            Ok(serde_json::json!({ "id": out.id, "title": out.title }))
        }
        "read" => {
            let id = require_str(&call.payload, "id")?;
            let doc = ddd::documents::get(&id)?;
            Ok(serde_json::json!({
                "title": doc.title,
                "content": doc.content,
                "created_by": doc.created_by,
                "plugins": doc.plugins,
            }))
        }

        "fetch" => {
            let url = require_str(&call.payload, "url")?;
            let mut headers = ddd::abi::JsonMap::new();
            if let Some(extra) = call.payload.get("headers").and_then(|v| v.as_object()) {
                for (name, value) in extra {
                    headers.insert(name.clone(), value.clone());
                }
            }
            let response = ddd::http::get_with_headers(&url, headers)?;
            Ok(serde_json::json!({
                "status": response.status(),
                "headers": response.0.headers,
                "body_bytes": response.0.body_bytes,
                "final_url": response.0.final_url,
                "body": response.text().unwrap_or_default(),
            }))
        }

        "call" => {
            let plugin = require_str(&call.payload, "plugin")?;
            let function = require_str(&call.payload, "function")?;
            let value: serde_json::Value = ddd::plugins::call(
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

        "log_flood" => {
            for line in 0..150u32 {
                ddd::log::info(&format!("flood {line}"));
            }
            Ok(serde_json::json!("logged"))
        }

        "trap" => panic!("hello-backend was asked to trap"),

        "spin" => {
            let mut spun = 0u64;
            loop {
                spun = std::hint::black_box(spun.wrapping_add(1));
            }
        }

        "busy" => {
            let steps = call
                .payload
                .get("steps")
                .and_then(|value| value.as_u64())
                .unwrap_or(200);
            let mut spun = 0u64;
            for step in 0..steps {
                let _: Option<u64> = ddd::kv::get("runs")?;
                for _ in 0..50_000u32 {
                    spun = std::hint::black_box(spun.wrapping_add(step));
                }
            }
            Ok(serde_json::json!({ "steps": steps }))
        }

        other => Err(ddd::HostError::new(
            ddd::ErrorCode::NotFound,
            format!("hello-backend has no function `{other}`"),
        )),
    }
}

fn code_of<T>(result: ddd::Result<T>) -> &'static str {
    match result {
        Ok(_) => "ok",
        Err(error) => error.code.as_str(),
    }
}

fn require_str(payload: &serde_json::Value, key: &str) -> ddd::Result<String> {
    payload
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| {
            ddd::HostError::new(
                ddd::ErrorCode::InvalidArgument,
                format!("`{key}` is missing or not a string"),
            )
        })
}

ddd::http_routes!(route);
fn route(
    request: ddd::abi::http::HttpRouteRequest,
) -> ddd::Result<ddd::abi::http::HttpRouteResponse> {
    if request.path == "/refuse" {
        return Err(ddd::HostError::new(
            ddd::ErrorCode::NotFound,
            "hello-backend has nothing at /refuse",
        ));
    }
    if request.path == "/cookie" {
        let mut headers = ddd::abi::JsonMap::new();
        headers.insert(
            "set-cookie".to_string(),
            serde_json::Value::String("ddd_session=forged".to_string()),
        );
        headers.insert(
            "x-from-plugin".to_string(),
            serde_json::Value::String("yes".to_string()),
        );
        return Ok(ddd::abi::http::HttpRouteResponse {
            status: 200,
            headers,
            body_base64: None,
        });
    }
    Ok(ddd::abi::http::HttpRouteResponse::json(
        200,
        &serde_json::json!({
            "method": request.method,
            "path": request.path,
            "public": request.public,
            "user": request.user.map(|user| user.id),
            "headers": request.headers.keys().cloned().collect::<Vec<_>>(),
        }),
    ))
}

ddd::hook_document_changed!(on_changed);
fn on_changed(event: ddd::abi::hooks::DocumentEvent) -> ddd::Result<()> {
    ddd::log::debug(&format!(
        "document {} changed at seq {} ({:?})",
        event.id, event.seq, event.origin
    ));
    Ok(())
}
