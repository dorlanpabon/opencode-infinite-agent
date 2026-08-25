const { parseSessionRef } = require('./session-ref');

async function resolveSession(req, { ref, title }) {
  const id = parseSessionRef(ref);
  if (ref && !id) throw new TypeError('La referencia de sesión OpenCode no es válida.');
  if (id) {
    const session = await req('GET', `/session/${id}`);
    return { session, created: false };
  }
  const session = await req('POST', '/session', { title: title || 'infinite-agent' });
  return { session, created: true };
}

function initialPrompt(task, sentinel) {
  return [
    'You are working autonomously under an event-driven supervisor. It sends one continuation only after OpenCode reports that the current turn has ended.',
    '',
    '# TASK',
    task,
    '',
    '# PROTOCOL (MANDATORY)',
    '1. Maintain your todo list with todowrite at ALL times and keep statuses accurate (pending / in_progress / completed).',
    '2. Work continuously toward completing the task. Never stop early. Never ask questions; make reasonable decisions yourself.',
    '3. Verify your work before declaring completion (run builds/tests/lint when applicable).',
    '4. ONLY when EVERYTHING is fully complete and verified, end your final response with this exact marker on its own line:',
    sentinel,
    '',
    'Do NOT output the marker until the task is truly 100% complete. After each terminal turn, the supervisor will verify completion before continuing.',
  ].join('\n');
}

function resumePrompt(sentinel) {
  return [
    'An infinite-loop supervisor has re-attached to this session to drive it to completion.',
    '',
    '# PROTOCOL (MANDATORY)',
    '1. Keep your todo list updated with todowrite at ALL times.',
    '2. Continue working right where you left off. Never stop early; make reasonable decisions yourself instead of asking questions.',
    '3. Verify remaining work (builds/tests/lint when applicable).',
    '4. ONLY when EVERYTHING is fully complete and verified, end your final response with this exact marker on its own line:',
    sentinel,
    '',
    'Continue now.',
  ].join('\n');
}

function continuationPrompt(sentinel) {
  return [
    'Continue working on the current task. Pick up exactly where you left off.',
    'If the task is already 100% complete AND verified, reply with a brief final summary ending with this exact marker on its own line:',
    sentinel,
    'Otherwise, keep working right now without asking questions.',
  ].join('\n');
}

module.exports = { parseSessionRef, resolveSession, initialPrompt, resumePrompt, continuationPrompt };
