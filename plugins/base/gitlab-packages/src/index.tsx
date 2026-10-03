import type { Kernel } from "@kernel";
import { UPDATE_AVAILABLE, addPackageProvider, type PluginUpdate } from "plugin:admin";

import { GitLabSetup } from "./GitLabSetup.js";
import { DEFAULT_INSTANCE, browse, checkUpdates, download, validate, writeSettings } from "./gitlab.js";

export default function activate(kernel: Kernel): void {
  if (!kernel.session.isAdmin()) return;

  addPackageProvider({
    id: "gitlab",
    title: "GitLab",
    order: 20,
    description: "A project's generic package registry.",
    setup: GitLabSetup,
    defaults: () => writeSettings({ instance: DEFAULT_INSTANCE, project: "", tokenKind: "access", token: "" }),
    validate,
    browse: (source) => browse(source),
    download: (source, url) => download(source, url),
    checkUpdates: (source, plugins) =>
      checkUpdates(source, plugins, (update) => kernel.events.emit<PluginUpdate>(UPDATE_AVAILABLE, update)),
  });
}
