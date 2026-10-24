import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
  scryptSync,
  createHmac,
} from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export class Vault {
  key!: Buffer;
  constructor(private root: string) {}
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      this.key = await readFile(path.join(this.root, "vault.key"));
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      this.key = randomBytes(32);
      try {
        await writeFile(path.join(this.root, "vault.key"), this.key, {
          mode: 0o600,
          flag: "wx",
        });
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        this.key = await readFile(path.join(this.root, "vault.key"));
      }
    }
    if (this.key.length !== 32)
      throw new Error(
        "Invalid vault key file; restore the original key from backup.",
      );
  }
  encrypt(text: string) {
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", this.key, iv);
    return Buffer.concat([
      iv,
      c.update(text),
      c.final(),
      c.getAuthTag(),
    ]).toString("base64");
  }
  decrypt(text: string) {
    const b = Buffer.from(text, "base64"),
      c = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    c.setAuthTag(b.subarray(-16));
    return Buffer.concat([c.update(b.subarray(12, -16)), c.final()]).toString();
  }
  session() {
    const payload =
      String(Date.now() + 7 * 86400000) + ":" + randomBytes(24).toString("hex");
    return (
      payload +
      "." +
      createHmac("sha256", this.key).update(payload).digest("hex")
    );
  }
  valid(cookie: string | undefined) {
    return this.expiresAt(cookie) !== undefined;
  }
  expiresAt(cookie: string | undefined): number | undefined {
    if (!cookie || cookie.length > 256) return undefined;
    const parts = cookie.split(".");
    if (parts.length !== 2) return undefined;
    const [payload, sig] = parts;
    // Recognize old signed cookies for signature validation, but they have no
    // registered database session and therefore require login after upgrade.
    if (!/^\d{13}(?::[a-f0-9]{48})?$/.test(payload)) return undefined;
    const expiry = Number(payload.split(":")[0]);
    if (expiry <= Date.now() || expiry >= Date.now() + 8 * 86400000)
      return undefined;
    if (
      !equal(sig, createHmac("sha256", this.key).update(payload).digest("hex"))
    )
      return undefined;
    return expiry;
  }
}
export function validPassword(input: string, expected: string) {
  return timingSafeEqual(
    scryptSync(input, "blender-pilot", 32),
    scryptSync(expected, "blender-pilot", 32),
  );
}
