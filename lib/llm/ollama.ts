import { DEFAULT_OLLAMA_MODEL, OLLAMA_TIMEOUT_MS } from "../../config/constants";

type OllamaGenerateResponse = {
  response?: unknown;
};

export type ParserSource = "llm" | "fallback";

export type OllamaJsonResult<T> = {
  data: T;
  source: ParserSource;
};

type GenerateJsonOptions = {
  /** Default 15000. Multi-stage job parsing may need longer. */
  timeoutMs?: number;
  /** Ollama model name (must exist locally). Default: llama3 */
  model?: string;
};

function getOllamaGenerateUrl(): string {
  const raw = (process.env.OLLAMA_HOST ?? "http://localhost:11434").trim();
  const base = raw.replace(/\/+$/, "");
  return `${base}/api/generate`;
}

export async function generateJsonWithOllama<T>(
  prompt: string,
  fallback: T,
  options?: GenerateJsonOptions,
): Promise<OllamaJsonResult<T>> {
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? OLLAMA_TIMEOUT_MS.generateJsonDefault;
  const model = options?.model?.trim() || DEFAULT_OLLAMA_MODEL;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    console.log(`[Backend] Sending prompt to Ollama... (model=${model})`);
    const response = await fetch(getOllamaGenerateUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        options: {
          temperature: 0,
        },
        prompt,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { data: fallback, source: "fallback" };
    }

    const data = (await response.json()) as OllamaGenerateResponse;

    if (typeof data.response !== "string") {
      return { data: fallback, source: "fallback" };
    }

    const rawResponse = data.response;
    console.log(
      `[Backend] Raw response received (first 100 chars): ${rawResponse.slice(0, 100)}`,
    );

    return { data: JSON.parse(rawResponse) as T, source: "llm" };
  } catch {
    return { data: fallback, source: "fallback" };
  } finally {
    clearTimeout(timeout);
  }
}
