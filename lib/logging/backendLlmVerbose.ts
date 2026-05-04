// lib/logging/backendLlmVerbose.ts
/** Per-request Ollama / pipeline chatter. Set `ELIZA_BACKEND_LLM_VERBOSE=1` to enable. */

export function isBackendLlmVerboseLog(): boolean {
  return process.env.ELIZA_BACKEND_LLM_VERBOSE === "1";
}
