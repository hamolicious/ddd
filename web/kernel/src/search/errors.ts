export interface SerializedSearchError {
  readonly name: string;
  readonly message: string;
  readonly kind?: string;
}

export function planError(kind: string, message: string): Error {
  return Object.assign(new Error(message), { name: "SearchPlanError", kind });
}

export function serializeSearchError(error: unknown): SerializedSearchError {
  if (error instanceof Error) {
    const kind = (error as { kind?: unknown }).kind;
    return { name: error.name, message: error.message, ...(typeof kind === "string" ? { kind } : {}) };
  }
  return { name: "Error", message: String(error) };
}
