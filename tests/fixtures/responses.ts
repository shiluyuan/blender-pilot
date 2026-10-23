/** Deterministic protocol fixture. This is NOT an AI model or a visual evaluator. */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
export async function responsesFixture(host = "127.0.0.1") {
  const requests: any[] = [];
  let stage = 0;
  let hold = false;
  const sockets = new Set<any>();
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/responses") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    requests.push(body);
    if (hold) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": waiting\n\n");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    const emit = (type: string, data: any) =>
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      );
    const id = "resp_" + randomUUID(),
      mid = "msg_" + randomUUID();
    const base = {
      id,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: body.model,
      status: "in_progress",
      output: [],
    };
    emit("response.created", { response: base });
    const tools = body.tools || [];
    // Native Codex 0.164 groups MCP functions under Responses namespaces.
    const functions = tools.flatMap((tool: any) =>
      tool.type === "namespace"
        ? (tool.tools || []).map((fn: any) => ({ ...fn, namespace: tool.name }))
        : [tool],
    );
    const name = (suffix: string) =>
      functions.find((x: any) => x.name?.endsWith(suffix))?.name;
    let item: any;
    if (!Array.isArray(body.input) || tools.length === 0) {
      item = {
        id: mid,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "OK", annotations: [] }],
      };
    } else {
      const all = JSON.stringify(body.input);
      if (stage === 0) {
        item = {
          type: "function_call",
          name: name("get_scene_info"),
          arguments: "{}",
        };
        stage++;
      } else if (stage === 1) {
        item = {
          type: "function_call",
          name: name("execute_blender_code"),
          arguments: JSON.stringify({
            code: "import bpy\nbpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=1, location=(3,0,1))\no=bpy.context.object\no.name='Pilot_Verified_Sphere'\nm=bpy.data.materials.new('Pilot_Teal')\nm.diffuse_color=(0.12,0.65,0.48,1)\no.data.materials.append(m)\nfor area in bpy.context.screen.areas:\n    if area.type=='VIEW_3D':\n        area.spaces.active.shading.color_type='MATERIAL'\nprint(o.name, list(o.location))",
          }),
        };
        stage++;
      } else if (stage === 2) {
        item = {
          type: "function_call",
          name: name("save_library_asset"),
          arguments: JSON.stringify({
            name: "协议保存球体",
            category: "prop",
            objectNames: ["Pilot_Verified_Sphere"],
            tags: ["协议验收"],
          }),
        };
        stage++;
      } else if (stage === 3) {
        item = {
          type: "function_call",
          name: name("search_library"),
          arguments: JSON.stringify({ search: "协议保存球体" }),
        };
        stage++;
      } else if (stage === 4 || stage === 5) {
        let assetId = "";
        const findAsset = (v: any) => {
          if (typeof v === "string") {
            try {
              findAsset(JSON.parse(v));
            } catch {}
          } else if (Array.isArray(v)) v.forEach(findAsset);
          else if (v && typeof v === "object") {
            if (v.name === "协议保存球体" && v.id) assetId = v.id;
            Object.values(v).forEach(findAsset);
          }
        };
        findAsset(body.input);
        item = {
          type: "function_call",
          name: name(
            stage === 4 ? "get_library_asset" : "import_library_asset",
          ),
          arguments: JSON.stringify({ assetId }),
        };
        stage++;
      } else if (stage === 6) {
        // Tool outputs can be encoded JSON strings in the Responses input.
        const ids = [
          ...all.matchAll(/(?:captureId|\\?"id\\?")[:=]\\?"([a-f\d-]{36})/g),
        ].map((x) => x[1]);
        let captureId = "";
        const walk = (v: any) => {
          if (typeof v === "string") {
            try {
              walk(JSON.parse(v));
            } catch {}
          } else if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === "object") {
            if (v.capture?.id) captureId = v.capture.id;
            Object.values(v).forEach(walk);
          }
        };
        walk(body.input);
        captureId ||= ids.at(-1) || "";
        item = {
          type: "function_call",
          name: name("report_verification"),
          arguments: JSON.stringify({
            captureId,
            passed: true,
            observations:
              "协议测试夹具：已收到实际截图与对象回读；此文本不代表真实模型视觉判断。",
          }),
        };
        stage++;
      } else
        item = {
          id: mid,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "已创建 Pilot_Verified_Sphere，并保存操作前后截图。\n\n这是自动化协议测试，实际视觉判断需要你配置的多模态模型。",
              annotations: [],
            },
          ],
        };
    }
    if (item.type === "function_call")
      Object.assign(item, {
        namespace: functions.find((fn: any) => fn.name === item.name)
          ?.namespace,
        id: "fc_" + randomUUID(),
        call_id: "call_" + randomUUID(),
        status: "completed",
      });
    if (item.type === "function_call" && !item.name) {
      emit("response.failed", {
        response: {
          ...base,
          status: "failed",
          error: {
            code: "fixture_tool_missing",
            message:
              "Expected Blender tool missing: " +
              JSON.stringify(functions.map((t: any) => t.name)),
          },
        },
      });
      res.end();
      return;
    }
    emit("response.output_item.added", {
      output_index: 0,
      item:
        item.type === "function_call"
          ? { ...item, arguments: "", status: "in_progress" }
          : { ...item, content: [], status: "in_progress" },
    });
    if (item.type === "function_call") {
      emit("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: 0,
        delta: item.arguments,
      });
      emit("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: 0,
        arguments: item.arguments,
      });
    } else {
      emit("response.content_part.added", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      emit("response.output_text.delta", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: item.content[0].text,
      });
      emit("response.output_text.done", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: item.content[0].text,
      });
      emit("response.content_part.done", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: item.content[0],
      });
    }
    emit("response.output_item.done", { output_index: 0, item });
    emit("response.completed", {
      response: {
        ...base,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 100,
          output_tokens: 30,
          total_tokens: 130,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
    res.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    requests,
    setHold: (v: boolean) => (hold = v),
    reset: () => (stage = 0),
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
