import { Component, type ComponentType, type ErrorInfo, type ReactNode } from "react";

import type { BoundaryInfo } from "@kernel";

export interface BoundaryFallbackProps {
  readonly error: Error;
  readonly pluginId: string;
}

export interface BoundaryProps {
  readonly pluginId: string;
  readonly point: string;
  readonly fallback?: ComponentType<BoundaryFallbackProps>;
  readonly onError?: (error: Error, info: { pluginId: string; point: string }) => void;
  readonly children?: ReactNode;
}

interface BoundaryState {
  readonly error: Error | undefined;
}

export class PluginErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: undefined };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    console.error(
      `[plugin:${this.props.pluginId}] ${this.props.point} failed to render`,
      wrapped,
      info.componentStack,
    );
    this.props.onError?.(wrapped, { pluginId: this.props.pluginId, point: this.props.point });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const Fallback = this.props.fallback ?? DefaultFallback;
    return <Fallback error={error} pluginId={this.props.pluginId} />;
  }
}

export function DefaultFallback({ error, pluginId }: BoundaryFallbackProps): ReactNode {
  return (
    <span
      className="ddd-plugin-failed"
      role="status"
      title={error.message}
      style={{
        display: "inline-block",
        maxWidth: "100%",
        padding: "2px 6px",
        borderRadius: "var(--ddd-radius)",
        border: "1px solid var(--ddd-danger)",
        color: "var(--ddd-danger)",
        background: "var(--ddd-bg-subtle)",
        font: "inherit",
        fontSize: "0.85em",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      plugin {pluginId} failed
    </span>
  );
}

export function wrapWithBoundary<P extends object>(
  component: ComponentType<P>,
  info: BoundaryInfo & { readonly pluginId: string },
  onError?: BoundaryProps["onError"],
): ComponentType<P> {
  const Inner = component;
  const Wrapped = (props: P): ReactNode => (
    <PluginErrorBoundary
      pluginId={info.pluginId}
      point={info.point}
      {...(info.fallback ? { fallback: info.fallback } : {})}
      {...(onError ? { onError } : {})}
    >
      <Inner {...props} />
    </PluginErrorBoundary>
  );
  Wrapped.displayName = `${info.pluginId}:${info.point}(${Inner.displayName ?? Inner.name ?? "Anonymous"})`;
  return Wrapped;
}
