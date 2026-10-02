export type Unsubscribe = () => void;

export interface Disposable {
  dispose(): void;
}

export type Iso8601 = string;

export type CoreValue =
  | null
  | boolean
  | number
  | string
  | readonly CoreValue[]
  | { readonly [key: string]: CoreValue };

export type CoreMap = { readonly [key: string]: CoreValue };

export type FmValue = CoreValue;

export interface KernelLogger {
  debug(message: string, ...detail: readonly unknown[]): void;
  info(message: string, ...detail: readonly unknown[]): void;
  warn(message: string, ...detail: readonly unknown[]): void;
  error(message: string, ...detail: readonly unknown[]): void;
}
