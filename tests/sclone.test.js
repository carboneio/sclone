
const nock = require('nock');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const sclone = require('../sclone.js');
const { captureLogs } = require('./support/logs');

const urlS3GRA = 'https://s3.gra.first.cloud.test';
const urlS3SBG = 'https://s3.sbg.first.cloud.test';

let logs = null;

/** Cache and lock files written by the runs of the tests */
const TEST_CACHES = ['test-uni.cache.json', 'test-bi.cache.json'].map((name) => path.join(__dirname, name));
function removeTestCaches () {
    for (const _cache of TEST_CACHES) {
        fs.rmSync(_cache, { force: true });
    }
    for (const _name of fs.readdirSync(__dirname)) {
        if (/^sclone-[0-9a-f]{12}\.lock$/.test(_name) === true) {
            fs.rmSync(path.join(__dirname, _name), { force: true });
        }
    }
}

/** Lock file of a test configuration */
function lockOf (configPath) {
    const _config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', configPath)));
    return require('../helper').lockPath({ ..._config, cacheFilename: path.join(__dirname, '..', _config.cacheFilename) });
}

/** Identity of a test storage in the cache header */
const storageIdOf = (id, accessKeyId = 'access-key-id') => `${id}@${require('crypto').createHash('sha256').update(accessKeyId).digest('hex').slice(0, 12)}`;

/** S3 listing page of the given objects: [key, etag, size, lastModified] */
function s3Listing (objects) {
    return '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>invoices</Name><KeyCount>' + objects.length + '</KeyCount><IsTruncated>false</IsTruncated>'
        + objects.map(([key, etag, size, lastModified]) => `<Contents><Key>${key}</Key><LastModified>${lastModified ?? '2026-11-19T10:00:00.123Z'}</LastModified><ETag>"${etag}"</ETag><Size>${size}</Size></Contents>`).join('')
        + '</ListBucketResult>';
}

/** Read a cache file: header line + one line per object `[key, sourceEtag, sourceBytes, targetEtag, targetBytes]` */
function readCache (cachePath) {
    const [_header, ..._lines] = fs.readFileSync(cachePath, 'utf8').trimEnd().split('\n');
    return { ...JSON.parse(_header), files: Object.fromEntries(_lines.map((line) => { const [key, ...entry] = JSON.parse(line); return [key, entry]; })) };
}

/** Write a configuration (test config + overrides) into the tests folder, returns its path */
function writeConfig (base, overrides) {
    const _config = { ...JSON.parse(fs.readFileSync(path.join(__dirname, base))), ...overrides };
    const _path = path.join(__dirname, `config.tmp-${process.pid}.json`);
    fs.writeFileSync(_path, JSON.stringify(_config));
    return _path;
}

/** Names of the events logged at info level or above */
function infoEvents () {
    return logs.events().filter((line) => line.level !== 'debug').map((line) => line.event);
}

/** Poll the logs until `sync_end` appeared `count` times, then stop the cron task and callback. */
function waitForSyncEnd(task, count, callback) {
    const _interval = setInterval(() => {
        if (logs.filter('sync_end').length >= count) {
            clearInterval(_interval);
            task.stop();
            callback();
        }
    }, 50);
}

describe("Sclone", function () {
    this.timeout(20000); 

    this.beforeEach(function () {
        delete process.env.SCLONE_LOG_LEVEL;
        delete process.env.SCLONE_NAME;
        removeTestCaches();
        logs = captureLogs();
    });

    this.afterEach(function () {
        logs.restore();
        delete process.env.SCLONE_LOG_LEVEL;
        delete process.env.SCLONE_NAME;
        nock.cleanAll();
        removeTestCaches();
        fs.rmSync(path.join(__dirname, `config.tmp-${process.pid}.json`), { force: true });
    });
    
    describe("CRON disabled", function () {
        it('should start the sync process one time only', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-cron-disabled.json';
            /** The default job name is the name of the working directory: fixed, the test passes in any checkout */
            process.env.SCLONE_NAME = 'sclone';
            delete process.env.SCLONE_CRON;
    
            const nockAuthS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
                });

            const nockAuthS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
                });

            const nockListFilesS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(200, () => {
                  return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.empty.xml"));
                });

            const nockListFilesS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(200, () => {
                  return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.empty.xml"));
                });

            sclone(() => {
                assert.strictEqual(nockAuthS3GRA.pendingMocks().length, 0);
                assert.strictEqual(nockAuthS3SBG.pendingMocks().length, 0);
                assert.strictEqual(nockListFilesS3GRA.pendingMocks().length, 0);
                assert.strictEqual(nockListFilesS3SBG.pendingMocks().length, 0);
                /** A run without changes is a few lines long */
                assert.deepStrictEqual(infoEvents(), ['sync_start', 'storage_connected', 'storage_connected', 'listing_done', 'listing_done', 'sync_end']);
                const _events = logs.events();
                /** Every line of the run has the same job and run id */
                const _run = _events[0].run;
                assert.match(_run, /^[0-9a-f]{8}$/);
                for (const _line of _events) {
                    assert.strictEqual(_line.run, _run);
                    assert.strictEqual(_line.job, 'sclone');
                    assert.match(_line.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
                }
                const _start = logs.filter('sync_start')[0];
                assert.strictEqual(_start.mode, 'unidirectional');
                assert.strictEqual(_start.source, 's3:invoices');
                assert.strictEqual(_start.target, 's3:invoices');
                assert.strictEqual(_start.delete, false);
                assert.strictEqual(_start.dry_run, false);
                assert.strictEqual(_start.cron, false);
                assert.deepStrictEqual(logs.filter('storage_connected').map((line) => line.side).sort(), ['source', 'target']);
                for (const _listing of logs.filter('listing_done')) {
                    assert.strictEqual(_listing.objects, 0);
                    assert.strictEqual(_listing.bytes, 0);
                    assert.strictEqual(_listing.bucket, 'invoices');
                    assert.strictEqual(_listing.storage, 's3');
                    assert.strictEqual(typeof _listing.duration_ms, 'number');
                }
                const _end = logs.filter('sync_end')[0];
                assert.strictEqual(_end.level, 'info');
                assert.strictEqual(_end.status, 'success');
                assert.strictEqual(typeof _end.duration_ms, 'number');
                assert.strictEqual(_end.uploaded, 0);
                assert.strictEqual(_end.uploaded_bytes, 0);
                assert.strictEqual(_end.deleted, 0);
                assert.strictEqual(_end.failed, 0);
                assert.strictEqual(_end.source_objects, 0);
                assert.strictEqual(_end.target_objects, 0);
                assert.strictEqual(_end.source_bytes, 0);
                assert.strictEqual(_end.target_bytes, 0);
                assert.strictEqual(_end.error, undefined);
                /** No emoji, no multi-line message */
                for (const _line of logs.lines) {
                    assert.strictEqual(/\p{Extended_Pictographic}/u.test(_line), false, _line);
                    assert.strictEqual(_line.indexOf('\n'), _line.length - 1);
                }
                done();
            });
        });

        it('should return an error if the process returns an error (code 500 or request faillure)', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-cron-disabled.json';
            delete process.env.SCLONE_CRON;
    
            const nockAuthS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
                });

            const nockAuthS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
                });

            const nockListFilesS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .replyWithError("THIS IS A MAJOR ERROR")
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .replyWithError("THIS IS A MAJOR ERROR");
                
            const nockListFilesS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(500)
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(500);

            sclone((err) => {
                assert.strictEqual(err.toString().includes("Error: All S3 storages are not available"), true);
                assert.strictEqual(nockAuthS3GRA.pendingMocks().length, 0);
                assert.strictEqual(nockAuthS3SBG.pendingMocks().length, 0);
                assert.strictEqual(nockListFilesS3GRA.pendingMocks().length, 0);
                assert.strictEqual(nockListFilesS3SBG.pendingMocks().length, 0);
                /** Each page is requested again ("listRetry": 1), the whole listing is not */
                const _retries = logs.filter('listing_retry');
                assert.strictEqual(_retries.length, 2);
                assert.deepStrictEqual(_retries.map((line) => line.side).sort(), ['source', 'target']);
                for (const _retry of _retries) {
                    assert.strictEqual(_retry.level, 'warn');
                    assert.strictEqual(_retry.bucket, 'invoices');
                    assert.strictEqual(_retry.retry, 1);
                    assert.strictEqual(_retry.max_retry, 1);
                    assert.strictEqual(_retry.delay_ms, 1);
                    assert.strictEqual(_retry.error.includes('All S3 storages are not available'), true);
                }
                /** Messages of tiny-storage-client */
                const _client = logs.filter('storage_client');
                assert.strictEqual(_client.filter((line) => line.msg.includes('THIS IS A MAJOR ERROR')).length, 2);
                assert.strictEqual(_client.filter((line) => line.msg.includes('Status code: 500')).length, 2);
                for (const _line of _client) {
                    assert.strictEqual(['info', 'warn', 'error'].includes(_line.level), true);
                    assert.strictEqual(['source', 'target'].includes(_line.side), true);
                    assert.strictEqual(_line.storage, 's3');
                }
                assert.strictEqual(logs.filter('queue_retry').length, 0);
                assert.strictEqual(logs.filter('queue_failed').length, 1);
                assert.strictEqual(logs.filter('listing_done').length, 0);
                const _end = logs.filter('sync_end');
                assert.strictEqual(_end.length, 1);
                assert.strictEqual(_end[0].level, 'error');
                assert.strictEqual(_end[0].status, 'failed');
                assert.strictEqual(_end[0].error.includes('List files error'), true);
                /** Not listed: no bucket stats, they would skew the dashboards */
                assert.strictEqual(_end[0].source_objects, undefined);
                done();
            });
        });
    });

    describe("CRON enabled", function () {
        it('should start the sync process automatically multiple times', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-cron-enabled.json';
            delete process.env.SCLONE_CRON;
    
            const nockAuthS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
                });

            const nockAuthS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
                });

            const nockListFilesS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(200, () => {
                  return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.empty.xml"));
                })
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(200, () => {
                  return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.empty.xml"));
                });
                
            const nockListFilesS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(200, () => {
                  return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.empty.xml"));
                })
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(200, () => {
                  return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.empty.xml"));
                });

            sclone((err, task) => {
                waitForSyncEnd(task, 2, () => {
                    assert.strictEqual(err, null);
                    assert.strictEqual(nockAuthS3GRA.pendingMocks().length, 0);
                    assert.strictEqual(nockAuthS3SBG.pendingMocks().length, 0);
                    assert.strictEqual(nockListFilesS3GRA.pendingMocks().length, 0);
                    assert.strictEqual(nockListFilesS3SBG.pendingMocks().length, 0);
                    /** A tick during a slow run would add a "sync_skipped" line: not the subject of this test */
                    assert.deepStrictEqual(infoEvents().filter((event) => event !== 'sync_skipped'), [
                        'storage_connected', 'storage_connected', 'cron_scheduled',
                        'sync_start', 'listing_done', 'listing_done', 'sync_end',
                        'sync_start', 'listing_done', 'listing_done', 'sync_end'
                    ]);
                    assert.strictEqual(logs.filter('cron_scheduled')[0].cron, '* * * * * *');
                    /** The connection is done once, outside of any run */
                    assert.strictEqual(logs.filter('storage_connected').every((line) => line.run === undefined), true);
                    const _starts = logs.filter('sync_start');
                    assert.strictEqual(_starts.every((line) => line.cron === true), true);
                    const _ends = logs.filter('sync_end');
                    assert.strictEqual(_ends.every((line) => line.status === 'success'), true);
                    /** One run id per execution */
                    assert.notStrictEqual(_ends[0].run, _ends[1].run);
                    assert.strictEqual(_starts[0].run, _ends[0].run);
                    assert.strictEqual(_starts[1].run, _ends[1].run);
                    done();
                });
            });
         
        });

        it('should restart the sync process even if the storage is not accessible anymore from the previous process', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-cron-enabled.json';
            delete process.env.SCLONE_CRON;
    
            const nockAuthS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
                });

            const nockAuthS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
                });

            const nockListFilesS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .replyWithError("THIS IS A MAJOR ERROR")
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .replyWithError("THIS IS A MAJOR ERROR")
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(200, () => {
                  return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.empty.xml"));
                });
                
            const nockListFilesS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(500)
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(500)
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(200, () => {
                  return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.empty.xml"));
                });

            sclone((err, task) => {
                waitForSyncEnd(task, 2, () => {
                    assert.strictEqual(err, null);
                    assert.strictEqual(nockAuthS3GRA.pendingMocks().length, 0);
                    assert.strictEqual(nockAuthS3SBG.pendingMocks().length, 0);
                    assert.strictEqual(nockListFilesS3GRA.pendingMocks().length, 0);
                    assert.strictEqual(nockListFilesS3SBG.pendingMocks().length, 0);
                    assert.strictEqual(logs.filter('sync_start').length, 2);
                    assert.strictEqual(logs.filter('listing_retry').length, 2);
                    assert.deepStrictEqual(logs.filter('sync_end').map((line) => line.status), ['failed', 'success']);
                    assert.strictEqual(logs.filter('listing_done').length, 2);
                    done();
                });
            });
        });
    });

    describe("maxDeletion option", function () {
        it('should stop the process before deleting when the number of deletions reaches "maxDeletion"', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-maxdeletion.json';
            delete process.env.SCLONE_CRON;

            const nockAuthS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
                });

            const nockAuthS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
                });

            /** Source is empty */
            const nockListFilesS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(200, () => {
                  return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.empty.xml"));
                });

            /** Target has 5 files: they should all be deleted (delete:true), above the maxDeletion threshold of 3 */
            const nockListFilesS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(200, () => {
                  return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.xml"));
                });

            sclone((err) => {
                assert.strictEqual(err instanceof Error, true);
                assert.strictEqual(err.toString().includes('Too many element deleted'), true);
                assert.strictEqual(nockAuthS3GRA.pendingMocks().length, 0);
                assert.strictEqual(nockAuthS3SBG.pendingMocks().length, 0);
                assert.strictEqual(nockListFilesS3GRA.pendingMocks().length, 0);
                assert.strictEqual(nockListFilesS3SBG.pendingMocks().length, 0);
                const _plan = logs.filter('sync_plan')[0];
                assert.strictEqual(_plan.level, 'info');
                assert.strictEqual(_plan.delete_target, 5);
                const _end = logs.filter('sync_end')[0];
                assert.strictEqual(_end.status, 'failed');
                assert.strictEqual(_end.error.includes('Too many element deleted'), true);
                assert.strictEqual(_end.source_objects, 0);
                assert.strictEqual(_end.target_objects, 5);
                assert.strictEqual(_end.target_bytes > 0, true);
                assert.strictEqual(_end.deleted, 0);
                done();
            });
        });
    });

    describe("Bidirectional sync end-to-end", function () {
        const _cachePath = path.join(__dirname, 'test-bi.cache.json');

        beforeEach(function () {
            fs.rmSync(_cachePath, { force: true });
        });

        afterEach(function () {
            fs.rmSync(_cachePath, { force: true });
        });

        it('should sync a new source file to the target and save the cache file (first sync)', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-bi-cache.json';
            process.env.SCLONE_LOG_LEVEL = 'debug';
            delete process.env.SCLONE_CRON;

            const nockAuthS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
                });

            const nockAuthS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
                });

            /** Source has 1 file, target is empty */
            const nockListFilesS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(200, () => {
                  return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.one.xml"));
                });

            const nockListFilesS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(200, () => {
                  return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.empty.xml"));
                });

            const nockDownloadS3GRA = nock(urlS3GRA)
                .get('/invoices/invoice-2024-01.pdf')
                .reply(200, 'Hello1234', { 'content-type': 'application/pdf' });

            const nockUploadS3SBG = nock(urlS3SBG)
                .put('/invoices/invoice-2024-01.pdf')
                .reply(200, '');

            sclone((err) => {
                assert.strictEqual(err, undefined);
                assert.strictEqual(nockAuthS3GRA.pendingMocks().length, 0);
                assert.strictEqual(nockAuthS3SBG.pendingMocks().length, 0);
                assert.strictEqual(nockListFilesS3GRA.pendingMocks().length, 0);
                assert.strictEqual(nockListFilesS3SBG.pendingMocks().length, 0);
                assert.strictEqual(nockDownloadS3GRA.pendingMocks().length, 0);
                assert.strictEqual(nockUploadS3SBG.pendingMocks().length, 0);
                /** The cache file is saved: the listed token of the source, the PUT etag of the target (MD5 of the body when missing) */
                assert.strictEqual(fs.existsSync(_cachePath), true);
                const _cache = readCache(_cachePath);
                assert.deepStrictEqual(_cache, {
                    version: 2,
                    mode   : 'bidirectional',
                    source : storageIdOf('s3:s3.gra.first.cloud.test:gra/invoices'),
                    target : storageIdOf('s3:s3.sbg.first.cloud.test:sbg/invoices'),
                    files  : { 'invoice-2024-01.pdf': ['a55b475be5fc06d42e1baf84231253ce', 9, require('crypto').createHash('md5').update('Hello1234').digest('hex'), 9] }
                });
                /** First bidirectional sync: no cache yet, not a problem */
                assert.strictEqual(logs.filter('cache_error').length, 0);
                assert.strictEqual(fs.readdirSync(__dirname).some((name) => name.endsWith('.lock')), false, 'lock released');
                const _plan = logs.filter('sync_plan')[0];
                assert.strictEqual(_plan.level, 'info');
                assert.strictEqual(_plan.upload_target, 1);
                assert.strictEqual(_plan.update_target, 0);
                assert.strictEqual(_plan.upload_target_bytes, 9);
                assert.strictEqual(_plan.upload_source, 0);
                assert.strictEqual(_plan.delete_target, 0);
                const _queueEnd = logs.filter('queue_end').find((line) => line.queue === 'upload-from-source-to-target');
                assert.strictEqual(_queueEnd.level, 'info');
                assert.strictEqual(_queueEnd.total, 1);
                const _end = logs.filter('sync_end')[0];
                assert.strictEqual(_end.status, 'success');
                assert.strictEqual(_end.uploaded, 1);
                assert.strictEqual(_end.uploaded_bytes, 9);
                assert.strictEqual(_end.deleted, 0);
                assert.strictEqual(_end.failed, 0);
                assert.strictEqual(_end.source_objects, 1);
                assert.strictEqual(_end.source_bytes, 9);
                assert.strictEqual(_end.target_objects, 0);
                const _saved = logs.filter('cache_saved')[0];
                assert.strictEqual(_saved.level, 'debug');
                assert.strictEqual(_saved.objects, 1);
                done();
            });
        });

        it('should save the cache without the failed file when a transfer fails: the next run with "delete:true" copies it again, never deletes it', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-bi-cache.json';
            delete process.env.SCLONE_CRON;

            const nockAuthS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
                });

            const nockAuthS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices').query({ 'list-type': '2', 'max-keys': '1' })
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
                });

            /** Source has 1 file, target is empty */
            const nockListFilesS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(200, () => {
                  return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.one.xml"));
                });

            const nockListFilesS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/invoices')
                .query({ 'list-type' : '2' })
                .reply(200, () => {
                  return fs.readFileSync(path.join(__dirname, "assets", "listFiles.s3.empty.xml"));
                });

            /** The transfer fails: download returns 404, a permanent error not retried */
            const nockDownloadS3GRA = nock(urlS3GRA)
                .get('/invoices/invoice-2024-01.pdf')
                .reply(404);

            sclone((err) => {
                assert.strictEqual(err instanceof Error, true);
                assert.strictEqual(err.toString().includes('Synchronisation errors'), true);
                assert.strictEqual(err.toString().includes('upload-from-source-to-target'), true);
                assert.strictEqual(nockAuthS3GRA.pendingMocks().length, 0);
                assert.strictEqual(nockAuthS3SBG.pendingMocks().length, 0);
                assert.strictEqual(nockListFilesS3GRA.pendingMocks().length, 0);
                assert.strictEqual(nockListFilesS3SBG.pendingMocks().length, 0);
                assert.strictEqual(nockDownloadS3GRA.pendingMocks().length, 0);
                /** The cache is saved, without entry for the file never transferred */
                assert.deepStrictEqual(readCache(_cachePath).files, {});
                /** One line, with the structured cause */
                const _failures = logs.filter('transfer_failed');
                assert.strictEqual(_failures.length, 1);
                _failures.forEach((line, i) => {
                    assert.strictEqual(line.level, 'warn');
                    assert.strictEqual(line.op, 'upload');
                    assert.strictEqual(line.direction, 'source_to_target');
                    assert.strictEqual(line.phase, 'download');
                    assert.strictEqual(line.key, 'invoice-2024-01.pdf');
                    assert.strictEqual(line.status, 404);
                    assert.strictEqual(line.error, 'S3 downloadFile Error 404 | file not found');
                    assert.strictEqual(line.reason, 'permanent');
                    assert.strictEqual(line.try, i);
                });
                const _end = logs.filter('sync_end')[0];
                assert.strictEqual(_end.status, 'failed');
                assert.strictEqual(_end.failed, 1);
                assert.strictEqual(_end.uploaded, 0);
                done();
            });
        });
    });

    describe("Guards, lock and cache v2", function () {
        const _listAllBuckets = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
        const _uniCache = path.join(__dirname, 'test-uni.cache.json');

        function nockRun (sourceObjects, targetObjects) {
            nock(urlS3GRA).get('/invoices').query({ 'list-type': '2', 'max-keys': '1' }).reply(200, _listAllBuckets, { 'content-type': 'application/xml' });
            nock(urlS3SBG).get('/invoices').query({ 'list-type': '2', 'max-keys': '1' }).reply(200, _listAllBuckets, { 'content-type': 'application/xml' });
            nock(urlS3GRA).get('/invoices').query({ 'list-type': '2' }).reply(200, s3Listing(sourceObjects), { 'content-type': 'application/xml' });
            nock(urlS3SBG).get('/invoices').query({ 'list-type': '2' }).reply(200, s3Listing(targetObjects), { 'content-type': 'application/xml' });
        }
        const _five = [1, 2, 3, 4, 5].map((i) => [`file${i}.pdf`, 'a'.repeat(32), 10]);

        it('should refuse to delete anything when the source is listed empty (unidirectional)', function (done) {
            process.env.SCLONE_CONFIG = writeConfig('config.test-maxdeletion.json', { maxDeletion: undefined });
            delete process.env.SCLONE_CRON;
            nockRun([], _five);
            sclone((err) => {
                assert.strictEqual(err instanceof Error, true);
                assert.strictEqual(err.message.includes('Deletion refused: the source storage is empty'), true, err.message);
                const _refused = logs.filter('deletion_refused')[0];
                assert.strictEqual(_refused.level, 'error');
                assert.strictEqual(_refused.reason, 'empty_side');
                assert.strictEqual(_refused.delete_target, 5);
                assert.strictEqual(logs.filter('sync_end')[0].deleted, 0);
                assert.strictEqual(nock.pendingMocks().length, 0, 'no delete request is mocked: none was sent');
                done();
            });
        });

        it('should not upload into an empty side (bidirectional): the next runs keep refusing instead of deleting the synced files', function (done) {
            const _biCache = path.join(__dirname, 'test-bi.cache.json');
            const _header = { version: 2, mode: 'bidirectional', source: storageIdOf('s3:s3.gra.first.cloud.test:gra/invoices'), target: storageIdOf('s3:s3.sbg.first.cloud.test:sbg/invoices') };
            fs.writeFileSync(_biCache, [JSON.stringify(_header), ..._five.map(([key, etag, size]) => JSON.stringify([key, etag, size, etag, size]))].join('\n') + '\n');
            process.env.SCLONE_CONFIG = 'tests/config.test-bi-cache.json';
            delete process.env.SCLONE_CRON;
            /** The source was emptied by mistake, a new file arrived on the target */
            nockRun([], [..._five, ['new.pdf', 'a55b475be5fc06d42e1baf84231253ce', 9]]);
            sclone((err) => {
                assert.strictEqual(err instanceof Error, true);
                assert.strictEqual(err.message.includes('Deletion refused: the source storage is empty'), true, err.message);
                assert.strictEqual(logs.filter('deletion_refused')[0].reason, 'empty_side');
                assert.strictEqual(nock.pendingMocks().length, 0, 'no download, upload or delete is mocked: none was sent');
                const _end = logs.filter('sync_end')[0];
                assert.deepStrictEqual([_end.status, _end.uploaded, _end.deleted, _end.failed], ['failed', 0, 0, 0]);
                assert.deepStrictEqual(Object.keys(readCache(_biCache).files).sort(), _five.map(([key]) => key), 'the synced files keep their cache');
                fs.rmSync(_biCache, { force: true });
                done();
            });
        });

        it('should refuse only the deletions above "maxDeletion": the uploads still run, the run fails', function (done) {
            process.env.SCLONE_CONFIG = writeConfig('config.test-maxdeletion.json', {});
            delete process.env.SCLONE_CRON;
            nockRun([['new.pdf', 'a55b475be5fc06d42e1baf84231253ce', 9]], _five);
            const nockDownload = nock(urlS3GRA).get('/invoices/new.pdf').reply(200, 'Hello1234');
            const nockUpload = nock(urlS3SBG).put('/invoices/new.pdf').reply(200, '');
            sclone((err) => {
                assert.strictEqual(err instanceof Error, true);
                assert.strictEqual(err.message.includes('Too many element deleted'), true, err.message);
                assert.strictEqual(nockDownload.pendingMocks().length + nockUpload.pendingMocks().length, 0);
                assert.strictEqual(nock.pendingMocks().length, 0, 'no delete request is mocked: none was sent');
                const _refused = logs.filter('deletion_refused');
                assert.deepStrictEqual(_refused.map((l) => [l.level, l.reason, l.delete_target, l.max_deletion]), [['error', 'max_deletion', 5, 3]]);
                const _end = logs.filter('sync_end')[0];
                assert.deepStrictEqual([_end.status, _end.uploaded, _end.deleted], ['failed', 1, 0]);
                assert.deepStrictEqual(Object.keys(readCache(_uniCache).files), ['new.pdf'], 'the upload is recorded');
                done();
            });
        });

        it('should refuse the deletions on a Swift container with "X-Versions-Location", and still upload to it', function (done) {
            const _urlAuth = 'https://auth.cloud.ovh.net/v3';
            const _urlSwift = 'https://storage.gra.cloud.ovh.net/v1/AUTH_test';
            const _config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.test-s3-swift.json')));
            process.env.SCLONE_CONFIG = writeConfig('config.test-s3-swift.json', { mode: 'unidirectional', delete: true, cron: undefined, cacheFilename: 'tests/test-uni.cache.json' });
            delete process.env.SCLONE_CRON;
            nock(urlS3GRA).get('/invoices').query({ 'list-type': '2', 'max-keys': '1' }).reply(200, _listAllBuckets, { 'content-type': 'application/xml' });
            nock(_urlAuth).post('/auth/tokens').reply(200, { token: { catalog: [{ type: 'object-store', endpoints: [{ region: _config.target.region, url: _urlSwift }] }] } }, { 'X-Subject-Token': 'token' });
            nock(_urlSwift).head('/invoices').reply(204, '', { 'x-versions-location': 'invoices_versions' });
            nock(urlS3GRA).get('/invoices').query({ 'list-type': '2' }).reply(200, s3Listing([['new.pdf', 'a55b475be5fc06d42e1baf84231253ce', 9]]), { 'content-type': 'application/xml' });
            nock(_urlSwift).get('/invoices').query(true).reply(200, JSON.stringify([{ name: 'old.pdf', hash: 'a'.repeat(32), bytes: 10, last_modified: '2026-11-19T10:00:00.000000' }]), { 'content-type': 'application/json' });
            nock(_urlSwift).get('/invoices').query({ limit: '10000', marker: 'old.pdf' }).reply(200, '[]', { 'content-type': 'application/json' });
            nock(urlS3GRA).get('/invoices/new.pdf').reply(200, 'Hello1234');
            const nockUpload = nock(_urlSwift).put('/invoices/new.pdf').reply(201, '');
            sclone((err) => {
                assert.strictEqual(err instanceof Error, true);
                assert.strictEqual(err.message.includes('swift_versions_stack'), true, err.message);
                assert.strictEqual(nockUpload.pendingMocks().length, 0);
                assert.strictEqual(nock.pendingMocks().length, 0, 'no delete request is mocked: none was sent');
                assert.strictEqual(logs.filter('swift_versions_stack').length, 1);
                assert.deepStrictEqual(logs.filter('deletion_refused').map((l) => [l.reason, l.side, l.delete_target]), [['swift_versions_stack', 'target', 1]]);
                const _end = logs.filter('sync_end')[0];
                assert.deepStrictEqual([_end.status, _end.uploaded, _end.deleted], ['failed', 1, 0]);
                done();
            });
        });

        it('should delete up to "maxDeletion" objects included, and an empty side with "allowEmptySide"', function (done) {
            process.env.SCLONE_CONFIG = writeConfig('config.test-maxdeletion.json', { maxDeletion: 5, allowEmptySide: true });
            delete process.env.SCLONE_CRON;
            nockRun([], _five);
            /** Each deletion is confirmed by a HEAD on the side the file is missing from */
            const nockHead = nock(urlS3GRA).head(/^\/invoices\/file[1-5]\.pdf$/).times(5).reply(404);
            const nockDelete = nock(urlS3SBG).post('/invoices/').query({ delete: '' }).reply(200, (uri, body) => '<DeleteResult>' + (body.match(/<Key>[^<]*<\/Key>/g) ?? []).map((key) => `<Deleted>${key}</Deleted>`).join('') + '</DeleteResult>');
            sclone((err) => {
                assert.strictEqual(err, undefined);
                assert.strictEqual(nockHead.pendingMocks().length, 0);
                assert.strictEqual(nockDelete.pendingMocks().length, 0);
                assert.strictEqual(logs.filter('sync_end')[0].deleted, 5);
                assert.deepStrictEqual(readCache(_uniCache).files, {});
                done();
            });
        });

        describe('Empty side and confirmed deletions', function () {
            const _biCache = path.join(__dirname, 'test-bi.cache.json');
            const _ids = { source: storageIdOf('s3:s3.gra.first.cloud.test:gra/invoices'), target: storageIdOf('s3:s3.sbg.first.cloud.test:sbg/invoices') };
            const _new = ['new.pdf', 'a55b475be5fc06d42e1baf84231253ce', 9];
            /** Cache of the five synced files */
            function writeCache (file, mode) {
                fs.writeFileSync(file, [JSON.stringify({ version: 2, mode, ..._ids }), ..._five.map(([key, etag, size]) => JSON.stringify([key, etag, size, etag, size]))].join('\n') + '\n');
                return fs.readFileSync(file, 'utf8');
            }
            afterEach(function () {
                fs.rmSync(_biCache, { force: true });
            });

            it('should refuse the deletions when the source was emptied then refilled with a new file (unidirectional), and keep refusing on the next runs', function (done) {
                const _cache = writeCache(_uniCache, 'unidirectional');
                process.env.SCLONE_CONFIG = writeConfig('config.test-maxdeletion.json', { maxDeletion: undefined });
                delete process.env.SCLONE_CRON;
                nockRun([_new], _five);
                nock(urlS3GRA).get('/invoices/new.pdf').reply(200, 'Hello1234');
                nock(urlS3SBG).put('/invoices/new.pdf').reply(200, '');
                sclone((err) => {
                    assert.strictEqual(err?.message.includes('Deletion refused: the source storage is empty'), true, err?.message);
                    assert.deepStrictEqual(logs.filter('deletion_refused').map((l) => [l.reason, l.side, l.delete_target]), [['empty_side', 'source', 5]]);
                    assert.strictEqual(nock.pendingMocks().length, 0, 'the new file is copied, no HEAD or delete is mocked: none was sent');
                    assert.deepStrictEqual([logs.filter('sync_end')[0].uploaded, logs.filter('sync_end')[0].deleted], [1, 0]);
                    assert.strictEqual(fs.readFileSync(_uniCache, 'utf8'), _cache, 'the cache is not saved: the new file has no cache entry');
                    /** Next run: the new file is on both sides, the source still has no synchronised file */
                    nock.cleanAll();
                    nockRun([_new], [..._five, _new]);
                    sclone((err) => {
                        assert.strictEqual(err?.message.includes('Deletion refused: the source storage is empty'), true, err?.message);
                        assert.strictEqual(nock.pendingMocks().length, 0);
                        assert.deepStrictEqual([logs.filter('sync_end')[1].uploaded, logs.filter('sync_end')[1].deleted], [0, 0]);
                        assert.strictEqual(fs.readFileSync(_uniCache, 'utf8'), _cache);
                        done();
                    });
                });
            });

            it('should refuse the deletions when the source was emptied then refilled with a new file (bidirectional): the new file is copied, nothing is copied into the source', function (done) {
                const _cache = writeCache(_biCache, 'bidirectional');
                process.env.SCLONE_CONFIG = 'tests/config.test-bi-cache.json';
                delete process.env.SCLONE_CRON;
                nockRun([_new], [..._five, ['other.pdf', 'b'.repeat(32), 3]]);
                nock(urlS3GRA).get('/invoices/new.pdf').reply(200, 'Hello1234');
                nock(urlS3SBG).put('/invoices/new.pdf').reply(200, '');
                sclone((err) => {
                    assert.strictEqual(err?.message.includes('Deletion refused: the source storage is empty'), true, err?.message);
                    assert.strictEqual(logs.filter('deletion_refused')[0].reason, 'empty_side');
                    assert.strictEqual(nock.pendingMocks().length, 0);
                    assert.deepStrictEqual([logs.filter('sync_end')[0].uploaded, logs.filter('sync_end')[0].deleted], [1, 0]);
                    assert.strictEqual(fs.readFileSync(_biCache, 'utf8'), _cache);
                    done();
                });
            });

            it('should log both refusals when the source is empty and "maxDeletion" is exceeded, and copy nothing into the empty source', function (done) {
                const _cache = writeCache(_biCache, 'bidirectional');
                process.env.SCLONE_CONFIG = writeConfig('config.test-bi-cache.json', { maxDeletion: 3 });
                delete process.env.SCLONE_CRON;
                nockRun([], [..._five, _new]);
                sclone((err) => {
                    assert.strictEqual(err?.message.includes('Too many element deleted'), true, err?.message);
                    assert.strictEqual(err?.message.includes('Deletion refused: the source storage is empty'), true, err?.message);
                    assert.deepStrictEqual(logs.filter('deletion_refused').map((l) => l.reason), ['max_deletion', 'empty_side']);
                    assert.strictEqual(nock.pendingMocks().length, 0, 'no download, upload or delete is mocked: none was sent');
                    assert.deepStrictEqual([logs.filter('sync_end')[0].uploaded, logs.filter('sync_end')[0].deleted], [0, 0]);
                    assert.strictEqual(fs.readFileSync(_biCache, 'utf8'), _cache);
                    done();
                });
            });

            it('should not delete a file missing from a listing but still present (HEAD 200): its cache is kept, the run succeeds (bidirectional)', function (done) {
                writeCache(_biCache, 'bidirectional');
                process.env.SCLONE_CONFIG = 'tests/config.test-bi-cache.json';
                delete process.env.SCLONE_CRON;
                nockRun(_five.slice(0, 4), _five);
                const nockHead = nock(urlS3GRA).head('/invoices/file5.pdf').reply(200, '', { etag: `"${'a'.repeat(32)}"` });
                sclone((err) => {
                    assert.strictEqual(err, undefined);
                    assert.strictEqual(nockHead.pendingMocks().length, 0);
                    assert.strictEqual(nock.pendingMocks().length, 0, 'no delete is mocked: none was sent');
                    assert.deepStrictEqual(logs.filter('deletion_skipped').map((l) => [l.level, l.reason, l.count]), [['warn', 'still_present', 1]]);
                    /** The cache holds the listed objects: the target token is kept, the next run checks the file again */
                    assert.deepStrictEqual(readCache(_biCache).files['file5.pdf'], [null, null, 'a'.repeat(32), 10]);
                    assert.deepStrictEqual([logs.filter('sync_end')[0].deleted, logs.filter('sync_end')[0].failed], [0, 0]);
                    done();
                });
            });

            it('should not delete a file whose absence cannot be confirmed (HEAD 429 after the retries): counted as failed (unidirectional)', function (done) {
                process.env.SCLONE_CONFIG = writeConfig('config.test-maxdeletion.json', { maxDeletion: undefined });
                delete process.env.SCLONE_CRON;
                nockRun(_five.slice(0, 4), _five);
                const nockHead = nock(urlS3GRA).head('/invoices/file5.pdf').times(2).reply(429, '');
                sclone((err) => {
                    assert.strictEqual(err?.message.includes('Deletion not confirmed | 1 file(s) not deleted'), true, err?.message);
                    assert.strictEqual(nockHead.pendingMocks().length, 0, 'retried once ("retry": 1)');
                    assert.strictEqual(nock.pendingMocks().length, 0, 'no delete is mocked: none was sent');
                    assert.deepStrictEqual(logs.filter('deletion_skipped').map((l) => [l.reason, l.count]), [['not_confirmed', 1]]);
                    const _end = logs.filter('sync_end')[0];
                    assert.deepStrictEqual([_end.status, _end.deleted, _end.failed], ['failed', 0, 1]);
                    done();
                });
            });

            it('should change nothing if another process took over the lock during the run', function (done) {
                process.env.SCLONE_CONFIG = 'tests/config.test-cron-disabled.json';
                delete process.env.SCLONE_CRON;
                const _lock = lockOf('tests/config.test-cron-disabled.json');
                const _other = JSON.stringify({ pid: process.ppid, hostname: require('os').hostname(), start: Date.now() });
                nock(urlS3GRA).get('/invoices').query({ 'list-type': '2', 'max-keys': '1' }).reply(200, _listAllBuckets, { 'content-type': 'application/xml' });
                nock(urlS3SBG).get('/invoices').query({ 'list-type': '2', 'max-keys': '1' }).reply(200, _listAllBuckets, { 'content-type': 'application/xml' });
                nock(urlS3GRA).get('/invoices').query({ 'list-type': '2' }).reply(200, () => {
                    fs.writeFileSync(_lock, _other);
                    return s3Listing([_new]);
                }, { 'content-type': 'application/xml' });
                nock(urlS3SBG).get('/invoices').query({ 'list-type': '2' }).reply(200, s3Listing([]), { 'content-type': 'application/xml' });
                sclone((err) => {
                    assert.strictEqual(err?.message.includes('Lock lost'), true, err?.message);
                    assert.strictEqual(nock.pendingMocks().length, 0, 'no download or upload is mocked: none was sent');
                    assert.strictEqual(fs.readFileSync(_lock, 'utf8'), _other, 'the lock of the other process is kept');
                    assert.strictEqual(fs.existsSync(_uniCache), false);
                    done();
                });
            });
        });

        it('should fail a one time run if another process holds the lock', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-cron-disabled.json';
            delete process.env.SCLONE_CRON;
            const _lock = lockOf('tests/config.test-cron-disabled.json');
            fs.writeFileSync(_lock, JSON.stringify({ pid: process.ppid, start: Date.now() }));
            sclone((err) => {
                assert.strictEqual(err instanceof Error, true);
                assert.strictEqual(err.message.includes('Another sclone process synchronises the same storages'), true);
                const _end = logs.filter('sync_end')[0];
                assert.strictEqual(_end.status, 'failed');
                assert.strictEqual(fs.existsSync(_lock), true, 'the lock of the other process is kept');
                done();
            });
        });

        it('should refuse a bidirectional run while a unidirectional configuration of the same pair runs (one lock per pair)', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-bi-cache.json';
            delete process.env.SCLONE_CRON;
            const _lock = lockOf('tests/config.test-cron-disabled.json');
            assert.strictEqual(lockOf('tests/config.test-bi-cache.json'), _lock);
            fs.writeFileSync(_lock, JSON.stringify({ pid: process.ppid, hostname: require('os').hostname(), start: Date.now() }));
            sclone((err) => {
                assert.strictEqual(err?.message.includes('Another sclone process synchronises the same storages'), true, err?.message);
                assert.strictEqual(fs.existsSync(path.join(__dirname, 'test-bi.cache.json')), false);
                done();
            });
        });

        it('should skip a cron run if another process holds the lock', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-cron-enabled.json';
            delete process.env.SCLONE_CRON;
            fs.writeFileSync(lockOf('tests/config.test-cron-enabled.json'), JSON.stringify({ pid: process.ppid, start: Date.now() }));
            nock(urlS3GRA).get('/invoices').query({ 'list-type': '2', 'max-keys': '1' }).reply(200, _listAllBuckets, { 'content-type': 'application/xml' });
            nock(urlS3SBG).get('/invoices').query({ 'list-type': '2', 'max-keys': '1' }).reply(200, _listAllBuckets, { 'content-type': 'application/xml' });
            sclone((err, task) => {
                assert.strictEqual(err, null);
                const _interval = setInterval(() => {
                    const _skipped = logs.filter('sync_skipped');
                    if (_skipped.length === 0) {
                        return;
                    }
                    clearInterval(_interval);
                    task.stop();
                    assert.strictEqual(_skipped[0].reason, 'locked');
                    assert.strictEqual(_skipped[0].level, 'warn');
                    assert.strictEqual(_skipped[0].pid, process.ppid);
                    assert.strictEqual(logs.filter('sync_start').length, 0);
                    done();
                }, 50);
            });
        });

        it('should log a skipped cron run at error level when the holder of the lock runs for longer than the stale delay', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-cron-enabled.json';
            delete process.env.SCLONE_CRON;
            fs.writeFileSync(lockOf('tests/config.test-cron-enabled.json'), JSON.stringify({ pid: process.ppid, start: Date.now() - 11 * 60000 }));
            nock(urlS3GRA).get('/invoices').query({ 'list-type': '2', 'max-keys': '1' }).reply(200, _listAllBuckets, { 'content-type': 'application/xml' });
            nock(urlS3SBG).get('/invoices').query({ 'list-type': '2', 'max-keys': '1' }).reply(200, _listAllBuckets, { 'content-type': 'application/xml' });
            sclone((err, task) => {
                assert.strictEqual(err, null);
                const _interval = setInterval(() => {
                    const _skipped = logs.filter('sync_skipped');
                    if (_skipped.length === 0) {
                        return;
                    }
                    clearInterval(_interval);
                    task.stop();
                    assert.deepStrictEqual([_skipped[0].level, _skipped[0].reason, _skipped[0].held_ms > 10 * 60000], ['error', 'locked', true]);
                    done();
                }, 50);
            });
        });

        it('should resolve an opaque etag once with a HEAD, then list only (no request per object) in the steady state', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-cron-disabled.json';
            delete process.env.SCLONE_CRON;
            const _md5 = 'a'.repeat(32);
            const _opaque = 'e'.repeat(64);
            nockRun([['enc.pdf', _opaque, 10], ['plain.pdf', _md5, 10]], [['enc.pdf', _md5, 10], ['plain.pdf', _md5, 10]]);
            const nockHead = nock(urlS3GRA).head('/invoices/enc.pdf').reply(200, '', { etag: `"${_md5}"` });
            sclone((err) => {
                assert.strictEqual(err, undefined);
                assert.strictEqual(nockHead.pendingMocks().length, 0);
                assert.strictEqual(logs.filter('sync_end')[0].uploaded, 0);
                assert.deepStrictEqual(readCache(_uniCache).files, { 'enc.pdf': [_opaque, 10, _md5, 10], 'plain.pdf': [_md5, 10, _md5, 10] });
                /** Second run: the listings only */
                nock.cleanAll();
                nockRun([['enc.pdf', _opaque, 10], ['plain.pdf', _md5, 10]], [['enc.pdf', _md5, 10], ['plain.pdf', _md5, 10]]);
                sclone((err) => {
                    assert.strictEqual(err, undefined);
                    assert.strictEqual(nock.pendingMocks().length, 0);
                    assert.strictEqual(logs.filter('sync_end')[1].uploaded, 0);
                    done();
                });
            });
        });
    });

    describe("Logs contract", function () {
        const _listAllBuckets = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><Name>invoices</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>";
        const _readAsset = (name) => fs.readFileSync(path.join(__dirname, "assets", name));

        function nockConnections () {
            nock(urlS3GRA).get('/invoices').query({ 'list-type': '2', 'max-keys': '1' }).reply(200, _listAllBuckets, { 'content-type': 'application/xml' });
            nock(urlS3SBG).get('/invoices').query({ 'list-type': '2', 'max-keys': '1' }).reply(200, _listAllBuckets, { 'content-type': 'application/xml' });
        }

        /** Status of a failed upload: a 4xx is returned by tiny-storage-client with its status */
        it('should log the cause of a failed upload with its HTTP status (403)', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-cron-disabled.json';
            delete process.env.SCLONE_CRON;
            nockConnections();
            nock(urlS3GRA).get('/invoices').query({ 'list-type': '2' }).reply(200, _readAsset("listFiles.s3.one.xml"), { 'content-type': 'application/xml' });
            nock(urlS3SBG).get('/invoices').query({ 'list-type': '2' }).reply(200, _readAsset("listFiles.s3.empty.xml"), { 'content-type': 'application/xml' });
            /** A 403 is permanent: not retried ("retry" default: 1) */
            const nockDownload = nock(urlS3GRA).get('/invoices/invoice-2024-01.pdf').reply(200, 'Hello1234');
            const nockUpload = nock(urlS3SBG).put('/invoices/invoice-2024-01.pdf').reply(403, '<Error><Code>AccessDenied</Code></Error>', { 'content-type': 'application/xml' });

            sclone((err) => {
                assert.strictEqual(err instanceof Error, true);
                assert.strictEqual(nockDownload.pendingMocks().length, 0);
                assert.strictEqual(nockUpload.pendingMocks().length, 0);
                const _failures = logs.filter('transfer_failed');
                assert.strictEqual(_failures.length, 1);
                assert.strictEqual(_failures[0].level, 'warn');
                assert.strictEqual(_failures[0].status, 403);
                assert.strictEqual(_failures[0].code, 'AccessDenied');
                assert.strictEqual(_failures[0].reason, 'permanent');
                assert.strictEqual(_failures[0].phase, 'upload');
                assert.strictEqual(_failures[0].op, 'upload');
                assert.strictEqual(_failures[0].direction, 'source_to_target');
                assert.strictEqual(_failures[0].key, 'invoice-2024-01.pdf');
                assert.strictEqual(_failures[0].error, 'S3 uploadFile Error | Status code 403 | Code: AccessDenied');
                assert.deepStrictEqual(_failures.map((line) => line.try), [0]);
                assert.strictEqual(logs.filter('queue_retry').length, 0);
                const _end = logs.filter('sync_end')[0];
                assert.strictEqual(_end.level, 'error');
                assert.strictEqual(_end.status, 'failed');
                assert.strictEqual(_end.failed, 1);
                assert.strictEqual(_end.uploaded, 0);
                assert.strictEqual(_end.error.includes('upload-from-source-to-target | 1 operation(s) failed'), true);
                done();
            });
        });

        /**
         * tiny-storage-client >= 4.0.0: the error carries `storageStatusCode`, logged as `status`,
         * and the "storage_client" line of a single storage without fallback is logged at `error`.
         */
        it('should log the cause of a failed upload (503)', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-cron-disabled.json';
            delete process.env.SCLONE_CRON;
            nockConnections();
            nock(urlS3GRA).get('/invoices').query({ 'list-type': '2' }).reply(200, _readAsset("listFiles.s3.one.xml"), { 'content-type': 'application/xml' });
            nock(urlS3SBG).get('/invoices').query({ 'list-type': '2' }).reply(200, _readAsset("listFiles.s3.empty.xml"), { 'content-type': 'application/xml' });
            nock(urlS3GRA).get('/invoices/invoice-2024-01.pdf').times(2).reply(200, 'Hello1234');
            nock(urlS3SBG).put('/invoices/invoice-2024-01.pdf').times(10).reply(503, 'Slow Down');

            sclone((err) => {
                assert.strictEqual(err instanceof Error, true);
                const _failures = logs.filter('transfer_failed');
                assert.strictEqual(_failures.length, 2);
                assert.strictEqual(_failures[0].phase, 'upload');
                assert.strictEqual(_failures[0].key, 'invoice-2024-01.pdf');
                assert.strictEqual(_failures[0].error, 'S3 uploadFile Error | Error: All S3 storages are not available');
                assert.deepStrictEqual(_failures.map((line) => line.status), [503, 503]);
                const _client = logs.filter('storage_client').find((line) => line.msg.includes('Status code: 503'));
                assert.strictEqual(_client.level, 'error');
                assert.strictEqual(_client.side, 'target');
                assert.strictEqual(_client.run, _failures[0].run);
                assert.strictEqual(logs.filter('sync_end')[0].status, 'failed');
                done();
            });
        });

        it('should log "sync_skipped" when the previous run is still running', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-cron-enabled.json';
            delete process.env.SCLONE_CRON;
            nockConnections();
            /** The listing of the first run lasts longer than the cron period (1 second) */
            nock(urlS3GRA).get('/invoices').query({ 'list-type': '2' }).delay(1600).reply(200, _readAsset("listFiles.s3.empty.xml"), { 'content-type': 'application/xml' });
            nock(urlS3SBG).get('/invoices').query({ 'list-type': '2' }).reply(200, _readAsset("listFiles.s3.empty.xml"), { 'content-type': 'application/xml' });

            sclone((err, task) => {
                waitForSyncEnd(task, 1, () => {
                    assert.strictEqual(err, null);
                    const _skipped = logs.filter('sync_skipped');
                    assert.strictEqual(_skipped.length >= 1, true);
                    assert.strictEqual(_skipped[0].level, 'warn');
                    assert.strictEqual(_skipped[0].reason, 'already_running');
                    assert.strictEqual(_skipped[0].running_since_ms > 0, true);
                    assert.strictEqual(logs.filter('sync_end')[0].status, 'success');
                    done();
                });
            });
        });

        it('should end a one time run as failed if a storage cannot be connected', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-cron-disabled.json';
            delete process.env.SCLONE_CRON;
            nock(urlS3GRA).get('/invoices').query({ 'list-type': '2', 'max-keys': '1' }).reply(403, '<Error><Code>AccessDenied</Code></Error>', { 'content-type': 'application/xml' });

            sclone((err) => {
                assert.strictEqual(typeof err, 'string');
                const _failed = logs.filter('storage_connect_failed')[0];
                assert.strictEqual(_failed.level, 'error');
                assert.strictEqual(_failed.side, 'source');
                assert.strictEqual(_failed.storage, 's3');
                assert.strictEqual(_failed.bucket, 'invoices');
                assert.strictEqual(_failed.error.includes('Status 403'), true);
                assert.strictEqual(_failed.error.includes('secret-access-key'), false);
                const _end = logs.filter('sync_end')[0];
                assert.strictEqual(_end.status, 'failed');
                assert.strictEqual(_end.run, logs.filter('sync_start')[0].run);
                done();
            });
        });

        it('should never log the credentials', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-cron-disabled.json';
            process.env.SCLONE_LOG_LEVEL = 'debug';
            delete process.env.SCLONE_CRON;
            nockConnections();
            nock(urlS3GRA).get('/invoices').query({ 'list-type': '2' }).reply(200, _readAsset("listFiles.s3.empty.xml"), { 'content-type': 'application/xml' });
            nock(urlS3SBG).get('/invoices').query({ 'list-type': '2' }).reply(200, _readAsset("listFiles.s3.empty.xml"), { 'content-type': 'application/xml' });

            sclone(() => {
                const _output = logs.lines.join('');
                assert.strictEqual(_output.includes('access-key-id'), false);
                assert.strictEqual(_output.includes('secret-access-key'), false);
                done();
            });
        });
    });
});