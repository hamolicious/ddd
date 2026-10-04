use serde::Serialize;

use crate::date::Date;
use crate::filter::{CompareOp, Literal, TextMatch};

use super::catalog::{
    Column, DEFAULT_DOCUMENT_ROW, Decode, Kind, Scope, base_scope, document_content, document_id,
    quote_ident, source_table, tiebreak, trash_column,
};
use super::cursor::decode_cursor;
use super::fuzzy::{
    FuzzySpec, MAX_FUZZY_CANDIDATES, MAX_FUZZY_DISTANCE, MAX_VOCAB_ROWS, expand_terms, fuzzy_terms,
    vocabulary_filter,
};
use super::plan::FuzzyStage;
use super::plan::{
    Aggregate, Cond, MAX_SORT_KEYS, MAX_SUBQUERY_DEPTH, Plan, PlanError, SelectItem, Source, Stage,
    TrashScope,
};
use super::project::SqlValue;
use super::text::{Fts, Leafy, TextExpr, TextField, parse_text, to_fts, to_leaves};

const RELEVANCE: &str = "relevance";
const MATCHES: &str = "SELECT x.id AS id, -bm25(documents_fts, 3.0, 1.0, 2.0) AS rank FROM documents_fts JOIN documents x ON x.rowid = documents_fts.rowid WHERE documents_fts MATCH";

const CHILDREN_PATH: &str = "$.\"folders\".\"children\"";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OutputColumn {
    pub path: Vec<String>,
    pub decode: Decode,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CountQuery {
    pub sql: String,
    pub params: Vec<SqlValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Compiled {
    pub sql: String,
    pub params: Vec<SqlValue>,
    pub columns: Vec<OutputColumn>,
    pub cursor_columns: usize,
    pub page_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<CountQuery>,
    pub sources: Vec<Source>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub terms: Vec<String>,
    pub snippets: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fuzzy: Option<FuzzySpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vocabulary: Option<CountQuery>,
}

fn unexpanded(plan: &Plan) -> Option<&FuzzyStage> {
    plan.stages.iter().find_map(|stage| match stage {
        Stage::Fuzzy(fuzzy) if fuzzy.expanded.is_none() => Some(fuzzy),
        _ => None,
    })
}

fn vocabulary_query(fuzzy: &FuzzyStage) -> CountQuery {
    let mut params = Params::default();
    let max_distance = fuzzy.max_distance.unwrap_or(MAX_FUZZY_DISTANCE);
    let mut alternatives = Vec::new();
    for filter in vocabulary_filter(&fuzzy_terms(&fuzzy.query), max_distance) {
        let low = params.bind(SqlValue::Text(filter.low));
        let high = params.bind(SqlValue::Text(filter.high));
        let shortest = params.bind(SqlValue::Int(filter.shortest as i64));
        let longest = params.bind(SqlValue::Int(filter.longest as i64));
        let first = params.bind(SqlValue::Text(filter.first));
        let second = params.bind(SqlValue::Text(filter.second));
        alternatives.push(format!(
            "(term >= {low} AND term < {high}) OR (length(term) BETWEEN {shortest} AND {longest} \
             AND (substr(term, 1, 1) = {first} OR substr(term, 2, 1) = {second} OR substr(term, 1, 1) = {second}))"
        ));
    }
    let condition = if alternatives.is_empty() {
        "0".to_string()
    } else {
        alternatives.join(" OR ")
    };
    CountQuery {
        sql: format!(
            "SELECT term FROM documents_vocab WHERE {condition} ORDER BY doc DESC LIMIT {MAX_VOCAB_ROWS}"
        ),
        params: params.values,
    }
}

pub fn expand_plan(plan: &Plan, vocabulary: &[String]) -> Plan {
    let mut plan = plan.clone();
    for stage in &mut plan.stages {
        if let Stage::Fuzzy(fuzzy) = stage
            && fuzzy.expanded.is_none()
        {
            let max_distance = fuzzy.max_distance.unwrap_or(MAX_FUZZY_DISTANCE);
            fuzzy.expanded = Some(expand_terms(
                &fuzzy_terms(&fuzzy.query),
                max_distance,
                vocabulary,
            ));
        }
    }
    plan
}

#[derive(Default)]
struct Params {
    values: Vec<SqlValue>,
}

impl Params {
    fn bind(&mut self, value: SqlValue) -> String {
        self.values.push(value);
        format!("?{}", self.values.len())
    }
}

#[derive(Debug, Clone)]
struct SortKey {
    name: String,
    column: Column,
    desc: bool,
}

#[derive(Debug, Clone)]
struct Block {
    from: String,
    scope: Scope,
    wheres: Vec<String>,
    order: Vec<SortKey>,
    limit: Option<u64>,
    offset: Option<u64>,
    cursor: Option<String>,
    projection: Option<Vec<(String, Column)>>,
    shaped: bool,
    group: Option<Vec<String>>,
    distinct: bool,
}

impl Block {
    fn new(from: String, scope: Scope) -> Block {
        Block {
            from,
            scope,
            wheres: Vec::new(),
            order: Vec::new(),
            limit: None,
            offset: None,
            cursor: None,
            projection: None,
            shaped: false,
            group: None,
            distinct: false,
        }
    }

    fn paged(&self) -> bool {
        self.limit.is_some() || self.offset.is_some() || self.cursor.is_some()
    }

    fn closed(&self) -> bool {
        self.projection.is_some() || self.paged() || self.group.is_some() || self.distinct
    }
}

struct Compiler<'a> {
    source: Source,
    params: &'a mut Params,
    depth: usize,
    nested: bool,
    sources: Vec<Source>,
    blocks: usize,
    with_content: bool,
    texts: usize,
    terms: Vec<String>,
    snippets: bool,
    fuzzy: Option<FuzzySpec>,
}

pub fn compile(plan: &Plan) -> Result<Compiled, PlanError> {
    plan.validate()?;
    if let Some(fuzzy) = unexpanded(plan) {
        compile(&expand_plan(plan, &[]))?;
        return Ok(Compiled {
            sql: String::new(),
            params: Vec::new(),
            columns: Vec::new(),
            cursor_columns: 0,
            page_size: None,
            total: None,
            sources: vec![plan.source, Source::Documents],
            terms: Vec::new(),
            snippets: false,
            fuzzy: None,
            vocabulary: Some(vocabulary_query(fuzzy)),
        });
    }
    let mut params = Params::default();
    compile_with(plan, &mut params, 0, false)
}

fn compile_with(
    plan: &Plan,
    params: &mut Params,
    depth: usize,
    nested: bool,
) -> Result<Compiled, PlanError> {
    plan.validate()?;
    let mut trash = TrashScope::Live;
    let mut with_total = false;
    let mut with_content = false;
    for stage in &plan.stages {
        match stage {
            Stage::Trash(scope) => trash = *scope,
            Stage::WithTotal => with_total = true,
            Stage::WithContent => with_content = true,
            _ => {}
        }
    }

    let mut sources = vec![plan.source];
    if plan.source != Source::Documents {
        sources.push(Source::Documents);
    }
    let mut compiler = Compiler {
        source: plan.source,
        params,
        depth,
        nested,
        sources,
        blocks: depth * 100,
        with_content,
        texts: 0,
        terms: Vec::new(),
        snippets: false,
        fuzzy: None,
    };
    let (from, scope) = base_scope(plan.source);
    let mut block = Block::new(from, scope);
    match trash {
        TrashScope::Live => block.wheres.push(format!(
            "{} = 0",
            block.scope.resolve(trash_column(plan.source))?.sql
        )),
        TrashScope::Trashed => block.wheres.push(format!(
            "{} = 1",
            block.scope.resolve(trash_column(plan.source))?.sql
        )),
        TrashScope::All => {}
    }

    for stage in &plan.stages {
        match stage {
            Stage::Text(query) => {
                if let Some(expr) = parse_text(query)? {
                    if block.closed() {
                        block = compiler.wrap(block)?;
                    }
                    compiler.text_stage(&mut block, &expr)?;
                }
            }
            Stage::Match(expr) => {
                if block.closed() {
                    block = compiler.wrap(block)?;
                }
                compiler.text_stage(&mut block, expr)?;
            }
            Stage::Snippets => {
                if compiler.texts == 0 {
                    return Err(PlanError::BadStage(
                        "snippets need a text or match stage before them".into(),
                    ));
                }
                compiler.snippets = true;
            }
            Stage::Where(cond) => {
                if block.closed() {
                    block = compiler.wrap(block)?;
                }
                let sql = compiler.condition(cond, &block.scope)?;
                block.wheres.push(sql);
            }
            Stage::Sort(keys) => {
                if block.closed() {
                    block = compiler.wrap(block)?;
                }
                let mut order = Vec::new();
                for key in keys {
                    let (name, desc) = match key.strip_prefix('-') {
                        Some(rest) => (rest, true),
                        None => (key.as_str(), false),
                    };
                    let desc = if name == RELEVANCE {
                        if !block.scope.columns.iter().any(|c| c.name == RELEVANCE) {
                            return Err(PlanError::BadStage(
                                "relevance sorting needs a text match".into(),
                            ));
                        }
                        !desc
                    } else {
                        desc
                    };
                    let column = block.scope.resolve(name)?;
                    if column.kind == Kind::JsonMap {
                        return Err(PlanError::BadOperator(format!(
                            "{name} is a map and cannot be sorted"
                        )));
                    }
                    order.push(SortKey {
                        name: name.to_string(),
                        column,
                        desc,
                    });
                }
                for key in std::mem::take(&mut block.order) {
                    if !order.iter().any(|existing| existing.name == key.name) {
                        order.push(key);
                    }
                }
                order.truncate(MAX_SORT_KEYS);
                block.order = order;
            }
            Stage::Select(items) => {
                if block.projection.is_some() || block.distinct {
                    block = compiler.wrap(block)?;
                }
                block.projection = Some(project(items, &block.scope)?);
            }
            Stage::Distinct(fields) => {
                if !fields.is_empty() {
                    if block.closed() {
                        block = compiler.wrap(block)?;
                    }
                    let items: Vec<SelectItem> = fields
                        .iter()
                        .map(|field| SelectItem {
                            field: field.clone(),
                            alias: None,
                        })
                        .collect();
                    block.projection = Some(project(&items, &block.scope)?);
                } else {
                    if block.paged() || block.group.is_some() || block.distinct {
                        block = compiler.wrap(block)?;
                    }
                    if block.projection.is_none() {
                        if block.shaped {
                            block.projection = Some(
                                block
                                    .scope
                                    .columns
                                    .iter()
                                    .map(|c| (c.name.clone(), c.clone()))
                                    .collect(),
                            );
                        } else if let Some(table) = source_table(plan.source) {
                            let mut items: Vec<SelectItem> = table
                                .columns
                                .iter()
                                .map(|(name, _, _)| SelectItem {
                                    field: (*name).to_string(),
                                    alias: None,
                                })
                                .collect();
                            items.push(SelectItem {
                                field: "doc.id".into(),
                                alias: None,
                            });
                            block.projection = Some(project(&items, &block.scope)?);
                        }
                    }
                }
                block.distinct = true;
            }
            Stage::GroupBy(fields) => {
                if block.closed() {
                    block = compiler.wrap(block)?;
                }
                let items: Vec<SelectItem> = fields
                    .iter()
                    .map(|field| SelectItem {
                        field: field.clone(),
                        alias: None,
                    })
                    .collect();
                let keys = project(&items, &block.scope)?;
                for (_, column) in &keys {
                    if column.kind == Kind::JsonMap {
                        return Err(PlanError::BadOperator(format!(
                            "{} is a map and cannot be grouped",
                            column.name
                        )));
                    }
                }
                block.group = Some(keys.iter().map(|(_, column)| column.output_sql()).collect());
                block.projection = Some(keys);
                block.order.clear();
            }
            stage if stage.is_aggregate() => {
                if block.group.is_none() || block.paged() {
                    if block.closed() {
                        block = compiler.wrap(block)?;
                    }
                    block.group = Some(Vec::new());
                    block.projection = Some(Vec::new());
                    block.order.clear();
                }
                let (name, column) = aggregate(stage, &block.scope)?;
                let projection = block.projection.get_or_insert_with(Vec::new);
                if projection.iter().any(|(existing, _)| *existing == name) {
                    return Err(PlanError::BadStage(format!("{name} is used twice")));
                }
                projection.push((name, column));
            }
            Stage::Limit(n) if compiler.fuzzy.is_some() => {
                if let Some(fuzzy) = compiler.fuzzy.as_mut() {
                    fuzzy.page = Some(fuzzy.page.map_or(*n, |page| page.min(*n)));
                }
            }
            Stage::Offset(n) if compiler.fuzzy.is_some() => {
                if let Some(fuzzy) = compiler.fuzzy.as_mut() {
                    fuzzy.offset = Some(fuzzy.offset.unwrap_or(0) + n);
                    fuzzy.page = fuzzy.page.map(|page| page.saturating_sub(*n));
                }
            }
            Stage::Limit(n) => {
                if block.limit.is_some() {
                    block = compiler.wrap(block)?;
                }
                block.limit = Some(*n);
            }
            Stage::Offset(n) => {
                if block.paged() {
                    block = compiler.wrap(block)?;
                }
                block.offset = Some(*n);
            }
            Stage::Cursor(cursor) => {
                if block.paged() {
                    block = compiler.wrap(block)?;
                }
                block.cursor = Some(cursor.clone());
            }
            Stage::Fuzzy(fuzzy) => {
                if block.group.is_some() || block.distinct {
                    return Err(PlanError::BadStage(
                        "fuzzy ranks documents, so it cannot follow groupBy or distinct".into(),
                    ));
                }
                if block.paged() {
                    block = compiler.wrap(block)?;
                }
                compiler.fuzzy_stage(&mut block, fuzzy)?;
            }
            Stage::WithTotal | Stage::WithContent | Stage::Trash(_) => {}
            _ => unreachable!("aggregates are matched above"),
        }
    }

    compiler.finish(block, with_total)
}

fn aggregate(stage: &Stage, scope: &Scope) -> Result<(String, Column), PlanError> {
    let (default, spec): (&str, &Aggregate) = match stage {
        Stage::Count(a) => ("count", a),
        Stage::Sum(a) => ("sum", a),
        Stage::Min(a) => ("min", a),
        Stage::Max(a) => ("max", a),
        Stage::Avg(a) => ("avg", a),
        Stage::Collect(a) => ("collect", a),
        _ => unreachable!("only aggregates reach here"),
    };
    let name = spec.alias.clone().unwrap_or_else(|| default.to_string());
    let field = match &spec.field {
        Some(field) => Some(scope.resolve(field)?),
        None => None,
    };
    let value = |column: &Option<Column>| -> Result<Column, PlanError> {
        let column = column
            .clone()
            .ok_or_else(|| PlanError::BadStage("this aggregate needs a field".into()))?;
        if column.kind == Kind::JsonMap {
            return Err(PlanError::BadOperator(format!(
                "{} is a map and cannot be aggregated",
                column.name
            )));
        }
        Ok(column)
    };
    let (sql, kind) = match stage {
        Stage::Count(_) => match &field {
            Some(column) => (format!("count({})", column.value_sql()), Kind::Int),
            None => ("count(*)".to_string(), Kind::Int),
        },
        Stage::Sum(_) => (format!("sum({})", value(&field)?.value_sql()), Kind::Value),
        Stage::Min(_) => (format!("min({})", value(&field)?.value_sql()), Kind::Value),
        Stage::Max(_) => (format!("max({})", value(&field)?.value_sql()), Kind::Value),
        Stage::Avg(_) => (format!("avg({})", value(&field)?.value_sql()), Kind::Value),
        Stage::Collect(_) => {
            let column =
                field.ok_or_else(|| PlanError::BadStage("collect needs a field".into()))?;
            let item = match column.kind {
                Kind::Json | Kind::FmValue | Kind::JsonMap => {
                    format!("json({})", column.output_sql())
                }
                Kind::Bool => format!(
                    "json(CASE WHEN {} THEN 'true' ELSE 'false' END)",
                    column.sql
                ),
                _ => column.value_sql(),
            };
            (
                format!("json_group_array(DISTINCT {item}) FILTER (WHERE {item} IS NOT NULL)"),
                Kind::Json,
            )
        }
        _ => unreachable!("only aggregates reach here"),
    };
    Ok((
        name.clone(),
        Column {
            name,
            sql,
            kind,
            path: None,
            companion: None,
            origin: String::new(),
        },
    ))
}

fn project(items: &[SelectItem], scope: &Scope) -> Result<Vec<(String, Column)>, PlanError> {
    let mut out: Vec<(String, Column)> = Vec::with_capacity(items.len());
    for item in items {
        let name = item.name().to_string();
        if name.is_empty() {
            return Err(PlanError::BadStage("a selected field needs a name".into()));
        }
        if out.iter().any(|(existing, _)| *existing == name) {
            return Err(PlanError::BadStage(format!("{name} is selected twice")));
        }
        out.push((name, scope.resolve(&item.field)?));
    }
    Ok(out)
}

impl Compiler<'_> {
    fn text_stage(&mut self, block: &mut Block, expr: &TextExpr) -> Result<(), PlanError> {
        let id = document_id(&block.scope, self.source)?;
        self.texts += 1;
        for term in expr.terms() {
            if !self.terms.contains(&term) {
                self.terms.push(term);
            }
        }
        let rank = match to_fts(expr) {
            Fts::Query(query) => {
                let bound = self.params.bind(SqlValue::Text(query));
                let alias = format!("m{}", self.texts);
                block.from.push_str(&format!(
                    " JOIN ({MATCHES} {bound}) {alias} ON {alias}.id = {}",
                    id.sql
                ));
                format!("{alias}.rank")
            }
            Fts::Unrankable => {
                let predicate = self.leaves(&to_leaves(expr), &id.sql);
                block.wheres.push(predicate);
                "0".to_string()
            }
        };
        let sql = match block.scope.columns.iter().position(|c| c.name == RELEVANCE) {
            Some(index) => {
                let previous = block.scope.columns.remove(index);
                format!("({} + {rank})", previous.sql)
            }
            None => rank,
        };
        block.scope.columns.push(Column {
            name: RELEVANCE.to_string(),
            sql,
            kind: Kind::Real,
            path: None,
            companion: None,
            origin: RELEVANCE.to_string(),
        });
        Ok(())
    }

    fn fuzzy_stage(&mut self, block: &mut Block, fuzzy: &FuzzyStage) -> Result<(), PlanError> {
        let id = document_id(&block.scope, self.source)
            .map_err(|_| PlanError::BadStage("fuzzy needs the document id in the rows".into()))?;
        if let Some(projection) = &block.projection
            && !projection.iter().any(|(_, column)| column.sql == id.sql)
        {
            return Err(PlanError::BadStage(
                "fuzzy needs id among the selected fields".into(),
            ));
        }
        let fields = fuzzy
            .fields
            .clone()
            .filter(|fields| !fields.is_empty())
            .unwrap_or_else(|| vec![TextField::Title, TextField::Content, TextField::Fm]);
        let terms = fuzzy_terms(&fuzzy.query);
        let max_distance = fuzzy.max_distance.unwrap_or(MAX_FUZZY_DISTANCE);
        let expanded = fuzzy.expanded.clone().unwrap_or_default();
        if expanded.is_empty() {
            block.wheres.push("0".into());
        } else {
            let columns: Vec<&str> = fields.iter().map(|field| field.column()).collect();
            let query = format!(
                "{{{}}} : ({})",
                columns.join(" "),
                expanded
                    .iter()
                    .map(|word| format!("\"{}\"", word.replace('"', "\"\"")))
                    .collect::<Vec<_>>()
                    .join(" OR ")
            );
            let bound = self.params.bind(SqlValue::Text(query));
            block.from.push_str(&format!(
                " JOIN (SELECT x.id AS id FROM documents_fts JOIN documents x ON x.rowid = documents_fts.rowid \
                 WHERE documents_fts MATCH {bound} ORDER BY bm25(documents_fts) LIMIT {MAX_FUZZY_CANDIDATES}) fg ON fg.id = {}",
                id.sql
            ));
        }
        block
            .from
            .push_str(&format!(" JOIN documents fz ON fz.id = {}", id.sql));
        self.fuzzy = Some(FuzzySpec {
            terms,
            fields,
            limit: fuzzy.limit,
            max_distance,
            offset: None,
            page: None,
            total: false,
        });
        Ok(())
    }

    fn leaves(&mut self, leaf: &Leafy, id: &str) -> String {
        match leaf {
            Leafy::Match(query) => {
                let bound = self.params.bind(SqlValue::Text(query.clone()));
                format!("({id} IN (SELECT id FROM ({MATCHES} {bound})))")
            }
            Leafy::And(children) => {
                let parts: Vec<String> = children
                    .iter()
                    .map(|child| self.leaves(child, id))
                    .collect();
                format!("({})", parts.join(" AND "))
            }
            Leafy::Or(children) => {
                let parts: Vec<String> = children
                    .iter()
                    .map(|child| self.leaves(child, id))
                    .collect();
                any_of(parts)
            }
            Leafy::Not(child) => format!("(NOT {})", self.leaves(child, id)),
        }
    }

    fn alias(&mut self) -> String {
        self.blocks += 1;
        format!("b{}", self.blocks)
    }

    fn outputs(&self, block: &Block) -> Vec<(String, Column)> {
        match &block.projection {
            Some(projection) => projection.clone(),
            None => block
                .scope
                .columns
                .iter()
                .map(|column| (column.name.clone(), column.clone()))
                .collect(),
        }
    }

    fn wrap(&mut self, block: Block) -> Result<Block, PlanError> {
        let outputs = self.outputs(&block);
        let select = outputs
            .iter()
            .map(|(name, column)| format!("{} AS {}", column.output_sql(), quote_ident(name)))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = self.block_sql(&block, &select, false)?;
        let alias = self.alias();
        let mut scope = Scope::default();
        for (name, column) in &outputs {
            scope.columns.push(Column {
                name: name.clone(),
                sql: format!("{alias}.{}", quote_ident(name)),
                kind: column.kind.materialized(),
                path: None,
                companion: None,
                origin: column.origin.clone(),
            });
        }
        let mut next = Block::new(format!("({sql}) {alias}"), scope);
        next.shaped = block.shaped || block.projection.is_some();
        if block.group.is_some() || block.distinct {
            return Ok(next);
        }
        for key in &block.order {
            if let Ok(column) = next.scope.resolve(&key.name) {
                next.order.push(SortKey {
                    name: key.name.clone(),
                    column,
                    desc: key.desc,
                });
            }
        }
        Ok(next)
    }

    fn order_terms(&self, block: &Block) -> (Vec<(String, bool, bool)>, Option<Column>) {
        let mut terms = Vec::new();
        for key in &block.order {
            terms.push((key.column.value_sql(), key.desc, key.column.kind.nullable()));
        }
        let tie = if block.group.is_some() || block.distinct {
            None
        } else {
            tiebreak(&block.scope, self.source)
        };
        (terms, tie)
    }

    fn order_by(&self, block: &Block) -> String {
        let (terms, tie) = self.order_terms(block);
        let mut parts = Vec::new();
        for (sql, desc, nullable) in &terms {
            if *nullable {
                parts.push(format!("({sql} IS NULL)"));
            }
            parts.push(format!("{sql} {}", if *desc { "DESC" } else { "ASC" }));
        }
        if let Some(tie) = tie
            && !terms.iter().any(|(sql, _, _)| *sql == tie.sql)
        {
            parts.push(format!("{} ASC", tie.sql));
        }
        if let Some(group) = &block.group {
            for sql in group {
                parts.push(format!("{sql} ASC"));
            }
        } else if block.distinct
            && let Some(projection) = &block.projection
        {
            for (_, column) in projection {
                if column.kind != Kind::JsonMap {
                    parts.push(format!("{} ASC", column.output_sql()));
                }
            }
        }
        if parts.is_empty() {
            String::new()
        } else {
            format!(" ORDER BY {}", parts.join(", "))
        }
    }

    fn cursor_where(&mut self, block: &Block, cursor: &str) -> Result<String, PlanError> {
        let (terms, tie) = self.order_terms(block);
        let tie = tie
            .ok_or_else(|| PlanError::BadStage("a cursor needs the row id in the result".into()))?;
        let values = decode_cursor(cursor)?;
        if values.len() != terms.len() + 1 {
            return Err(PlanError::BadValue(
                "the cursor does not belong to this query".into(),
            ));
        }
        let mut keys: Vec<(String, bool, SqlValue)> = terms
            .into_iter()
            .zip(values.iter())
            .map(|((sql, desc, _), value)| (sql, desc, value.clone()))
            .collect();
        keys.push((tie.sql.clone(), false, values[values.len() - 1].clone()));
        let mut alternatives = Vec::new();
        for index in 0..keys.len() {
            let mut parts = Vec::new();
            for (sql, _, value) in &keys[..index] {
                parts.push(match value {
                    SqlValue::Null => format!("{sql} IS NULL"),
                    other => format!("{sql} = {}", self.params.bind(other.clone())),
                });
            }
            let (sql, desc, value) = &keys[index];
            match value {
                SqlValue::Null => continue,
                other => {
                    let bound = self.params.bind(other.clone());
                    let op = if *desc { "<" } else { ">" };
                    parts.push(format!("({sql} {op} {bound} OR {sql} IS NULL)"));
                }
            }
            alternatives.push(format!("({})", parts.join(" AND ")));
        }
        if alternatives.is_empty() {
            return Ok("0".into());
        }
        Ok(format!("({})", alternatives.join(" OR ")))
    }

    fn block_sql(
        &mut self,
        block: &Block,
        select: &str,
        ordered: bool,
    ) -> Result<String, PlanError> {
        let mut wheres = block.wheres.clone();
        if let Some(cursor) = &block.cursor {
            wheres.push(self.cursor_where(block, cursor)?);
        }
        let distinct = if block.distinct { "DISTINCT " } else { "" };
        let mut sql = format!("SELECT {distinct}{select} FROM {}", block.from);
        if !wheres.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&wheres.join(" AND "));
        }
        if let Some(group) = &block.group
            && !group.is_empty()
        {
            sql.push_str(" GROUP BY ");
            sql.push_str(&group.join(", "));
        }
        if ordered || block.paged() {
            sql.push_str(&self.order_by(block));
        }
        match (block.limit, block.offset) {
            (Some(limit), Some(offset)) => sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}")),
            (Some(limit), None) => sql.push_str(&format!(" LIMIT {limit}")),
            (None, Some(offset)) => sql.push_str(&format!(" LIMIT -1 OFFSET {offset}")),
            (None, None) => {}
        }
        Ok(sql)
    }

    fn default_row(&self, scope: &Scope) -> Result<Vec<(Vec<String>, Column)>, PlanError> {
        let mut row = Vec::new();
        let documents: Vec<&str> = DEFAULT_DOCUMENT_ROW
            .iter()
            .copied()
            .chain(self.with_content.then_some("content"))
            .collect();
        match source_table(self.source) {
            None => {
                for name in documents {
                    row.push((vec![name.to_string()], scope.resolve(name)?));
                }
            }
            Some(table) => {
                for (name, _, _) in table.columns {
                    row.push((vec![(*name).to_string()], scope.resolve(name)?));
                }
                for name in documents {
                    row.push((
                        vec!["doc".to_string(), name.to_string()],
                        scope.resolve(&format!("doc.{name}"))?,
                    ));
                }
            }
        }
        Ok(row)
    }

    fn finish(mut self, block: Block, with_total: bool) -> Result<Compiled, PlanError> {
        let visible: Vec<(Vec<String>, Column)> = match &block.projection {
            Some(projection) => projection
                .iter()
                .map(|(name, column)| (vec![name.clone()], column.clone()))
                .collect(),
            None if block.shaped => block
                .scope
                .columns
                .iter()
                .map(|column| (vec![column.name.clone()], column.clone()))
                .collect(),
            None => self.default_row(&block.scope)?,
        };

        if with_total && let Some(fuzzy) = self.fuzzy.as_mut() {
            fuzzy.total = true;
        }
        let total = if with_total && !self.nested && self.fuzzy.is_none() {
            let unpaged = Block {
                limit: None,
                offset: None,
                cursor: None,
                ..block.clone()
            };
            let counted = if unpaged.group.as_ref().is_some_and(Vec::is_empty) {
                "count(*)"
            } else {
                "1"
            };
            let inner = self.block_sql(&unpaged, counted, false)?;
            Some(CountQuery {
                sql: format!("SELECT count(*) FROM ({inner})"),
                params: self.params.values.clone(),
            })
        } else {
            None
        };

        let mut select: Vec<String> = visible
            .iter()
            .enumerate()
            .map(|(index, (_, column))| format!("{} AS c{index}", column.output_sql()))
            .collect();
        let columns: Vec<OutputColumn> = visible
            .iter()
            .map(|(path, column)| OutputColumn {
                path: path.clone(),
                decode: column.kind.materialized().decode(),
            })
            .collect();

        let content = if self.snippets && !self.nested {
            Some(document_content(&block.scope, self.source)?)
        } else {
            None
        };
        let page_size = if self.nested { None } else { block.limit };
        let mut cursor_columns = 0;
        if page_size.is_some() {
            let (terms, tie) = self.order_terms(&block);
            if let Some(tie) = tie {
                for (index, (sql, _, _)) in terms.iter().enumerate() {
                    select.push(format!("{sql} AS k{index}"));
                }
                select.push(format!("{} AS k{}", tie.sql, terms.len()));
                cursor_columns = terms.len() + 1;
            }
        }
        if let Some(content) = &content {
            select.push(format!("{} AS snippet_source", content.sql));
        }
        let fuzzy = if self.nested { None } else { self.fuzzy.take() };
        if fuzzy.is_some() {
            select.push("fz.id AS fuzzy_id".into());
            select.push("fz.title AS fuzzy_title".into());
            select.push("fz.content AS fuzzy_content".into());
        }

        let probed = Block {
            limit: match page_size {
                Some(n) if fuzzy.is_none() => Some(n + 1),
                _ if fuzzy.is_some() => Some(MAX_FUZZY_CANDIDATES),
                _ => block.limit,
            },
            ..block
        };
        let page_size = if fuzzy.is_some() { None } else { page_size };
        if fuzzy.is_some() {
            cursor_columns = 0;
        }
        let sql = self.block_sql(&probed, &select.join(", "), true)?;
        let sources = self.sources;
        Ok(Compiled {
            sql,
            params: self.params.values.clone(),
            columns,
            cursor_columns,
            page_size,
            total,
            sources,
            terms: self.terms,
            snippets: self.snippets,
            fuzzy,
            vocabulary: None,
        })
    }

    fn condition(&mut self, cond: &Cond, scope: &Scope) -> Result<String, PlanError> {
        Ok(match cond {
            Cond::All => "1".into(),
            Cond::None => "0".into(),
            Cond::And(children) => self.join(children, scope, " AND ", "1")?,
            Cond::Or(children) => self.join(children, scope, " OR ", "0")?,
            Cond::Not(child) => format!("(NOT {})", self.condition(child, scope)?),
            Cond::Cmp { field, op, value } => {
                let column = scope.resolve(field)?;
                self.compare(&column, *op, value)?
            }
            Cond::In { field, values } => {
                let column = scope.resolve(field)?;
                let mut parts = Vec::new();
                for value in values {
                    parts.push(self.compare(&column, CompareOp::Eq, value)?);
                }
                any_of(parts)
            }
            Cond::Contains { field, value } => {
                let column = scope.resolve(field)?;
                self.list(&column, CompareOp::Eq, std::slice::from_ref(value), false)?
            }
            Cond::ContainsAny { field, values } => {
                let column = scope.resolve(field)?;
                self.list(&column, CompareOp::Eq, values, false)?
            }
            Cond::Any { field, op, value } => {
                let column = scope.resolve(field)?;
                self.list(&column, *op, std::slice::from_ref(value), false)?
            }
            Cond::Every { field, op, value } => {
                let column = scope.resolve(field)?;
                self.list(&column, *op, std::slice::from_ref(value), true)?
            }
            Cond::Missing { field } => presence(&scope.resolve(field)?, Presence::Missing),
            Cond::Exists { field } => presence(&scope.resolve(field)?, Presence::Exists),
            Cond::IsNull { field } => presence(&scope.resolve(field)?, Presence::Null),
            Cond::Text { field, mode, value } => {
                let column = scope.resolve(field)?;
                self.text(&column, *mode, value)?
            }
            Cond::ChildOf { field, of, deep } => {
                let column = id_column(scope, field)?;
                let of = self.params.bind(SqlValue::Text(of.clone()));
                if *deep {
                    format!(
                        "({} IN (WITH RECURSIVE tree(id) AS (\
                         SELECT j.value FROM documents p, json_each(p.plugins, '{CHILDREN_PATH}') j WHERE p.id = {of} \
                         UNION SELECT j.value FROM tree JOIN documents p ON p.id = tree.id, json_each(p.plugins, '{CHILDREN_PATH}') j\
                         ) SELECT id FROM tree))",
                        column.sql
                    )
                } else {
                    format!(
                        "({} IN (SELECT j.value FROM documents p, json_each(p.plugins, '{CHILDREN_PATH}') j WHERE p.id = {of}))",
                        column.sql
                    )
                }
            }
            Cond::InPlan { field, plan } => {
                if self.depth + 1 > MAX_SUBQUERY_DEPTH {
                    return Err(PlanError::Limit(format!(
                        "subqueries nest deeper than {MAX_SUBQUERY_DEPTH}"
                    )));
                }
                let column = scope.resolve(field)?;
                let sub = compile_with(plan, &mut *self.params, self.depth + 1, true)?;
                if sub.columns.len() != 1 {
                    return Err(PlanError::BadStage(
                        "a subquery must select exactly one field".into(),
                    ));
                }
                for source in sub.sources {
                    if !self.sources.contains(&source) {
                        self.sources.push(source);
                    }
                }
                format!("({} IN (SELECT c0 FROM ({})))", column.value_sql(), sub.sql)
            }
            Cond::ParentOf { field, of } => {
                let column = id_column(scope, field)?;
                let of = self.params.bind(SqlValue::Text(of.clone()));
                format!(
                    "EXISTS (SELECT 1 FROM documents p, json_each(p.plugins, '{CHILDREN_PATH}') j WHERE p.id = {} AND j.value = {of})",
                    column.sql
                )
            }
        })
    }

    fn join(
        &mut self,
        children: &[Cond],
        scope: &Scope,
        glue: &str,
        empty: &str,
    ) -> Result<String, PlanError> {
        if children.is_empty() {
            return Ok(empty.to_string());
        }
        let parts = children
            .iter()
            .map(|child| self.condition(child, scope))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(format!("({})", parts.join(glue)))
    }

    fn compare(
        &mut self,
        column: &Column,
        op: CompareOp,
        literal: &Literal,
    ) -> Result<String, PlanError> {
        if is_ordering(op) && matches!(literal, Literal::Null | Literal::Bool(_)) {
            return Err(PlanError::BadOperator(format!(
                "{} cannot be ordered against {}",
                column.name,
                literal_name(literal)
            )));
        }
        if let Some(type_sql) = column.type_sql() {
            return Ok(self.dynamic(&type_sql, &column.value_sql(), op, literal));
        }
        let sql = column.sql.clone();
        let mismatch = || {
            PlanError::BadValue(format!(
                "{} cannot be compared with {}",
                column.name,
                literal_name(literal)
            ))
        };
        let guard = |body: String| {
            if column.kind.nullable() {
                format!("({sql} IS NOT NULL AND {body})")
            } else {
                body
            }
        };
        match column.kind {
            Kind::JsonMap => Err(PlanError::BadOperator(format!(
                "{} is a map and cannot be compared",
                column.name
            ))),
            Kind::Text | Kind::NullText => match literal {
                Literal::Str(text) => {
                    let bound = self.params.bind(SqlValue::Text(text.clone()));
                    Ok(guard(format!("{sql} {} {bound}", sql_op(op))))
                }
                Literal::Null if column.kind == Kind::NullText => Ok(null_compare(&sql, op)),
                _ => Err(mismatch()),
            },
            Kind::Int | Kind::NullInt | Kind::Real => match literal {
                Literal::Int(n) => {
                    let bound = self.params.bind(SqlValue::Int(*n));
                    Ok(guard(format!("{sql} {} {bound}", sql_op(op))))
                }
                Literal::Float(f) => {
                    let bound = self.params.bind(SqlValue::Real(*f));
                    Ok(guard(format!("{sql} {} {bound}", sql_op(op))))
                }
                Literal::Null if column.kind == Kind::NullInt => Ok(null_compare(&sql, op)),
                _ => Err(mismatch()),
            },
            Kind::Bool => match literal {
                Literal::Bool(b) => Ok(format!("{sql} {} {}", sql_op(op), i64::from(*b))),
                _ => Err(mismatch()),
            },
            Kind::Date | Kind::NullDate => {
                let date = match literal {
                    Literal::Date(date) => date.clone(),
                    Literal::Str(text) => Date::parse(text).map_err(|_| mismatch())?,
                    Literal::Null if column.kind == Kind::NullDate => {
                        return Ok(null_compare(&sql, op));
                    }
                    _ => return Err(mismatch()),
                };
                let bound = self
                    .params
                    .bind(SqlValue::Text(date.canonical().to_string()));
                Ok(guard(format!(
                    "julianday({sql}) {} julianday({bound})",
                    sql_op(op)
                )))
            }
            Kind::Json | Kind::FmValue | Kind::Value => {
                unreachable!("dynamic columns are handled above")
            }
        }
    }

    fn dynamic(
        &mut self,
        type_sql: &str,
        value_sql: &str,
        op: CompareOp,
        literal: &Literal,
    ) -> String {
        if op == CompareOp::Ne {
            let eq = self.dynamic(type_sql, value_sql, CompareOp::Eq, literal);
            return format!("({type_sql} IS NOT NULL AND NOT {eq})");
        }
        let op_sql = sql_op(op);
        match literal {
            Literal::Null => format!("({type_sql} IS 'null')"),
            Literal::Bool(b) => format!("({type_sql} IS '{}')", if *b { "true" } else { "false" }),
            Literal::Str(text) => {
                let bound = self.params.bind(SqlValue::Text(text.clone()));
                format!("({type_sql} IS 'text' AND {value_sql} {op_sql} {bound})")
            }
            Literal::Int(n) => {
                let bound = self.params.bind(SqlValue::Int(*n));
                format!(
                    "(({type_sql} IS 'integer' OR {type_sql} IS 'real') AND {value_sql} {op_sql} {bound})"
                )
            }
            Literal::Float(f) => {
                let bound = self.params.bind(SqlValue::Real(*f));
                format!(
                    "(({type_sql} IS 'integer' OR {type_sql} IS 'real') AND {value_sql} {op_sql} {bound})"
                )
            }
            Literal::Date(date) => {
                let bound = self
                    .params
                    .bind(SqlValue::Text(date.canonical().to_string()));
                format!(
                    "({type_sql} IS 'text' AND {value_sql} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' AND {value_sql} {op_sql} {bound})"
                )
            }
        }
    }

    fn list(
        &mut self,
        column: &Column,
        op: CompareOp,
        literals: &[Literal],
        every: bool,
    ) -> Result<String, PlanError> {
        let Some((base, path)) = column.list_sql() else {
            return Err(PlanError::BadOperator(format!(
                "{} is not a list",
                column.name
            )));
        };
        for literal in literals {
            if is_ordering(op) && matches!(literal, Literal::Null | Literal::Bool(_)) {
                return Err(PlanError::BadOperator(format!(
                    "{} cannot be ordered against {}",
                    column.name,
                    literal_name(literal)
                )));
            }
        }
        let element = any_of(
            literals
                .iter()
                .map(|literal| self.dynamic("j.type", "j.value", op, literal))
                .collect(),
        );
        let is_array = format!("json_type({base}, '{path}') IS 'array'");
        Ok(if every {
            format!(
                "({is_array} AND NOT EXISTS (SELECT 1 FROM json_each({base}, '{path}') j WHERE NOT {element}))"
            )
        } else {
            format!(
                "({is_array} AND EXISTS (SELECT 1 FROM json_each({base}, '{path}') j WHERE {element}))"
            )
        })
    }

    fn text(
        &mut self,
        column: &Column,
        mode: TextMatch,
        needle: &str,
    ) -> Result<String, PlanError> {
        let value = column.value_sql();
        let guard = match (column.kind, column.type_sql()) {
            (Kind::Text, _) => None,
            (Kind::NullText, _) => Some(format!("{value} IS NOT NULL")),
            (_, Some(type_sql)) => Some(format!("{type_sql} IS 'text'")),
            _ => {
                return Err(PlanError::BadOperator(format!(
                    "{} is not text",
                    column.name
                )));
            }
        };
        let needle = super::schema::fold(needle);
        let body = if needle.is_empty() {
            "1".to_string()
        } else {
            let length = needle.chars().count() as i64;
            let bound = self.params.bind(SqlValue::Text(needle));
            match mode {
                TextMatch::Contains => format!("instr(ddd_fold({value}), {bound}) > 0"),
                TextMatch::StartsWith => format!("instr(ddd_fold({value}), {bound}) = 1"),
                TextMatch::EndsWith => format!("substr(ddd_fold({value}), -{length}) = {bound}"),
            }
        };
        Ok(match guard {
            Some(guard) => format!("({guard} AND {body})"),
            None => format!("({body})"),
        })
    }
}

fn id_column(scope: &Scope, field: &str) -> Result<Column, PlanError> {
    let column = scope.resolve(field)?;
    if !matches!(column.kind, Kind::Text | Kind::NullText) {
        return Err(PlanError::BadOperator(format!(
            "{field} is not a document id"
        )));
    }
    Ok(column)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Presence {
    Missing,
    Exists,
    Null,
}

fn presence(column: &Column, want: Presence) -> String {
    match (column.type_sql(), column.kind) {
        (Some(_), Kind::FmValue) => match want {
            Presence::Missing => "0".into(),
            Presence::Exists => "1".into(),
            Presence::Null => format!(
                "({} IS 'null')",
                column.companion.as_deref().unwrap_or("kind")
            ),
        },
        (Some(type_sql), _) => match want {
            Presence::Missing => format!("({type_sql} IS NULL)"),
            Presence::Exists => format!("({type_sql} IS NOT NULL)"),
            Presence::Null => format!("({type_sql} IS 'null')"),
        },
        (None, kind) if kind.nullable() && kind != Kind::JsonMap => match want {
            Presence::Missing | Presence::Null => format!("({} IS NULL)", column.sql),
            Presence::Exists => format!("({} IS NOT NULL)", column.sql),
        },
        (None, _) => match want {
            Presence::Missing | Presence::Null => "0".into(),
            Presence::Exists => "1".into(),
        },
    }
}

fn any_of(parts: Vec<String>) -> String {
    if parts.is_empty() {
        "0".into()
    } else {
        format!("({})", parts.join(" OR "))
    }
}

fn null_compare(sql: &str, op: CompareOp) -> String {
    match op {
        CompareOp::Eq => format!("({sql} IS NULL)"),
        _ => format!("({sql} IS NOT NULL)"),
    }
}

fn is_ordering(op: CompareOp) -> bool {
    matches!(
        op,
        CompareOp::Lt | CompareOp::Lte | CompareOp::Gt | CompareOp::Gte
    )
}

fn sql_op(op: CompareOp) -> &'static str {
    match op {
        CompareOp::Eq => "=",
        CompareOp::Ne => "!=",
        CompareOp::Lt => "<",
        CompareOp::Lte => "<=",
        CompareOp::Gt => ">",
        CompareOp::Gte => ">=",
    }
}

fn literal_name(literal: &Literal) -> &'static str {
    match literal {
        Literal::Bool(_) => "a boolean",
        Literal::Int(_) | Literal::Float(_) => "a number",
        Literal::Str(_) => "a string",
        Literal::Date(_) => "a date",
        Literal::Null => "null",
    }
}
