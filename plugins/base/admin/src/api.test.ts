/**
 * The pure helpers in `api.ts`.
 *
 * `describeActor` is the one with a rule behind it rather than a format: deleting a user
 * keeps the attribution id (SPEC §5.1), so every id that no longer resolves has to render as
 * something a human can read, and `plugin:<id>`/`system` actors must not be mistaken for
 * people.
 */

import { describe, expect, it } from "vitest";

import { auditParams, describeActor, formatBytes, formatWhen, type UserView } from "./api.js";

const user = (over: Partial<UserView>): UserView => ({
  id: "u1",
  email: "a@example.com",
  name: "A",
  is_admin: false,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("auditParams", () => {
  it("omits unset and blank filters", () => {
    expect(auditParams({})).toBe("");
    expect(auditParams({ action: "   ", actor: "" })).toBe("");
  });

  it("encodes what is set", () => {
    expect(auditParams({ action: "document.delete", limit: 50 })).toBe(
      "?action=document.delete&limit=50",
    );
    expect(auditParams({ cursor: "abc=" })).toBe("?cursor=abc%3D");
  });

  it("trims, so a stray space does not filter on nothing", () => {
    expect(auditParams({ actor: " u1 " })).toBe("?actor=u1");
  });
});

describe("describeActor", () => {
  const users = [user({ id: "u1" }), user({ id: "u2", email: "gone@example.com", is_active: false })];

  it("names an active user by email", () => {
    expect(describeActor("u1", users)).toBe("a@example.com");
  });

  it("marks a soft-deleted account, keeping the attribution readable", () => {
    expect(describeActor("u2", users)).toBe("gone@example.com (deleted)");
  });

  it("does not pretend an unknown id is a person", () => {
    expect(describeActor("u9", users)).toBe("deleted user (u9)");
  });

  it("labels non-human actors", () => {
    expect(describeActor("system", users)).toBe("system");
    expect(describeActor("plugin:calendar", users)).toBe("plugin calendar");
  });

  it("handles a missing actor", () => {
    expect(describeActor(null, users)).toBe("—");
    expect(describeActor(undefined, [])).toBe("—");
  });
});

describe("formatBytes", () => {
  it("uses binary units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1024 * 1024 * 5.5)).toBe("5.5 MiB");
    expect(formatBytes(1024 * 1024 * 1024 * 20)).toBe("20 GiB");
  });

  it("refuses to invent a number", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("formatWhen", () => {
  it("passes through a value it cannot parse instead of showing Invalid Date", () => {
    expect(formatWhen("not a date")).toBe("not a date");
    expect(formatWhen(null)).toBe("—");
    expect(formatWhen(undefined)).toBe("—");
  });

  it("renders a real timestamp", () => {
    expect(formatWhen("2026-09-23T10:00:00.000Z")).not.toBe("—");
  });
});
