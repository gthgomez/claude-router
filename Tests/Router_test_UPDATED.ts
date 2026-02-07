import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { determineRoute } from "../supabase/functions/router/index.ts";
import type { RouterInput } from "../supabase/functions/router/index.ts";

// --- STANDARD PRODUCTION MODELS (2026) ---
const OPUS = "claude-opus-4-5-20251101";
const SONNET = "claude-sonnet-4-5-20250929";
const HAIKU = "claude-haiku-4-5-20251001";

// --- TEST SUITE ---

Deno.test("Router: [M] Mobile Optimization (Latency Gate)", () => {
  const input: RouterInput = {
    userQuery: "How do I make a grilled cheese?",
    currentSessionTokens: 500,
    platform: "mobile",
    userId: "u123"
  };

  const result = determineRoute(input);
  assertEquals(result.model, HAIKU);
  assertEquals(result.rationaleTag, "HAIKU_LOW_LATENCY");
});

Deno.test("Router: [M] Boundary Gate (Context Overflow Protection)", () => {
  const input: RouterInput = {
    userQuery: "Please summarize the last 50 pages.",
    currentSessionTokens: 155000, // Exceeds 150k limit
    platform: "web",
    userId: "u123"
  };

  const result = determineRoute(input);
  assertEquals(result.model, OPUS);
  assertEquals(result.extendedThinking, true); // Should trigger reasoning
  assertEquals(result.rationaleTag, "OPUS_FRONTIER_REASONING");
});

Deno.test("Router: [I] Inverse Intent (Mobile Complexity Override)", () => {
  const input: RouterInput = {
    userQuery: "Conduct a deep research into quantum entanglement",
    currentSessionTokens: 1000,
    platform: "mobile", // Normally Haiku, but "research" triggers Opus
    userId: "u123"
  };

  const result = determineRoute(input);
  assertEquals(result.model, OPUS);
  assertEquals(result.extendedThinking, true);
});

Deno.test("Router: [A] Adversarial Stickiness (Short Input)", () => {
  const input: RouterInput = {
    userQuery: "Ok.", // < 10 chars
    currentSessionTokens: 8000,
    platform: "web",
    userId: "u123"
  };

  const result = determineRoute(input);
  // Should default to Sonnet as standard web, but check stickiness logic
  assertEquals(result.model, SONNET);
  assertEquals(result.rationaleTag, "SONNET_STANDARD");
});

Deno.test("Router: [N] Null/Zero Context (First Message)", () => {
  const input: RouterInput = {
    userQuery: "Hello, world!",
    currentSessionTokens: 0,
    platform: "web",
    userId: "u123"
  };

  const result = determineRoute(input);
  assertEquals(result.model, SONNET);
});
