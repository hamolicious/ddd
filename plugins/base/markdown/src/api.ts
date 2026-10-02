import type { ComponentType, ReactNode } from "react";

import { createRegistry, s, type DocumentId, type Unsubscribe } from "@kernel";

export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

export interface DocumentRegions {
  readonly frontmatter: TextSpan | null;
  readonly sections: TextSpan | null;
  readonly body: TextSpan;
}

export interface RenderAttachmentOptions {
  readonly placement: "inline" | "page";
  readonly alt?: string;
  readonly fallback: ReactNode;
}

export interface RenderOptions {
  readonly documentId?: string;
  readonly offset?: number;
}

export interface MarkdownRenderer {
  readonly render: (text: string, options?: RenderOptions) => ReactNode;
  readonly bodyOf: (text: string) => string;
  readonly regions: (text: string) => DocumentRegions;
  readonly taskStates: () => readonly MarkdownTaskState[];
  readonly renderAttachment: (attachmentId: string, options: RenderAttachmentOptions) => ReactNode | undefined;
  readonly promoteToDocument: (attachmentId: string) => Promise<string>;
  readonly renderDocLink: (documentId: string) => ReactNode;
  readonly onChange: (listener: () => void) => Unsubscribe;
}

export interface MarkdownAttachmentProps {
  readonly id: string;
  readonly alt?: string;
  readonly placement: "inline" | "page";
  readonly fallback: ReactNode;
  readonly frame: (content: ReactNode) => ReactNode;
}

export interface MarkdownAttachment {
  readonly id: string;
  readonly component: ComponentType<MarkdownAttachmentProps>;
  readonly order?: number;
}

export interface MarkdownCodeBlockProps {
  readonly code: string;
  readonly language?: string;
  readonly meta?: string;
  readonly documentId?: DocumentId;
}

export interface MarkdownCodeBlock {
  readonly id: string;
  readonly component: ComponentType<MarkdownCodeBlockProps>;
  readonly order?: number;
}

export interface MarkdownComponent {
  readonly node: string;
  readonly component: ComponentType<Record<string, unknown>>;
  readonly order?: number;
}

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

export interface MarkdownFenceProps {
  readonly code: string;
  readonly meta?: string;
  readonly documentId?: DocumentId;
}

export interface MarkdownFence {
  readonly language: string;
  readonly component: ComponentType<MarkdownFenceProps>;
}

export interface MarkdownRemark {
  readonly id: string;
  readonly plugin: unknown;
  readonly options?: unknown;
  readonly order?: number;
}

export interface MarkdownTaskState {
  readonly marker: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly order?: number;
  readonly done?: boolean;
}

const orderOr100 = (item: { readonly order?: number }): number => item.order ?? 100;

export const attachmentRegistry = createRegistry<MarkdownAttachment>({
  key: (item) => item.id,
  order: orderOr100,
  shape: s.object({ id: s.string(), component: s.component(), order: s.optional(s.number()) }),
});

export const codeBlockRegistry = createRegistry<MarkdownCodeBlock>({
  key: (item) => item.id,
  order: orderOr100,
  shape: s.object({ id: s.string(), component: s.component(), order: s.optional(s.number()) }),
});

export const componentRegistry = createRegistry<MarkdownComponent>({
  key: (item) => item.node,
  order: orderOr100,
  shape: s.object({ node: s.string(), component: s.component(), order: s.optional(s.number()) }),
});

export const directiveRegistry = createRegistry<MarkdownDirective>({
  key: (item) => `${item.kind}:${item.name}`,
  shape: s.object({ name: s.string(), kind: s.literal("container", "leaf", "text"), component: s.component() }),
});

export const fenceRegistry = createRegistry<MarkdownFence>({
  key: (item) => item.language,
  shape: s.object({ language: s.string(), component: s.component() }),
});

export const remarkRegistry = createRegistry<MarkdownRemark>({
  key: (item) => item.id,
  order: orderOr100,
  shape: s.object({ id: s.string(), plugin: s.any(), options: s.optional(s.any()), order: s.optional(s.number()) }),
});

export const taskStateRegistry = createRegistry<MarkdownTaskState>({
  key: (item) => item.marker,
  order: orderOr100,
  shape: s.object({
    marker: s.string(),
    label: s.string(),
    icon: s.any(),
    order: s.optional(s.number()),
    done: s.optional(s.boolean()),
  }),
});
