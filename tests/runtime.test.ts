import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexRuntime } from "../packages/runtime-adapters/codex.js";

test("Codex adapter: protocol, resume, image input, redaction and interruption", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-runtime-"));
  const binary = path.join(root, "fixture.mjs");
  await writeFile(
    binary,
    `#!/usr/bin/env node
import {createInterface} from 'node:readline';
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');let turn=0;
createInterface({input:process.stdin}).on('line',line=>{
 const v=JSON.parse(line);if(v.id===undefined)return;
 if(v.method==='initialize')send({id:v.id,result:{userAgent:'fixture'}});
 else if(v.method==='thread/start'||v.method==='thread/resume')send({id:v.id,result:{thread:{id:v.params.threadId||'native-1'}}});
 else if(v.method==='turn/start'){
  turn++;const id='turn-'+turn;send({id:v.id,result:{turn:{id,status:'inProgress'}}});
  send({method:'turn/started',params:{turn:{id}}});
  if(v.params.input.some(i=>i.type==='localImage'))send({method:'image-observed',params:{path:v.params.input.find(i=>i.type==='localImage').path}});
  process.stderr.write('provider says '+process.env.PILOT_MODEL_KEY+'\\n');
  if(turn===1)setTimeout(()=>{send({method:'item/agentMessage/delta',params:{delta:'done'}});send({method:'turn/completed',params:{turn:{id,status:'completed'}}});},15);
 }else if(v.method==='turn/interrupt'){send({id:v.id,result:{}});send({method:'turn/completed',params:{turn:{id:'turn-'+turn,status:'interrupted'}}});}
});
`,
  );
  await chmod(binary, 0o700);
  const prior = process.env.CODEX_BIN;
  process.env.CODEX_BIN = binary;
  const events: any[] = [];
  const options = {
    home: path.join(root, "home"),
    cwd: root,
    settings: {
      baseUrl: "https://relay.example/custom/v1",
      apiKey: "arbitrary-secret-key",
      model: "custom-vision",
      effort: "low" as const,
    },
    proxyCommand: "node",
    proxyArgs: ["proxy.js"],
    runnerUrl: "http://127.0.0.1:8091",
    runToken: "test-token",
    onEvent: (method: string, params: any) => events.push({ method, params }),
  };
  let runtime = new CodexRuntime(options);
  try {
    assert.equal(await runtime.start(), "native-1");
    const config = await readFile(
      path.join(options.home, "config.toml"),
      "utf8",
    );
    assert(config.includes("https://relay.example/custom/v1"));
    assert(!config.includes(options.settings.apiKey));
    assert(config.includes('sandbox_mode = "read-only"'));
    const done = await runtime.turn(
      [
        { type: "text", text: "inspect" },
        { type: "localImage", path: "/fixture/image.jpg" },
      ],
      new AbortController().signal,
    );
    assert.equal(done.status, "completed");
    assert(events.some((e) => e.method === "image-observed"));
    assert(!JSON.stringify(events).includes(options.settings.apiKey));
    const abort = new AbortController();
    const pending = runtime.turn(
      [{ type: "text", text: "wait" }],
      abort.signal,
    );
    setTimeout(() => abort.abort(), 30);
    assert.equal((await pending).status, "interrupted");
    await runtime.close();
    runtime = new CodexRuntime(options);
    assert.equal(await runtime.start("native-existing"), "native-existing");
  } finally {
    await runtime.close();
    if (prior === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prior;
    await rm(root, { recursive: true, force: true });
  }
});
