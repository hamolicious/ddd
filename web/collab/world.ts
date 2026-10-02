import * as Y from "yjs";
import { expect } from "vitest";

import { TEXT_ROOT } from "../harness/src/ops.js";
import { authenticate, RestClient } from "../harness/src/rest.js";
import { Peer, sleep } from "./peer.js";
import { startServer, type CollabServer } from "./server.js";

export interface Account {
  readonly email: string;
  readonly password: string;
}

export const ALICE: Account = { email: "alice@collab.test", password: "collab-alice-password-1" };
export const BOB: Account = { email: "bob@collab.test", password: "collab-bob-password-1" };

export interface World {
  readonly server: CollabServer;
  readonly rest: RestClient;
  device(name: string, account?: Account, options?: { online?: boolean }): Promise<Peer>;
  note(content: string): Promise<string>;
  close(): Promise<void>;
}

export async function world(port: number): Promise<World> {
  const server = await startServer({ port, database: `ddd_collab_${port}` });
  const aliceToken = await authenticate(server.url, ALICE.email, ALICE.password);
  const rest = new RestClient(server.url, aliceToken);
  await ensureAccount(server.url, rest, BOB);
  const devices: Peer[] = [];

  return {
    server,
    rest,
    async device(name, account = ALICE, options = {}) {
      const token = await new RestClient(server.url).login(account.email, account.password);
      const peer = new Peer(name, server.url, token);
      devices.push(peer);
      if (options.online !== false) await peer.online();
      return peer;
    },
    async note(content) {
      const response = await rest.request("POST", "/api/documents", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      return ((await response.json()) as { id: string }).id;
    },
    async close() {
      await Promise.all(devices.map((peer) => peer.close()));
      if (server.owned) await server.stop();
    },
  };
}

async function ensureAccount(url: string, admin: RestClient, account: Account): Promise<void> {
  try {
    await new RestClient(url).login(account.email, account.password);
    return;
  } catch {
  }
  const invite = (await admin.json("POST", "/api/admin/invites", { email: account.email })) as { token: string };
  await new RestClient(url).register(account.email, account.password, invite.token);
}

export async function serverText(rest: RestClient, id: string): Promise<string> {
  const { state } = await rest.crdtState(id);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const text = doc.getText(TEXT_ROOT).toString();
  doc.destroy();
  return text;
}

export async function converged(
  rest: RestClient,
  id: string,
  peers: readonly Peer[],
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let nudged = false;
  for (;;) {
    const server = await serverText(rest, id);
    const locals = peers.map((peer) => peer.text(id));
    const materialized = (await rest.getDocument(id)).content;
    if (locals.every((text) => text === server) && materialized === server) return server;
    if (Date.now() > deadline) {
      const sides = [
        `server crdt:     ${JSON.stringify(server)}`,
        `server content:  ${JSON.stringify(materialized)}`,
        ...peers.map((peer, index) => `${peer.name.padEnd(16)} ${JSON.stringify(locals[index])}`),
      ];
      expect.fail(`${id} did not converge within ${timeoutMs} ms\n${sides.join("\n")}`);
    }
    if (!nudged && Date.now() > deadline - timeoutMs / 2) {
      for (const peer of peers) peer.resync(id);
      nudged = true;
    }
    await sleep(80);
  }
}

export function eachExactlyOnce(text: string, needles: readonly string[]): void {
  const wrong = needles
    .map((needle) => [needle, text.split(needle).length - 1] as const)
    .filter(([, count]) => count !== 1);
  expect(wrong, `in ${JSON.stringify(text)}`).toEqual([]);
}

export { sleep };
