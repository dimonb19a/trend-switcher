// Safe error text for logs and the ledger: AGENT_TEST=1 node --test agent/test-errors.mjs
// An external error is described from allowlisted fields only (code, kind, status, one cause the
// same way); its message, name, body and headers are never copied, so no regex has to find a
// credential inside them. Errors raised by this code base keep their authored first line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecordableError, describeError, redactText } from './errors.mjs';

const MARKER = 'synthetic-short-key'; // 19 characters: below any token-length mask on purpose

/** The forms a credential takes in the text of a third-party error. Each must leave no trace in the envelope. */
const FORMS = {
  https: `server response 429 at https://rpc.example/v2/${MARKER} (request failed)`,
  userinfo: `server at https://user:${MARKER}@rpc.example/v2`,
  query: `server at https://rpc.example/?apikey=${MARKER}`,
  ipv6: `server at https://[2001:db8::1]:8545/v2/${MARKER}`,
  header: `HTTP 403 X-API-Key: ${MARKER}`,
  bearer: `request failed Authorization: Bearer ${MARKER}`,
  escaped: `server at https:\\/\\/rpc.example\\/v2\\/${MARKER}`,
  body: `bad reply {"error":"invalid key ${MARKER}","key":"${MARKER}"}`,
  plain: `the key ${MARKER} was rejected`,
  multiline: `first line is harmless\nsecond line: ${MARKER}`,
};

test('an external error never contributes its message, name, data, body or cause text to the envelope', () => {
  for (const [form, message] of Object.entries(FORMS)) {
    const error = Object.assign(new Error(message), { code: 'SERVER_ERROR', shortMessage: message, info: { responseBody: message, responseStatus: 429 } });
    const out = describeError(error);
    assert.equal(out, '[SERVER_ERROR] server error (http 429)', `${form}: ${out}`);
    assert.ok(!out.includes(MARKER), `${form}: ${out}`);
  }
  // the marker in the code, in the name, in a nested cause, in a non-string code: still not copied
  const inCode = Object.assign(new Error('x'), { code: `KEY_${MARKER}` });
  assert.equal(describeError(inCode), 'error');
  const inName = Object.assign(new Error('x'), { name: `Error ${MARKER}`, code: 'TIMEOUT' });
  assert.equal(describeError(inName), '[TIMEOUT] timeout');
  const nested = Object.assign(new Error(`outer ${MARKER}`), { code: 'UNKNOWN_ERROR', cause: Object.assign(new Error(`inner ${MARKER}`), { code: 'ECONNRESET', status: 502 }) });
  assert.equal(describeError(nested), '[UNKNOWN_ERROR] unknown error caused by: [ECONNRESET] connection reset (http 502)');
  const viaInfo = Object.assign(new Error('x'), { code: 'SERVER_ERROR', info: { error: Object.assign(new Error(`deep ${MARKER}`), { code: -32000 }) } });
  assert.equal(describeError(viaInfo), '[SERVER_ERROR] server error caused by: [code -32000] error');
  const unknownKind = Object.assign(new TypeError(`cannot read ${MARKER}`), {});
  assert.equal(describeError(unknownKind), 'TypeError');
});

test('a call exception says whether revert data was present; ethers status fields and numeric codes are kept', () => {
  assert.equal(describeError(Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION', data: null })), '[CALL_EXCEPTION] call exception (no revert data)');
  assert.equal(describeError(Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: '0x08c379a0' })), '[CALL_EXCEPTION] call exception (revert data present)');
  assert.equal(describeError(Object.assign(new Error('x'), { code: 'SERVER_ERROR', response: { statusCode: 503 } })), '[SERVER_ERROR] server error (http 503)');
});

test('an error raised by this code base keeps its authored first line, its code and its status; the second guard still masks what it would carry', () => {
  class JudgeLike extends RecordableError { constructor(m, status) { super(m); this.name = 'JudgeLike'; this.status = status; } }
  assert.equal(describeError(new JudgeLike('HTTP 401 from the judge endpoint', 401)), 'HTTP 401 from the judge endpoint (http 401)');
  const typed = new RecordableError(`quote unavailable after 2 attempts (deadline): ${describeError(Object.assign(new Error(FORMS.ipv6), { code: 'SERVER_ERROR' }))}`, { cause: new Error(FORMS.ipv6) });
  typed.code = 'QUOTE_UNAVAILABLE';
  const out = describeError(typed);
  assert.equal(out, '[QUOTE_UNAVAILABLE] quote unavailable after 2 attempts (deadline): [SERVER_ERROR] server error');
  assert.ok(!out.includes(MARKER));
  // an authored message that (wrongly) carried a credential form is still masked by the second guard
  for (const message of [`refused at https://[2001:db8::1]:8545/v2/${MARKER}`, `refused X-API-Key: ${MARKER}`, `refused at https:\\/\\/rpc.example\\/v2\\/${MARKER}`, `refused Bearer ${MARKER}`, `refused with ${'A'.repeat(40)}`]) {
    const line = describeError(new RecordableError(message));
    assert.ok(!line.includes(MARKER) && !line.includes('A'.repeat(40)), line);
  }
  assert.equal(describeError(new RecordableError(`invalid api key ${'q'.repeat(48)}`), { redact: ['q'.repeat(48)] }), 'invalid api key <redacted>');
  assert.equal(describeError(new RecordableError(`first\nsecond ${MARKER}`)), 'first');
});

test('redactText: hostnames stay, a public address stays readable, a 64-hex value is shortened, credential fields are masked', () => {
  assert.equal(redactText(`at https://[2001:db8::1]:8545/v2/${MARKER} then https:\\/\\/rpc.example\\/v2\\/${MARKER}`), 'at <[2001:db8::1]> then <rpc.example>');
  assert.equal(redactText(`key ${'A'.repeat(40)} address 0x${'1'.repeat(40)} hash 0x${'ab'.repeat(32)} secret hunter2secret`, ['hunter2secret']), `key <token> address 0x${'1'.repeat(40)} hash 0xabababab… secret <redacted>`);
  assert.equal(redactText(`Authorization: Bearer ${MARKER}; apikey=${MARKER}; token: ${MARKER}`), 'Authorization=<redacted> apikey=<redacted> token=<redacted>');
  assert.equal(redactText('the API key; nothing was sent'), 'the API key; nothing was sent'); // a word without a separator is prose, not a field
});

test('non-error values and empty messages still give one bounded line that echoes nothing', () => {
  assert.equal(describeError(null), 'error');
  assert.equal(describeError(`plain text ${MARKER}`), 'error (non-error value of type string thrown)');
  assert.equal(describeError(new Error('')), 'error');
  assert.equal(describeError(new RecordableError('')), 'RecordableError');
  assert.ok(describeError(new RecordableError('x'.repeat(500))).length <= 300);
});
