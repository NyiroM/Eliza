// scripts/verify-eval-queue-failure-visibility.mts — non-match reason for max pipeline retries.
import assert from "node:assert/strict";
import * as reasonMod from "../lib/discovery/evalFailureReason";
import * as failMod from "../lib/discovery/evalFailureStore";

type ReasonApi = typeof import("../lib/discovery/evalFailureReason");
type FailApi = typeof import("../lib/discovery/evalFailureStore");

const reasonApi: ReasonApi =
  (reasonMod as unknown as { default?: ReasonApi }).default ?? (reasonMod as unknown as ReasonApi);
const failApi: FailApi =
  (failMod as unknown as { default?: FailApi }).default ?? (failMod as unknown as FailApi);

const { buildPipelineFailureNotMatchReason } = reasonApi;
const { isFailureInCooldown } = failApi;

const reason = buildPipelineFailureNotMatchReason(3, "Ollama timeout after 300000ms");
assert.match(reason, /Pipeline failed after 3 attempt/);
assert.match(reason, /not a constraint veto/);
assert.match(reason, /Ollama timeout/);

const long = "x".repeat(500);
const clipped = buildPipelineFailureNotMatchReason(3, long);
assert.ok(clipped.length < 500, "error payload is truncated");
assert.ok(clipped.endsWith("..."));

assert.equal(
  isFailureInCooldown({
    id: "job-1",
    attempts: 1,
    last_error: "boom",
    last_error_at: "2000-01-01T00:00:00.000Z",
  }),
  false,
);

console.log("verify-eval-queue-failure-visibility: ok");
