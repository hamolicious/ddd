import { describe, expect, it } from "vitest";

import type { SlashCommand } from "@protocols/lm/slash.command";

import { matchCommands, slashQuery } from "./match.js";

const command = (title: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({
  id: title,
  title,
  run: () => undefined,
  ...extra,
});

describe("slashQuery", () => {
  it("opens after a slash at the start of a line or after a space", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/att")).toBe("att");
    expect(slashQuery("some text /att")).toBe("att");
  });

  it("stays closed inside words, paths and after a space in the query", () => {
    expect(slashQuery("a/b")).toBeUndefined();
    expect(slashQuery("https://x")).toBeUndefined();
    expect(slashQuery("/attach ")).toBeUndefined();
    expect(slashQuery("plain")).toBeUndefined();
  });
});

describe("matchCommands", () => {
  // In seat order, as the host hands them over. `Date` carries an `order` hint that used
  // to put it first; the wiring's seat order decides now, and this function leaves it be.
  const all = [
    command("Attach file", { keywords: ["upload"] }),
    command("Insert table"),
    command("Date", { keywords: ["today"], order: 10 }),
  ];

  it("lists everything in seat order with nothing typed, ignoring the order hint", () => {
    expect(matchCommands(all, "", "d").map((c) => c.title)).toEqual(["Attach file", "Insert table", "Date"]);
  });

  it("puts title matches first, then keywords, then anything containing it", () => {
    expect(matchCommands(all, "att", "d").map((c) => c.title)).toEqual(["Attach file"]);
    expect(matchCommands(all, "up", "d").map((c) => c.title)).toEqual(["Attach file"]);
    expect(matchCommands(all, "tab", "d").map((c) => c.title)).toEqual(["Insert table"]);
    expect(matchCommands(all, "able", "d").map((c) => c.title)).toEqual(["Insert table"]);
  });

  it("keeps seat order within a rank rather than sorting by title", () => {
    const seated = [command("Zebra task"), command("Alpha task"), command("Task list", { keywords: ["task"] })];
    expect(matchCommands(seated, "task", "d").map((c) => c.title)).toEqual(["Zebra task", "Alpha task", "Task list"]);
  });

  it("drops commands whose when says no, or throws", () => {
    const hidden = [
      command("A", { when: () => false }),
      command("B", {
        when: () => {
          throw new Error("x");
        },
      }),
      command("C"),
    ];
    expect(matchCommands(hidden, "", "d").map((c) => c.title)).toEqual(["C"]);
  });
});
