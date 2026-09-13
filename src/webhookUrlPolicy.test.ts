import { describe, it, expect } from "vitest";
import { isWebhookUrlAllowed } from "./webhookUrlPolicy";

describe("isWebhookUrlAllowed", () => {
  it("allows https", () => {
    expect(isWebhookUrlAllowed("https://api.unibooks.example/api/v1/messaging/webhook/edge-chat/")).toBe(true);
  });

  it("allows plain http only to the local dev server", () => {
    expect(isWebhookUrlAllowed("http://localhost:8000/api/v1/messaging/webhook/edge-chat/")).toBe(true);
    expect(isWebhookUrlAllowed("http://127.0.0.1:8000/api/v1/messaging/webhook/edge-chat/")).toBe(true);
  });

  it("rejects plain http to anywhere else", () => {
    // A webhook body carries the room id and a message preview; over http it
    // is readable by anyone on the path.
    expect(isWebhookUrlAllowed("http://api.unibooks.example/webhook/")).toBe(false);
    expect(isWebhookUrlAllowed("http://169.254.169.254/latest/meta-data/")).toBe(false);
  });

  it("rejects non-http schemes and unparseable values", () => {
    expect(isWebhookUrlAllowed("file:///etc/passwd")).toBe(false);
    expect(isWebhookUrlAllowed("not a url")).toBe(false);
  });

  it("treats an unset or empty variable as 'no webhook configured'", () => {
    expect(isWebhookUrlAllowed(undefined)).toBe(false);
    expect(isWebhookUrlAllowed("")).toBe(false);
  });
});
