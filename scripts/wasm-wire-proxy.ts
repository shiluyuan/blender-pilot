/** Test-only framing adapter for PGlite's single PostgreSQL backend.
 * Serializes complete extended-query cycles, retaining a connection's ownership
 * through BEGIN..COMMIT/ROLLBACK. Production uses PostgreSQL directly.
 */
import { createServer, connect, type Socket } from "node:net";
export async function wasmWireProxy(upstreamPort: number, port: number) {
  type Client = {
    socket: Socket;
    upstream: Socket;
    input: Buffer;
    output: Buffer;
    startup: boolean;
    closed: boolean;
  };
  const clients = new Set<Client>(),
    queue: { client: Client; bytes: Buffer }[] = [];
  let owner: Client | undefined,
    busy = false;
  const pump = () => {
    if (busy) return;
    const at = owner ? queue.findIndex((q) => q.client === owner) : 0;
    if (at < 0 || !queue[at]) return;
    const item = queue.splice(at, 1)[0];
    if (item.client.closed) {
      pump();
      return;
    }
    owner = item.client;
    busy = true;
    item.client.upstream.write(item.bytes);
  };
  const enqueue = (client: Client, bytes: Buffer) => {
    queue.push({ client, bytes });
    pump();
  };
  const server = createServer((socket) => {
    const upstream = connect(upstreamPort, "127.0.0.1");
    const c: Client = {
      socket,
      upstream,
      input: Buffer.alloc(0),
      output: Buffer.alloc(0),
      startup: true,
      closed: false,
    };
    clients.add(c);
    socket.on("data", (data) => {
      c.input = Buffer.concat([
        c.input,
        typeof data === "string" ? Buffer.from(data) : data,
      ]);
      if (c.startup) {
        if (c.input.length < 8) return;
        const length = c.input.readUInt32BE(0);
        if (c.input.length < length) return;
        const bytes = c.input.subarray(0, length);
        c.input = c.input.subarray(length);
        if (length === 8 && bytes.readUInt32BE(4) === 80877103) {
          socket.write("N");
          return;
        }
        c.startup = false;
        enqueue(c, bytes);
      }
      let offset = 0,
        complete = 0;
      while (c.input.length - offset >= 5) {
        const size = 1 + c.input.readUInt32BE(offset + 1);
        if (size < 5 || size > 32 * 1024 * 1024) {
          socket.destroy();
          return;
        }
        if (c.input.length - offset < size) break;
        const type = String.fromCharCode(c.input[offset]);
        offset += size;
        if (type === "S" || type === "Q") complete = offset;
        else if (type === "X") {
          upstream.end();
          socket.end();
          return;
        }
      }
      if (complete) {
        enqueue(c, c.input.subarray(0, complete));
        c.input = c.input.subarray(complete);
      }
    });
    upstream.on("data", (data) => {
      if (!c.closed) socket.write(data);
      c.output = Buffer.concat([
        c.output,
        typeof data === "string" ? Buffer.from(data) : data,
      ]);
      while (c.output.length >= 5) {
        const size = 1 + c.output.readUInt32BE(1);
        if (c.output.length < size) break;
        const type = String.fromCharCode(c.output[0]),
          frame = c.output.subarray(0, size);
        c.output = c.output.subarray(size);
        if (type === "Z" && owner === c) {
          busy = false;
          if (frame[5] === 73) owner = undefined;
          pump();
        }
      }
    });
    const close = () => {
      if (c.closed) return;
      c.closed = true;
      clients.delete(c);
      for (let i = queue.length - 1; i >= 0; i--)
        if (queue[i].client === c) queue.splice(i, 1);
      if (owner === c) {
        owner = undefined;
        busy = false;
      }
      upstream.destroy();
      socket.destroy();
      pump();
    };
    socket.on("error", close);
    upstream.on("error", close);
    socket.on("close", close);
    upstream.on("close", close);
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return {
    close: async () => {
      for (const c of clients) {
        c.socket.destroy();
        c.upstream.destroy();
      }
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
