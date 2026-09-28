//! The resolver (PLUGIN-PROTOCOLS §6, §6a, §6b): who feeds whom, in what seat, and in
//! what order plugins activate.
//!
//! **Auto-wire by default, store only the overrides.** Every consumed port is wired to
//! every compatible provided port the rules allow, and [`Wiring`] records only what a
//! person changed: pins (`bind`), cut and added wires, seat order, and unplugged plugins.
//!
//! The rules, in the order they apply:
//!
//! - A wire joins a provided port to a consumed port of the same kind. Automatic wires need
//!   the same protocol id, a version in range, and shapes that fit (§6b). A slot may also be
//!   wired **by shape** across protocols, by hand only (`add`). Services and events wire
//!   only within one protocol id.
//! - A plugin may feed its own slots and events, never consume its own service.
//! - A service port takes one provider: its pin, else the only fitting one, else the base
//!   distribution's, else the first by plugin id (with a warning). A pinned provider that is
//!   missing falls back the same way, with a warning; the pin stays stored.
//! - A slot port seats every fitting provider: `order[host]` first, then each provider
//!   port's `order` hint, then plugin id. `seats: 1` shows only the first; the rest are
//!   on the bench. Event ports hear every fitting emitter.
//! - A required service port with no provider skips its plugin, and so does a provider
//!   that is skipped. An optional port just stays unbound.
//! - Activation is Kahn's algorithm over service wires, **a layer at a time with each
//!   layer sorted by id**. A cycle through optional wires is broken by dropping them; any
//!   other cycle skips every plugin in it.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::semver;
use super::{ProtocolKind, ProtocolPackage, Shape, Wiring, fits, split_port, split_wire, wire};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

fn yes() -> bool {
    true
}

/// What the resolver needs to know about one installed plugin: its manifest's ports, and
/// whether it may run at all.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDescriptor {
    pub id: String,
    #[serde(default)]
    pub version: String,
    /// Part of the base distribution: what `?safe=1` keeps, and the preferred provider when
    /// several fit.
    #[serde(default)]
    pub base: bool,
    /// Approved and switched on. `false` for a pending, disabled or failed plugin.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Declares `"hot": true` (§6c).
    #[serde(default)]
    pub hot: bool,
    /// Has a frontend half. A backend-only plugin never activates in a page.
    #[serde(default = "yes")]
    pub frontend: bool,
    #[serde(default)]
    pub provides: BTreeMap<String, ProvidedPort>,
    #[serde(default)]
    pub consumes: BTreeMap<String, ConsumedPort>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidedPort {
    /// `lm/navbar.item@1.0.0`.
    pub protocol: String,
    /// The default-seat hint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumedPort {
    /// `lm/router@^1.0`.
    pub protocol: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs: Option<Vec<String>>,
    #[serde(default)]
    pub optional: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seats: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveInput {
    pub plugins: Vec<PluginDescriptor>,
    #[serde(default)]
    pub protocols: Vec<ProtocolPackage>,
    #[serde(default)]
    pub wiring: Wiring,
    /// `?safe=1`: only the base distribution activates.
    #[serde(default)]
    pub base_only: bool,
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkipReason {
    /// Unplugged, not enabled, or left out by `?safe=1`. The one reason that is not a problem.
    Disabled,
    /// A required service port has nothing to bind to.
    MissingService,
    /// A required service's provider is itself skipped.
    ServiceSkipped,
    /// In, or behind, a cycle of service wires.
    Cycle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub plugin: String,
    pub reason: SkipReason,
    /// One sentence, for the aggregated notice and the editor.
    pub detail: String,
}

/// One wire the resolver made.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedWire {
    /// The provided port, `plugin:port`.
    pub from: String,
    /// The consumed port.
    pub to: String,
    pub kind: ProtocolKind,
    /// The consumer's protocol id.
    pub protocol: String,
    /// The provider's protocol id; differs from `protocol` only for a by-shape wire.
    pub offer_protocol: String,
    /// Wired by hand across protocols (§6b): a person vouched for the meaning.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub by_shape: bool,
    /// Slots: the 1-based seat. `0` for services and events.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub seat: u32,
    /// Slots with `seats: 1`: not the one shown.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bench: bool,
    /// One end does not activate, so the wire carries nothing.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub inactive: bool,
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

/// `provider` activates before `consumer`; when `required`, a skipped provider skips it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationEdge {
    pub provider: String,
    pub consumer: String,
    pub required: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: Severity,
    /// Stable: `missing-service`, `unknown-need`, `several-providers`, `pin-missing`,
    /// `no-fit`, `unheard`, `unknown-protocol`, `duplicate-port`, `cycle`,
    /// `optional-cycle`.
    pub code: String,
    pub plugin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<String>,
    /// One sentence for a tooltip or a log line.
    pub message: String,
}

/// What a port's badge says in the editor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortStatus {
    /// `pinned`, `providers`, `pin-missing`, `missing`, `optional`, `benched`, `unheard`,
    /// `no-fit`.
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    /// Activation order of the plugins that activate.
    pub order: Vec<String>,
    pub skipped: Vec<Skipped>,
    /// Every wire, inactive ones included, for drawing.
    pub wires: Vec<ResolvedWire>,
    /// Service port → the provided port bound to it.
    pub bindings: BTreeMap<String, String>,
    /// Slot host port → the provided ports in its seats, in order (the bench left out).
    pub seats: BTreeMap<String, Vec<String>>,
    /// Slot host port → the provided ports on its bench.
    pub bench: BTreeMap<String, Vec<String>>,
    /// Event listener port → the emitting ports it hears.
    pub listeners: BTreeMap<String, Vec<String>>,
    pub activation: Vec<ActivationEdge>,
    pub diagnostics: Vec<Diagnostic>,
    pub status: BTreeMap<String, PortStatus>,
}

impl Resolution {
    /// Plugins that activate.
    pub fn active(&self) -> BTreeSet<&str> {
        self.order.iter().map(String::as_str).collect()
    }

    pub fn errors(&self) -> usize {
        self.diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.severity == Severity::Error)
            .count()
    }
}

// ---------------------------------------------------------------------------
// Protocol lookups
// ---------------------------------------------------------------------------

struct Registry<'a> {
    by_id: BTreeMap<&'a str, Vec<&'a ProtocolPackage>>,
}

impl<'a> Registry<'a> {
    fn new(protocols: &'a [ProtocolPackage]) -> Self {
        let mut by_id: BTreeMap<&str, Vec<&ProtocolPackage>> = BTreeMap::new();
        for package in protocols {
            by_id.entry(package.id.as_str()).or_default().push(package);
        }
        for versions in by_id.values_mut() {
            versions.sort_by(|a, b| semver::compare(&a.version, &b.version));
        }
        Registry { by_id }
    }

    fn kind(&self, id: &str) -> Option<ProtocolKind> {
        self.by_id
            .get(id)
            .and_then(|versions| versions.first())
            .map(|p| p.kind)
    }

    fn exact(&self, id: &str, version: &str) -> Option<&'a ProtocolPackage> {
        self.by_id
            .get(id)?
            .iter()
            .copied()
            .find(|package| package.version == version)
    }

    /// The oldest known version a range admits: what a consumer written against that range
    /// can rely on.
    fn floor(&self, id: &str, range: &str) -> Option<&'a ProtocolPackage> {
        self.by_id
            .get(id)?
            .iter()
            .copied()
            .find(|package| semver::satisfies(&package.version, range))
    }
}

/// `lm/router@^1.0` → `("lm/router", "^1.0")`.
pub fn parse_ref(reference: &str) -> Option<(&str, &str)> {
    reference.split_once('@')
}

/// A consumer's requirement: the protocol's shape at the oldest version in range, cut down
/// to `needs`.
fn need_shape(registry: &Registry, port: &ConsumedPort) -> Option<Shape> {
    let (id, range) = parse_ref(&port.protocol)?;
    let package = registry.floor(id, range)?;
    Some(package.shape.narrowed(port.needs.as_deref()))
}

/// A provider's offer: the whole protocol at the exact version it claims.
fn offer_shape<'a>(registry: &Registry<'a>, port: &ProvidedPort) -> Option<&'a Shape> {
    let (id, version) = parse_ref(&port.protocol)?;
    registry.exact(id, version).map(|package| &package.shape)
}

/// Can provided port `offer` of `provider` feed consumed port `need` of `consumer`?
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    /// The types fit: a wire may exist.
    pub ok: bool,
    /// Same protocol id.
    pub same: bool,
    /// Same protocol, version in range, types fit: wired automatically.
    pub auto: bool,
    /// Why not, when not.
    pub reasons: Vec<String>,
}

fn pair(
    registry: &Registry,
    provider: &str,
    offer: &ProvidedPort,
    consumer: &str,
    need: &ConsumedPort,
) -> Option<Pairing> {
    let (offer_id, offer_version) = parse_ref(&offer.protocol)?;
    let (need_id, range) = parse_ref(&need.protocol)?;
    let offer_kind = registry.kind(offer_id)?;
    let need_kind = registry.kind(need_id)?;
    let refuse = |reason: String, same: bool| {
        Some(Pairing {
            ok: false,
            same,
            auto: false,
            reasons: vec![reason],
        })
    };
    if offer_kind != need_kind {
        return refuse(
            format!(
                "a {} port can't feed a {} port",
                kind_name(offer_kind),
                kind_name(need_kind)
            ),
            false,
        );
    }
    if provider == consumer && offer_kind == ProtocolKind::Service {
        return refuse("a plugin can't consume its own service".to_string(), false);
    }
    let same = offer_id == need_id;
    if !same && offer_kind != ProtocolKind::Slot {
        return refuse(
            format!(
                "{} ports only wire within one protocol",
                kind_name(offer_kind)
            ),
            false,
        );
    }
    let reasons = match (offer_shape(registry, offer), need_shape(registry, need)) {
        (Some(offered), Some(needed)) => fits(offered, &needed),
        (None, _) => vec![format!(
            "{} is not a registered protocol version",
            offer.protocol
        )],
        (_, None) => vec![format!("no registered version of {need_id} is in {range}")],
    };
    let in_range = same && semver::satisfies(offer_version, range);
    let ok = reasons.is_empty();
    Some(Pairing {
        ok,
        same,
        auto: same && in_range && ok,
        reasons: if ok && same && !in_range {
            vec![format!("version {offer_version} is outside {range}")]
        } else {
            reasons
        },
    })
}

fn kind_name(kind: ProtocolKind) -> &'static str {
    match kind {
        ProtocolKind::Service => "service",
        ProtocolKind::Slot => "slot",
        ProtocolKind::Event => "event",
    }
}

fn key(plugin: &str, port: &str) -> String {
    format!("{plugin}:{port}")
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

struct Candidate<'a> {
    plugin: &'a str,
    port: &'a str,
    key: String,
    offer: &'a ProvidedPort,
    pairing: Pairing,
    base: bool,
}

impl Candidate<'_> {
    /// Default seat: the order hint, then plugin id, then port name.
    fn rank(&self) -> (f64, &str, &str) {
        (self.offer.order.unwrap_or(100.0), self.plugin, self.port)
    }
}

fn protocol_id(reference: &str) -> String {
    parse_ref(reference)
        .map(|(id, _)| id)
        .unwrap_or(reference)
        .to_string()
}

/// Resolve `input` into wires, seats and an activation order. Total: malformed ports are
/// diagnosed and left out, never a panic.
pub fn resolve(input: &ResolveInput) -> Resolution {
    let registry = Registry::new(&input.protocols);
    let wiring = &input.wiring;
    let cut: BTreeSet<&str> = wiring.cut.iter().map(String::as_str).collect();
    let add: BTreeSet<&str> = wiring.add.iter().map(String::as_str).collect();
    let mut out = Resolution::default();

    // --- who takes part --------------------------------------------------------------
    let mut plugins: Vec<&PluginDescriptor> = input.plugins.iter().collect();
    plugins.sort_by(|a, b| a.id.cmp(&b.id));
    let mut participants: Vec<&PluginDescriptor> = Vec::new();
    for plugin in &plugins {
        if !plugin.frontend {
            continue;
        }
        let why = if wiring.is_unplugged(&plugin.id) {
            Some("unplugged")
        } else if !plugin.enabled {
            Some("not enabled")
        } else if input.base_only && !plugin.base {
            Some("safe mode: base plugins only")
        } else {
            None
        };
        match why {
            Some(detail) => out.skipped.push(Skipped {
                plugin: plugin.id.clone(),
                reason: SkipReason::Disabled,
                detail: detail.to_string(),
            }),
            None => participants.push(plugin),
        }
    }

    let mut diagnose = |severity, code: &str, plugin: &str, port: Option<&str>, message: String| {
        out.diagnostics.push(Diagnostic {
            severity,
            code: code.to_string(),
            plugin: plugin.to_string(),
            port: port.map(str::to_string),
            message,
        });
    };

    // --- ports that cannot be understood ---------------------------------------------
    for plugin in &participants {
        for name in plugin.provides.keys() {
            if plugin.consumes.contains_key(name) {
                diagnose(
                    Severity::Error,
                    "duplicate-port",
                    &plugin.id,
                    Some(&key(&plugin.id, name)),
                    format!(
                        "{} · {name} is both provided and consumed; port names must be unique",
                        plugin.id
                    ),
                );
            }
        }
        for (name, port) in &plugin.provides {
            let known = parse_ref(&port.protocol).and_then(|(id, _)| registry.kind(id));
            if known.is_none() {
                diagnose(
                    Severity::Warning,
                    "unknown-protocol",
                    &plugin.id,
                    Some(&key(&plugin.id, name)),
                    format!(
                        "{} · {name} provides {}, which no installed package defines",
                        plugin.id, port.protocol
                    ),
                );
            }
        }
        for (name, port) in &plugin.consumes {
            let Some((id, _)) = parse_ref(&port.protocol) else {
                continue;
            };
            let Some(package) = registry.by_id.get(id).and_then(|v| v.last()) else {
                diagnose(
                    Severity::Warning,
                    "unknown-protocol",
                    &plugin.id,
                    Some(&key(&plugin.id, name)),
                    format!(
                        "{} · {name} consumes {}, which no installed package defines",
                        plugin.id, port.protocol
                    ),
                );
                continue;
            };
            if let (Some(needs), Some(fields)) = (port.needs.as_ref(), package.shape.fields()) {
                let unknown: Vec<&str> = needs
                    .iter()
                    .filter(|need| !fields.contains_key(*need))
                    .map(String::as_str)
                    .collect();
                if !unknown.is_empty() {
                    diagnose(
                        Severity::Error,
                        "unknown-need",
                        &plugin.id,
                        Some(&key(&plugin.id, name)),
                        format!(
                            "{} · {name} needs `{}`, which {id} doesn't have",
                            plugin.id,
                            unknown.join("`, `")
                        ),
                    );
                }
            }
        }
    }

    // --- wire every consumed port ------------------------------------------------------
    let mut missing: BTreeMap<String, String> = BTreeMap::new(); // plugin → detail
    let mut no_fit: BTreeSet<String> = BTreeSet::new();
    for consumer in &participants {
        for (name, need) in &consumer.consumes {
            let to = key(&consumer.id, name);
            let Some((need_id, range)) = parse_ref(&need.protocol) else {
                continue;
            };
            // An unknown protocol is diagnosed above and wires nothing. Its kind is unknown
            // too, so it never skips the plugin: only a service's absence does that.
            let Some(kind) = registry.kind(need_id) else {
                continue;
            };
            let mut candidates: Vec<Candidate> = Vec::new();
            for provider in &participants {
                for (port, offer) in &provider.provides {
                    if provider.id == consumer.id && kind == ProtocolKind::Service {
                        continue;
                    }
                    let Some(pairing) = pair(&registry, &provider.id, offer, &consumer.id, need)
                    else {
                        continue;
                    };
                    if pairing.same || pairing.ok {
                        candidates.push(Candidate {
                            plugin: &provider.id,
                            port,
                            key: key(&provider.id, port),
                            offer,
                            pairing,
                            base: provider.base,
                        });
                    }
                }
            }
            for candidate in candidates
                .iter()
                .filter(|c| c.pairing.same && !c.pairing.auto)
            {
                no_fit.insert(candidate.key.clone());
                let why = if candidate.pairing.reasons.is_empty() {
                    format!("version is outside {range}")
                } else {
                    candidate.pairing.reasons.join("; ")
                };
                diagnose(
                    Severity::Warning,
                    "no-fit",
                    candidate.plugin,
                    Some(&candidate.key),
                    format!(
                        "{} · {} can't serve {} · {name}: {why}",
                        candidate.plugin, candidate.port, consumer.id
                    ),
                );
            }
            let offer_protocol = |c: &Candidate| protocol_id(&c.offer.protocol);

            match kind {
                ProtocolKind::Service => {
                    let autos: Vec<&Candidate> =
                        candidates.iter().filter(|c| c.pairing.auto).collect();
                    let pick = match autos.len() {
                        0 => None,
                        1 => Some(autos[0]),
                        _ => Some(autos.iter().copied().find(|c| c.base).unwrap_or(autos[0])),
                    };
                    let chosen = match wiring.bind.get(&to) {
                        Some(None) => None,
                        Some(Some(pinned)) => {
                            match candidates.iter().find(|c| &c.key == pinned && c.pairing.ok) {
                                Some(found) => Some(found),
                                None => {
                                    out.status.insert(
                                        to.clone(),
                                        PortStatus {
                                            code: "pin-missing".into(),
                                            count: None,
                                        },
                                    );
                                    diagnose(
                                        Severity::Warning,
                                        "pin-missing",
                                        &consumer.id,
                                        Some(&to),
                                        format!(
                                            "{} · {name} is pinned to {pinned}, which isn't available. Using {} until it returns.",
                                            consumer.id,
                                            pick.map(|c| c.plugin).unwrap_or("nothing")
                                        ),
                                    );
                                    pick
                                }
                            }
                        }
                        None => pick,
                    };
                    if autos.len() > 1 {
                        let pinned = matches!(wiring.bind.get(&to), Some(Some(p)) if chosen.is_some_and(|c| &c.key == p));
                        if pinned {
                            out.status.insert(
                                to.clone(),
                                PortStatus {
                                    code: "pinned".into(),
                                    count: Some(autos.len()),
                                },
                            );
                        } else {
                            out.status.entry(to.clone()).or_insert(PortStatus {
                                code: "providers".into(),
                                count: Some(autos.len()),
                            });
                            diagnose(
                                Severity::Warning,
                                "several-providers",
                                &consumer.id,
                                Some(&to),
                                format!(
                                    "{} · {name}: {} providers fit ({}). Using {}; wire one to pin it.",
                                    consumer.id,
                                    autos.len(),
                                    autos
                                        .iter()
                                        .map(|c| c.plugin)
                                        .collect::<Vec<_>>()
                                        .join(", "),
                                    chosen.map(|c| c.plugin).unwrap_or("none")
                                ),
                            );
                        }
                    }
                    match chosen {
                        Some(chosen) => {
                            out.wires.push(ResolvedWire {
                                from: chosen.key.clone(),
                                to: to.clone(),
                                kind,
                                protocol: need_id.to_string(),
                                offer_protocol: offer_protocol(chosen),
                                by_shape: !chosen.pairing.auto,
                                seat: 0,
                                bench: false,
                                inactive: false,
                            });
                            out.bindings.insert(to.clone(), chosen.key.clone());
                            out.activation.push(ActivationEdge {
                                provider: chosen.plugin.to_string(),
                                consumer: consumer.id.clone(),
                                required: !need.optional,
                            });
                            if need.optional {
                                out.status.entry(to.clone()).or_insert(PortStatus {
                                    code: "optional".into(),
                                    count: None,
                                });
                            }
                        }
                        None if need.optional => {
                            out.status.insert(
                                to.clone(),
                                PortStatus {
                                    code: "optional".into(),
                                    count: None,
                                },
                            );
                        }
                        None => {
                            out.status.insert(
                                to.clone(),
                                PortStatus {
                                    code: "missing".into(),
                                    count: None,
                                },
                            );
                            let fitting = candidates.iter().filter(|c| c.pairing.ok).count();
                            let detail = format!(
                                "{name} needs {need_id} and nothing that fits is wired{}",
                                if fitting > 0 {
                                    format!(" ({fitting} would fit)")
                                } else {
                                    String::new()
                                }
                            );
                            diagnose(
                                Severity::Error,
                                "missing-service",
                                &consumer.id,
                                Some(&to),
                                format!("{} won't activate: {detail}.", consumer.id),
                            );
                            missing.entry(consumer.id.clone()).or_insert(detail);
                        }
                    }
                }
                ProtocolKind::Slot | ProtocolKind::Event => {
                    let mut list: Vec<&Candidate> = candidates
                        .iter()
                        .filter(|c| {
                            let wire_key = wire(&c.key, &to);
                            (c.pairing.auto && !cut.contains(wire_key.as_str()))
                                || (c.pairing.ok
                                    && !c.pairing.auto
                                    && add.contains(wire_key.as_str()))
                        })
                        .collect();
                    let explicit = wiring.order.get(&to);
                    let at = |c: &Candidate| {
                        explicit
                            .and_then(|order| order.iter().position(|seat| seat == &c.key))
                            .unwrap_or(usize::MAX)
                    };
                    list.sort_by(|a, b| {
                        at(a).cmp(&at(b)).then_with(|| {
                            let (ra, rb) = (a.rank(), b.rank());
                            ra.0.total_cmp(&rb.0)
                                .then(ra.1.cmp(rb.1))
                                .then(ra.2.cmp(rb.2))
                        })
                    });
                    let single = kind == ProtocolKind::Slot && need.seats == Some(1);
                    for (index, candidate) in list.iter().enumerate() {
                        let bench = single && index > 0;
                        out.wires.push(ResolvedWire {
                            from: candidate.key.clone(),
                            to: to.clone(),
                            kind,
                            protocol: need_id.to_string(),
                            offer_protocol: offer_protocol(candidate),
                            by_shape: !candidate.pairing.auto,
                            seat: if kind == ProtocolKind::Slot {
                                if single { 1 } else { index as u32 + 1 }
                            } else {
                                0
                            },
                            bench,
                            inactive: false,
                        });
                    }
                    if single && list.len() > 1 {
                        out.status.insert(
                            to.clone(),
                            PortStatus {
                                code: "benched".into(),
                                count: Some(list.len() - 1),
                            },
                        );
                    }
                }
            }
        }
    }

    // --- skips, and what they take down with them ------------------------------------
    let mut skipped: BTreeMap<String, (SkipReason, String)> = BTreeMap::new();
    for (plugin, detail) in missing {
        skipped.insert(plugin, (SkipReason::MissingService, detail));
    }
    loop {
        let mut grew = false;
        for edge in &out.activation {
            if edge.required
                && skipped.contains_key(&edge.provider)
                && !skipped.contains_key(&edge.consumer)
            {
                let detail = format!(
                    "\"{}\", which provides a service it requires, does not activate",
                    edge.provider
                );
                skipped.insert(edge.consumer.clone(), (SkipReason::ServiceSkipped, detail));
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }

    // --- activation order: Kahn, a sorted layer at a time ------------------------------
    let order_over = |edges: &[&ActivationEdge],
                      candidates: &BTreeSet<String>|
     -> (Vec<String>, BTreeSet<String>) {
        let mut remaining = candidates.clone();
        let mut order = Vec::new();
        loop {
            let ready: Vec<String> = remaining
                .iter()
                .filter(|id| {
                    !edges.iter().any(|edge| {
                        &edge.consumer == *id
                            && edge.provider != **id
                            && remaining.contains(&edge.provider)
                    })
                })
                .cloned()
                .collect();
            if ready.is_empty() {
                break;
            }
            for id in ready {
                remaining.remove(&id);
                order.push(id);
            }
        }
        (order, remaining)
    };
    let alive: BTreeSet<String> = participants
        .iter()
        .map(|p| p.id.clone())
        .filter(|id| !skipped.contains_key(id))
        .collect();
    let live_edges: Vec<&ActivationEdge> = out
        .activation
        .iter()
        .filter(|edge| alive.contains(&edge.provider) && alive.contains(&edge.consumer))
        .collect();
    let (mut order, mut stuck) = order_over(&live_edges, &alive);
    let mut dropped_optional: BTreeSet<(String, String)> = BTreeSet::new();
    if !stuck.is_empty() {
        // A cycle through optional wires is broken by dropping those wires: an optional
        // service is exactly one the plugin can live without.
        let hard: Vec<&ActivationEdge> = live_edges
            .iter()
            .copied()
            .filter(|edge| {
                edge.required || !(stuck.contains(&edge.provider) && stuck.contains(&edge.consumer))
            })
            .collect();
        let (retry, still) = order_over(&hard, &alive);
        if still.len() < stuck.len() {
            for edge in &live_edges {
                if !edge.required
                    && stuck.contains(&edge.provider)
                    && stuck.contains(&edge.consumer)
                {
                    dropped_optional.insert((edge.provider.clone(), edge.consumer.clone()));
                }
            }
            order = retry;
            stuck = still;
        }
    }
    for id in &stuck {
        let members = stuck.iter().cloned().collect::<Vec<_>>().join(", ");
        skipped.insert(
            id.clone(),
            (
                SkipReason::Cycle,
                format!("service cycle involving {members}"),
            ),
        );
        diagnose(
            Severity::Error,
            "cycle",
            id,
            None,
            format!("{id} is in a cycle of service wires and is skipped."),
        );
    }
    for (provider, consumer) in &dropped_optional {
        diagnose(
            Severity::Warning,
            "optional-cycle",
            consumer,
            None,
            format!("{consumer}'s optional use of {provider} is dropped to break a cycle."),
        );
    }
    out.order = order;

    // --- what the runtime reads: only wires between plugins that activate -------------
    let active: BTreeSet<String> = out.order.iter().cloned().collect();
    let plugin_of = |port: &str| {
        split_port(port)
            .map(|(plugin, _)| plugin.to_string())
            .unwrap_or_default()
    };
    out.bindings.clear();
    for wire_entry in &mut out.wires {
        let from = plugin_of(&wire_entry.from);
        let to = plugin_of(&wire_entry.to);
        let dropped = dropped_optional.contains(&(from.clone(), to.clone()))
            && wire_entry.kind == ProtocolKind::Service;
        wire_entry.inactive = !active.contains(&from) || !active.contains(&to) || dropped;
        if wire_entry.inactive {
            continue;
        }
        match wire_entry.kind {
            ProtocolKind::Service => {
                out.bindings
                    .insert(wire_entry.to.clone(), wire_entry.from.clone());
            }
            ProtocolKind::Slot => {
                let bucket = if wire_entry.bench {
                    &mut out.bench
                } else {
                    &mut out.seats
                };
                bucket
                    .entry(wire_entry.to.clone())
                    .or_default()
                    .push(wire_entry.from.clone());
            }
            ProtocolKind::Event => {
                out.listeners
                    .entry(wire_entry.to.clone())
                    .or_default()
                    .push(wire_entry.from.clone());
            }
        }
    }
    out.activation
        .retain(|edge| !dropped_optional.contains(&(edge.provider.clone(), edge.consumer.clone())));

    // --- provided ports nothing hears ------------------------------------------------
    let heard: BTreeSet<&str> = out.wires.iter().map(|w| w.from.as_str()).collect();
    let mut unheard = Vec::new();
    for plugin in &participants {
        for name in plugin.provides.keys() {
            let port = key(&plugin.id, name);
            if heard.contains(port.as_str()) {
                continue;
            }
            if no_fit.contains(&port) {
                out.status.insert(
                    port,
                    PortStatus {
                        code: "no-fit".into(),
                        count: None,
                    },
                );
            } else {
                out.status.insert(
                    port.clone(),
                    PortStatus {
                        code: "unheard".into(),
                        count: None,
                    },
                );
                unheard.push((plugin.id.clone(), port));
            }
        }
    }
    for (plugin, port) in unheard {
        out.diagnostics.push(Diagnostic {
            severity: Severity::Warning,
            code: "unheard".to_string(),
            message: format!(
                "{} provides a port nothing consumes.",
                port.replace(':', " · ")
            ),
            plugin,
            port: Some(port),
        });
    }

    for (plugin, (reason, detail)) in skipped {
        out.skipped.push(Skipped {
            plugin,
            reason,
            detail,
        });
    }
    out.skipped.sort_by(|a, b| a.plugin.cmp(&b.plugin));
    out.diagnostics.sort_by(|a, b| {
        a.severity
            .cmp(&b.severity)
            .then(a.plugin.cmp(&b.plugin))
            .then(a.code.cmp(&b.code))
    });
    out
}

/// Every port on the other side that shares the protocol of `port` or fits its shape, for
/// the editor's "could connect" list and the compatibility marks while dragging.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortCandidate {
    /// The port on the other side.
    pub port: String,
    #[serde(flatten)]
    pub pairing: Pairing,
}

/// `dir` is `"in"` when `port` is consumed, `"out"` when it is provided. Unplugged plugins
/// are left out, as they are from resolution.
pub fn candidates(input: &ResolveInput, port: &str, dir: &str) -> Vec<PortCandidate> {
    let registry = Registry::new(&input.protocols);
    let Some((plugin_id, name)) = split_port(port) else {
        return Vec::new();
    };
    let Some(me) = input.plugins.iter().find(|p| p.id == plugin_id) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for other in &input.plugins {
        if input.wiring.is_unplugged(&other.id) {
            continue;
        }
        if dir == "in" {
            let Some(need) = me.consumes.get(name) else {
                break;
            };
            for (their, offer) in &other.provides {
                if let Some(pairing) = pair(&registry, &other.id, offer, plugin_id, need) {
                    out.push(PortCandidate {
                        port: key(&other.id, their),
                        pairing,
                    });
                }
            }
        } else {
            let Some(offer) = me.provides.get(name) else {
                break;
            };
            for (their, need) in &other.consumes {
                if let Some(pairing) = pair(&registry, plugin_id, offer, &other.id, need) {
                    out.push(PortCandidate {
                        port: key(&other.id, their),
                        pairing,
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| {
        let weight = |c: &PortCandidate| {
            if c.pairing.auto {
                0
            } else if c.pairing.ok {
                1
            } else {
                2
            }
        };
        weight(a).cmp(&weight(b)).then(a.port.cmp(&b.port))
    });
    out
}

// ---------------------------------------------------------------------------
// Apply plan (§6c)
// ---------------------------------------------------------------------------

/// One line of what a change does, for the editor's change list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Change {
    Unplug {
        plugin: String,
    },
    Plug {
        plugin: String,
    },
    /// A service port's provider changed.
    Bind {
        port: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<String>,
    },
    /// A host's seats changed.
    Seats {
        port: String,
        seats: Vec<String>,
        added: Vec<String>,
        removed: Vec<String>,
    },
    /// An event listener gained or lost an emitter.
    Listen {
        port: String,
        added: Vec<String>,
        removed: Vec<String>,
    },
}

/// What applying `after` on a client running `before` does (§6c).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPlan {
    pub changes: Vec<Change>,
    /// Plugins that stop, in reverse activation order.
    pub stop: Vec<String>,
    /// Plugins that start, in activation order.
    pub start: Vec<String>,
    /// Plugins that restart because a service they use changed, and everything that uses
    /// them through services, in activation order.
    pub restart: Vec<String>,
    /// Host and listener ports whose seats or emitters change in place.
    pub hosts: Vec<String>,
    /// Plugins the change touches that do not declare `"hot": true`: a reload instead.
    pub cold: Vec<String>,
    /// Stops that nobody asked for: a service they require went away.
    pub also_stops: Vec<String>,
    /// Starts that nobody asked for: what they needed is back.
    pub also_starts: Vec<String>,
    /// Errors the change adds (Apply asks to confirm when this is above zero).
    pub added_errors: usize,
}

impl ApplyPlan {
    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
            && self.stop.is_empty()
            && self.start.is_empty()
            && self.restart.is_empty()
            && self.hosts.is_empty()
    }
}

/// The difference between two resolutions as something a client can run. `hot` names the
/// plugins that declare `"hot": true`; `before_wiring`/`after_wiring` supply the unplug
/// and plug lines.
pub fn plan(
    before: &Resolution,
    after: &Resolution,
    before_wiring: &Wiring,
    after_wiring: &Wiring,
    hot: &BTreeSet<String>,
) -> ApplyPlan {
    let mut out = ApplyPlan::default();
    let was = before.active();
    let will = after.active();
    let stop: BTreeSet<String> = was.difference(&will).map(|s| s.to_string()).collect();
    let start: BTreeSet<String> = will.difference(&was).map(|s| s.to_string()).collect();
    let moving: BTreeSet<&str> = stop
        .iter()
        .chain(start.iter())
        .map(String::as_str)
        .collect();

    let mut unplug: Vec<&String> = after_wiring
        .unplugged
        .iter()
        .filter(|id| !before_wiring.is_unplugged(id))
        .collect();
    let mut plug: Vec<&String> = before_wiring
        .unplugged
        .iter()
        .filter(|id| !after_wiring.is_unplugged(id))
        .collect();
    unplug.sort();
    plug.sort();
    for id in &unplug {
        out.changes.push(Change::Unplug {
            plugin: (*id).clone(),
        });
    }
    for id in &plug {
        out.changes.push(Change::Plug {
            plugin: (*id).clone(),
        });
    }

    // Service bindings: the consumer restarts, and so does everything that uses it.
    let mut restart: BTreeSet<String> = BTreeSet::new();
    let bound: BTreeSet<&String> = before
        .bindings
        .keys()
        .chain(after.bindings.keys())
        .collect();
    for port in bound {
        let (from, to) = (before.bindings.get(port), after.bindings.get(port));
        if from == to {
            continue;
        }
        let consumer = plugin_of(port);
        if moving.contains(consumer) {
            continue;
        }
        restart.insert(consumer.to_string());
        out.changes.push(Change::Bind {
            port: port.clone(),
            from: from.cloned(),
            to: to.cloned(),
        });
    }
    loop {
        let mut grew = false;
        for edge in &after.activation {
            if restart.contains(&edge.provider)
                && !restart.contains(&edge.consumer)
                && will.contains(edge.consumer.as_str())
                && !moving.contains(edge.consumer.as_str())
            {
                restart.insert(edge.consumer.clone());
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }

    // Slots and events change in place.
    let mut hosts: BTreeSet<String> = BTreeSet::new();
    let settled = |ports: Option<&Vec<String>>| -> Vec<String> {
        ports
            .map(|ports| {
                ports
                    .iter()
                    .filter(|p| !moving.contains(plugin_of(p)))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    };
    let seat_keys: BTreeSet<&String> = before.seats.keys().chain(after.seats.keys()).collect();
    for port in seat_keys {
        if moving.contains(plugin_of(port)) {
            continue;
        }
        let (a, b) = (
            settled(before.seats.get(port)),
            settled(after.seats.get(port)),
        );
        if a == b {
            continue;
        }
        hosts.insert(port.clone());
        out.changes.push(Change::Seats {
            port: port.clone(),
            added: b.iter().filter(|p| !a.contains(p)).cloned().collect(),
            removed: a.iter().filter(|p| !b.contains(p)).cloned().collect(),
            seats: b,
        });
    }
    let listener_keys: BTreeSet<&String> = before
        .listeners
        .keys()
        .chain(after.listeners.keys())
        .collect();
    for port in listener_keys {
        if moving.contains(plugin_of(port)) {
            continue;
        }
        let (a, b) = (
            settled(before.listeners.get(port)),
            settled(after.listeners.get(port)),
        );
        if a == b {
            continue;
        }
        hosts.insert(port.clone());
        out.changes.push(Change::Listen {
            port: port.clone(),
            added: b.iter().filter(|p| !a.contains(p)).cloned().collect(),
            removed: a.iter().filter(|p| !b.contains(p)).cloned().collect(),
        });
    }

    let position = |id: &str| {
        after
            .order
            .iter()
            .position(|x| x == id)
            .or_else(|| before.order.iter().position(|x| x == id))
            .unwrap_or(usize::MAX)
    };
    let sorted = |set: &BTreeSet<String>| {
        let mut list: Vec<String> = set.iter().cloned().collect();
        list.sort_by_key(|id| position(id));
        list
    };
    let mut stop_list = sorted(&stop);
    stop_list.reverse();
    out.stop = stop_list;
    out.start = sorted(&start);
    out.restart = sorted(&restart);
    out.hosts = hosts.into_iter().collect();
    out.also_stops = out
        .stop
        .iter()
        .filter(|id| !unplug.iter().any(|u| u == id))
        .cloned()
        .collect();
    out.also_starts = out
        .start
        .iter()
        .filter(|id| !plug.iter().any(|p| p == id))
        .cloned()
        .collect();
    let touched: BTreeSet<&String> = stop
        .iter()
        .chain(start.iter())
        .chain(restart.iter())
        .collect();
    out.cold = touched
        .into_iter()
        .filter(|id| !hot.contains(*id))
        .cloned()
        .collect();
    out.added_errors = after.errors().saturating_sub(before.errors());
    out
}

/// `graph:index` → `graph`.
fn plugin_of(port: &str) -> &str {
    split_port(port).map(|(plugin, _)| plugin).unwrap_or(port)
}

/// A wire's two ends, for callers that hold `"a:x -> b:y"`.
pub fn wire_ends(text: &str) -> Option<(&str, &str)> {
    split_wire(text)
}
