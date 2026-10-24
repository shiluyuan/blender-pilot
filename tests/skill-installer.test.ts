import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  runSkillInstaller,
  validateSkillGitTree,
} from "../packages/storage/skill-installer.js";

const sha = "a".repeat(40);
const markdown =
  "---\nname: synthetic-skill\ndescription: Test only.\n---\nReview the scene.\n";
const tree =
  "100644 blob " + sha + " " + Buffer.byteLength(markdown) + "\tSKILL.md\0";

test("git inspection rejects links, submodules, traversal and oversized trees before checkout", () => {
  assert.deepEqual(validateSkillGitTree(Buffer.from(tree)), [
    { name: "SKILL.md", size: Buffer.byteLength(markdown) },
  ]);
  const nested = tree.replace("\tSKILL.md", "\tskills/example/SKILL.md");
  assert.deepEqual(
    validateSkillGitTree(
      Buffer.from(nested + "120000 blob " + sha + " 9\tCLAUDE.md\0"),
    ),
    [{ name: "skills/example/SKILL.md", size: Buffer.byteLength(markdown) }],
  );
  for (const invalid of [
    "120000 blob " + sha + " 8\tlinked-secret\0",
    "160000 commit " + sha + " -\tmodule\0",
    "100644 blob " + sha + " 2\t../outside\0",
    "100644 blob " + sha + " 2\t/absolute\0",
    "100644 blob " + sha + " 104857601\tlarge\0",
    tree + tree,
    tree.slice(0, -1),
    tree.repeat(5001),
  ])
    assert.throws(() => validateSkillGitTree(Buffer.from(invalid)), /技能/);
});

async function fixture(root: string, mode = "valid") {
  const git = path.join(root, "git.mjs"),
    npx = path.join(root, "npx.mjs");
  const fixtureTree =
    mode === "symlink"
      ? tree + "120000 blob " + sha + " 16\tsecrets\0"
      : mode === "metadata-link"
        ? tree.replace("\tSKILL.md", "\tskills/example/SKILL.md") +
          "120000 blob " +
          sha +
          " 9\tCLAUDE.md\0"
        : tree;
  await writeFile(
    git,
    [
      "#!" + process.execPath,
      "import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';",
      "import path from 'node:path';",
      "const args=process.argv.slice(2),cwd=process.cwd();",
      "appendFileSync(path.join(cwd,'commands.jsonl'),JSON.stringify({command:'git',args})+'\\n');",
      "if(args.includes('clone')) {",
      " mkdirSync(args.at(-1),{recursive:true});",
      " if(" +
        JSON.stringify(mode) +
        "==='output') process.stderr.write('SYNTHETIC_OUTPUT_SECRET'.repeat(10000));",
      " if(" +
        JSON.stringify(mode) +
        "==='timeout') {writeFileSync(path.join(cwd,'child.pid'),String(process.pid));setInterval(()=>{},1000);}",
      "} else if(args.includes('ls-tree')) {",
      " process.stdout.write(" + JSON.stringify(fixtureTree) + ");",
      "} else if(args.includes('checkout')) {",
      " writeFileSync(path.join(cwd,'checkout-reached'),'yes');",
      " const target=path.join(cwd,'source'," +
        JSON.stringify(
          mode === "metadata-link" ? "skills/example/SKILL.md" : "SKILL.md",
        ) +
        ");",
      " mkdirSync(path.dirname(target),{recursive:true});",
      " writeFileSync(target," + JSON.stringify(markdown) + ");",
      "}",
    ].join("\n"),
  );
  await writeFile(
    npx,
    [
      "#!" + process.execPath,
      "import {appendFileSync,writeFileSync} from 'node:fs';",
      "import path from 'node:path';",
      "const args=process.argv.slice(2);",
      "appendFileSync(path.join(process.cwd(),'commands.jsonl'),JSON.stringify({command:'npx',args})+'\\n');",
      "writeFileSync(path.join(process.cwd(),'npx-reached'),JSON.stringify({args,leakedKey:process.env.PILOT_MODEL_KEY??null,ignoreScripts:process.env.npm_config_ignore_scripts,telemetry:process.env.DISABLE_TELEMETRY}));",
    ].join("\n"),
  );
  await chmod(git, 0o700);
  await chmod(npx, 0o700);
  return { gitCommand: git, command: npx };
}

test("npx receives only the inspected internal checkout with fixed flags and stripped secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-installer-flow-"));
  const prior = process.env.PILOT_MODEL_KEY;
  process.env.PILOT_MODEL_KEY = "synthetic-secret-not-for-installer";
  try {
    await runSkillInstaller(
      root,
      "owner/repository",
      ["synthetic-skill"],
      await fixture(root),
    );
    const receipt = JSON.parse(
      await readFile(path.join(root, "npx-reached"), "utf8"),
    );
    assert.deepEqual(receipt.args, [
      "--yes",
      "--package=skills@1.7.4",
      "skills",
      "add",
      path.join(root, "source"),
      "--agent",
      "codex",
      "--skill",
      "synthetic-skill",
      "--copy",
      "--yes",
    ]);
    assert.equal(receipt.leakedKey, null);
    assert.equal(receipt.ignoreScripts, "true");
    assert.equal(receipt.telemetry, "1");
    const commands = (await readFile(path.join(root, "commands.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(commands.length, 4);
    assert(commands[0].args.includes("--no-checkout"));
    assert(commands[1].args.includes("ls-tree"));
    assert(commands[2].args.includes("checkout"));
    assert.equal(commands[3].command, "npx");
  } finally {
    if (prior === undefined) delete process.env.PILOT_MODEL_KEY;
    else process.env.PILOT_MODEL_KEY = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("repository metadata links outside skill folders are excluded from literal whitelist checkout", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "pilot-installer-metadata-"),
  );
  try {
    await runSkillInstaller(
      root,
      "owner/repository",
      ["synthetic-skill"],
      await fixture(root, "metadata-link"),
    );
    const paths = await readFile(path.join(root, "checkout-paths"), "utf8");
    assert.equal(paths, "skills/example/SKILL.md\0");
    await assert.rejects(stat(path.join(root, "source", "CLAUDE.md")), {
      code: "ENOENT",
    });
    const commands = (await readFile(path.join(root, "commands.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const checkout = commands.find((item) => item.args.includes("checkout"));
    assert(checkout.args.includes("--literal-pathspecs"));
    assert(checkout.args.includes("--pathspec-file-nul"));
    assert(
      checkout.args.includes(
        "--pathspec-from-file=" + path.join(root, "checkout-paths"),
      ),
    );
    assert.equal(commands.at(-1).command, "npx");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("excessive installer output is stopped without returning untrusted output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-installer-output-"));
  try {
    await assert.rejects(
      runSkillInstaller(root, "owner/repository", undefined, {
        ...(await fixture(root, "output")),
        maxOutputBytes: 100,
      }),
      (error: any) => {
        assert.match(error.message, /输出超出限制/);
        assert(!error.message.includes("SYNTHETIC_OUTPUT_SECRET"));
        return true;
      },
    );
    await assert.rejects(stat(path.join(root, "npx-reached")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a remote symlink mode prevents both checkout and upstream npx copy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilot-installer-links-"));
  try {
    await assert.rejects(
      runSkillInstaller(
        root,
        "owner/repository",
        undefined,
        await fixture(root, "symlink"),
      ),
      /符号链接/,
    );
    for (const name of ["checkout-reached", "npx-reached"])
      await assert.rejects(stat(path.join(root, name)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer deadline terminates its owned git process before proceeding to npx", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "pilot-installer-timeout-"),
  );
  try {
    await assert.rejects(
      runSkillInstaller(root, "owner/repository", undefined, {
        ...(await fixture(root, "timeout")),
        timeoutMs: 200,
      }),
      /超时/,
    );
    const pid = Number(await readFile(path.join(root, "child.pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(stat(path.join(root, "npx-reached")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
