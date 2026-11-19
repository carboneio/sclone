const assert = require('assert');
const logger = require('../logger');
const { captureLogs, parseLine } = require('./support/logs');

describe('logger', function () {
  let _logs = null;

  beforeEach(function () {
    delete process.env.SCLONE_NAME;
    delete process.env.SCLONE_LOG_LEVEL;
    _logs = captureLogs();
    logger.setup({ name: 'test-job' });
  });

  afterEach(function () {
    _logs.restore();
    logger.endRun();
    logger.setup({});
  });

  it('should write one logfmt line per event, with a single write ending with a new line', function () {
    logger.log('info', 'sync_start', 'Synchronisation started', { mode: 'unidirectional', delete: false, transfers: 15 });
    assert.strictEqual(_logs.lines.length, 1);
    const _line = _logs.lines[0];
    assert.match(_line, /^ts=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z level=info job=test-job event=sync_start msg="Synchronisation started" mode=unidirectional delete=false transfers=15\n$/);
    assert.strictEqual(_line.indexOf('\n'), _line.length - 1);
  });

  it('should escape quotes, backslashes, new lines, tabs and control characters', function () {
    logger.log('error', 'test', 'line 1\nline 2', { error: 'say "hi"\\o/\r\n\tend\u0001', eq: 'a=b', unicode: 'Récapitulatif-日本', empty: '', space: 'a b' });
    const _line = _logs.lines[0];
    assert.strictEqual(_line.split('\n').length, 2, 'one line only');
    assert.ok(_line.includes('msg="line 1\\nline 2"'));
    assert.ok(_line.includes('error="say \\"hi\\"\\\\o/\\r\\n\\tend\\u0001"'));
    assert.ok(_line.includes('eq="a=b"'));
    assert.ok(_line.includes('unicode=Récapitulatif-日本'));
    assert.ok(_line.includes('empty=""'));
    assert.ok(_line.includes('space="a b"'));
    /** The line can be parsed back to the original values */
    const _parsed = parseLine(_line);
    assert.strictEqual(_parsed.msg, 'line 1\nline 2');
    assert.strictEqual(_parsed.error, 'say "hi"\\o/\r\n\tend\u0001');
    assert.strictEqual(_parsed.eq, 'a=b');
    assert.strictEqual(_parsed.unicode, 'Récapitulatif-日本');
  });

  it('should not let a value inject another field or line', function () {
    logger.log('info', 'test', 'msg', { key: 'x level=error event=fake\nts=0 level=error' });
    assert.strictEqual(_logs.lines.length, 1);
    const _parsed = parseLine(_logs.lines[0]);
    assert.strictEqual(_parsed.level, 'info');
    assert.strictEqual(_parsed.event, 'test');
    assert.strictEqual(_parsed.key, 'x level=error event=fake\nts=0 level=error');
  });

  it('should write numbers and booleans bare, omit null and undefined fields, sanitize keys and ignore reserved keys', function () {
    logger.log('info', 'test', 'msg', { bytes: 1024, ratio: 0.5, ok: true, nothing: null, missing: undefined, 'Bad-Key.Name': 1, level: 'error', run: 'fake', '': 2 });
    const _line = _logs.lines[0];
    assert.ok(_line.includes(' bytes=1024 ratio=0.5 ok=true bad_key_name=1\n'));
    assert.strictEqual(_line.includes('nothing'), false);
    assert.strictEqual(_line.includes('missing'), false);
    assert.strictEqual(_line.includes('run='), false);
    assert.strictEqual((_line.match(/level=/g) ?? []).length, 1);
  });

  it('should add a run id between startRun and endRun only', function () {
    const _run = logger.startRun();
    assert.match(_run, /^[0-9a-f]{8}$/);
    logger.log('info', 'a', 'in');
    logger.endRun();
    logger.log('info', 'b', 'out');
    assert.strictEqual(parseLine(_logs.lines[0]).run, _run);
    assert.strictEqual(parseLine(_logs.lines[1]).run, undefined);
    assert.notStrictEqual(logger.startRun(), _run);
  });

  it('should filter the lines below the level threshold', function () {
    logger.setup({ logLevel: 'warn' });
    logger.log('debug', 'a', 'a');
    logger.log('info', 'b', 'b');
    logger.log('warn', 'c', 'c');
    logger.log('error', 'd', 'd');
    assert.deepStrictEqual(_logs.events().map((line) => line.event), ['c', 'd']);
    logger.setup({ logLevel: 'debug' });
    logger.log('debug', 'e', 'e');
    assert.strictEqual(_logs.events().pop().event, 'e');
  });

  it('should accept the level case-insensitively', function () {
    logger.setup({ logLevel: 'WARN' });
    logger.log('info', 'a', 'a');
    logger.log('warn', 'b', 'b');
    process.env.SCLONE_LOG_LEVEL = 'Error';
    logger.setup({});
    logger.log('warn', 'c', 'c');
    logger.log('error', 'd', 'd');
    assert.deepStrictEqual(_logs.events().map((line) => line.event), ['b', 'd']);
  });

  it('should use info and write one warning if the level is invalid', function () {
    logger.setup({ logLevel: 'verbose' });
    logger.log('debug', 'a', 'a');
    logger.log('info', 'b', 'b');
    const _events = _logs.events();
    assert.deepStrictEqual(_events.map((line) => line.event), ['config_warning', 'b']);
    assert.strictEqual(_events[0].level, 'warn');
    assert.strictEqual(_events[0].log_level, 'verbose');
  });

  it('should give priority to the environment variables over the configuration', function () {
    process.env.SCLONE_NAME = 'from-env';
    process.env.SCLONE_LOG_LEVEL = 'error';
    logger.setup({ name: 'from-config', logLevel: 'debug' });
    logger.log('warn', 'a', 'a');
    logger.log('error', 'b', 'b');
    assert.strictEqual(_logs.lines.length, 1);
    assert.strictEqual(parseLine(_logs.lines[0]).job, 'from-env');
  });

  it('should use the name of the working directory as default job name', function () {
    logger.setup({});
    logger.log('info', 'a', 'a');
    assert.strictEqual(parseLine(_logs.lines[0]).job, require('path').basename(process.cwd()));
  });

  it('should never throw, whatever the values', function () {
    const _circular = {};
    _circular.self = _circular;
    const _throwing = { toString () { throw new Error('boom'); } };
    assert.doesNotThrow(() => {
      logger.log('info', 'a', _circular, { circular: _circular, throwing: _throwing, big: 10n, sym: Symbol('s'), fn: () => {}, err: new Error('failed') });
      logger.log('unknown-level', null, undefined, null);
      logger.log('info', 'b', 'msg', 'not an object');
    });
    const _first = _logs.lines[0];
    assert.ok(_first.includes('msg="[unserializable]"'));
    assert.ok(_first.includes('circular="[unserializable]"'));
    assert.ok(_first.includes('big=10'));
    assert.ok(_first.includes('err="Error: failed"'));
    assert.strictEqual(parseLine(_logs.lines[1]).level, 'info');
    logger.setOutput(() => { throw new Error('EPIPE'); });
    assert.doesNotThrow(() => logger.log('info', 'c', 'c'));
  });

  it('should truncate very long values', function () {
    logger.log('info', 'a', 'a', { error: 'x'.repeat(10000) });
    assert.ok(_logs.lines[0].length < 2200);
    assert.ok(_logs.lines[0].includes('…'));
  });

  it('should log a field whose getter throws as [unserializable], and keep the other fields', function () {
    logger.log('info', 'a', 'a', { before: 1, get broken () { throw new Error('getter'); }, after: 2 });
    assert.strictEqual(_logs.lines.length, 1);
    assert.match(_logs.lines[0], / before=1 broken="\[unserializable\]" after=2\n$/);
  });

  it('should log own keys only, never inherited ones', function () {
    const _fields = Object.create({ inherited: 'yes' });
    _fields.own = 1;
    logger.log('info', 'a', 'a', _fields);
    logger.log('info', 'b', 'b', JSON.parse('{"__proto__":{"polluted":1},"x":1}'));
    assert.match(_logs.lines[0], / msg=a own=1\n$/);
    assert.strictEqual(parseLine(_logs.lines[1]).x, 1);
    assert.strictEqual({}.polluted, undefined);
  });

  it('should keep the first of two keys equal once sanitised', function () {
    logger.log('info', 'a', 'a', { 'Foo-Bar': 1, foo_bar: 2, 'foo.bar': 3, skipped: null, SKIPPED: 'kept' });
    assert.match(_logs.lines[0], / msg=a foo_bar=1 skipped=kept\n$/);
  });

  it('should escape the C1 controls, the line separators and the bidirectional controls', function () {
    const _value = 'a\u0085b\u009bc\u2028d\u2029e\u200ef\u200fg\u202ah\u202ei\u2066j\u2069k';
    logger.log('info', 'a', 'a', { v: _value, bare: 'x\u202e' });
    const _line = _logs.lines[0];
    assert.ok(_line.includes('v="a\\u0085b\\u009bc\\u2028d\\u2029e\\u200ef\\u200fg\\u202ah\\u202ei\\u2066j\\u2069k"'), _line);
    assert.ok(_line.includes('bare="x\\u202e"'), _line);
    assert.strictEqual(/[\u0080-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(_line), false);
    assert.strictEqual(parseLine(_line).v, _value);
  });

  it('should truncate a value once escaped, never inside an escape sequence or a surrogate pair', function () {
    for (const _unit of ['\u0001', '\\', '"', '\n', '😀', 'é\u0001😀\\']) {
      for (let _shift = 0; _shift < 7; _shift++) {
        _logs.lines.length = 0;
        const _value = 'a'.repeat(_shift) + _unit.repeat(3000);
        logger.log('info', 'a', 'a', { v: _value });
        const _raw = _logs.lines[0].match(/ v=("(?:[^"\\]|\\.)*")\n$/)[1];
        assert.ok(_raw.length <= 2048 + 2, _raw.length);
        assert.ok(_raw.endsWith('…"'));
        /** Valid escapes (JSON.parse throws on a cut one), no lone surrogate, and a prefix of the value */
        const _parsed = JSON.parse(_raw);
        assert.strictEqual(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(_parsed), false);
        assert.ok(_value.startsWith(_parsed.slice(0, -1)));
        assert.ok(_parsed.length > 300, 'not cut too short');
      }
    }
  });

  it('should drop the fields which do not fit in a line of 16 000 characters, and add truncated=true', function () {
    const _fields = {};
    for (let i = 0; i < 40; i++) {
      _fields['f' + i] = '\u0001'.repeat(2047);
    }
    _fields.status = 503;
    logger.log('error', 'a', 'a', _fields);
    const _line = _logs.lines[0];
    assert.ok(_line.length <= 16000 + 1, _line.length);
    assert.ok(_line.endsWith(' status=503 truncated=true\n'));
    assert.strictEqual(parseLine(_line).f0, '\u0001'.repeat(341) + '…');
    assert.strictEqual(parseLine(_line).f39, undefined);
  });

  it('should log a function as [function], and an Error nested in an object as its message and code only', function () {
    const _err = Object.assign(new Error('boom'), { code: 'ECONNRESET', cause: { headers: { authorization: 'AWS4-HMAC-SHA256 Signature=abc' } } });
    logger.log('info', 'a', 'a', { fn: function secretSource () { return 'source'; }, obj: { err: _err, fn: () => 1 } });
    const _parsed = parseLine(_logs.lines[0]);
    assert.strictEqual(_parsed.fn, '[function]');
    assert.deepStrictEqual(JSON.parse(_parsed.obj), { err: { message: 'boom', code: 'ECONNRESET' }, fn: '[function]' });
    assert.strictEqual(/source|abc|headers/.test(_logs.lines[0]), false);
  });

  it('should redact the Authorization and X-Auth-Token headers, and unquoted secrets', function () {
    logger.log('error', 'a', 'Authorization: Bearer abc123 | authorization: AWS4-HMAC-SHA256 Credential=AKIA1/20250101/gra/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=sig1 | x-auth-token: tok1', {
      error: 'X-Auth-Token:tok2 aws_secret_access_key=key1 secretAccessKey: key2 password: "pass1" Password=pass2',
      summary: '{"Authorization":"Bearer abc456"}'
    });
    const _line = _logs.lines[0];
    assert.strictEqual(/abc123|AKIA1|SignedHeaders|sig1|tok1|tok2|key1|key2|pass1|pass2|abc456/.test(_line), false, _line);
    assert.ok(_line.includes('Authorization: ***'));
    assert.ok(_line.includes('X-Auth-Token:***'));
    assert.ok(_line.includes('password: \\"***\\"'));
  });

  it('should redact secrets passed as key=value', function () {
    logger.log('error', 'a', 'GET https://s3.test/b/k?X-Amz-Signature=abcdef&X-Amz-Credential=AKIA123 failed', { error: 'password=hunter2 token=xyz' });
    const _line = _logs.lines[0];
    assert.strictEqual(/abcdef|AKIA123|hunter2|xyz/.test(_line), false, _line);
    assert.ok(_line.includes('X-Amz-Signature=***'));
  });

  it('should redact secrets written as JSON in free-text fields', function () {
    const _body = JSON.stringify({ error: { code: 'SignatureDoesNotMatch', awsaccesskeyid: 'AKIA123', stringtosign: 'AWS4 abc', signatureprovided: 'sig\\"456' } });
    logger.log('error', 'a', `Response: ${_body}`, { error: '{"secretAccessKey": "s3cr3t", "password":"hunter2", "region":"gra"}', summary: '"x-auth-token":"tok"' });
    const _line = _logs.lines[0];
    assert.strictEqual(/AKIA123|AWS4 abc|456|s3cr3t|hunter2|tok"/.test(_line), false, _line);
    assert.ok(_line.includes('SignatureDoesNotMatch'));
    assert.ok(_line.includes('region'));
    assert.ok(_line.includes('gra'));
  });

  it('should redact a JSON secret cut by the truncation', function () {
    logger.log('error', 'a', 'a', { error: '{"password":"' + 'x'.repeat(5000) + '"}' });
    assert.strictEqual(_logs.lines[0].includes('xxx'), false);
  });

  it('should never rewrite an identifier field such as an object key', function () {
    logger.log('warn', 'transfer_failed', 'upload failed', { key: 'exports/token=abc/password=1.pdf', bucket: 'token=b' });
    const _line = parseLine(_logs.lines[0]);
    assert.strictEqual(_line.key, 'exports/token=abc/password=1.pdf');
    assert.strictEqual(_line.bucket, 'token=b');
  });
});
