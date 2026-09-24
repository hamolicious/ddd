/**
 * The sync indicator's wording. SPEC §6.5 makes it the only always-visible signal
 * that an edit has not reached the server, so the cases below are the promise, not
 * the styling: "synced" never appears while something is pending, offline says the
 * workspace is still usable, and an expired session says local data is intact
 * (SPEC §5.3).
 */

import { describe, expect, it } from "vitest";

import type { SyncState, SyncStatus } from "@kernel";

import { describeSync } from "./sync-status.js";

const state = (status: SyncStatus, patch: Partial<SyncState> = {}): SyncState => ({
  status,
  safeSeq: 10,
  headSeq: 10,
  pending: 0,
  ...patch,
});

describe("describeSync", () => {
  it("says synced only when nothing is pending", () => {
    expect(describeSync(state("synced"))).toMatchObject({ label: "Synced", tone: "ok" });
  });

  it("never claims synced while local edits are unsent", () => {
    const described = describeSync(state("synced", { pending: 2 }));
    expect(described.label).not.toBe("Synced");
    expect(described.tone).toBe("busy");
    expect(described.pending).toBe(2);
    expect(described.detail).toContain("2 local edits have not reached the server");
  });

  it("counts one edit in the singular", () => {
    expect(describeSync(state("offline", { pending: 1 })).detail).toContain("1 local edit has");
  });

  it("reports bootstrap progress while the first sync runs", () => {
    const described = describeSync(
      state("syncing", { bootstrap: { rows: 1200, total: 5000, complete: false } }),
    );
    expect(described.label).toBe("First sync…");
    expect(described.detail).toContain("1200 of 5000");
  });

  it("reports how far behind the feed is when catching up", () => {
    const described = describeSync(state("syncing", { safeSeq: 10, headSeq: 34 }));
    expect(described.detail).toContain("24 changes");
  });

  it("offers a retry when offline, and says reading still works", () => {
    const described = describeSync(state("offline"));
    expect(described).toMatchObject({ tone: "warn", action: "reconnect" });
    expect(described.detail).toContain("readable");
  });

  it("promises that an expired session has discarded nothing", () => {
    const described = describeSync(state("auth-required"));
    expect(described.action).toBe("reauth");
    expect(described.detail).toContain("nothing local has been discarded");
  });

  it("shows the server's error text when sync failed", () => {
    const described = describeSync(state("error", { lastError: "1006 abnormal closure" }));
    expect(described).toMatchObject({ tone: "error", action: "reconnect" });
    expect(described.detail).toContain("1006 abnormal closure");
  });

  it("covers every status in the contract", () => {
    const statuses: readonly SyncStatus[] = [
      "offline",
      "connecting",
      "syncing",
      "synced",
      "auth-required",
      "error",
    ];
    for (const status of statuses) {
      expect(describeSync(state(status)).label.length).toBeGreaterThan(0);
    }
  });
});
