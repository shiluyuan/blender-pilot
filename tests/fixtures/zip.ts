import { deflateRawSync } from "node:zlib";
import { skillCRC32 } from "../../packages/storage/skill-bundle.js";
export function zip(
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
