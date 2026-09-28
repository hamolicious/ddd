import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/folders.default-location",
  version: "1.0.0",
  kind: "event",
  name: "DefaultLocation",
  sticky: true,
  description: `
Where new notes go when the caller names no folder. Sent at activation and on every change,
here or on another device. Sticky: a listener that starts or restarts later still hears the
current value at once. An explicit location, like "New document here" in the tree, always
beats it.`,
  shape: s.object({
    path: s.string().describe("A folder path, `\"\"` for the root."),
  }),
};
