const MAX_LOG_LENGTH = 500;

function redactString(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[REDACTED_PHONE]")
    .replace(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s]*/gi, "[REDACTED_LOCAL_URL]")
    .replace(/[A-Za-z]:\\[^\s"]+/g, "[REDACTED_PATH]");
}

export function redactSensitiveData(input: unknown): string {
  const source =
    typeof input === "string"
      ? input
      : (() => {
          try {
            return JSON.stringify(input);
          } catch {
            return String(input);
          }
        })();

  const redacted = redactString(source);
  if (redacted.length <= MAX_LOG_LENGTH) {
    return redacted;
  }
  return `${redacted.slice(0, MAX_LOG_LENGTH)}...[TRUNCATED]`;
}
