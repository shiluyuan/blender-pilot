import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
export class Upstream {
  private client?: Client;
  private connecting?: Promise<Client>;
  async connect() {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new Client({
        name: "blender-pilot-bridge",
        version: "0.1.0",
      });
      const transport = new StdioClientTransport({
        command: process.env.MCP_BIN || "mcp-for-blender",
        args: [],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (x): x is [string, string] => typeof x[1] === "string",
            ),
          ),
          DISABLE_TELEMETRY: "true",
          BLENDER_HOST: "127.0.0.1",
          BLENDER_PORT: process.env.BLENDER_PORT || "9876",
        },
        stderr: "pipe",
      });
      transport.stderr?.on("data", () => {});
      await client.connect(transport);
      client.onclose = () => {
        this.client = undefined;
      };
      const list = await client.listTools();
      for (const name of ["look", "execute_blender_code", "get_scene_info"])
        if (!list.tools.some((t) => t.name === name))
          throw new Error(`MCP 缺少工具 ${name}`);
      this.client = client;
      return client;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
  async call(name: string, args: Record<string, unknown>, timeout = 120000) {
    const c = await this.connect();
    const r = await c.callTool({ name, arguments: args }, undefined, {
      timeout,
    });
    const content = r.content as any[];
    const errors = content.filter(
      (x) =>
        x.type === "text" &&
        /^(Error executing code:|Rejected by safe mode|Error getting|Couldn.t)/.test(
          x.text,
        ),
    );
    if (r.isError || errors.length)
      throw new Error(
        content
          .filter((x) => x.type === "text")
          .map((x) => x.text)
          .join("\n")
          .slice(0, 5000),
      );
    return content;
  }
  async python(code: string) {
    const content = await this.call("execute_blender_code", { code });
    return content
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("\n");
  }
  async json(code: string) {
    const text = await this.python(code);
    const marker = "PILOT_JSON:";
    const i = text.lastIndexOf(marker);
    if (i < 0) throw new Error("Blender 未返回预期的结构化结果");
    return JSON.parse(text.slice(i + marker.length).trim());
  }
  async close() {
    await this.client?.close();
  }
}
