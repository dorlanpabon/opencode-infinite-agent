function safeText(value, maximum = 4_000) {
  const text = value instanceof Error ? value.message : String(value);
  const limit = Number.isSafeInteger(maximum) && maximum >= 0 ? maximum : 4_000;
  return text
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[REDACTED]@')
    .replace(/(authorization\s*:\s*(?:basic|bearer)\s+)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/((?:password|token|secret|api[_-]?key)"?\s*[=:]\s*"?)[^\s,;"}&]+/giu, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/gu, '[REDACTED]')
    .slice(0, limit);
}

module.exports = { safeText };
