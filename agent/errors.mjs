// Error text that may reach a log line or a ledger row. External libraries put request URLs (which
// may carry a provider key), response bodies and headers into their messages, codes, names and
// causes; none of that belongs in a durable record, and no regular expression over free text can
// prove that a credential is gone (an IPv6 authority, an escaped URL, a short key behind a header
// name all slip past pattern masking). So an EXTERNAL error is described by allowlisted fields
// only: an identifier-like code, an error kind derived from that code, an HTTP status when one is
// attached, and one level of cause described the same way — never its message. Prose is kept only
// for errors this code base raises itself (`RecordableError` and its subclasses), whose messages
// are authored here; even those pass through `redactText` as a second guard.

/** An error whose message was written by this code base and may be recorded as prose. */
export class RecordableError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = new.target.name;
    this.recordable = true;
  }
}

const URL_RE = /\b(?:https?|wss?):(?:\\?\/){2}(?:\[[^\]\s]*\]|[^\s"'<>()[\]])[^\s"'<>()]*/giu;
const HEX64_RE = /\b0x[0-9a-fA-F]{64}\b/gu;
const TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/gu;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;
const CREDENTIAL_FIELD_RE = /\b(?:authorization|x-api-key|api[-_]?key|apikey|secret|token|password)\b\s*[:=]\s*(?:bearer\s+)?\S+/giu;
const BEARER_RE = /\bbearer\s+\S+/giu;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,40}$/u;
const NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,40}$/u;

/** Text with URLs reduced to their hostname, 64-hex values shortened, credential fields and long tokens masked, the given strings redacted. */
export function redactText(text, redact = []) {
  let s = String(text ?? '');
  for (const value of redact) if (typeof value === 'string' && value.length >= 8) s = s.split(value).join('<redacted>');
  s = s.replace(HEX64_RE, (m) => `${m.slice(0, 10)}…`);
  s = s.replace(URL_RE, (m) => { try { return `<${new URL(m.replace(/\\\//gu, '/')).hostname}>`; } catch { return '<url>'; } });
  s = s.replace(CREDENTIAL_FIELD_RE, (m) => `${m.split(/[:=]/u)[0].trim()}=<redacted>`);
  s = s.replace(BEARER_RE, 'bearer <redacted>');
  s = s.replace(TOKEN_RE, (m) => (ADDRESS_RE.test(m) ? m : '<token>')); // a public address stays readable; anything else this long is masked
  return s;
}

/** Error kinds by code: ethers v6 codes, Node system errors, fetch/abort codes. The phrase is ours; a code is kept only when it is identifier-like. */
const KINDS = Object.freeze({
  NETWORK_ERROR: 'network error', TIMEOUT: 'timeout', SERVER_ERROR: 'server error', BAD_DATA: 'bad data from the endpoint',
  CALL_EXCEPTION: 'call exception', UNKNOWN_ERROR: 'unknown error', INSUFFICIENT_FUNDS: 'insufficient funds',
  NONCE_EXPIRED: 'nonce expired', REPLACEMENT_UNDERPRICED: 'replacement underpriced', TRANSACTION_REPLACED: 'transaction replaced',
  UNPREDICTABLE_GAS_LIMIT: 'gas limit could not be estimated', ACTION_REJECTED: 'action rejected', INVALID_ARGUMENT: 'invalid argument',
  MISSING_ARGUMENT: 'missing argument', UNEXPECTED_ARGUMENT: 'unexpected argument', VALUE_MISMATCH: 'value mismatch',
  NUMERIC_FAULT: 'numeric fault', BUFFER_OVERRUN: 'buffer overrun', OFFCHAIN_FAULT: 'offchain fault',
  UNSUPPORTED_OPERATION: 'unsupported operation', NOT_IMPLEMENTED: 'not implemented', CANCELLED: 'cancelled',
  ECONNRESET: 'connection reset', ECONNREFUSED: 'connection refused', ECONNABORTED: 'connection aborted', ENOTFOUND: 'host not found',
  ETIMEDOUT: 'connection timed out', EAI_AGAIN: 'dns lookup failed', EPIPE: 'broken pipe', EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable', ABORT_ERR: 'aborted', ERR_NETWORK: 'network error', UND_ERR_CONNECT_TIMEOUT: 'connect timeout',
  UND_ERR_HEADERS_TIMEOUT: 'headers timeout', UND_ERR_BODY_TIMEOUT: 'body timeout', UND_ERR_SOCKET: 'socket error',
});

const firstLine = (value) => String(value ?? '').split(/\r?\n/u)[0].trim();
const safeCode = (error) => {
  const code = error?.code;
  if (typeof code === 'string' && CODE_RE.test(code)) return code;
  if (Number.isInteger(code)) return `code ${code}`;
  return null;
};
const safeName = (error) => (typeof error?.name === 'string' && NAME_RE.test(error.name) && error.name !== 'Error' ? error.name : null);
const httpStatus = (error) => {
  const status = error?.status ?? error?.statusCode ?? error?.info?.responseStatus ?? error?.response?.status ?? error?.response?.statusCode;
  return Number.isInteger(status) ? status : null;
};

/** The allowlisted description of an error whose text is not ours: code, kind, status. Never its message. */
function describeExternal(error) {
  const code = safeCode(error);
  const parts = [];
  if (code) parts.push(`[${code}]`);
  let kind = (code && KINDS[code]) ?? safeName(error) ?? 'error';
  if (code === 'CALL_EXCEPTION') kind += typeof error?.data === 'string' && error.data.length > 2 ? ' (revert data present)' : ' (no revert data)';
  parts.push(kind);
  const status = httpStatus(error);
  if (status !== null) parts.push(`(http ${status})`);
  return parts.join(' ');
}

/**
 * One safe line for an error. An error raised by this code base (`recordable`): `[code] its own
 * first line (http status)`. Any other error: `[code] kind (http status) caused by: [code] kind`,
 * built from allowlisted fields only — the message, body, headers, name and cause text of an
 * external error are never copied. Non-error values are reported as such, not echoed.
 */
export function describeError(error, { redact = [], maxLength = 300 } = {}) {
  if (error === null || error === undefined) return 'error';
  let out;
  if (error && typeof error === 'object' && error.recordable === true) {
    const parts = [];
    const code = safeCode(error);
    if (code) parts.push(`[${code}]`);
    parts.push(firstLine(error.message) || safeName(error) || 'error');
    const status = httpStatus(error);
    if (status !== null) parts.push(`(http ${status})`);
    out = parts.join(' ');
  } else if (error && typeof error === 'object') {
    out = describeExternal(error);
    const cause = error.cause ?? error.error ?? error.info?.error;
    if (cause && typeof cause === 'object' && cause !== error) out += ` caused by: ${cause.recordable === true ? firstLine(cause.message) || 'error' : describeExternal(cause)}`;
  } else {
    out = `error (non-error value of type ${typeof error} thrown)`;
  }
  out = redactText(out, redact);
  if (out.length > maxLength) out = `${out.slice(0, maxLength - 1)}…`;
  return out;
}
