import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/attachments.viewer",
  version: "1.0.0",
  kind: "slot",
  name: "AttachmentViewer",
  key: "id",
  description: `
A way of showing files of some types, by extension. Several viewers may claim one extension:
the first seat shows it unless the user picked another in Settings, Attachments.`,
  declarations: `
export interface AttachmentViewerProps {
  readonly file: {
    readonly id: string;
    readonly name: string;
    readonly mime: string;
    readonly size: number;
  };
  /** The bytes, already fetched over the session. */
  readonly blob: Blob;
  /** An object URL for \`blob\`, owned by \`attachments\`: do not revoke it. */
  readonly url: string;
  readonly placement: "inline" | "page";
}`,
  shape: s.object({
    id: s.string(),
    label: s.string().describe("Shown in Settings when viewers compete for a type."),
    extensions: s.array(s.string()).describe("Lower case, no dot: `[\"png\", \"jpg\"]`."),
    component: s.component().as("ComponentType<AttachmentViewerProps>"),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
  }),
};
