function assistantText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && p.type === 'text')
    .map((p) => p.text || '')
    .join('\n')
    .trim();
}

function hasSentinel(text, sentinel) {
  return Boolean(text) && text.includes(sentinel);
}

function todosDone(todos) {
  const list = Array.isArray(todos) ? todos : [];
  const total = list.length;
  if (total === 0) return { done: false, completed: 0, total: 0 };
  const finished = list.filter((t) => t.status === 'completed' || t.status === 'cancelled').length;
  return { done: finished === total, completed: finished, total };
}

function excerpt(text, maxLines = 6, maxLen = 160) {
  if (!text) return '(sin texto)';
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, maxLines);
  const clipped = lines.map((l) => (l.length > maxLen ? l.slice(0, maxLen) + '...' : l));
  return clipped.join('\n  ');
}

function messageError(info) {
  return info && info.error ? info.error : null;
}

function usageOf(info) {
  const tokens = (info && info.tokens) || {};
  const cache = tokens.cache || {};
  return {
    input: tokens.input || 0,
    output: tokens.output || 0,
    cacheRead: cache.read || 0,
    cacheWrite: cache.write || 0,
    cost: (info && info.cost) || 0,
  };
}

module.exports = { assistantText, hasSentinel, todosDone, excerpt, messageError, usageOf };
