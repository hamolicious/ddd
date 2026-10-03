import type { PluginUpdate, UpdateCheckContext } from "plugin:admin";

import { chooseFile, newestRelease, packageFilesUrl, packageListUrl, packageUrl, parsePackageUrl } from "./gitlab.js";

export const SOURCE_ID = "gitlab";

export async function checkUpdates(
  context: UpdateCheckContext,
  report: (update: PluginUpdate) => void,
): Promise<void> {
  const problems: string[] = [];
  await Promise.all(
    context.plugins
      .filter((plugin) => !plugin.authenticated)
      .map(async (plugin) => {
        const location = parsePackageUrl(plugin.url);
        if (!location) return;
        const listed = await context.lookup(packageListUrl(location));
        if (listed.status !== 200) {
          problems.push(`${plugin.id}: GitLab answered ${listed.status}`);
          return;
        }
        const newest = newestRelease(listed.body, location);
        if (!newest) return;
        const files = await context.lookup(packageFilesUrl(location, newest.id));
        const file = files.status === 200 ? chooseFile(files.body, location, newest.version) : undefined;
        if (!file) {
          problems.push(`${plugin.id}: ${newest.version} has no .zip file`);
          return;
        }
        report({
          plugin: plugin.id,
          source: SOURCE_ID,
          current: plugin.version,
          latest: newest.version,
          install: {
            url: packageUrl({ ...location, version: newest.version, file }),
            label: `${location.name} ${newest.version} from ${location.project}`,
          },
        });
      }),
  );
  if (problems.length > 0) throw new Error(problems.join("; "));
}
