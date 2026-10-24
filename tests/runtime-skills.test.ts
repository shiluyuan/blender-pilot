import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  CodexRuntime,
  type CodexSkill,
} from "../packages/runtime-adapters/codex.js";
import { MAX_PROJECT_SKILLS } from "../packages/contracts/skills.js";

async function skillAt(
  root: string,
  name: string,
  marker = "Inspect with Blender MCP.",
) {
  const folder = path.join(root, name);
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, "SKILL.md");
  await writeFile(
    file,
    `---\nname: ${name}\ndescription: A synthetic Blender workflow for protocol testing.\n---\n\n${marker}\n`,
  );
  return { name, path: file };
}

function runtimeOptions(root: string, skills: CodexSkill[] = []) {
  return {
    home: path.join(root, "home"),
    cwd: root,
    settings: {
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "synthetic-local-fixture-key",
      model: "fixture",
      effort: "low" as const,
    },
    proxyCommand: process.execPath,
    proxyArgs: [] as string[],
    runnerUrl: "http://127.0.0.1:8091",
    runToken: "test-only-token",
    skills,
    onEvent: (_method: string, _params: unknown) => {},
  };
}

async function protocolBinary(root: string, mode = "loaded") {
  const file = path.join(root, "fixture.mjs");
  await writeFile(
    file,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let roots = [], turn = 0;
createInterface({input:process.stdin}).on('line', line => {
 const v = JSON.parse(line); if(v.id === undefined) return;
 appendFileSync(${JSON.stringify(path.join(root, "rpc.jsonl"))}, JSON.stringify(v) + '\\n');
 let result = {};
 if(v.method === 'initialize') result = {userAgent:'fixture'};
 else if(v.method === 'skills/extraRoots/set') roots = v.params.extraRoots;
 else if(v.method === 'skills/list') {
  const skills = roots.map(folder => ({name:readFileSync(path.join(folder,'SKILL.md'),'utf8').match(/name: (.+)/)[1],path:path.join(folder,'SKILL.md'),enabled:true}));
  if(${JSON.stringify(mode)} === 'missing') skills.length = 0;
  if(${JSON.stringify(mode)} === 'unexpected') skills.push({name:'unselected',path:'/unselected/SKILL.md',enabled:true});
  result = {data:[{cwd:v.params.cwds[0], skills, errors:[]}]};
 } else if(v.method === 'thread/start' || v.method === 'thread/resume') result = {thread:{id:v.params.threadId || 'skill-thread'}};
 else if(v.method === 'turn/start') result = {turn:{id:'turn-'+(++turn),status:'completed',items:[]}};
 send({id:v.id,result});
});
`,
  );
  await chmod(file, 0o700);
  return file;
}

test("selected skills use native inputs, an isolated catalog and retain shell restrictions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-skills-runtime-"));
  const prior = process.env.CODEX_BIN;
  let runtime: CodexRuntime | undefined;
  try {
    const skill = await skillAt(path.join(root, "catalog"), "lighting-review");
    process.env.CODEX_BIN = await protocolBinary(root);
    const options = runtimeOptions(root, [skill]);
    runtime = new CodexRuntime(options);
    await runtime.start("existing-thread");
    const config = await readFile(
      path.join(options.home, "config.toml"),
      "utf8",
    );
    assert.match(config, /shell_tool = false/);
    assert.match(config, /sandbox_mode = "read-only"/);
    assert.match(config, /project_root_markers = \[\]/);
    assert.match(config, /\[skills\.bundled\]\nenabled = false/);
    const input = [{ type: "text" as const, text: "Review the scene" }];
    await runtime.turn(input, new AbortController().signal);
    await runtime.turn(input, new AbortController().signal);
    assert.equal(
      input.length,
      1,
      "caller input must not be mutated or accumulate skill items",
    );
    const messages = (await readFile(path.join(root, "rpc.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      messages.map((v) => v.method),
      [
        "initialize",
        "skills/extraRoots/set",
        "skills/list",
        "thread/resume",
        "turn/start",
        "turn/start",
      ],
    );
    assert.equal(
      messages[3].params.cwd,
      path.join(options.home, "skill-workspace"),
    );
    for (const message of messages.filter((v) => v.method === "turn/start"))
      assert.deepEqual(message.params.input, [
        ...input,
        { type: "skill", ...skill },
      ]);
  } finally {
    await runtime?.close();
    if (prior === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid, missing, duplicate and linked skill paths fail before starting Codex", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-skills-paths-"));
  try {
    const good = await skillAt(root, "valid-skill");
    const alias = path.join(root, "alias");
    await symlink(path.dirname(good.path), alias);
    const cases = [
      [{ ...good, path: "relative/SKILL.md" }],
      [{ ...good, path: path.join(root, "missing", "SKILL.md") }],
      [{ ...good, path: path.join(alias, "SKILL.md") }],
      [{ ...good, name: "bad\nname" }],
      [good, good],
      Array.from({ length: MAX_PROJECT_SKILLS + 1 }, () => good),
    ];
    for (const skills of cases) {
      const runtime = new CodexRuntime(runtimeOptions(root, skills));
      await assert.rejects(runtime.start(), /技能/);
      assert.equal(runtime.proc, undefined);
      await runtime.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing or unexpected catalog skills fail visibly before a thread or model turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-skills-catalog-"));
  const prior = process.env.CODEX_BIN;
  try {
    for (const mode of ["missing", "unexpected"]) {
      const scenario = path.join(root, mode);
      const skill = await skillAt(scenario, "selected");
      process.env.CODEX_BIN = await protocolBinary(scenario, mode);
      const runtime = new CodexRuntime(runtimeOptions(scenario, [skill]));
      try {
        await assert.rejects(runtime.start(), /技能/);
        const rpc = await readFile(path.join(scenario, "rpc.jsonl"), "utf8");
        assert(!rpc.includes('"thread/start"'));
        assert(!rpc.includes('"turn/start"'));
        assert(
          runtime.proc?.exitCode !== null || runtime.proc?.signalCode !== null,
        );
      } finally {
        await runtime.close();
      }
    }
  } finally {
    if (prior === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "Codex 0.164 native skill injection reaches a local Responses fixture without unrelated project skills",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pilot-skills-native-"));
    const prior = process.env.CODEX_BIN;
    const requests: any[] = [];
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, data: any) =>
        response.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
        );
      const id = `response-${requests.length}`;
      const item = {
        id: `message-${requests.length}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Synthetic protocol fixture completed.",
            annotations: [],
          },
        ],
      };
      send("response.created", {
        response: { id, status: "in_progress", output: [] },
      });
      send("response.output_item.added", {
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      });
      send("response.output_item.done", { output_index: 0, item });
      send("response.completed", {
        response: {
          id,
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      });
      response.end();
    });
    let runtime: CodexRuntime | undefined;
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const marker = "PILOT_SELECTED_SKILL_BODY_8d519e7d";
      const skill = await skillAt(
        path.join(root, "catalog"),
        "lighting-check",
        marker,
      );
      await skillAt(
        path.join(root, ".agents", "skills"),
        "unrelated-project-skill",
        "PILOT_UNSELECTED_SKILL_MUST_NOT_APPEAR",
      );
      const proxy = path.join(root, "proxy.mjs");
      await writeFile(
        proxy,
        `import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
let result={};if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'synthetic-blender',version:'1'}};
else if(m.method==='tools/list')result={tools:[{name:'get_scene_info',description:'Read synthetic scene',inputSchema:{type:'object',properties:{}}}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`,
      );
      process.env.CODEX_BIN = path.resolve("node_modules/.bin/codex");
      const options = runtimeOptions(root, [skill]);
      options.settings.baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
      options.proxyArgs = [proxy];
      runtime = new CodexRuntime(options);
      await runtime.start();
      const turn = await runtime.turn(
        [
          {
            type: "text",
            text: "Use the selected workflow to review a synthetic scene.",
          },
        ],
        new AbortController().signal,
      );
      assert.equal(turn.status, "completed");
      assert.equal(requests.length, 1);
      const sent = JSON.stringify(requests[0]);
      assert(
        sent.includes(marker),
        "native Codex must inject the SKILL.md body, not merely send its name",
      );
      assert(!sent.includes("PILOT_UNSELECTED_SKILL_MUST_NOT_APPEAR"));
      assert(!sent.includes("unrelated-project-skill"));
      assert(
        !JSON.stringify(requests[0].tools).includes('"name":"exec_command"'),
      );
    } finally {
      await runtime?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prior === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = prior;
      await rm(root, { recursive: true, force: true });
    }
  },
);
