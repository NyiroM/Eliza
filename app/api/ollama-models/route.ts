import { exec } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import {
  DEFAULT_OLLAMA_MODEL,
  OLLAMA_LIST_MAX_BUFFER_BYTES,
  OLLAMA_LIST_TIMEOUT_MS,
} from "../../../config/constants";
import { parseOllamaListStdout } from "../../../lib/ollama/parseOllamaList";

const execAsync = promisify(exec);

export async function GET() {
  try {
    const { stdout } = await execAsync("ollama list", {
      timeout: OLLAMA_LIST_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: OLLAMA_LIST_MAX_BUFFER_BYTES,
    });
    const models = parseOllamaListStdout(stdout);

    if (models.length === 0) {
      return NextResponse.json({
        models: [DEFAULT_OLLAMA_MODEL],
        ok: false,
        warning:
          "Ollama responded but no models were parsed. Is Ollama installed? Using fallback model.",
      });
    }

    return NextResponse.json({ models, ok: true });
  } catch {
    return NextResponse.json({
      models: [DEFAULT_OLLAMA_MODEL],
      ok: false,
      warning: `Could not run \`ollama list\` (Ollama may not be running or not on PATH). Using fallback model: ${DEFAULT_OLLAMA_MODEL}.`,
    });
  }
}
