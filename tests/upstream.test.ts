import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Upstream } from "../packages/blender-bridge/upstream.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-upstream-"));
  const binary = path.join(root, "mcp.mjs");
  await writeFile(
    binary,
    `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const root=process.env.PILOT_FIXTURE_ROOT;
appendFileSync(root+'/starts',process.pid+'\\n');
const first=readFileSync(root+'/starts','utf8').trim().split('\\n').length===1;
process.on('exit',()=>writeFileSync(root+'/exit-'+process.pid,'closed'));
process.stdin.on('end',()=>process.exit(0));
const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const v=JSON.parse(line);if(v.id===undefined)return;
 if(v.method==='initialize')send({id:v.id,result:{protocolVersion:v.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}});
 else if(v.method==='tools/list'){
  writeFileSync(root+'/listing','ready');
  if(process.env.PILOT_FIXTURE_MODE==='slow'&&first)return;
  const names=first&&process.env.PILOT_FIXTURE_MODE==='invalid-once'?['look']:['look','execute_blender_code','get_scene_info'];
  send({id:v.id,result:{tools:names.map(name=>({name,inputSchema:{type:'object'}}))}});
 }else if(v.method==='tools/call')send({id:v.id,result:{content:[{type:'text',text:'ok'}]}});
});
`,
  );
  await chmod(binary, 0o700);
  return { root, binary };
}

async function waitFile(file: string) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    try {
      return await readFile(file, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Fixture did not create " + file);
}

test("failed MCP tool negotiation closes its process and retry creates one healthy client", async () => {
  const { root, binary } = await fixture();
  const prior = process.env.MCP_BIN;
  process.env.MCP_BIN = binary;
  const upstream = new Upstream({
    PILOT_FIXTURE_ROOT: root,
    PILOT_FIXTURE_MODE: "invalid-once",
  });
  try {
    await assert.rejects(upstream.connect(), /MCP 缺少工具/);
    const firstPid = (await readFile(path.join(root, "starts"), "utf8")).trim();
    await waitFile(path.join(root, "exit-" + firstPid));
    const clients = await Promise.all([
      upstream.connect(),
      upstream.connect(),
      upstream.connect(),
    ]);
    assert.equal(clients[0], clients[1]);
    assert.equal(clients[1], clients[2]);
    assert.deepEqual(await upstream.call("get_scene_info", {}), [
      { type: "text", text: "ok" },
    ]);
    assert.equal(
      (await readFile(path.join(root, "starts"), "utf8")).trim().split("\n")
        .length,
      2,
    );
    await upstream.close();
    for (const pid of (await readFile(path.join(root, "starts"), "utf8"))
      .trim()
      .split("\n"))
      await waitFile(path.join(root, "exit-" + pid));
  } finally {
    await upstream.close();
    if (prior === undefined) delete process.env.MCP_BIN;
    else process.env.MCP_BIN = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("closing MCP during initialization rejects the pending connect and never republishes its client", async () => {
  const { root, binary } = await fixture();
  const prior = process.env.MCP_BIN;
  process.env.MCP_BIN = binary;
  const upstream = new Upstream({
    PILOT_FIXTURE_ROOT: root,
    PILOT_FIXTURE_MODE: "slow",
  });
  try {
    const pending = upstream.connect();
    const rejected = assert.rejects(pending, /closed|取消/i);
    await waitFile(path.join(root, "listing"));
    await Promise.all([upstream.close(), upstream.close()]);
    await rejected;
    const firstPid = (await readFile(path.join(root, "starts"), "utf8")).trim();
    await waitFile(path.join(root, "exit-" + firstPid));
    await upstream.connect();
    assert.deepEqual(await upstream.call("get_scene_info", {}), [
      { type: "text", text: "ok" },
    ]);
    assert.equal(
      (await readFile(path.join(root, "starts"), "utf8")).trim().split("\n")
        .length,
      2,
    );
  } finally {
    await upstream.close();
    if (prior === undefined) delete process.env.MCP_BIN;
    else process.env.MCP_BIN = prior;
    await rm(root, { recursive: true, force: true });
  }
});
