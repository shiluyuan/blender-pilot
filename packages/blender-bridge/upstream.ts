import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
export class Upstream {
  constructor(private environment: Record<string, string> = {}) {}
  private client?: Client;
  private connecting?: Promise<Client>;
  private connection?: { client: Client; transport: StdioClientTransport };
  private closing?: Promise<void>;
  private generation = 0;
  async connect() {
    if (this.closing) throw new Error("Blender MCP 正在关闭");
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    const generation = this.generation;
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
          ...this.environment,
        },
        stderr: "pipe",
      });
      const connection = { client, transport };
      this.connection = connection;
      transport.stderr?.on("data", () => {});
      client.onclose = () => {
        if (this.client === client) this.client = undefined;
        if (this.connection === connection) this.connection = undefined;
      };
      try {
        await client.connect(transport);
        const list = await client.listTools();
        for (const name of ["look", "execute_blender_code", "get_scene_info"])
          if (!list.tools.some((t) => t.name === name))
            throw new Error(`MCP 缺少工具 ${name}`);
        if (generation !== this.generation)
          throw new Error("Blender MCP 连接已取消");
        this.client = client;
        return client;
      } catch (error) {
        // A failed handshake or incompatible tool list still owns a native
        // subprocess. Reap it before allowing another connection attempt.
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        if (this.connection === connection) this.connection = undefined;
        throw error;
      }
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
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.generation++;
    const connection = this.connection;
    const connecting = this.connecting;
    this.client = undefined;
    this.closing = (async () => {
      // close() must also stop initialization, not just a fully ready client.
      // Closing the transport rejects the pending SDK handshake/list request.
      if (connection) {
        await connection.client.close().catch(() => {});
        await connection.transport.close();
      }
      await connecting?.catch(() => {});
    })().finally(() => {
      if (this.connection === connection) this.connection = undefined;
      this.closing = undefined;
    });
    return this.closing;
  }
}
