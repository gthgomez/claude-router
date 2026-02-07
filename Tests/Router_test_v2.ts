import { assertEquals, assertNotEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { determineRoute, countTokens } from "../supabase/functions/router/index.ts";
import type { RouterInput } from "../supabase/functions/router/index.ts";

// --- MODEL CONSTANTS ---
const OPUS = "claude-opus-4-5-20251101";
const SONNET = "claude-sonnet-4-5-20250929";
const HAIKU = "claude-haiku-4-5-20251001";

// =============================================================================
// [N] NULL / EDGE BOUNDARY TESTS
// =============================================================================

Deno.test("[N] Empty string query → Haiku fallback", () => {
  const input: RouterInput = {
    userQuery: "",
    currentSessionTokens: 0,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, HAIKU);
  assertEquals(result.rationaleTag, "HAIKU_EMPTY_QUERY");
});

Deno.test("[N] Whitespace-only query → Haiku fallback", () => {
  const input: RouterInput = {
    userQuery: "   \n\t  ",
    currentSessionTokens: 0,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, HAIKU);
  assertEquals(result.rationaleTag, "HAIKU_EMPTY_QUERY");
});

Deno.test("[N] First message (zero tokens) on web → Sonnet default", () => {
  const input: RouterInput = {
    userQuery: "Hello, how are you today?",
    currentSessionTokens: 0,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, SONNET);
});

Deno.test("[N] Exactly at 150k boundary → Opus", () => {
  const input: RouterInput = {
    userQuery: "Continue the analysis.",
    currentSessionTokens: 150_001,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, OPUS);
  assertEquals(result.rationaleTag, "OPUS_CONTEXT_OVERFLOW");
});

Deno.test("[N] Just under 150k boundary → NOT forced Opus", () => {
  const input: RouterInput = {
    userQuery: "Continue.",
    currentSessionTokens: 149_990,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  // Should NOT be context overflow, complexity decides
  assertNotEquals(result.rationaleTag, "OPUS_CONTEXT_OVERFLOW");
});

// =============================================================================
// [M] MANDATORY BOUNDARY TESTS
// =============================================================================

Deno.test("[M] Context overflow protection (>150k) → Opus with extended thinking", () => {
  const input: RouterInput = {
    userQuery: "Summarize everything we discussed.",
    currentSessionTokens: 160_000,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, OPUS);
  assertEquals(result.extendedThinking, true);
  assertEquals(result.rationaleTag, "OPUS_CONTEXT_OVERFLOW");
});

Deno.test("[M] 'deep research' keyword → Opus regardless of platform", () => {
  const input: RouterInput = {
    userQuery: "Do deep research on quantum computing applications",
    currentSessionTokens: 500,
    platform: "mobile",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, OPUS);
  assertEquals(result.extendedThinking, true);
});

Deno.test("[M] 'complex architecture' keyword → Opus", () => {
  const input: RouterInput = {
    userQuery: "Design a complex architecture for a distributed system",
    currentSessionTokens: 1000,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, OPUS);
});

Deno.test("[M] 'system design' keyword → Opus", () => {
  const input: RouterInput = {
    userQuery: "Help me with system design for a high-throughput API",
    currentSessionTokens: 0,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, OPUS);
});

Deno.test("[M] Mobile simple query under 5k → Haiku", () => {
  const input: RouterInput = {
    userQuery: "What's the weather like?",
    currentSessionTokens: 500,
    platform: "mobile",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, HAIKU);
  assertEquals(result.rationaleTag, "HAIKU_MOBILE_SIMPLE");
});

// =============================================================================
// [I] INVERSE / OVERRIDE TESTS
// =============================================================================

Deno.test("[I] Mobile + code keyword → Sonnet (NOT Haiku)", () => {
  const input: RouterInput = {
    userQuery: "Write a function to sort an array",
    currentSessionTokens: 500,
    platform: "mobile",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, SONNET);
  assertEquals(result.rationaleTag, "SONNET_CODE_TASK");
});

Deno.test("[I] Mobile + debug request → Sonnet (NOT Haiku)", () => {
  const input: RouterInput = {
    userQuery: "Debug this code for me",
    currentSessionTokens: 100,
    platform: "mobile",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, SONNET);
});

Deno.test("[I] Mobile + high context (>5k) → Sonnet", () => {
  const input: RouterInput = {
    userQuery: "What did we discuss earlier?",
    currentSessionTokens: 8000,
    platform: "mobile",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, SONNET);
  assertEquals(result.rationaleTag, "SONNET_MOBILE_COMPLEX");
});

Deno.test("[I] Mobile + complexity trigger → Opus overrides mobile optimization", () => {
  const input: RouterInput = {
    userQuery: "Conduct a comprehensive audit of this security system",
    currentSessionTokens: 500,
    platform: "mobile",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, OPUS);
});

// =============================================================================
// [A] ADVERSARIAL / STICKINESS TESTS
// =============================================================================

Deno.test("[A] Very short input 'Ok.' on web → Sonnet default", () => {
  const input: RouterInput = {
    userQuery: "Ok.",
    currentSessionTokens: 5000,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, SONNET);
});

Deno.test("[A] Single word 'Yes' on web low context → Haiku trivial", () => {
  const input: RouterInput = {
    userQuery: "Yes",
    currentSessionTokens: 100,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, HAIKU);
  assertEquals(result.rationaleTag, "HAIKU_TRIVIAL_WEB");
});

Deno.test("[A] 'Hello' on web → Haiku trivial", () => {
  const input: RouterInput = {
    userQuery: "Hello",
    currentSessionTokens: 0,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, HAIKU);
});

Deno.test("[A] Multi-question query → elevated complexity", () => {
  const input: RouterInput = {
    userQuery: "What is X? How does Y work? Why is Z important? Can you explain W?",
    currentSessionTokens: 0,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  // Multiple questions should bump complexity
  assertEquals(result.model, SONNET);
});

Deno.test("[A] Numbered list request → Sonnet minimum", () => {
  const input: RouterInput = {
    userQuery: "1. First explain this. 2. Then show me that. 3. Finally summarize.",
    currentSessionTokens: 0,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, SONNET);
});

// =============================================================================
// CODE TASK DETECTION TESTS
// =============================================================================

Deno.test("Code: 'implement' keyword → Sonnet", () => {
  const input: RouterInput = {
    userQuery: "Implement a binary search tree",
    currentSessionTokens: 0,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, SONNET);
  assertEquals(result.rationaleTag, "SONNET_CODE_TASK");
});

Deno.test("Code: 'typescript' mention → Sonnet", () => {
  const input: RouterInput = {
    userQuery: "How do I use generics in TypeScript?",
    currentSessionTokens: 0,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, SONNET);
});

Deno.test("Code: SQL query request → Sonnet", () => {
  const input: RouterInput = {
    userQuery: "Write a SQL query to join these tables",
    currentSessionTokens: 0,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, SONNET);
});

Deno.test("Code: Contains code block → elevated complexity", () => {
  const input: RouterInput = {
    userQuery: "What's wrong with this?\n```javascript\nconst x = 1;\nconsole.log(x);\n```",
    currentSessionTokens: 0,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, SONNET);
});

Deno.test("Code: 'regex' mention → Sonnet", () => {
  const input: RouterInput = {
    userQuery: "Help me write a regex for email validation",
    currentSessionTokens: 0,
    platform: "mobile",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, SONNET);
});

// =============================================================================
// HISTORY CONTEXT TESTS
// =============================================================================

Deno.test("History: Large history increases complexity", () => {
  const longHistory = Array(20).fill({
    role: "user",
    content: "This is a moderately long message to simulate conversation history."
  });
  
  const input: RouterInput = {
    userQuery: "Continue",
    currentSessionTokens: 0, // Low base tokens
    platform: "web",
    userId: "u123",
    history: longHistory
  };
  const result = determineRoute(input);
  // History should push complexity up
  assertEquals(result.model, SONNET);
});

// =============================================================================
// PLATFORM-SPECIFIC TESTS
// =============================================================================

Deno.test("Platform: Web default path → Sonnet", () => {
  const input: RouterInput = {
    userQuery: "Tell me about machine learning",
    currentSessionTokens: 2000,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, SONNET);
});

Deno.test("Platform: Web with elevated context (>50k) → Sonnet elevated", () => {
  const input: RouterInput = {
    userQuery: "Summarize our discussion",
    currentSessionTokens: 55_000,
    platform: "web",
    userId: "u123"
  };
  const result = determineRoute(input);
  assertEquals(result.model, SONNET);
  assertEquals(result.rationaleTag, "SONNET_ELEVATED_CONTEXT");
});

// =============================================================================
// TOKEN COUNTING TESTS
// =============================================================================

Deno.test("countTokens: Empty string → 0", () => {
  assertEquals(countTokens(""), 0);
});

Deno.test("countTokens: Null-ish input → 0", () => {
  assertEquals(countTokens(null as unknown as string), 0);
  assertEquals(countTokens(undefined as unknown as string), 0);
});

Deno.test("countTokens: Normal text returns positive", () => {
  const tokens = countTokens("Hello, how are you today?");
  assertEquals(tokens > 0, true);
});

// =============================================================================
// RATIONALE TAG COVERAGE
// =============================================================================

Deno.test("Rationale: All expected tags are reachable", () => {
  const expectedTags = [
    "HAIKU_EMPTY_QUERY",
    "OPUS_CONTEXT_OVERFLOW", 
    "OPUS_HIGH_COMPLEXITY",
    "SONNET_CODE_TASK",
    "HAIKU_MOBILE_SIMPLE",
    "SONNET_MOBILE_COMPLEX",
    "SONNET_ELEVATED_CONTEXT",
    "HAIKU_TRIVIAL_WEB",
    "SONNET_DEFAULT"
  ];
  
  const testCases: RouterInput[] = [
    { userQuery: "", currentSessionTokens: 0, platform: "web", userId: "u" },
    { userQuery: "x", currentSessionTokens: 160000, platform: "web", userId: "u" },
    { userQuery: "deep research topic", currentSessionTokens: 0, platform: "web", userId: "u" },
    { userQuery: "write code", currentSessionTokens: 0, platform: "web", userId: "u" },
    { userQuery: "hi", currentSessionTokens: 100, platform: "mobile", userId: "u" },
    { userQuery: "continue", currentSessionTokens: 8000, platform: "mobile", userId: "u" },
    { userQuery: "continue", currentSessionTokens: 55000, platform: "web", userId: "u" },
    { userQuery: "hello", currentSessionTokens: 0, platform: "web", userId: "u" },
    { userQuery: "explain photosynthesis", currentSessionTokens: 2000, platform: "web", userId: "u" },
  ];
  
  const foundTags = new Set(testCases.map(tc => determineRoute(tc).rationaleTag));
  
  for (const tag of expectedTags) {
    assertEquals(foundTags.has(tag), true, `Missing rationale tag: ${tag}`);
  }
});
