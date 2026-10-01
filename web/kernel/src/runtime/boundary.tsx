/**
 * The kernel error boundary — SPEC §6.4's "every contribution is wrapped in an
 * error boundary (in-place 'plugin X failed')".
 *
 * It is the kernel's, not each plugin author's, for the same reason the loader owns
 * dependency order: the guarantee has to hold for code the kernel did not write.
 * The loader wraps every contributed component with {@link wrapWithBoundary}, and a
 * plugin rendering another plugin's component gets the same wrapper from
 * `kernel.ui.boundary`.
 *
 * The fallback is deliberately small and in place: a failed sidebar panel must not
 * blank the app, and a failed navbar item must not push the rest of the navbar
 * around. It names the plugin, because "which plugin" is the only actionable fact.
 */

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
  /** Reported to the loader, which aggregates it into one notice. */
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
    // The component stack is the difference between "plugin X failed" and a
    // reproducible bug report, and React only hands it over here.
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

/** The in-place chip. Styled with kernel tokens so it is legible in any theme. */
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

/**
 * Wrap a component so a render-time throw becomes a chip instead of a blank app.
 * The wrapper keeps the component's props and display name — a React devtools tree
 * full of `Boundary` nodes is its own kind of unhelpful.
 */
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
