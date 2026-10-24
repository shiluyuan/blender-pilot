import test from "node:test";
import assert from "node:assert/strict";
import {
  api,
  ApiError,
  AUTHENTICATION_REQUIRED,
  checkAuthentication,
} from "../apps/web/api.js";

async function browserEnvironment(
  run: (events: () => number) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const target = new EventTarget();
  let events = 0;
  target.addEventListener(AUTHENTICATION_REQUIRED, () => events++);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: target,
  });
  try {
    await run(() => events);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("late unauthorized response cannot dismiss a login completed after that request began", async () => {
  await browserEnvironment(async (events) => {
    let release!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = async (input) =>
      String(input).endsWith("/old-request")
        ? oldResponse
        : new Response(
            JSON.stringify(
              String(input).endsWith("/auth/login")
                ? { ok: true }
                : { error: "expired" },
            ),
            { status: String(input).endsWith("/auth/login") ? 200 : 401 },
          );
    const old = api("/old-request").catch((error) => error);
    await api("/auth/login", { method: "POST", body: "{}" });
    release(
      new Response(JSON.stringify({ error: "old cookie expired" }), {
        status: 401,
      }),
    );
    const result = await old;
    assert(result instanceof ApiError && result.status === 401);
    assert.equal(
      events(),
      0,
      "the previous cookie's late response must not close the new login",
    );
    await assert.rejects(
      api("/protected"),
      (error: unknown) => error instanceof ApiError && error.status === 401,
    );
    assert.equal(
      events(),
      1,
      "a current request's401 still requests authentication",
    );
  });
});

test("connection auth probes are deduplicated and only a confirmed expired session opens login", async () => {
  await browserEnvironment(async (events) => {
    let requests = 0;
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = async () => {
      requests++;
      return response;
    };
    const first = checkAuthentication();
    const second = checkAuthentication();
    assert.equal(first, second);
    release(
      new Response(JSON.stringify({ authenticated: false }), { status: 200 }),
    );
    await Promise.all([first, second]);
    assert.equal(requests, 1);
    assert.equal(events(), 1);
    globalThis.fetch = async () => {
      throw new TypeError("network offline");
    };
    await checkAuthentication();
    assert.equal(
      events(),
      1,
      "an unreachable server is not proof of a revoked cookie",
    );
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ authenticated: true }), { status: 200 });
    await checkAuthentication();
    assert.equal(
      events(),
      1,
      "a valid session survives a transport disconnect",
    );
  });
});
