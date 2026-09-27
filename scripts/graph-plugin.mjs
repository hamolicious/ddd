#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const graphDir = path.join(repoRoot, "graphify-out");
const htmlPath = path.join(graphDir, "graph.html");
const graphPath = path.join(graphDir, "graph.json");

function usage(exitCode = 0) {
  console.log(`Usage: node scripts/graph-plugin.mjs <plugin> [options]

Show only a plugin's Graphify communities and direct neighbours.

Options:
  --port <number>  Preferred localhost port (default: 8000)
  --no-open        Serve without opening a browser
  --dry-run        Print the matched communities without starting a server
  -h, --help       Show this help`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  let plugin;
  let port = 8000;
  let open = true;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") usage();
    if (arg === "--no-open") {
      open = false;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--port") {
      port = Number(argv[++index]);
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (plugin) {
      throw new Error(`Expected one plugin name, received: ${arg}`);
    } else {
      plugin = arg;
    }
  }

  if (!plugin) usage(1);
  if (!/^[a-zA-Z0-9._-]+$/.test(plugin)) {
    throw new Error("Plugin names may contain only letters, numbers, dots, underscores, and hyphens.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }

  return { plugin, port, open, dryRun };
}

function embeddedJson(html, name) {
  const marker = `const ${name} = `;
  const start = html.indexOf(marker);
  if (start === -1) throw new Error(`Could not find ${name} in graph.html.`);
  const valueStart = start + marker.length;
  const valueEnd = html.indexOf(";\n", valueStart);
  if (valueEnd === -1) throw new Error(`Could not read ${name} from graph.html.`);
  return JSON.parse(html.slice(valueStart, valueEnd));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findNeighbourhood(plugin, htmlNodes, htmlEdges, graph) {
  const htmlIds = new Set(htmlNodes.map((node) => String(node.id)));
  const anchors = new Set();
  const pluginPath = new RegExp(`(^|/)plugins/(base|examples)/${escapeRegExp(plugin)}/`, "i");
  const pluginLabel = new RegExp(`(^|/)${escapeRegExp(plugin)}(?:/|\\.|$)`, "i");

  for (const node of graph.nodes ?? []) {
    if (pluginPath.test(String(node.source_file ?? "").replaceAll("\\", "/"))) {
      const community = String(node.community);
      if (htmlIds.has(community)) anchors.add(community);
    }
  }

  for (const node of htmlNodes) {
    if (pluginLabel.test(String(node.label ?? ""))) anchors.add(String(node.id));
  }

  if (anchors.size === 0) {
    const suggestions = htmlNodes
      .filter((node) => String(node.label ?? "").toLowerCase().includes(plugin.toLowerCase()))
      .slice(0, 8)
      .map((node) => node.label);
    const hint = suggestions.length ? ` Nearby labels: ${suggestions.join(", ")}` : "";
    throw new Error(`No graph communities matched plugin '${plugin}'.${hint}`);
  }

  const visible = new Set(anchors);
  for (const edge of htmlEdges) {
    const source = String(edge.from);
    const target = String(edge.to);
    if (anchors.has(source)) visible.add(target);
    if (anchors.has(target)) visible.add(source);
  }

  return {
    anchors: [...anchors],
    visible: [...visible],
  };
}

function injectNeighbourhood(html, plugin, anchors, visible) {
  const script = `
<script id="graph-plugin-neighbourhood">
(() => {
  const anchors = ${JSON.stringify(anchors)};
  const visibleIds = ${JSON.stringify(visible)};
  network.once('stabilizationIterationsDone', () => {
    const visible = new Set(visibleIds);
    nodesDS.update(RAW_NODES.map(node => ({ id: node.id, hidden: !visible.has(String(node.id)) })));
    network.selectNodes(anchors);
    network.fit({ nodes: visibleIds, animation: true });
    showInfo(anchors[0]);

    const badge = document.createElement('div');
    badge.textContent = ${JSON.stringify(`${plugin}: ${anchors.length} communities + ${visible.length - anchors.length} direct neighbours`)};
    badge.style.cssText = 'position:fixed;top:12px;left:12px;z-index:10;padding:7px 10px;border-radius:6px;background:#1a1a2eee;color:#ddd;border:1px solid #3a3a5e;font:12px sans-serif';
    document.body.appendChild(badge);
  });
})();
</script>`;

  return html.replace("</body>", `${script}\n</body>`);
}

function listen(serverFactory, preferredPort) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > Math.min(preferredPort + 20, 65535)) {
        reject(new Error(`No free port found from ${preferredPort} to ${port - 1}.`));
        return;
      }

      const server = serverFactory();
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE") {
          tryPort(port + 1);
        } else {
          reject(error);
        }
      });
      server.listen(port, "127.0.0.1", () => resolve({ server, port }));
    };

    tryPort(preferredPort);
  });
}

function openBrowser(url) {
  const candidates = process.platform === "darwin"
    ? [["open", [url]]]
    : process.platform === "win32"
      ? [["cmd", ["/c", "start", "", url]]]
      : [["xdg-open", [url]], ["cmd.exe", ["/c", "start", "", url]]];

  const tryCandidate = (index) => {
    if (index >= candidates.length) {
      console.warn(`No browser opener found; visit ${url} manually.`);
      return;
    }
    const [command, args] = candidates[index];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => tryCandidate(index + 1));
    child.unref();
  };

  tryCandidate(0);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [html, graphText] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(graphPath, "utf8"),
  ]);
  const plugin = options.plugin;
  const htmlNodes = embeddedJson(html, "RAW_NODES");
  const htmlEdges = embeddedJson(html, "RAW_EDGES");
  const graph = JSON.parse(graphText);
  const neighbourhood = findNeighbourhood(plugin, htmlNodes, htmlEdges, graph);
  const labelsById = new Map(htmlNodes.map((node) => [String(node.id), node.label]));

  console.log(`Plugin: ${plugin}`);
  console.log(`Anchors (${neighbourhood.anchors.length}): ${neighbourhood.anchors.map((id) => labelsById.get(id)).join(", ")}`);
  console.log(`Direct neighbours: ${neighbourhood.visible.length - neighbourhood.anchors.length}`);

  if (options.dryRun) return;

  const page = injectNeighbourhood(
    html,
    plugin,
    neighbourhood.anchors,
    neighbourhood.visible,
  );
  const { server, port } = await listen(
    () => createServer((request, response) => {
      if (request.url === "/" || request.url?.startsWith("/graph.html")) {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(page);
      } else {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found\n");
      }
    }),
    options.port,
  );
  const url = `http://127.0.0.1:${port}/graph.html`;

  console.log(`Serving isolated graph at ${url} (Ctrl-C to stop)`);
  if (options.open) openBrowser(url);

  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error) => {
  console.error(`graph-plugin: ${error.message}`);
  process.exit(1);
});
