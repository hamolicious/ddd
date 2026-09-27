import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import {
  checkpointKey,
  readCheckpoint,
  removeCheckpoint,
  writeCheckpoint,
  type AttachmentCheckpoint,
} from "./checkpoint.js";

describe("attachment import checkpoints", () => {
  it("persists a resumable upload and removes it after the wrapper exists", async () => {
    const archive = `vault-${crypto.randomUUID()}`;
    const path = "Assets/photo.png";
    const checkpoint: AttachmentCheckpoint = {
      key: checkpointKey(archive, path),
      archive,
      path,
      uploadId: "UPLOAD",
      attachment: { id: "ATTACHMENT", name: "photo.png", mime: "image/png" },
    };

    await writeCheckpoint(checkpoint);
    await expect(readCheckpoint(archive, path)).resolves.toEqual(checkpoint);
    await removeCheckpoint(archive, path);
    await expect(readCheckpoint(archive, path)).resolves.toBeUndefined();
  });
});
