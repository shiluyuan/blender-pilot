import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
const url = process.env.PILOT_RUNNER_URL || "http://127.0.0.1:8091";
const token = process.env.PILOT_RUN_TOKEN;
if (!token) throw new Error("PILOT_RUN_TOKEN required");
async function request(endpoint: string, body?: unknown) {
  const response = await fetch(url + endpoint, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(190000),
  });
  if (!response.ok) throw new Error((await response.text()).slice(0, 1500));
  return response.json() as Promise<any>;
}
const server = new Server(
  { name: "blender-pilot", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () =>
  request("/mcp/tools"),
);
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await request("/mcp/call", {
      name: req.params.name,
      arguments: req.params.arguments || {},
    });
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: String(e) }] };
  }
});
await server.connect(new StdioServerTransport());
