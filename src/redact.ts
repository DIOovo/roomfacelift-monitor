const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const JWT = /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g;
const BEARER = new RegExp("\\bBearer\\s+[a-zA-Z0-9._~+/-]+=*", "gi");
const PEM = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const URL = /https?:\/\/[^\s"'<>]+/gi;
const LONG_SECRET = /\b[a-zA-Z0-9_-]{32,}\b/g;
const SENSITIVE_PAIR = /\b(authorization|cookie|set-cookie|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|supabase[_-]?token|waffo[_-]?key)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const SENSITIVE_QUERY = /([?&](?:token|signature|sig|key|api_key|access_token)=)[^&#\s]+/gi;

export function redactSecrets(value: unknown) {
  const text = typeof value === "string" ? value : safeStringify(value);
  return text
    .replace(PEM, "[PRIVATE_KEY_REDACTED]")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(JWT, "[JWT_REDACTED]")
    .replace(SENSITIVE_PAIR, (_match, key: string) => `${key}=[REDACTED]`)
    .replace(SENSITIVE_QUERY, "$1[REDACTED]")
    .replace(URL, "[URL_REDACTED]")
    .replace(EMAIL, "[EMAIL_REDACTED]")
    .replace(UUID, "[ID_REDACTED]")
    .replace(LONG_SECRET, "[TOKEN_REDACTED]")
    .slice(0, 1200);
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[UNSERIALIZABLE]";
  }
}
