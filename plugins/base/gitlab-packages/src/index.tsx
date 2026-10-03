import type { Kernel } from "@kernel";
import { UPDATE_AVAILABLE, addPackageSource, type PluginUpdate } from "plugin:admin";

import { GitLabSource } from "./GitLabSource.js";
import { SOURCE_ID, checkUpdates } from "./updates.js";

export default function activate(kernel: Kernel): void {
  if (!kernel.session.isAdmin()) return;

  addPackageSource({
    id: SOURCE_ID,
    title: "GitLab",
    order: 20,
    description: "Download a plugin zip from a project's generic package registry.",
    component: GitLabSource,
    checkUpdates: (context) =>
      checkUpdates(context, (update) => kernel.events.emit<PluginUpdate>(UPDATE_AVAILABLE, update)),
  });
}
