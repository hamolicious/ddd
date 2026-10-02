import { useEffect, useRef, useState } from "react";
import type { ComponentType, ReactElement } from "react";

import type { SavedSearchProps, SearchShellProps, SearchSpec } from "./api.js";

import { savedSearchOf } from "./saved.js";
import { encodeSpec, parseSpec, sameSpec } from "./spec.js";

export interface SavedSearchDeps {
  readonly SearchShell: ComponentType<SearchShellProps>;
  readonly open: (id: string, line?: number) => void;
  readonly update: (id: string, value: string) => void;
}

export function createSavedSearch({ SearchShell, open, update }: SavedSearchDeps): ComponentType<SavedSearchProps> {
  return function SavedSearch({ row, embedded, renderView, renderSettings, pageSize, showsEmpty }: SavedSearchProps): ReactElement {
    const stored = savedSearchOf(row) ?? "";
    const [spec, setSpec] = useState<SearchSpec>(() => parseSpec(stored));
    const seen = useRef(stored);
    useEffect(() => {
      if (stored === seen.current) return;
      seen.current = stored;
      setSpec(parseSpec(stored));
    }, [stored]);
    const changed = !sameSpec(spec, parseSpec(stored));
    return (
      <SearchShell
        spec={spec}
        onSpecChange={setSpec}
        controls={embedded === true ? "hidden" : "folded"}
        onOpen={open}
        renderView={renderView}
        {...(renderSettings ? { renderSettings } : {})}
        {...(pageSize !== undefined ? { pageSize } : {})}
        {...(showsEmpty !== undefined ? { showsEmpty } : {})}
        {...(changed ? { onSave: () => update(row.id, encodeSpec(spec)), saveLabel: "Update saved search" } : {})}
      />
    );
  };
}
