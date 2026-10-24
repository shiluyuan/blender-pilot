import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexRuntime } from "../packages/runtime-adapters/codex.js";
import { normalizeCodexEvent } from "../packages/contracts/chat-events.js";

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
    onEvent: (method: string, params: any) => {
      events.push({ method, params });
    },
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

test("Codex adapter isolates resumed turns, accepts pre-ack events and drains ordered delivery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-runtime-order-"));
  const binary = path.join(root, "fixture.mjs");
  await writeFile(
    binary,
    `#!/usr/bin/env node
import {createInterface} from 'node:readline';
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const event=(method,params={})=>send({method,params:{threadId:'native-existing',...params}});
let current='',replies=[];
createInterface({input:process.stdin}).on('line',line=>{
 const v=JSON.parse(line);
 if(!v.method){
  if(v.id==='ask-1'||v.id==='approve-1'){
   replies.push(v);if(replies.length===2){
    event('fixture/serverReplies',{turnId:current,replies});
    event('item/completed',{threadId:'foreign-thread',turnId:current,item:{id:'foreign-item',type:'agentMessage',text:'wrong thread'}});
    event('item/completed',{turnId:'old-turn',item:{id:'old-item',type:'agentMessage',text:'wrong turn'}});
    event('turn/completed',{turn:{id:current,status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text:'Canonical answer without deltas.'}]}});
   }
  }return;
 }
 if(v.id===undefined)return;
 if(v.method==='initialize')send({id:v.id,result:{userAgent:'fixture'}});
 else if(v.method==='thread/resume'){
  event('item/completed',{turnId:'old-turn',item:{id:'history',type:'agentMessage',text:'resume history'}});
  send({id:v.id,result:{thread:{id:'native-existing'}}});
 }else if(v.method==='turn/start'){
  current='new-turn';
  event('turn/started',{turn:{id:'old-turn'}});
  event('item/agentMessage/delta',{turnId:'old-turn',itemId:'history',delta:'old delta'});
  event('turn/completed',{turn:{id:'old-turn',status:'completed'}});
  event('item/started',{turnId:current,item:{id:'comment',type:'agentMessage',phase:'commentary',text:''}});
  event('item/agentMessage/delta',{turnId:current,itemId:'comment',delta:'Inspecting the scene.'});
  event('item/completed',{turnId:current,item:{id:'comment',type:'agentMessage',phase:'commentary',text:'Inspecting the scene.'}});
  event('turn/plan/updated',{turnId:current,plan:[{step:'Inspect',status:'completed'}]});
  event('item/started',{turnId:current,item:{id:'mcp-1',type:'mcpToolCall',server:'blender',tool:'get_scene_info',status:'inProgress'}});
  event('item/completed',{turnId:current,item:{id:'mcp-1',type:'mcpToolCall',server:'blender',tool:'get_scene_info',status:'completed',result:{content:[{type:'image',mimeType:'image/png',data:'large-base64'},{type:'text',text:'ok'}]}}});
  setTimeout(()=>{
   send({id:v.id,result:{turn:{id:current,status:'inProgress'}}});
   send({id:'ask-1',method:'item/tool/requestUserInput',params:{threadId:'native-existing',turnId:current,questions:[]}});
   send({id:'approve-1',method:'item/fileChange/requestApproval',params:{threadId:'native-existing',turnId:current}});
  },10);
 }
});
`,
  );
  await chmod(binary, 0o700);
  const prior = process.env.CODEX_BIN;
  process.env.CODEX_BIN = binary;
  const events: { method: string; params: any }[] = [];
  const runtime = new CodexRuntime({
    home: path.join(root, "home"),
    cwd: root,
    settings: {
      baseUrl: "https://relay.example",
      model: "fixture",
      effort: "low",
    },
    proxyCommand: "node",
    proxyArgs: [],
    runnerUrl: "http://127.0.0.1:8091",
    runToken: "test-token",
    onEvent: async (method, params) => {
      // Simulate asynchronous durable delivery; completion must wait for it.
      await new Promise((resolve) => setTimeout(resolve, 2));
      events.push({ method, params });
    },
  });
  try {
    await runtime.start("native-existing");
    const turn = await runtime.turn(
      [{ type: "text", text: "inspect" }],
      new AbortController().signal,
    );
    assert.equal(turn.id, "new-turn");
    assert.equal(events.at(-1)?.method, "turn/completed");
    assert(
      !events.some((event) =>
        /wrong turn|wrong thread|resume history|old delta/.test(
          JSON.stringify(event),
        ),
      ),
    );
    const normalized = events.flatMap((event) =>
      normalizeCodexEvent(event.method, event.params),
    );
    assert.deepEqual(
      normalized
        .filter((e) => e.type.startsWith("message."))
        .map((e) => [e.type, e.payload.itemId]),
      [
        ["message.started", "comment"],
        ["message.delta", "comment"],
        ["message.completed", "comment"],
        ["message.completed", "answer"],
      ],
    );
    assert.equal(
      normalized.find(
        (e) => e.type === "message.completed" && e.payload.itemId === "answer",
      )?.payload.text,
      "Canonical answer without deltas.",
    );
    assert(normalized.some((e) => e.type === "plan.updated"));
    assert.equal(
      normalized.filter((e) => e.type === "runtime.notice").length,
      2,
    );
    const nativeTool = normalized.find(
      (e) => e.type === "runtime.item.completed",
    );
    assert.equal(nativeTool?.payload.callId, "mcp-1");
    assert.equal(nativeTool?.payload.server, "blender");
    assert(!JSON.stringify(nativeTool).includes("large-base64"));
    const replies = events.find((e) => e.method === "fixture/serverReplies")
      ?.params.replies;
    assert.equal(replies[0].error.code, -32601);
    assert.equal(replies[1].result.decision, "decline");
  } finally {
    await runtime.close();
    if (prior === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex close rejects in-flight RPC and waits for child process cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-runtime-close-"));
  const binary = path.join(root, "fixture.mjs");
  await writeFile(
    binary,
    `#!/usr/bin/env node
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);
if(v.method==='initialize')process.stdout.write(JSON.stringify({id:v.id,result:{}})+'\\n');
if(v.method==='thread/start')process.stdout.write(JSON.stringify({id:v.id,result:{thread:{id:'native-1'}}})+'\\n');
});

`,
  );
  await chmod(binary, 0o700);
  const prior = process.env.CODEX_BIN;
  process.env.CODEX_BIN = binary;
  const runtime = new CodexRuntime({
    home: path.join(root, "home"),
    cwd: root,
    settings: {
      baseUrl: "https://relay.example",
      model: "fixture",
      effort: "low",
    },
    proxyCommand: "node",
    proxyArgs: [],
    runnerUrl: "http://127.0.0.1:8091",
    runToken: "test-token",
    onEvent: () => {},
  });
  try {
    await runtime.start();
    const pending = runtime.turn(
      [{ type: "text", text: "wait" }],
      new AbortController().signal,
    );
    const rejected = assert.rejects(pending, /关闭/);
    await runtime.close();
    await rejected;
    assert(
      runtime.proc?.exitCode !== null || runtime.proc?.signalCode !== null,
    );
    await runtime.close();
    await assert.rejects(runtime.request("turn/start", {}), /关闭/);
  } finally {
    await runtime.close();
    if (prior === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "Codex completes pre-ack snapshots and fails visibly on provider or event delivery errors",
  { timeout: 5000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pilot-runtime-errors-"));
    const binary = path.join(root, "fixture.mjs");
    await writeFile(
      binary,
      `#!/usr/bin/env node
import {createInterface} from 'node:readline';
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');let count=0;
createInterface({input:process.stdin}).on('line',line=>{const v=JSON.parse(line);if(v.id===undefined)return;
 if(v.method==='initialize')send({id:v.id,result:{}});
 else if(v.method==='thread/start')send({id:v.id,result:{thread:{id:'native-errors'}}});
 else if(v.method==='turn/start'){
  const id='turn-'+(++count), mode=v.params.input[0].text;
  if(mode==='error'){
   send({id:v.id,result:{turn:{id,status:'inProgress'}}});
   send({method:'error',params:{threadId:'native-errors',turnId:id,willRetry:false,error:{message:'Provider rejected '+process.env.PILOT_MODEL_KEY}}});
  }else{
   send({method:'turn/completed',params:{threadId:'native-errors',turn:{id,status:'completed',items:[{id:'final-'+count,type:'agentMessage',phase:'final_answer',text:'Final '+mode}]}}});
   setTimeout(()=>send({id:v.id,result:{turn:{id,status:'inProgress'}}}),5);
  }
 }
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
        baseUrl: "https://relay.example",
        apiKey: 'key-with-"quote-and-back\\slash',
        model: "fixture",
        effort: "low" as const,
      },
      proxyCommand: "node",
      proxyArgs: [],
      runnerUrl: "http://127.0.0.1:8091",
      runToken: "test-token",
      onEvent: (method: string, params: any) => {
        events.push({ method, params });
      },
    };
    let runtime = new CodexRuntime(options);
    try {
      await runtime.start();
      assert.equal(
        (
          await runtime.turn(
            [{ type: "text", text: "early" }],
            new AbortController().signal,
          )
        ).status,
        "completed",
      );
      assert.equal(
        events.find((e) => e.method === "item/completed")?.params.item.text,
        "Final early",
      );
      await assert.rejects(
        runtime.turn(
          [{ type: "text", text: "error" }],
          new AbortController().signal,
        ),
        /Provider rejected \[redacted\]/,
      );
      assert(!JSON.stringify(events).includes(options.settings.apiKey));
      assert.equal(
        events.find((e) => e.method === "error")?.params.error.message,
        "Provider rejected [redacted]",
      );
      await runtime.close();
      runtime = new CodexRuntime({
        ...options,
        onEvent: async (method) => {
          if (method === "item/completed")
            throw new Error("durable event delivery failed");
        },
      });
      await runtime.start();
      await assert.rejects(
        runtime.turn(
          [{ type: "text", text: "delivery" }],
          new AbortController().signal,
        ),
        /durable event delivery failed/,
      );
    } finally {
      await runtime.close();
      if (prior === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = prior;
      await rm(root, { recursive: true, force: true });
    }
  },
);
