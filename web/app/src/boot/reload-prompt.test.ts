import { describe, expect, it, vi } from "vitest";

import type { Notice } from "@kernel";

import { RELOAD_NOTICE_ID, ReloadPrompt } from "./reload-prompt.js";

describe("the reload prompt", () => {
  it("is one notice for an update and a stale plugin list, shown once the kernel exists", () => {
    const notices: Notice[] = [];
    const reloadPage = vi.fn();
    const prompt = new ReloadPrompt(reloadPage);
    prompt.askForStale();
    expect(notices).toEqual([]);

    prompt.attach((notice) => notices.push(notice));
    expect(notices.map((n) => [n.id, n.message])).toEqual([[RELOAD_NOTICE_ID, "Plugins need updating. Reload while online."]]);

    const apply = vi.fn();
    prompt.offerUpdate(apply);
    expect(notices.at(-1)?.id).toBe(RELOAD_NOTICE_ID);
    expect(notices.at(-1)?.message).toBe("An update is available.");

    // One Reload covers both: the waiting worker takes control and reloads.
    notices.at(-1)?.actions?.[0]?.run();
    expect(apply).toHaveBeenCalledOnce();
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it("says a list without a resolution needs a reload while online", () => {
    const reloadPage = vi.fn();
    const prompt = new ReloadPrompt(reloadPage);
    let notice: Notice | undefined;
    prompt.attach((n) => (notice = n));
    prompt.askForStale();
    expect(notice?.message).toBe("Plugins need updating. Reload while online.");
    notice?.actions?.[0]?.run();
    expect(reloadPage).toHaveBeenCalledOnce();
  });
});
