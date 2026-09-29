import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/document-browser",
  version: "2.0.0",
  kind: "service",
  name: "DocumentBrowser",
  description: "Creating documents from anywhere in the app, and the list of ids currently shown.",
  declarations: `
export interface NewDocumentOptions {
  /**
   * Where the new document belongs, as a hint for whoever files documents (\`folders\`
   * files it under this note). Passed through on \`lm/document-browser.created\`.
   */
  readonly parent?: string;
  readonly title?: string;
}`,
  shape: s.object({
    createDocument: s
      .func()
      .as("(options?: NewDocumentOptions) => Promise<string>")
      .describe("Create an empty document and navigate to it. Rejects when the server cannot be reached."),
    newDocument: s
      .func()
      .as("(options?: NewDocumentOptions) => void")
      .describe("The same, for UI entry points: never rejects, and reports a failure as a notice with a retry."),
    visible: s.func().as("() => readonly string[]").describe("The ids currently shown, for \"select all\" style commands."),
  }),
};
