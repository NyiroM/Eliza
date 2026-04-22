import { exec } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { parseOllamaListStdout } from "../../../lib/ollama/parseOllamaList";

const execAsync = promisify(exec);

const DEFAULT_MODEL = "llama3";

export async function GET() {
  try {
    const { stdout } = await execAsync("ollama list", {
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const models = parseOllamaListStdout(stdout);

    if (models.length === 0) {
      return NextResponse.json({
        models: [DEFAULT_MODEL],
        ok: false,
        warning:
          "Ollama responded but no models were parsed. Is Ollama installed? Using fallback model.",
      });
    }

    return NextResponse.json({ models, ok: true });
  } catch {
    return NextResponse.json({
      models: [DEFAULT_MODEL],
      ok: false,
      warning:
        "Could not run `ollama list` (Ollama may not be running or not on PATH). Using fallback model: llama3.",
    });
  }
}
