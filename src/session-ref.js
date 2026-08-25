const SESSION_ID = /^ses_[A-Za-z0-9]+$/;
const INTERNAL_SESSION_LINK = /^oc:\/\/renderer\/server\/c2lkZWNhcg\/session\/(ses_[A-Za-z0-9]+)$/;

function parseSessionRef(input) {
  if (input === null || input === undefined || input === '') return null;
  const value = String(input);
  if (SESSION_ID.test(value)) return value;
  return INTERNAL_SESSION_LINK.exec(value)?.[1] ?? null;
}

module.exports = { parseSessionRef };
