export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, "[private key redacted]")
    .replace(/(\b(?:api[_ -]?key|(?:access[_ -]?|refresh[_ -]?)?token|password|passwd|(?:client[_ -]?)?secret)|пароль|токен)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\x60[^\x60]*\x60|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/\b(Bearer|Basic)\s+[a-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\b(?:sk-(?:proj-)?[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{16,}|github_pat_[a-z0-9_]{16,}|AKIA[A-Z0-9]{16}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+)\b/gi, "[redacted]");
}
