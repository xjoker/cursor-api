import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_KEY, startFakeGateway } from "./fixtures/gateway-harness.mjs";

const headers = { authorization: `Bearer ${CLIENT_KEY}`, "content-type": "application/json" };

test("OpenAI-only surface rejects legacy Messages routes and omits them from root metadata", { timeout: 20_000 }, async () => {
  const gateway = await startFakeGateway();
  try {
    for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
      const response = await fetch(`${gateway.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 404, `${path}: ${await response.clone().text()}`);
      assert.equal((await response.json()).code, "not_found");
    }

    const root = await fetch(`${gateway.baseUrl}/`);
    assert.equal(root.status, 200);
    const metadata = await root.json();
    assert.equal("messages" in metadata.openai, false);
    assert.equal("count_tokens" in metadata.openai, false);
    assert.equal(metadata.openai.chat_completions, "POST /v1/chat/completions");
    assert.equal(metadata.openai.responses, "POST /v1/responses");
  } finally {
    await gateway.stop();
  }
});
