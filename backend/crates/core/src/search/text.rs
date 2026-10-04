use serde::{Deserialize, Serialize};

use super::plan::PlanError;

pub const MAX_TEXT_BYTES: usize = 1024;
pub const MAX_QUERY_TERMS: usize = 32;
pub const FIELD_WEIGHTS: [f64; 3] = [3.0, 1.0, 2.0];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextField {
    Title,
    Content,
    Fm,
}

impl TextField {
    pub fn column(self) -> &'static str {
        match self {
            TextField::Title => "title",
            TextField::Content => "content",
            TextField::Fm => "fm",
        }
    }

    fn parse(name: &str) -> Option<TextField> {
        match name.to_ascii_lowercase().as_str() {
            "title" => Some(TextField::Title),
            "content" => Some(TextField::Content),
            "fm" => Some(TextField::Fm),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextExpr {
    Term(String),
    Prefix(String),
    Phrase(String),
    And(Vec<TextExpr>),
    Or(Vec<TextExpr>),
    Not(Box<TextExpr>),
    In {
        field: TextField,
        expr: Box<TextExpr>,
    },
}

impl TextExpr {
    pub fn terms(&self) -> Vec<String> {
        fn walk(expr: &TextExpr, negated: bool, out: &mut Vec<String>) {
            match expr {
                TextExpr::Term(word) | TextExpr::Prefix(word) | TextExpr::Phrase(word) => {
                    if !negated {
                        for token in tokens(word) {
                            if !out.contains(&token) {
                                out.push(token);
                            }
                        }
                    }
                }
                TextExpr::And(children) | TextExpr::Or(children) => {
                    for child in children {
                        walk(child, negated, out);
                    }
                }
                TextExpr::Not(child) => walk(child, !negated, out),
                TextExpr::In { expr, .. } => walk(expr, negated, out),
            }
        }
        let mut out = Vec::new();
        walk(self, false, &mut out);
        out
    }

    fn count_terms(&self) -> usize {
        match self {
            TextExpr::Term(_) | TextExpr::Prefix(_) | TextExpr::Phrase(_) => 1,
            TextExpr::And(children) | TextExpr::Or(children) => {
                children.iter().map(TextExpr::count_terms).sum()
            }
            TextExpr::Not(child) => child.count_terms(),
            TextExpr::In { expr, .. } => expr.count_terms(),
        }
    }

    pub fn check(&self) -> Result<(), PlanError> {
        if self.count_terms() > MAX_QUERY_TERMS {
            return Err(PlanError::Limit(format!(
                "more than {MAX_QUERY_TERMS} search terms"
            )));
        }
        Ok(())
    }
}

fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_lowercase)
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Word(String),
    Phrase(String),
    Field(TextField),
    Minus,
    Or,
    Open,
    Close,
}

fn lex(input: &str) -> Vec<Token> {
    let chars: Vec<char> = input.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        match c {
            '"' => {
                let start = i + 1;
                let end = chars[start..]
                    .iter()
                    .position(|c| *c == '"')
                    .map(|p| start + p);
                let text: String = chars[start..end.unwrap_or(chars.len())].iter().collect();
                match end {
                    Some(end) => {
                        out.push(Token::Phrase(text));
                        i = end + 1;
                    }
                    None => {
                        for word in text.split_whitespace() {
                            out.push(Token::Word(word.to_string()));
                        }
                        i = chars.len();
                    }
                }
            }
            '(' => {
                out.push(Token::Open);
                i += 1;
            }
            ')' => {
                out.push(Token::Close);
                i += 1;
            }
            '-' if chars.get(i + 1).is_some_and(|n| !n.is_whitespace()) => {
                out.push(Token::Minus);
                i += 1;
            }
            _ => {
                let start = i;
                while i < chars.len()
                    && !chars[i].is_whitespace()
                    && !matches!(chars[i], '"' | '(' | ')')
                {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect();
                if word == "OR" {
                    out.push(Token::Or);
                } else if let Some((name, rest)) = word.split_once(':')
                    && let Some(field) = TextField::parse(name)
                {
                    if rest.is_empty() {
                        if i < chars.len() && !chars[i].is_whitespace() {
                            out.push(Token::Field(field));
                        } else {
                            out.push(Token::Word(name.to_string()));
                        }
                    } else {
                        out.push(Token::Field(field));
                        out.push(Token::Word(rest.to_string()));
                    }
                } else {
                    out.push(Token::Word(word));
                }
            }
        }
    }
    out
}

struct Parser {
    tokens: Vec<Token>,
    at: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.at)
    }

    fn or(&mut self, depth: usize) -> Option<TextExpr> {
        let mut alternatives = Vec::new();
        loop {
            if let Some(expr) = self.and(depth) {
                alternatives.push(expr);
            }
            match self.peek() {
                Some(Token::Or) => self.at += 1,
                _ => break,
            }
        }
        collapse(alternatives, TextExpr::Or)
    }

    fn and(&mut self, depth: usize) -> Option<TextExpr> {
        let mut parts = Vec::new();
        while let Some(token) = self.peek() {
            match token {
                Token::Or => break,
                Token::Close if depth > 0 => break,
                Token::Close => self.at += 1,
                _ => {
                    if let Some(expr) = self.unary(depth) {
                        parts.push(expr);
                    }
                }
            }
        }
        collapse(parts, TextExpr::And)
    }

    fn unary(&mut self, depth: usize) -> Option<TextExpr> {
        if self.peek() == Some(&Token::Minus) {
            self.at += 1;
            return self.atom(depth).map(|expr| TextExpr::Not(Box::new(expr)));
        }
        self.atom(depth)
    }

    fn atom(&mut self, depth: usize) -> Option<TextExpr> {
        let token = self.tokens.get(self.at).cloned()?;
        self.at += 1;
        match token {
            Token::Word(word) => word_expr(&word),
            Token::Phrase(text) => (!tokens(&text).is_empty()).then_some(TextExpr::Phrase(text)),
            Token::Field(field) => self.atom(depth).map(|expr| TextExpr::In {
                field,
                expr: Box::new(expr),
            }),
            Token::Open => {
                let inner = self.or(depth + 1);
                if self.peek() == Some(&Token::Close) {
                    self.at += 1;
                }
                inner
            }
            Token::Minus | Token::Or | Token::Close => None,
        }
    }
}

fn word_expr(word: &str) -> Option<TextExpr> {
    if let Some(stem) = word.strip_suffix('*') {
        return (!tokens(stem).is_empty()).then(|| TextExpr::Prefix(stem.to_string()));
    }
    (!tokens(word).is_empty()).then(|| TextExpr::Term(word.to_string()))
}

fn collapse(mut parts: Vec<TextExpr>, wrap: fn(Vec<TextExpr>) -> TextExpr) -> Option<TextExpr> {
    match parts.len() {
        0 => None,
        1 => parts.pop(),
        _ => Some(wrap(parts)),
    }
}

fn prefix_last(expr: &mut TextExpr) -> bool {
    match expr {
        TextExpr::Term(word) => {
            *expr = TextExpr::Prefix(std::mem::take(word));
            true
        }
        TextExpr::Prefix(_) => true,
        TextExpr::Phrase(_) | TextExpr::Not(_) => false,
        TextExpr::And(children) | TextExpr::Or(children) => {
            children.last_mut().is_some_and(prefix_last)
        }
        TextExpr::In { expr, .. } => prefix_last(expr),
    }
}

pub fn parse_text(input: &str) -> Result<Option<TextExpr>, PlanError> {
    if input.len() > MAX_TEXT_BYTES {
        return Err(PlanError::Limit(format!(
            "search text is over {MAX_TEXT_BYTES} bytes"
        )));
    }
    let mut parser = Parser {
        tokens: lex(input),
        at: 0,
    };
    let mut expr = parser.or(0);
    if let Some(expr) = &mut expr {
        expr.check()?;
        if !input.ends_with(char::is_whitespace) {
            prefix_last(expr);
        }
    }
    Ok(expr)
}

fn quote(word: &str) -> String {
    format!("\"{}\"", word.replace('"', "\"\""))
}

pub enum Fts {
    Query(String),
    Unrankable,
}

pub fn to_fts(expr: &TextExpr) -> Fts {
    match fts(expr) {
        Some(query) => Fts::Query(query),
        None => Fts::Unrankable,
    }
}

fn fts(expr: &TextExpr) -> Option<String> {
    match expr {
        TextExpr::Term(word) => Some(quote(word)),
        TextExpr::Prefix(word) => Some(format!("{} *", quote(word))),
        TextExpr::Phrase(text) => Some(quote(text)),
        TextExpr::In { field, expr } => Some(format!("{{{}}} : ({})", field.column(), fts(expr)?)),
        TextExpr::Or(children) => {
            let parts = children.iter().map(fts).collect::<Option<Vec<_>>>()?;
            Some(format!("({})", parts.join(" OR ")))
        }
        TextExpr::And(children) => {
            let mut positive = Vec::new();
            let mut negative = Vec::new();
            for child in children {
                match child {
                    TextExpr::Not(inner) => negative.push(fts(inner)?),
                    other => positive.push(fts(other)?),
                }
            }
            if positive.is_empty() {
                return None;
            }
            let mut query = format!("({})", positive.join(" AND "));
            for part in negative {
                query = format!("({query} NOT {part})");
            }
            Some(query)
        }
        TextExpr::Not(_) => None,
    }
}

pub enum Leafy {
    Match(String),
    And(Vec<Leafy>),
    Or(Vec<Leafy>),
    Not(Box<Leafy>),
}

pub fn to_leaves(expr: &TextExpr) -> Leafy {
    leaves_in(expr, None)
}

fn leaves_in(expr: &TextExpr, field: Option<TextField>) -> Leafy {
    let scoped = |query: String| match field {
        Some(field) => format!("{{{}}} : ({query})", field.column()),
        None => query,
    };
    match expr {
        TextExpr::And(children) => Leafy::And(
            children
                .iter()
                .map(|child| leaves_in(child, field))
                .collect(),
        ),
        TextExpr::Or(children) => Leafy::Or(
            children
                .iter()
                .map(|child| leaves_in(child, field))
                .collect(),
        ),
        TextExpr::Not(child) => Leafy::Not(Box::new(leaves_in(child, field))),
        TextExpr::In { field: inner, expr } => match fts(expr) {
            Some(query) => Leafy::Match(format!("{{{}}} : ({query})", inner.column())),
            None => leaves_in(expr, Some(*inner)),
        },
        leaf => Leafy::Match(scoped(fts(leaf).unwrap_or_default())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &str) -> TextExpr {
        parse_text(input).unwrap().unwrap()
    }

    fn term(word: &str) -> TextExpr {
        TextExpr::Term(word.into())
    }

    #[test]
    fn terms_are_anded_and_the_last_one_is_a_prefix() {
        assert_eq!(
            parse("invoice acme"),
            TextExpr::And(vec![term("invoice"), TextExpr::Prefix("acme".into())])
        );
        assert_eq!(
            parse("invoice acme "),
            TextExpr::And(vec![term("invoice"), term("acme")])
        );
    }

    #[test]
    fn operators_phrases_fields_and_groups() {
        assert_eq!(
            parse("invoice -draft \"acme corp\" "),
            TextExpr::And(vec![
                term("invoice"),
                TextExpr::Not(Box::new(term("draft"))),
                TextExpr::Phrase("acme corp".into()),
            ])
        );
        assert_eq!(parse("a OR b "), TextExpr::Or(vec![term("a"), term("b")]));
        assert_eq!(
            parse("title:q3* (x OR y) "),
            TextExpr::And(vec![
                TextExpr::In {
                    field: TextField::Title,
                    expr: Box::new(TextExpr::Prefix("q3".into()))
                },
                TextExpr::Or(vec![term("x"), term("y")]),
            ])
        );
    }

    #[test]
    fn broken_input_degrades_to_plain_terms() {
        assert_eq!(
            parse("\"acme corp"),
            TextExpr::And(vec![term("acme"), TextExpr::Prefix("corp".into())])
        );
        assert_eq!(
            parse("title: x "),
            TextExpr::And(vec![term("title"), term("x")])
        );
        assert_eq!(parse("OR a OR "), term("a"));
        assert_eq!(
            parse("(a b ) ) "),
            TextExpr::And(vec![term("a"), term("b")])
        );
        assert_eq!(parse("- a "), term("a"));
        assert_eq!(parse("re-use "), term("re-use"));
        assert!(parse_text("   ").unwrap().is_none());
        assert!(parse_text("\"\" ( ) -").unwrap().is_none());
    }

    #[test]
    fn limits_are_errors() {
        assert!(matches!(
            parse_text(&"a".repeat(1025)),
            Err(PlanError::Limit(_))
        ));
        let many = (0..33)
            .map(|i| format!("w{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert!(matches!(parse_text(&many), Err(PlanError::Limit(_))));
    }

    #[test]
    fn compiles_to_fts5_syntax() {
        let Fts::Query(query) = to_fts(&parse("invoice -draft \"acme corp\" title:q3")) else {
            panic!("rankable");
        };
        assert_eq!(
            query,
            "((\"invoice\" AND \"acme corp\" AND {title} : (\"q3\" *)) NOT \"draft\")"
        );
        assert!(matches!(to_fts(&parse("-draft")), Fts::Unrankable));
        assert!(matches!(to_fts(&parse("a OR -b")), Fts::Unrankable));
    }

    #[test]
    fn a_negated_term_keeps_its_field() {
        let expr = TextExpr::In {
            field: TextField::Title,
            expr: Box::new(TextExpr::Not(Box::new(TextExpr::Term("x".into())))),
        };
        let Leafy::Not(inner) = to_leaves(&expr) else {
            panic!("a negation");
        };
        let Leafy::Match(query) = *inner else {
            panic!("a match");
        };
        assert_eq!(query, "{title} : (\"x\")");
    }

    #[test]
    fn positive_terms_are_collected_once() {
        assert_eq!(
            parse("Invoice -draft \"acme corp\" invoice").terms(),
            vec!["invoice", "acme", "corp"]
        );
    }
}
