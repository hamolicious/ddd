import { useEffect, useState } from "react";

export const COMPACT_MEDIA_QUERY = "(max-width: 640px), (max-height: 480px) and (pointer: coarse)";

export function useCompact(): boolean {
  const [compact, setCompact] = useState(matchesCompact);
  useEffect(() => {
    const media = globalThis.matchMedia?.(COMPACT_MEDIA_QUERY);
    if (!media) return undefined;
    const listener = (): void => setCompact(media.matches);
    listener();
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  return compact;
}

function matchesCompact(): boolean {
  return globalThis.matchMedia?.(COMPACT_MEDIA_QUERY).matches ?? false;
}

export function useTouchOnly(): boolean {
  const [touch, setTouch] = useState(() => globalThis.matchMedia?.("(hover: none)").matches ?? false);
  useEffect(() => {
    const media = globalThis.matchMedia?.("(hover: none)");
    if (!media) return undefined;
    const listener = (): void => setTouch(media.matches);
    listener();
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  return touch;
}
