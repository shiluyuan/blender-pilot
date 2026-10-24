import "./database-env.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { deflateRawSync } from "node:zlib";
import sharp from "sharp";
import {
  bundleSkills,
  parseSkillMarkdown,
  readSkillZip,
  skillCRC32,
} from "../packages/storage/skill-bundle.js";
import { SkillCatalog } from "../packages/storage/skill-catalog.js";
import {
  readSkillResource,
  verifyRunSkills,
} from "../packages/storage/skill-resources.js";
import {
  normalizeSkillSource,
  skillInstallArguments,
  validateSkillGitTree,
} from "../packages/storage/skill-installer.js";
import { buildApp } from "../apps/server/app.js";

const markdown = (name = "fixture-blender") =>
  Buffer.from(
    "---\nname: " +
      name +
      "\ndescription: |\n  Create a fixture scene with Blender MCP.\n  Inspect evidence before reporting.\n---\nUse Blender MCP and read references/guide.md before proceeding.\n",
  );

function zip(
  files: Array<{
    name: string;
    data: Buffer;
    mode?: number;
    declaredSize?: number;
    flags?: number;
  }>,
) {
  let offset = 0;
  const local: Buffer[] = [],
    central: Buffer[] = [];
  for (const file of files) {
    const name = Buffer.from(file.name),
      packed = deflateRawSync(file.data),
      crc = skillCRC32(file.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(file.flags || 0x800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(file.declaredSize ?? file.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(0x0314, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(file.flags || 0x800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(file.declaredSize ?? file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(((file.mode ?? 0x81a4) << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    local.push(head, name, packed);
    central.push(entry, name);
    offset += head.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central),
    footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50);
  footer.writeUInt16LE(files.length, 8);
  footer.writeUInt16LE(files.length, 10);
  footer.writeUInt32LE(directory.length, 12);
  footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, footer]);
}

test("skill bundle accepts standard YAML resources and rejects invalid manifests and hostile archives before extraction", () => {
  const manifest = parseSkillMarkdown(markdown());
  assert.equal(manifest.name, "fixture-blender");
  assert.match(manifest.description, /Inspect evidence/);
  const archive = zip([
    { name: "wrapped/SKILL.md", data: markdown() },
    { name: "wrapped/references/guide.md", data: Buffer.from("Guide") },
  ]);
  const parsed = bundleSkills(readSkillZip(archive));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].files.length, 2);
  assert.match(parsed[0].sha256, /^[a-f0-9]{64}$/);
  for (const data of [
    Buffer.from("no front matter"),
    markdown("Bad_Name"),
    Buffer.from("---\nname: a\ndescription: test\nname: b\n---\ntext"),
    Buffer.from("---\nname: a\ndescription: test\n---\n"),
    Buffer.from([0xff]),
    Buffer.alloc(65537, 65),
  ])
    assert.throws(() => parseSkillMarkdown(data));
  for (const name of [
    "../SKILL.md",
    "/SKILL.md",
    "C:/SKILL.md",
    "a/../../SKILL.md",
    "a\\SKILL.md",
    ".git/config",
  ])
    assert.throws(() => readSkillZip(zip([{ name, data: markdown() }])));
  assert.throws(
    () =>
      readSkillZip(zip([{ name: "SKILL.md", data: markdown(), mode: 0xa1ff }])),
    /符号链接/,
  );
  assert.throws(
    () =>
      readSkillZip(zip([{ name: "SKILL.md", data: markdown(), flags: 0x801 }])),
    /加密/,
  );
  assert.throws(
    () =>
      readSkillZip(
        zip([
          {
            name: "SKILL.md",
            data: markdown(),
            declaredSize: 50 * 1024 * 1024 + 1,
          },
        ]),
      ),
    /50 MiB/,
  );
  assert.throws(
    () =>
      readSkillZip(
        zip([
          {
            name: "SKILL.md",
            data: Buffer.alloc(1024 * 1024, 65),
            declaredSize: 10,
          },
        ]),
      ),
    /解压失败/,
  );
  assert.throws(
    () =>
      readSkillZip(
        zip([
          { name: "SKILL.md", data: markdown() },
          { name: "SKILL.md", data: markdown() },
        ]),
      ),
    /重复/,
  );
  const corrupt = Buffer.from(archive);
  corrupt[40] ^= 255;
  assert.throws(() => readSkillZip(corrupt));
  assert.throws(() => readSkillZip(archive.subarray(0, -1)));
  assert.throws(
    () =>
      bundleSkills([
        { name: "SKILL.md", data: markdown() },
        { name: "nested/SKILL.md", data: markdown("nested") },
      ]),
    /嵌套/,
  );
});

test("npx skill sources are repository identifiers, never shell commands or credential URLs", () => {
  assert.equal(
    normalizeSkillSource("https://github.com/vercel-labs/skills.git"),
    "vercel-labs/skills",
  );
  const args = skillInstallArguments("org/repo", ["fixture-blender"]);
  assert.deepEqual(args, [
    "--yes",
    "--package=skills@1.7.4",
    "skills",
    "add",
    "org/repo",
    "--agent",
    "codex",
    "--skill",
    "fixture-blender",
    "--copy",
    "--yes",
  ]);
  for (const source of [
    "npx evil",
    "org/repo; echo secret",
    "file:///etc",
    "../../repo",
    "https://token@github.com/org/repo",
    "https://github.com/org/repo?token=secret",
    "--help",
    "http://github.com/org/repo",
    "https://gitlab.com/org/repo",
    "org/repo/tree/main",
  ])
    assert.throws(() => normalizeSkillSource(source));
  assert.throws(() => skillInstallArguments("org/repo", ["--all"]));
  const gitEntry = (
    mode: string,
    size: string,
    file = "skills/example/SKILL.md",
  ) =>
    Buffer.from(
      mode + " blob " + "a".repeat(40) + " " + size + "\t" + file + "\0",
    );
  assert.deepEqual(validateSkillGitTree(gitEntry("100644", "12")), [
    { name: "skills/example/SKILL.md", size: 12 },
  ]);
  for (const malicious of [
    gitEntry("120000", "12"),
    gitEntry("160000", "12"),
    gitEntry("100644", "104857601"),
    gitEntry("100644", "10", "../escape"),
    Buffer.from("invalid"),
  ])
    assert.throws(() => validateSkillGitTree(malicious));
});

test("skills API persists catalog and project selection, pins immutable run files and enforces resource boundaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-skills-"));
  const { app, store } = await buildApp({
    dataRoot: root,
    databaseSchema: "pilot_skills_" + process.pid,
    password: "test-password-1234",
    internalToken: "test-token-1234567890",
    runnerUrl: "http://127.0.0.1:1",
    poll: false,
  });
  try {
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/skills" })).statusCode,
      401,
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "test-password-1234" },
    });
    const headers = { cookie: "pilot_session=" + login.cookies[0].value };
    const call = (method: any, url: string, payload?: any) =>
      app.inject({ method, url: "/api" + url, headers, payload });
    const projectId = "legacy-project_" + process.pid,
      otherProject = randomUUID();
    await store.put("project", projectId, {
      id: projectId,
      name: "Skills project",
    });
    await store.put("project", otherProject, {
      id: otherProject,
      name: "Independent project",
    });
    const image = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const archive = zip([
      { name: "skill/SKILL.md", data: markdown() },
      {
        name: "skill/references/guide.md",
        data: Buffer.from("Original guide"),
      },
      { name: "skill/assets/example.png", data: image },
    ]);
    const installed = await call("POST", "/skills/upload", {
      name: "fixture.zip",
      dataBase64: archive.toString("base64"),
    });
    assert.equal(installed.statusCode, 201, installed.body);
    const skill = installed.json().items[0];
    assert.equal(skill.name, "fixture-blender");
    assert.equal(skill.fileCount, 3);
    assert.equal(skill.path, undefined);
    assert.equal((await call("GET", "/skills")).json().items.length, 1);
    const detail = (await call("GET", "/skills/" + skill.id)).json();
    assert.match(detail.content, /Use Blender MCP/);
    assert(detail.files.includes("references/guide.md"));
    assert.equal(
      (
        await call("POST", "/skills/upload", {
          name: "SKILL.md",
          dataBase64: markdown().toString("base64"),
        })
      ).statusCode,
      409,
    );
    const duplicateBatch = zip([
      { name: "new/SKILL.md", data: markdown("new-candidate") },
      { name: "existing/SKILL.md", data: markdown() },
    ]);
    assert.equal(
      (
        await call("POST", "/skills/upload", {
          name: "batch.zip",
          dataBase64: duplicateBatch.toString("base64"),
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await call("GET", "/skills")).json().items.length,
      1,
      "no partial install when one skill conflicts",
    );
    assert.equal(
      (
        await call("POST", "/skills/upload", {
          name: "bad.zip",
          dataBase64: zip([{ name: "../SKILL.md", data: markdown() }]).toString(
            "base64",
          ),
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await call("POST", "/skills/upload", {
          name: "SKILL.md",
          dataBase64: "!@#$",
        })
      ).statusCode,
      400,
    );
    assert.deepEqual(
      (
        await call("PUT", "/projects/" + projectId + "/skills", {
          skillIds: [skill.id],
        })
      ).json().skillIds,
      [skill.id],
    );
    assert.deepEqual(
      (await call("GET", "/projects/" + otherProject + "/skills")).json()
        .skillIds,
      [],
    );
    const catalog = new SkillCatalog(store.db, root),
      runId = randomUUID();
    const snapshot = await catalog.resolveForRun(projectId, runId);
    await verifyRunSkills(root, projectId, runId, snapshot);
    assert.equal(snapshot[0].sha256, skill.sha256);
    assert.equal(
      (await readSkillResource(snapshot, skill.id, "references/guide.md"))[0]
        .type,
      "text",
    );
    assert.equal(
      (await readSkillResource(snapshot, skill.id, "assets/example.png"))[0]
        .type,
      "image",
    );
    await assert.rejects(readSkillResource(snapshot, skill.id, "../../secret"));
    await assert.rejects(
      readSkillResource(snapshot, randomUUID(), "SKILL.md"),
      /不属于/,
    );
    await assert.rejects(
      verifyRunSkills(root, otherProject, runId, snapshot),
      /不属于/,
    );
    assert.equal(
      (await call("PATCH", "/skills/" + skill.id, { enabled: false })).json()
        .enabled,
      false,
    );
    assert.deepEqual(
      (await call("GET", "/projects/" + projectId + "/skills")).json().skillIds,
      [],
    );
    assert.equal(
      (
        await call("PUT", "/projects/" + projectId + "/skills", {
          skillIds: [skill.id],
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await call("PATCH", "/skills/" + skill.id, { enabled: true }))
        .statusCode,
      200,
    );
    await call("PUT", "/projects/" + projectId + "/skills", {
      skillIds: [skill.id],
    });
    const persisted = new SkillCatalog(store.db, root);
    assert.deepEqual((await persisted.projectSkills(projectId)).skillIds, [
      skill.id,
    ]);
    assert.equal(
      (await call("DELETE", "/skills/" + skill.id)).json().deleted,
      true,
    );
    assert.deepEqual((await persisted.projectSkills(projectId)).skillIds, []);
    assert.equal((await call("GET", "/skills")).json().items.length, 0);
    assert.match(await readFile(snapshot[0].path, "utf8"), /fixture-blender/);
    await verifyRunSkills(root, projectId, runId, snapshot);
    const base = path.dirname(snapshot[0].path);
    await symlink("/etc/passwd", path.join(base, "escape.md"));
    await assert.rejects(
      readSkillResource(snapshot, skill.id, "escape.md"),
      /符号链接/,
    );
    await assert.rejects(
      verifyRunSkills(root, projectId, runId, snapshot),
      /符号链接/,
    );
    await rm(path.join(base, "escape.md"));
    await writeFile(path.join(base, "references/guide.md"), "Tampered");
    await assert.rejects(
      verifyRunSkills(root, projectId, runId, snapshot),
      /校验失败/,
    );
    const large = [];
    for (let i = 0; i < 5; i++)
      large.push(
        ...(await catalog.upload(
          "SKILL.md",
          Buffer.concat([
            markdown("large-skill-" + i),
            Buffer.alloc(60 * 1024, 65),
          ]).toString("base64"),
        )),
      );
    await catalog.select(
      projectId,
      large.map((item) => item.id),
    );
    const oversizedRunId = randomUUID();
    await assert.rejects(
      catalog.resolveForRun(projectId, oversizedRunId),
      /256 KiB/,
    );
    await assert.rejects(
      readFile(
        path.join(
          root,
          "projects",
          projectId,
          "runs",
          oversizedRunId,
          "skills",
          large[0].id,
          "SKILL.md",
        ),
      ),
      (error: any) => error.code === "ENOENT",
    );
    assert.equal(
      (await call("GET", "/projects/" + randomUUID() + "/skills")).statusCode,
      404,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
