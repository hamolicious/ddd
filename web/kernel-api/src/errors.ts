export class KernelError extends Error {
  constructor(
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ContractViolationError extends KernelError {}

export class PluginError extends KernelError {
  constructor(
    readonly pluginId: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`${pluginId}: ${message}`, { pluginId });
  }
}

export class CapabilityUnavailableError extends KernelError {
  constructor(
    readonly capability: string,
    reason: string,
  ) {
    super(`capability "${capability}" is unavailable: ${reason}`, { capability });
  }
}

export class CoreUnavailableError extends KernelError {}

export class NotImplementedError extends KernelError {}

export function notImplemented(what: string): never {
  throw new NotImplementedError(`not implemented: ${what}`);
}
