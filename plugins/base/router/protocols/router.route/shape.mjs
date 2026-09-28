import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/router.route",
  version: "1.0.0",
  kind: "slot",
  name: "Route",
  key: "path",
  description: `
One route. \`path\` is a pattern with \`:name\` segments (\`/doc/:id\`); matches are passed to the
view as \`params\`. Hash-based, so the app works from \`file://\` in the shell with no server
rewrites. The more specific pattern matches first; seat order only breaks ties.`,
  shape: s.object({
    path: s.string(),
    view: s.string().describe("The `lm/main.view` id to render."),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
  }),
};
