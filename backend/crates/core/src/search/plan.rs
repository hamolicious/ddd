use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::filter::{CompareOp, Literal, TextMatch};

use super::text::{TextExpr, TextField};

pub const MAX_STAGES: usize = 32;
pub const MAX_SORT_KEYS: usize = 8;
pub const MAX_LIMIT: u64 = 1_000_000;
pub const MAX_CONDITIONS: usize = 256;
pub const MAX_CONDITION_DEPTH: usize = 16;
pub const MAX_SUBQUERY_DEPTH: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    #[default]
    Documents,
    Fm,
    Links,
    Tasks,
    Attachments,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Documents => "documents",
            Source::Fm => "fm",
            Source::Links => "links",
            Source::Tasks => "tasks",
            Source::Attachments => "attachments",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrashScope {
    #[default]
    Live,
    Trashed,
    All,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelectItem {
    pub field: String,
    #[serde(default, rename = "as", skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
}

impl SelectItem {
    pub fn name(&self) -> &str {
        self.alias.as_deref().unwrap_or(&self.field)
    }
}

fn default_field_id() -> String {
    "id".to_string()
}

fn is_default_field_id(field: &str) -> bool {
    field == "id"
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Aggregate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(default, rename = "as", skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cond {
    All,
    None,
    And(Vec<Cond>),
    Or(Vec<Cond>),
    Not(Box<Cond>),
    Cmp {
        field: String,
        op: CompareOp,
        value: Literal,
    },
    In {
        field: String,
        values: Vec<Literal>,
    },
    Contains {
        field: String,
        value: Literal,
    },
    ContainsAny {
        field: String,
        values: Vec<Literal>,
    },
    Any {
        field: String,
        op: CompareOp,
        value: Literal,
    },
    Every {
        field: String,
        op: CompareOp,
        value: Literal,
    },
    Missing {
        field: String,
    },
    IsNull {
        field: String,
    },
    Exists {
        field: String,
    },
    Text {
        field: String,
        mode: TextMatch,
        value: String,
    },
    ChildOf {
        #[serde(
            default = "default_field_id",
            skip_serializing_if = "is_default_field_id"
        )]
        field: String,
        of: String,
        #[serde(default)]
        deep: bool,
    },
    ParentOf {
        #[serde(
            default = "default_field_id",
            skip_serializing_if = "is_default_field_id"
        )]
        field: String,
        of: String,
    },
    InPlan {
        field: String,
        plan: Box<Plan>,
    },
}

impl Cond {
    fn measure(&self, depth: usize, nodes: &mut usize) -> Result<(), PlanError> {
        *nodes += 1;
        if depth > MAX_CONDITION_DEPTH {
            return Err(PlanError::Limit(format!(
                "conditions nest deeper than {MAX_CONDITION_DEPTH}"
            )));
        }
        if *nodes > MAX_CONDITIONS {
            return Err(PlanError::Limit(format!(
                "more than {MAX_CONDITIONS} conditions"
            )));
        }
        match self {
            Cond::And(children) | Cond::Or(children) => {
                for child in children {
                    child.measure(depth + 1, nodes)?;
                }
                Ok(())
            }
            Cond::Not(child) => child.measure(depth + 1, nodes),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FuzzyStage {
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<TextField>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_distance: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Text(String),
    Match(TextExpr),
    Snippets,
    Where(Cond),
    Sort(Vec<String>),
    Select(Vec<SelectItem>),
    Distinct(Vec<String>),
    GroupBy(Vec<String>),
    Count(Aggregate),
    Sum(Aggregate),
    Min(Aggregate),
    Max(Aggregate),
    Avg(Aggregate),
    Collect(Aggregate),
    Limit(u64),
    Offset(u64),
    Cursor(String),
    WithTotal,
    WithContent,
    Trash(TrashScope),
    Fuzzy(FuzzyStage),
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Plan {
    #[serde(default)]
    pub source: Source,
    #[serde(default)]
    pub stages: Vec<Stage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub enum PlanError {
    #[error("malformed plan: {0}")]
    Malformed(String),
    #[error("unknown field: {0}")]
    UnknownField(String),
    #[error("{0}")]
    BadOperator(String),
    #[error("{0}")]
    BadValue(String),
    #[error("{0}")]
    BadStage(String),
    #[error("limit exceeded: {0}")]
    Limit(String),
}

impl Stage {
    pub fn is_aggregate(&self) -> bool {
        matches!(
            self,
            Stage::Count(_)
                | Stage::Sum(_)
                | Stage::Min(_)
                | Stage::Max(_)
                | Stage::Avg(_)
                | Stage::Collect(_)
        )
    }
}

impl Plan {
    pub fn from_json_str(input: &str) -> Result<Plan, PlanError> {
        let plan: Plan =
            serde_json::from_str(input).map_err(|e| PlanError::Malformed(e.to_string()))?;
        plan.validate()?;
        Ok(plan)
    }

    pub fn validate(&self) -> Result<(), PlanError> {
        if self.stages.len() > MAX_STAGES {
            return Err(PlanError::Limit(format!("more than {MAX_STAGES} stages")));
        }
        let mut offset = false;
        let mut cursor = false;
        for (index, stage) in self.stages.iter().enumerate() {
            match stage {
                Stage::GroupBy(fields) if fields.is_empty() => {
                    return Err(PlanError::BadStage(
                        "groupBy needs at least one field".into(),
                    ));
                }
                Stage::GroupBy(_)
                    if !self.stages.get(index + 1).is_some_and(Stage::is_aggregate) =>
                {
                    return Err(PlanError::BadStage(
                        "groupBy must be followed by an aggregate".into(),
                    ));
                }
                Stage::Sum(a)
                | Stage::Min(a)
                | Stage::Max(a)
                | Stage::Avg(a)
                | Stage::Collect(a)
                    if a.field.is_none() =>
                {
                    return Err(PlanError::BadStage("this aggregate needs a field".into()));
                }
                Stage::Where(cond) => cond.measure(0, &mut 0)?,
                Stage::Match(expr) => expr.check()?,
                Stage::Sort(keys) if keys.len() > MAX_SORT_KEYS => {
                    return Err(PlanError::Limit(format!(
                        "more than {MAX_SORT_KEYS} sort keys"
                    )));
                }
                Stage::Sort(keys) if keys.is_empty() => {
                    return Err(PlanError::BadStage("sort needs at least one key".into()));
                }
                Stage::Select(items) if items.is_empty() => {
                    return Err(PlanError::BadStage(
                        "select needs at least one field".into(),
                    ));
                }
                Stage::Limit(n) if *n > MAX_LIMIT => {
                    return Err(PlanError::Limit(format!("limit is above {MAX_LIMIT}")));
                }
                Stage::Fuzzy(_) if index + 1 != self.stages.len() => {
                    return Err(PlanError::BadStage("fuzzy must be the last stage".into()));
                }
                Stage::Fuzzy(fuzzy) if fuzzy.limit.is_some_and(|n| n > MAX_LIMIT) => {
                    return Err(PlanError::Limit(format!("limit is above {MAX_LIMIT}")));
                }
                Stage::Offset(_) => offset = true,
                Stage::Cursor(_) => cursor = true,
                Stage::WithContent if self.source != Source::Documents => {
                    return Err(PlanError::BadStage(
                        "withContent applies to documents only".into(),
                    ));
                }
                _ => {}
            }
        }
        if offset && cursor {
            return Err(PlanError::BadStage(
                "cursor and offset cannot be combined".into(),
            ));
        }
        Ok(())
    }
}
