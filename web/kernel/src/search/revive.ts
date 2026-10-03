import { SearchPlanError, SearchUnavailableError } from "@kernel";

import type { SerializedSearchError } from "./errors.js";

export function reviveSearchError(error: SerializedSearchError): Error {
  if (error.name === "SearchPlanError") return new SearchPlanError(error.kind ?? "malformed", error.message);
  if (error.name === "SearchUnavailableError") return new SearchUnavailableError(error.message);
  return new Error(error.message);
}
