/**
 * A modal's validation and `confirm`'s shape: what the buttons are, which one Enter
 * presses, and what has to be typed before a confirm goes through.
 */

import { describe, expect, it } from "vitest";

import type { ModalField } from "../../_shared/context-menu-api.js";

import { check, confirmModal } from "./Modal.js";

describe("check", () => {
  const fields: readonly ModalField[] = [
    { kind: "text", id: "name", label: "Name", required: true },
    {
      kind: "text",
      id: "again",
      label: "Again",
      validate: (value, values) => (value === values["name"] ? undefined : "Not the same."),
    },
    { kind: "checkbox", id: "purge", label: "Purge" },
  ];

  it("rejects a blank required field and a failed validator", () => {
    expect(check(fields, { name: "  ", again: "x", purge: false })).toEqual({
      name: "Required.",
      again: "Not the same.",
    });
  });

  it("passes when every field is acceptable", () => {
    expect(check(fields, { name: "a", again: "a", purge: true })).toEqual({});
  });
});

describe("confirmModal", () => {
  it("is Cancel then Confirm, with Confirm the default", () => {
    const modal = confirmModal({ title: "Sure?" });
    expect(modal.buttons?.map((button) => [button.id, button.label, button.tone ?? "plain"])).toEqual([
      ["cancel", "Cancel", "plain"],
      ["confirm", "Confirm", "primary"],
    ]);
    expect(modal.buttons?.[0]?.dismiss).toBe(true);
    expect(modal.buttons?.[1]?.default).toBe(true);
    expect(modal.fields).toBeUndefined();
  });

  it("is red, says Delete, and starts on Cancel when dangerous", () => {
    const modal = confirmModal({ title: "Delete?", danger: true });
    expect(modal.buttons?.[1]).toMatchObject({ label: "Delete", tone: "danger" });
    expect(modal.buttons?.[0]?.autoFocus).toBe(true);
  });

  it("asks for the exact text when typeToConfirm is set", () => {
    const fields = confirmModal({ title: "Delete?", typeToConfirm: "notes" }).fields ?? [];
    expect(check(fields, { typed: "note" })).toEqual({ typed: "Type notes exactly." });
    expect(check(fields, { typed: "notes" })).toEqual({});
  });
});
