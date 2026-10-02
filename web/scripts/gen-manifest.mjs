#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const schemaPath = resolve(repo, "schema/manifest.schema.json");
const tsOut = resolve(repo, "web/kernel-api/src/manifest.generated.ts");
const rsOut = resolve(repo, "backend/crates/server/src/manifest_types.rs");

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const defs = schema.$defs ?? {};
const refName = (ref) => ref.replace("#/$defs/", "");

function tsType(node) {
  if (node.$ref) return refName(node.$ref);
  if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join(" | ");
  switch (node.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `readonly (${tsType(node.items)})[]`;
    case "object":
      if (node.additionalProperties && typeof node.additionalProperties === "object") {
        return `Readonly<Record<string, ${tsType(node.additionalProperties)}>>`;
      }
      return "Readonly<Record<string, unknown>>";
    default:
      return "unknown";
  }
}

function tsInterface(name, node, root = false) {
  const required = new Set(node.required ?? []);
  let out = `export interface ${name} {\n`;
  for (const [key, prop] of Object.entries(node.properties ?? {})) {
    const safeKey = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
    const present = required.has(key) || prop["x-rust-always"];
    out += `  readonly ${safeKey}${present ? "" : "?"}: ${tsType(prop)};\n`;
  }
  if (root) {
    out += "  readonly [extension: `x-${string}`]: unknown;\n";
  }
  out += "}\n";
  return out;
}

function renderTs() {
  let out = `export const MANIFEST_KERNEL_VERSION = ${JSON.stringify(schema["x-kernel-version"])};\n\n`;
  for (const [name, node] of Object.entries(defs)) out += `${tsInterface(name, node)}\n`;
  out += tsInterface("PluginManifest", schema, true);
  out += `\nexport const MANIFEST_SCHEMA: ManifestSchemaNode = ${JSON.stringify(stripForRuntime(schema), null, 2)};\n\n`;
  out += `export interface ManifestSchemaNode {
  readonly $ref?: string;
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, ManifestSchemaNode>>;
  readonly additionalProperties?: ManifestSchemaNode | boolean;
  readonly propertyNames?: { readonly format?: string };
  readonly items?: ManifestSchemaNode;
  readonly enum?: readonly unknown[];
  readonly format?: string;
  readonly minimum?: number;
  readonly $defs?: Readonly<Record<string, ManifestSchemaNode>>;
  readonly "x-removed"?: Readonly<Record<string, string>>;
}
`;
  return out;
}

function stripForRuntime(node) {
  if (Array.isArray(node)) return node.map(stripForRuntime);
  if (typeof node !== "object" || node === null) return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "description" || key === "title" || key === "$schema" || key === "$id") continue;
    if (key.startsWith("x-") && key !== "x-removed") continue;
    if (key === "x-removed") {
      out[key] = value;
      continue;
    }
    out[key] = key === "properties" || key === "$defs"
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripForRuntime(v)]))
      : stripForRuntime(value);
  }
  return out;
}

const rustName = (defName) => defs[defName]?.["x-rust-name"] ?? defName;

function snake(key) {
  return key
    .replace(/-/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function rsField(key, prop, isRequired) {
  const field = prop["x-rust-field"] ?? snake(key);
  const attrs = [];
  let type;
  if (field !== key) attrs.push(`rename = ${JSON.stringify(key)}`);
  const inner = (node) => {
    if (node.$ref) return rustName(refName(node.$ref));
    if (node["x-rust-type"]) return node["x-rust-type"];
    switch (node.type) {
      case "string":
        return "String";
      case "number":
        return "f64";
      case "integer":
        return "u32";
      case "boolean":
        return "bool";
      case "array":
        return `Vec<${inner(node.items)}>`;
      case "object":
        return `BTreeMap<String, ${node.additionalProperties && typeof node.additionalProperties === "object" ? inner(node.additionalProperties) : "serde_json::Value"}>`;
      default:
        return "serde_json::Value";
    }
  };
  const base = inner(prop);
  if (isRequired) {
    type = base;
  } else if (prop["x-rust-default"]) {
    type = base;
    attrs.unshift("default");
    if (prop["x-rust-skip-if"]) attrs.push(`skip_serializing_if = ${JSON.stringify(prop["x-rust-skip-if"])}`);
  } else if (prop.type === "array" && !prop["x-rust-option"]) {
    type = base;
    attrs.unshift("default");
    if (!prop["x-rust-always"]) attrs.push('skip_serializing_if = "Vec::is_empty"');
  } else if (prop.type === "object" && !prop.$ref) {
    type = base;
    attrs.unshift("default");
    attrs.push('skip_serializing_if = "BTreeMap::is_empty"');
  } else if (prop.type === "boolean") {
    type = base;
    attrs.unshift("default");
    attrs.push('skip_serializing_if = "std::ops::Not::not"');
  } else {
    type = `Option<${base}>`;
    attrs.unshift("default");
    attrs.push('skip_serializing_if = "Option::is_none"');
  }
  let out = "";
  if (attrs.length) out += `    #[serde(${attrs.join(", ")})]\n`;
  out += `    pub ${field}: ${type},\n`;
  return out;
}

function rsStruct(name, node) {
  const derive = node["x-rust-derive"] ?? ["Debug", "Clone", "Serialize", "Deserialize"];
  const required = new Set(node.required ?? []);
  let out = `#[derive(${derive.join(", ")})]\n`;
  out += `pub struct ${name} {\n`;
  for (const [key, prop] of Object.entries(node.properties ?? {})) out += rsField(key, prop, required.has(key));
  if (node["x-rust-extra"]) {
    out += "    #[serde(flatten)]\n";
    out += "    pub extra: BTreeMap<String, serde_json::Value>,\n";
  }
  out += "}\n";
  return out;
}

function renderRs() {
  let out = "use std::collections::BTreeMap;\n\nuse serde::{Deserialize, Serialize};\n\n";
  out += `pub const KERNEL_VERSION: &str = ${JSON.stringify(schema["x-kernel-version"])};\n\n`;
  out += rsStruct(schema["x-rust-name"] ?? "PluginManifest", schema);
  for (const [name, node] of Object.entries(defs)) out += `\n${rsStruct(rustName(name), node)}`;
  return out;
}

function rustfmt(source) {
  const run = spawnSync("rustfmt", ["--edition", "2024", "--emit", "stdout"], { input: source, encoding: "utf8" });
  if (run.status !== 0) {
    console.error(run.stderr || "rustfmt failed");
    process.exit(1);
  }
  return run.stdout;
}

const outputs = [
  [tsOut, renderTs()],
  [rsOut, rustfmt(renderRs())],
];

const check = process.argv.includes("--check");
let stale = 0;
for (const [path, content] of outputs) {
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {
  }
  if (current === content) continue;
  if (check) {
    stale += 1;
    console.error(`stale: ${path.slice(repo.length + 1)} (run \`node web/scripts/gen-manifest.mjs\`)`);
  } else {
    writeFileSync(path, content);
    console.log(`wrote ${path.slice(repo.length + 1)}`);
  }
}
if (stale > 0) process.exit(1);
