import type { SessionContext, SessionContextMessage } from './contracts.js';

const MAX_MESSAGES = 20;
const MAX_MESSAGE_TEXT = 4_000;
const MAX_CONTEXT_TEXT = 24_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rawMessages(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return isRecord(value) && Array.isArray(value.data) ? value.data : [];
}

function boundedText(value: string, maximum: number): string {
  let start = 0;
  while (start < value.length && /\s/u.test(value[start]!)) start += 1;
  return value.slice(start, start + maximum).trimEnd();
}

function safeMessage(value: unknown, maximum: number): SessionContextMessage | null {
  if (!isRecord(value)) return null;
  const info = isRecord(value.info) ? value.info : value;
  if (info.synthetic === true || value.synthetic === true) return null;
  const role = info.role;
  if (role !== 'user' && role !== 'assistant') return null;
  const parts = Array.isArray(value.parts) ? value.parts : [];
  const chunks: string[] = [];
  let remaining = maximum;
  for (const part of parts) {
    if (!isRecord(part) || part.type !== 'text' || part.synthetic === true || typeof part.text !== 'string') continue;
    const separator = chunks.length === 0 ? 0 : 1;
    const text = boundedText(part.text, Math.max(0, remaining - separator));
    if (!text) continue;
    chunks.push(text);
    remaining -= separator + text.length;
    if (remaining <= 0) break;
  }
  const text = chunks.join('\n');
  const directText = typeof value.text === 'string' ? boundedText(value.text, maximum) : '';
  const selected = text || directText;
  return selected ? { role, text: selected } : null;
}

export function parseSessionContextPayload(sessionId: string, value: unknown, limit: number): SessionContext {
  const maximum = Math.max(1, Math.min(MAX_MESSAGES, Math.trunc(limit)));
  const selected: SessionContextMessage[] = [];
  let remaining = MAX_CONTEXT_TEXT;
  const messages = rawMessages(value);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (selected.length >= maximum || remaining <= 0) break;
    const message = safeMessage(messages[index], Math.min(MAX_MESSAGE_TEXT, remaining));
    if (!message) continue;
    selected.push(message);
    remaining -= message.text.length;
  }
  return { sessionId, messages: selected.reverse() };
}
