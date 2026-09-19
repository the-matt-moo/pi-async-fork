import test from "node:test";
import assert from "node:assert/strict";
import { suggestEffort, type JevEffortOptions } from "../src/jev-effort.js";

// ---------- helpers ----------

function mockFetch(choice: string, confidence: number): JevEffortOptions["fetch"] {
  return async (_url, _init) =>
    new Response(
      JSON.stringify({ answers: { effort: { choice, confidence } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

function failingFetch(): JevEffortOptions["fetch"] {
  return async () => new Response("server error", { status: 500 });
}

function throwingFetch(): JevEffortOptions["fetch"] {
  return async () => {
    throw new Error("network down");
  };
}

const noCredential: JevEffortOptions["readCredential"] = async () => undefined;
const fakeCredential: JevEffortOptions["readCredential"] = async () => "test-key";

// ---------- Jev happy path ----------

void test("suggests fast for read-only lookup task", async () => {
  const result = await suggestEffort(
    "Find all files that reference the AuthService class",
    { fetch: mockFetch("fast", 0.88), readCredential: fakeCredential },
  );
  assert.equal(result.tier, "fast");
  assert.equal(result.source, "jev");
  assert.equal(result.confidence, 0.88);
});

void test("suggests balanced for implementation task", async () => {
  const result = await suggestEffort(
    "Implement rate limiting on the /api/upload endpoint with tests",
    { fetch: mockFetch("balanced", 0.82), readCredential: fakeCredential },
  );
  assert.equal(result.tier, "balanced");
  assert.equal(result.source, "jev");
});

void test("suggests deep for architectural task", async () => {
  const result = await suggestEffort(
    "Redesign the event sourcing pipeline to handle conflicting writes across three services",
    { fetch: mockFetch("deep", 0.91), readCredential: fakeCredential },
  );
  assert.equal(result.tier, "deep");
  assert.equal(result.source, "jev");
});

// ---------- fallback to balanced ----------

void test("falls back to balanced when no API key", async () => {
  const result = await suggestEffort("Fix the build", {
    readCredential: noCredential,
  });
  assert.equal(result.tier, "balanced");
  assert.equal(result.source, "default");
});

void test("falls back to balanced on API error", async () => {
  const result = await suggestEffort("Review the PR", {
    fetch: failingFetch(),
    readCredential: fakeCredential,
  });
  assert.equal(result.tier, "balanced");
  assert.equal(result.source, "default");
});

void test("falls back to balanced on network error", async () => {
  const result = await suggestEffort("Investigate the memory leak", {
    fetch: throwingFetch(),
    readCredential: fakeCredential,
  });
  assert.equal(result.tier, "balanced");
  assert.equal(result.source, "default");
});

void test("falls back to balanced when confidence is below threshold", async () => {
  const result = await suggestEffort("Do something", {
    fetch: mockFetch("fast", 0.2),
    readCredential: fakeCredential,
    confidenceThreshold: 0.5,
  });
  assert.equal(result.tier, "balanced");
  assert.equal(result.source, "default");
});

void test("falls back to balanced for unknown tier label", async () => {
  const result = await suggestEffort("Fix the tests", {
    fetch: mockFetch("extreme", 0.99),
    readCredential: fakeCredential,
  });
  assert.equal(result.tier, "balanced");
  assert.equal(result.source, "default");
});

// ---------- edge cases ----------

void test("returns balanced for empty task", async () => {
  const result = await suggestEffort("", {
    fetch: mockFetch("fast", 0.99),
    readCredential: fakeCredential,
  });
  assert.equal(result.tier, "balanced");
  assert.equal(result.source, "default");
});

void test("truncates long task to 2000 chars", async () => {
  let capturedBody = "";
  const captureFetch: JevEffortOptions["fetch"] = async (_url, init) => {
    capturedBody = typeof init?.body === "string" ? init.body : "";
    return new Response(
      JSON.stringify({ answers: { effort: { choice: "balanced", confidence: 0.8 } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  await suggestEffort("x".repeat(5000), {
    fetch: captureFetch,
    readCredential: fakeCredential,
  });

  const parsed = JSON.parse(capturedBody);
  assert.equal(parsed.state.length, 2000);
});

void test("explicit apiKey bypasses credential reader", async () => {
  let credentialCalled = false;
  const result = await suggestEffort("Check the logs", {
    apiKey: "direct-key",
    fetch: mockFetch("fast", 0.75),
    readCredential: async () => {
      credentialCalled = true;
      return "not-used";
    },
  });
  assert.equal(result.tier, "fast");
  assert.equal(result.source, "jev");
  assert.equal(credentialCalled, false);
});
