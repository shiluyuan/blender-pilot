/** Publish only actual browser captures from a passed native Blender run. */
import sharp from "sharp";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const revision = process.env.PILOT_SCREENSHOT_REVISION;
if (!revision || !/^[a-f0-9]{40}$/.test(revision))
  throw new Error(
    "Set PILOT_SCREENSHOT_REVISION to the full application commit SHA.",
  );
const source = process.env.PILOT_NATIVE_CAPTURE_DATA || ".data/integration";
const report = JSON.parse(
  await readFile(path.join(source, "result.json"), "utf8"),
);
if (!report.passed || !report.blender)
  throw new Error(
    "Real Blender acceptance must pass before publishing its captures.",
  );
const output = "docs/screenshots/workbench";
await mkdir(output, { recursive: true });
const images = [];
for (const theme of ["light", "dark"]) {
  const input = path.join(source, `workbench-${theme}.png`);
  const data = await sharp(await readFile(input))
    .webp({ lossless: true })
    .toBuffer();
  const metadata = await sharp(data).metadata();
  if (
    !metadata.width ||
    metadata.width < 1000 ||
    !metadata.height ||
    metadata.height < 600
  )
    throw new Error("Expected a full desktop workbench capture: " + input);
  const file = `workbench-${theme}.webp`;
  await writeFile(path.join(output, file), data);
  images.push({
    file,
    source: input,
    width: metadata.width,
    height: metadata.height,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
await writeFile(
  path.join(output, "manifest.json"),
  JSON.stringify(
    {
      applicationRevision: revision,
      packagedAt: new Date().toISOString(),
      capturedAt: report.time,
      scope:
        "Actual Blender desktop over authenticated VNC in the production web UI; original browser pixels, lossless WebP, no compositing or retouching.",
      blender: report.blender,
      codex: report.codex,
      model: report.model,
      mode: report.mode,
      database: report.databaseValidation,
      report: "../../validation/compact-native.json",
      images,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Packaged ${images.length} real Blender workbench captures.`);
