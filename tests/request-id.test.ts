import test from "node:test";
import assert from "node:assert/strict";
import { requestId } from "../apps/web/request-id.js";
test("request IDs work without secure-context randomUUID and retain UUID v4 shape", () => {
  const source = {
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
  };
  const ids = Array.from({ length: 100 }, () => requestId(source));
  assert.equal(new Set(ids).size, 100);
  for (const id of ids)
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
});
