#!/usr/bin/env node
// Loopback-only, read-only API/CLI-equivalent/MCP smoke probe for the seeded sandbox.
import { readFile } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const origin = process.env.OPENOUTBOUND_REVIEW_ORIGIN ?? "http://127.0.0.1:7331";
const base = new URL(origin);
if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
  throw new Error("Review probe is restricted to loopback HTTP.");
}
const home = new URL("./.openoutbound/server.json", import.meta.url);
const state = JSON.parse(await readFile(home, "utf8"));
const key = state.local_keys?.agent;
if (!key) throw new Error("Local running server agent key is missing.");
const headers = { Authorization: `Bearer ${key}`, "OpenOutbound-Workspace": "northwind" };
async function get(path, authenticated = true) {
  const response = await fetch(new URL(path, base), {
    headers: authenticated ? headers : {},
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
const health = await get("/health", false);
const spec = await get("/openapi.json", false);
const sandbox = await get("/v1/sandbox/status");
const campaigns = await get("/v1/campaigns");
const signals = await get("/v1/signals?limit=5");
const messages = await get("/v1/messages?limit=5");
console.log(
  JSON.stringify(
    {
      health: {
        status: health.status,
        version: health.version,
        database: health.database,
        worker: health.worker,
      },
      openapi_paths: Object.keys(spec.paths ?? {}).length,
      workspaces: sandbox.workspaces.map((w) => ({ slug: w.slug, counts: w.counts })),
      northwind: {
        campaigns: campaigns.items?.length,
        sample_signals: signals.items?.length,
        sample_messages: messages.items?.length,
      },
    },
    null,
    2,
  ),
);

const client = new Client({ name: "openoutbound-review-readonly", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL("/mcp?toolsets=core", base), {
  requestInit: { headers },
});
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const getStatus = tools.find((t) => t.name === "get_status");
  if (!getStatus?.annotations?.readOnlyHint)
    throw new Error("get_status is not advertised read-only");
  const result = await client.callTool({
    name: "get_status",
    arguments: { workspace: "northwind" },
  });
  if (result.isError) throw new Error("MCP get_status returned an error");
  console.log(
    JSON.stringify(
      {
        mcp: {
          tool_count: tools.length,
          get_status_readonly: true,
          result_keys: Object.keys(result.structuredContent ?? {}),
        },
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
