/** Package actual browser captures without compositing, retouching or resizing.
 * Run the commands in docs/screenshots/latest/README.md first.
 */
import sharp from "sharp";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const revision = process.env.PILOT_SCREENSHOT_REVISION;
if (!revision || !/^[a-f0-9]{40}$/.test(revision))
  throw new Error(
    "Set PILOT_SCREENSHOT_REVISION to the full application commit SHA.",
  );
const output = "docs/screenshots/latest";
const sources = [
  [".data/chat-acceptance", "chat-dark.png", "chat-dark"],
  [".data/chat-acceptance", "chat-light.png", "chat-light"],
  [".data/chat-acceptance", "chat-responsive-375.png", "chat-narrow"],
  [".data/readme-interface", "08-library-light.png", "library-light"],
  [".data/readme-interface", "08-library-dark.png", "library-dark"],
  [".data/readme-interface", "08-templates-light.png", "templates-light"],
  [".data/readme-interface", "08-templates-dark.png", "templates-dark"],
  [".data/readme-interface", "08-projects-light.png", "projects-light"],
  [
    ".data/readme-interface",
    "08-project-rename-light.png",
    "project-rename-light",
  ],
  [".data/readme-interface", "08-settings-light.png", "settings-light"],
  [".data/readme-interface", "08-console-dark.png", "console-dark"],
  [".data/readme-interface", "08-studio-light.png", "workbench-light"],
  [".data/readme-interface", "08-studio-dark.png", "workbench-dark"],
  [".data/readme-skills", "skills-light-1440.png", "skills-light"],
  [".data/readme-skills", "skills-dark-1440.png", "skills-dark"],
  [".data/readme-skills", "skills-install-light.png", "skills-install-light"],
];
const reports = [];
for (const file of [
  ".data/chat-acceptance/result.json",
  ".data/readme-interface/visual-result.json",
  ".data/readme-skills/result.json",
]) {
  const result = JSON.parse(await readFile(file, "utf8"));
  if (!result.passed || result.uncaughtBrowserErrors.length)
    throw new Error("Screenshot source suite did not pass: " + file);
  reports.push({
    file,
    time: result.time,
    checks: result.checks.length,
    environment: result.environment,
  });
}
await mkdir(output, { recursive: true });
const images = [];
for (const [directory, file, name] of sources) {
  const source = path.join(directory, file);
  const buffer = await sharp(await readFile(source))
    .webp({ lossless: true })
    .toBuffer();
  const target = path.join(output, name + ".webp");
  await writeFile(target, buffer);
  const metadata = await sharp(buffer).metadata();
  images.push({
    file: name + ".webp",
    source,
    width: metadata.width,
    height: metadata.height,
    bytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  });
}
await writeFile(
  path.join(output, "manifest.json"),
  JSON.stringify(
    {
      applicationRevision: revision,
      packagedAt: new Date().toISOString(),
      format:
        "Lossless WebP; original browser capture dimensions; no compositing",
      scope:
        "Current application UI with explicit local fixtures; no live model or Blender runtime",
      reports,
      images,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Packaged ${images.length} captures, ${images.reduce((sum, image) => sum + image.bytes, 0)} bytes.`,
);
