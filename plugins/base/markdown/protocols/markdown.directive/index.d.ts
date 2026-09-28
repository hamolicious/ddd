/**
 * lm/markdown.directive@1.0.0: slot, owned by `markdown`.
 *
 * A directive: `:::name` (container), `::name` (leaf), `:name[text]{attrs}` (inline).
 * Directives and fences are the blessed syntaxes: named, collision-free, and they degrade
 * to literal text when the plugin is absent.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ComponentType, ReactNode } from "react";
import type { DocumentId } from "@kernel";

/** The protocol this package describes. */
export type ProtocolId = "lm/markdown.directive";
export type ProtocolVersion = "1.0.0";

export interface MarkdownDirectiveProps {
  readonly attributes: Readonly<Record<string, string>>;
  readonly label?: string;
  readonly children?: ReactNode;
  readonly documentId?: DocumentId;
}

export interface MarkdownDirective {
  readonly name: string;
  readonly kind: "container" | "leaf" | "text";
  readonly component: ComponentType<MarkdownDirectiveProps>;
}
