import type { Kernel } from "@kernel";
import { UPDATE_AVAILABLE, addPackageProvider, type PluginUpdate } from "plugin:admin";

import { GitHubSetup } from "./GitHubSetup.js";
import { GITHUB, fetchJson, gitHubSource, writeSettings } from "./github.js";

export default function activate(kernel: Kernel): void {
  if (!kernel.session.isAdmin()) return;

  const github = gitHubSource(GITHUB, fetchJson, async (request) => {
    const response = await kernel.session.fetchPlugin("/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    return response.blob();
  });

  addPackageProvider({
    id: "github",
    title: "GitHub",
    order: 10,
    description: "The .zip assets of a repository's releases.",
    setup: GitHubSetup,
    defaults: () => writeSettings({ repo: "", token: "" }),
    validate: github.validate,
    fromLink: github.fromLink,
    test: github.test,
    browse: github.browse,
    download: github.download,
    checkUpdates: (source, plugins) =>
      github.checkUpdates(source, plugins, (update) => kernel.events.emit<PluginUpdate>(UPDATE_AVAILABLE, update)),
  });
}
