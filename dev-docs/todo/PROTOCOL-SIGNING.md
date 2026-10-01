# Signed protocol namespaces

**Status:** deferred. Decided 2026-09-28 as part of `PLUGIN-PROTOCOLS.html` §10.

## Today's rule

Protocol ids are `<publisher>/<name>`. On each server, the first installed package that
uses a namespace owns it. `ddd/` is reserved for the base distribution from day one. The
content-hash rule still applies on top: two packages that bundle the same `id@version`
must be byte-identical, or the install is refused.

## What this leaves open

The first-install rule is per server and says nothing about who a publisher is.
Whoever installs `acme/` first on a given server owns it there, and two servers can
disagree about who `acme/` is. That is acceptable while frontend plugins are curated and
full-trust (also decided in §10): an admin approves every install anyway.

## What signed keys would add

- A namespace bound to a publisher key, so `acme/` means the same author on every server.
- A signature over each protocol package and plugin archive, checked at install
  alongside the existing archive validation.
- A path to key rotation and revocation.

## When to pick it up

With the trust-model work. Signing matters once plugins come from outside a curated set,
or when servers start sharing a catalog. It belongs next to the provenance and review
improvements the curated model already calls for (`PLUGIN-ARCHITECTURE-REVIEW.md`, P2).
