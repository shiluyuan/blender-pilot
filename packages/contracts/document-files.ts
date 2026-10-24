import { open } from "node:fs/promises";
import { decodeDocument, MAX_DOCUMENT_BYTES } from "./attachments.js";

/** Bound allocation/read as well as the declared upload size. */
export async function readDocumentFile(
  name: string,
  filename: string,
): Promise<string> {
  const file = await open(filename, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("文档附件必须是普通文件");
    if (stat.size > MAX_DOCUMENT_BYTES)
      throw new Error("文档附件最大 2 MiB；请拆分后上传");
    const bytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, null);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    return decodeDocument(name, bytes.subarray(0, offset));
  } finally {
    await file.close();
  }
}
