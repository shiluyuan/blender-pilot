import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP stdio facade preserves image content and per-run authorization", async () => {
  const token = "fixture-run-token";
  let authorized = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + token);
    authorized++;
    res.setHeader("content-type", "application/json");
    if (req.url === "/mcp/tools")
      res.end(
        JSON.stringify({
          tools: [
            {
              name: "capture",
              description: "fixture image",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        }),
      );
    else {
      let text = "";
      for await (const c of req) text += c;
      assert.equal(JSON.parse(text).name, "capture");
      res.end(
        JSON.stringify({
          content: [
            { type: "text", text: '{"captureId":"fixture"}' },
            {
              type: "image",
              mimeType: "image/png",
              data: "aW1hZ2UtZml4dHVyZQ==",
            },
          ],
        }),
      );
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const client = new Client({ name: "pilot-test", version: "1.0.0" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          path.resolve("packages/blender-bridge/mcp-proxy.ts"),
        ],
        env: {
          PATH: process.env.PATH || "",
          PILOT_RUNNER_URL: `http://127.0.0.1:${port}`,
          PILOT_RUN_TOKEN: token,
        },
        stderr: "pipe",
      }),
    );
    assert.equal((await client.listTools()).tools[0].name, "capture");
    const result = await client.callTool({ name: "capture", arguments: {} });
    assert.deepEqual((result.content as any[])[1], {
      type: "image",
      mimeType: "image/png",
      data: "aW1hZ2UtZml4dHVyZQ==",
    });
    assert(authorized >= 2);
  } finally {
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
