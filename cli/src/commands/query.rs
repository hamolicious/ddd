use anyhow::{Context, Result, bail};
use clap::Args;
use ddd_core::Date;
use ddd_core::filter::{Filter, Literal};
use ddd_core::query::{Op, Plan, Query, Sort, Trash, lower};
use serde_json::Value;

use crate::server::Server;

#[derive(Args)]
pub struct QueryArgs {
    #[arg(long)]
    text: Option<String>,
    #[arg(long = "filter", value_name = "FIELD:OP[:VALUE]")]
    filters: Vec<String>,
    #[arg(long)]
    any: bool,
    #[arg(long, value_name = "ID")]
    child_of: Option<String>,
    #[arg(long, requires = "child_of")]
    deep: bool,
    #[arg(long, value_name = "ID")]
    parent_of: Option<String>,
    #[arg(long, value_name = "KEY")]
    sort: Vec<String>,
    #[arg(long, value_parser = ["live", "trashed", "all"])]
    trash: Option<String>,
    #[arg(long)]
    limit: Option<u32>,
    #[arg(long)]
    cursor: Option<String>,
    #[arg(long)]
    snippets: bool,
    #[arg(long)]
    metadata_only: bool,
    #[arg(long)]
    plan: bool,
    #[arg(long)]
    json: bool,
    #[arg(long, env = "DDD_SERVER")]
    server: Option<String>,
    #[arg(long, env = "DDD_TOKEN", hide_env_values = true)]
    token: Option<String>,
}

pub fn run(args: QueryArgs) -> Result<()> {
    let plan = build(&args)?;
    if args.plan {
        println!("{}", serde_json::to_string_pretty(&plan.to_json())?);
        return Ok(());
    }
    let Some(url) = args.server.as_deref() else {
        bail!("which server? pass --server <url> or set DDD_SERVER (or --plan to print the query)");
    };
    let Some(token) = args
        .token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
    else {
        bail!(
            "not signed in: run `ddd login --server {url} --email <you>` and set DDD_TOKEN to what it prints"
        );
    };
    let server = Server::new(url);
    let path = if args.metadata_only {
        "/api/query?metadata_only=true"
    } else {
        "/api/query"
    };
    let answer = server.post_json(path, &plan.to_json(), Some(token))?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&answer)?);
    } else {
        print_table(&answer);
    }
    Ok(())
}

fn build(args: &QueryArgs) -> Result<Plan> {
    let conditions = args
        .filters
        .iter()
        .map(|raw| condition(raw))
        .collect::<Result<Vec<_>>>()?;

    let mut query = Query::new();
    if let Some(text) = &args.text {
        query = query.text(text);
    }
    if args.any {
        query = query.any_of(|group| conditions.into_iter().fold(group, Query::where_filter));
    } else {
        query = conditions.into_iter().fold(query, Query::where_filter);
    }
    if let Some(id) = &args.child_of {
        query = query.child_of(id, args.deep);
    }
    if let Some(id) = &args.parent_of {
        query = query.parent_of(id);
    }
    for key in &args.sort {
        query = match Sort::parse(key).with_context(|| format!("`{key}` is not a sort key"))? {
            Sort::Relevance => query.sort_relevance(),
            Sort::Field(key) => match key.order {
                ddd_core::filter::SortOrder::Asc => query.sort(&key.field.as_dotted()),
                ddd_core::filter::SortOrder::Desc => query.sort_desc(&key.field.as_dotted()),
            },
        };
    }
    if let Some(trash) = &args.trash {
        query = query.trash(match trash.as_str() {
            "trashed" => Trash::Trashed,
            "all" => Trash::All,
            _ => Trash::Live,
        });
    }
    if let Some(limit) = args.limit {
        query = query.limit(limit);
    }
    if let Some(cursor) = &args.cursor {
        query = query.cursor(cursor);
    }
    if args.snippets {
        query = query.snippets();
    }
    query.build().context("the query is not valid")
}

fn condition(raw: &str) -> Result<Filter> {
    let mut parts = raw.splitn(3, ':');
    let field = parts.next().unwrap_or_default();
    let op: Op = parts
        .next()
        .with_context(|| format!("`{raw}`: expected field:op[:value]"))?
        .parse()
        .with_context(|| format!("`{raw}`"))?;
    let values = match (op, parts.next()) {
        (op, _) if op.is_valueless() => Vec::new(),
        (Op::ContainsAny, Some(value)) => value
            .split(',')
            .map(|item| literal(item.trim()))
            .collect::<Result<_>>()?,
        (_, Some(value)) => vec![literal(value)?],
        (op, None) => bail!("`{raw}`: `{op}` takes a value"),
    };
    lower(field, op, &values, false).with_context(|| format!("`{raw}`"))
}

fn literal(raw: &str) -> Result<Literal> {
    if let Some(date) = raw.strip_prefix("date:") {
        return Ok(Literal::Date(
            Date::parse(date).with_context(|| format!("`{date}` is not a date"))?,
        ));
    }
    if let Some(id) = raw.strip_prefix("doc:") {
        return Ok(Literal::Str(format!("doc://{id}")));
    }
    if let Some(text) = raw.strip_prefix("str:") {
        return Ok(Literal::Str(text.to_string()));
    }
    Ok(match raw {
        "true" => Literal::Bool(true),
        "false" => Literal::Bool(false),
        "null" => Literal::Null,
        _ => match raw.parse::<i64>() {
            Ok(int) => Literal::Int(int),
            Err(_) => match raw.parse::<f64>() {
                Ok(float) if float.is_finite() => Literal::Float(float),
                _ => Literal::Str(raw.to_string()),
            },
        },
    })
}

fn print_table(answer: &Value) {
    let documents = answer["documents"].as_array().cloned().unwrap_or_default();
    for document in &documents {
        let id = document["id"].as_str().unwrap_or_default();
        let title = document["title"].as_str().unwrap_or_default();
        println!("{id}  {title}");
        if let Some(snippet) = answer["hits"][id]["snippet"]["text"].as_str() {
            println!("    {snippet}");
        }
    }
    let total = answer["total"].as_u64().unwrap_or(documents.len() as u64);
    eprintln!("{} of {total}", documents.len());
    if let Some(cursor) = answer["next_cursor"].as_str() {
        eprintln!("more: --cursor {cursor}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct Cli {
        #[command(flatten)]
        args: QueryArgs,
    }

    fn plan(argv: &[&str]) -> Value {
        let cli = Cli::try_parse_from(std::iter::once("ddd").chain(argv.iter().copied())).unwrap();
        build(&cli.args).unwrap().to_json()
    }

    #[test]
    fn flags_build_the_core_plan() {
        assert_eq!(
            plan(&[
                "--filter",
                "title:text_contains:a",
                "--sort",
                "fm.key",
                "--limit",
                "20"
            ]),
            serde_json::json!({
                "filter": {"text": {"field": "title", "mode": "contains", "value": "a"}},
                "sort": ["fm.key"],
                "limit": 20,
            })
        );
    }

    #[test]
    fn values_are_typed() {
        let filter = &plan(&[
            "--filter",
            "fm.n:gt:3",
            "--filter",
            "fm.done:eq:true",
            "--filter",
            "fm.due:gte:date:2026-10-01",
            "--filter",
            "fm.code:eq:str:007",
            "--filter",
            "fm.tags:contains_any:a,b",
            "--filter",
            "fm.x:missing",
        ])["filter"]["and"];
        assert_eq!(filter[0]["cmp"]["value"], serde_json::json!({"int": 3}));
        assert_eq!(filter[1]["cmp"]["value"], serde_json::json!({"bool": true}));
        assert_eq!(
            filter[2]["cmp"]["value"],
            serde_json::json!({"date": "2026-10-01"})
        );
        assert_eq!(filter[3]["cmp"]["value"], serde_json::json!({"str": "007"}));
        assert_eq!(filter[4]["or"].as_array().unwrap().len(), 2);
        assert_eq!(filter[5], serde_json::json!({"missing": {"field": "fm.x"}}));
    }

    #[test]
    fn any_groups_and_relations_join() {
        let built = plan(&[
            "--any",
            "--filter",
            "fm.a:exists",
            "--filter",
            "fm.b:exists",
            "--child-of",
            "root",
            "--deep",
        ]);
        assert_eq!(built["filter"]["and"][0]["or"].as_array().unwrap().len(), 2);
        assert_eq!(
            built["filter"]["and"][1],
            serde_json::json!({"child_of": {"of": "root", "deep": true}})
        );
    }

    #[test]
    fn mistakes_are_refused_before_any_request() {
        let cli = Cli::try_parse_from(["ddd", "--filter", "nope:eq:1"]).unwrap();
        assert!(build(&cli.args).is_err());
        let cli = Cli::try_parse_from(["ddd", "--filter", "title:frobnicate:1"]).unwrap();
        assert!(build(&cli.args).is_err());
    }
}
