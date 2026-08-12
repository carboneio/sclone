
const sinon = require('sinon');
const nock = require('nock');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const sclone = require('../sclone.js');

const urlS3GRA = 'https://s3.gra.first.cloud.test';
const urlS3SBG = 'https://s3.sbg.first.cloud.test';

function getOccurrence(array, value) {
    var count = 0;
    array.forEach((v) => (v.includes(value) && count++));
    return count;
}

/** Poll the console spy until `value` appeared `count` times, then stop the cron task and callback. */
function waitForOutput(task, value, count, callback) {
    const _interval = setInterval(() => {
        const _output = console.log.getCalls().map(el => el.args[0]);
        if (getOccurrence(_output, value) >= count) {
            clearInterval(_interval);
            task.stop();
            callback();
        }
    }, 50);
}

describe("Sclone", function () {
    this.timeout(20000); 

    let spy = null;

    this.beforeEach(function (done) {
        /** SPY documentation: https://sinonjs.org/releases/v19/spies/ */
        spy = sinon.spy(console, 'log');
        done();
    });

    this.afterEach(function (done) {
        /** Restore the original function */
        if (spy?.restore) {
            spy.restore();
        }
        done();
    });
    
    describe("CRON disabled", function () {
        it('should start the sync process one time only', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-cron-disabled.json';
            delete process.env.SCLONE_CRON;
    
            const nockAuthS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/')
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
                });

            const nockAuthS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/')
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
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
                const _calls = console.log.getCalls();
                const _output = [];
                _calls.forEach(el => { _output.push(el.args[0]); });
                assert.strictEqual(getOccurrence(_output, 'Synchronisation: unidirectional'), 1);
                assert.strictEqual(getOccurrence(_output, 'Deletion: Disabled'), 1);
                assert.strictEqual(getOccurrence(_output, 'Cron: Disabled'), 1);
                assert.strictEqual(getOccurrence(_output, 'Source S3 connected!'), 1);
                assert.strictEqual(getOccurrence(_output, 'Target S3 connected!'), 1);
                assert.strictEqual(getOccurrence(_output, 'New synchro starting...'), 0);
                assert.strictEqual(getOccurrence(_output, 'Summary Source'), 1);
                assert.strictEqual(getOccurrence(_output, 'Summary Target'), 1);
                assert.strictEqual(getOccurrence(_output, 'Cache loading skipped on "unidirectional" mode'), 1);
                assert.strictEqual(getOccurrence(_output, 'Cache saving skipped on "unidirectional" mode'), 1);
                assert.strictEqual(getOccurrence(_output, 'Process done'), 1);
                done();
            });
        });

        it('should return an error if the process returns an error (code 500 or request faillure)', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-cron-disabled.json';
            delete process.env.SCLONE_CRON;
    
            const nockAuthS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/')
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
                });

            const nockAuthS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/')
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
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
                const _calls = console.log.getCalls();
                const _output = [];
                _calls.forEach(el => { _output.push(el.args[0]); });
                console.log(_output);
                assert.strictEqual(getOccurrence(_output, 'Synchronisation: unidirectional'), 1);
                assert.strictEqual(getOccurrence(_output, 'Deletion: Disabled'), 1);
                assert.strictEqual(getOccurrence(_output, 'Cron: Disabled'), 1);
                assert.strictEqual(getOccurrence(_output, 'Source S3 connected!'), 1);
                assert.strictEqual(getOccurrence(_output, 'Target S3 connected!'), 1);
                assert.strictEqual(getOccurrence(_output, 'New synchro starting...'), 0);
                assert.strictEqual(getOccurrence(_output, 'Error: THIS IS A MAJOR ERROR'), 2);
                assert.strictEqual(getOccurrence(_output, 'Status code: 500'), 2);
                assert.strictEqual(getOccurrence(_output, 'Retry to re-execute the process on failled elements...'), 1);
                assert.strictEqual(getOccurrence(_output, 'Stop retrying, check the error file!'), 1);
                assert.strictEqual(getOccurrence(_output, 'Cache loading skipped on "unidirectional" mode'), 1);
                assert.strictEqual(getOccurrence(_output, 'Cache saving skipped on "unidirectional" mode'), 0);
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
                .get('/')
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
                });

            const nockAuthS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/')
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
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
                waitForOutput(task, 'Process done', 2, () => {
                    assert.strictEqual(err, null);
                    assert.strictEqual(nockAuthS3GRA.pendingMocks().length, 0);
                    assert.strictEqual(nockAuthS3SBG.pendingMocks().length, 0);
                    assert.strictEqual(nockListFilesS3GRA.pendingMocks().length, 0);
                    assert.strictEqual(nockListFilesS3SBG.pendingMocks().length, 0);
                    const _calls = console.log.getCalls();
                    const _output = [];
                    _calls.forEach(el => { _output.push(el.args[0]); });
                    assert.strictEqual(getOccurrence(_output, 'Synchronisation: unidirectional'), 1);
                    assert.strictEqual(getOccurrence(_output, 'Deletion: Disabled'), 1);
                    assert.strictEqual(getOccurrence(_output, 'Cron Scheduled: * * * * * *'), 1);
                    assert.strictEqual(getOccurrence(_output, 'New synchro starting...'), 2);
                    assert.strictEqual(getOccurrence(_output, 'Summary Source'), 2);
                    assert.strictEqual(getOccurrence(_output, 'Summary Target'), 2);
                    assert.strictEqual(getOccurrence(_output, 'Cache loading skipped on "unidirectional" mode'), 2);
                    assert.strictEqual(getOccurrence(_output, 'Cache saving skipped on "unidirectional" mode'), 2);
                    assert.strictEqual(getOccurrence(_output, 'Process done'), 2);
                    done();
                });
            });
         
        });

        it('should restart the sync process even if the storage is not accessible anymore from the previous process', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-cron-enabled.json';
            delete process.env.SCLONE_CRON;
    
            const nockAuthS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/')
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
                });

            const nockAuthS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/')
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
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
                waitForOutput(task, 'Process done', 1, () => {
                    assert.strictEqual(err, null);
                    assert.strictEqual(nockAuthS3GRA.pendingMocks().length, 0);
                    assert.strictEqual(nockAuthS3SBG.pendingMocks().length, 0);
                    assert.strictEqual(nockListFilesS3GRA.pendingMocks().length, 0);
                    assert.strictEqual(nockListFilesS3SBG.pendingMocks().length, 0);
                    const _calls = console.log.getCalls();
                    const _output = [];
                    _calls.forEach(el => { _output.push(el.args[0]); });
                    assert.strictEqual(getOccurrence(_output, 'Synchronisation: unidirectional'), 1);
                    assert.strictEqual(getOccurrence(_output, 'Deletion: Disabled'), 1);
                    assert.strictEqual(getOccurrence(_output, 'Cron Scheduled: * * * * * *'), 1);
                    assert.strictEqual(getOccurrence(_output, 'New synchro starting...'), 2);
                    assert.strictEqual(getOccurrence(_output, 'Error: THIS IS A MAJOR ERROR'), 2);
                    assert.strictEqual(getOccurrence(_output, 'Status code: 500'), 2);
                    assert.strictEqual(getOccurrence(_output, 'Process failed!'), 1);
                    assert.strictEqual(getOccurrence(_output, 'Summary Source'), 1);
                    assert.strictEqual(getOccurrence(_output, 'Summary Target'), 1);
                    assert.strictEqual(getOccurrence(_output, 'Cache loading skipped on "unidirectional" mode'), 2);
                    assert.strictEqual(getOccurrence(_output, 'Cache saving skipped on "unidirectional" mode'), 1);
                    assert.strictEqual(getOccurrence(_output, 'Process done'), 1);
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
                .get('/')
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
                });

            const nockAuthS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/')
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
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
            delete process.env.SCLONE_CRON;

            const nockAuthS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/')
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
                });

            const nockAuthS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/')
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
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
                /** The cache file is saved and contains the synced file */
                assert.strictEqual(fs.existsSync(_cachePath), true);
                const _cache = JSON.parse(fs.readFileSync(_cachePath).toString());
                assert.strictEqual(_cache.length, 1);
                assert.strictEqual(_cache[0][0], 'invoice-2024-01.pdf');
                const _output = console.log.getCalls().map(el => el.args[0]);
                assert.strictEqual(getOccurrence(_output, 'Process done'), 1);
                done();
            });
        });

        it('should NOT save the cache file when a transfer fails, otherwise the next run with "delete:true" deletes the never-synced file from the source', function (done) {
            process.env.SCLONE_CONFIG = 'tests/config.test-bi-cache.json';
            delete process.env.SCLONE_CRON;

            const nockAuthS3GRA = nock(urlS3GRA)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/')
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
                });

            const nockAuthS3SBG = nock(urlS3SBG)
                .defaultReplyHeaders({ 'content-type': 'application/xml' })
                .get('/')
                .reply(200, () => {
                    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListAllMyBucketsResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Owner><ID>89123456:user-feiowjfOEIJW</ID><DisplayName>12345678:user-feiowjfOEIJW</DisplayName></Owner><Buckets><Bucket><Name>invoices</Name><CreationDate>2023-02-27T11:46:24.000Z</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>";
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

            /** The transfer fails: download returns 404 on the first try and on the retry */
            const nockDownloadS3GRA = nock(urlS3GRA)
                .get('/invoices/invoice-2024-01.pdf')
                .times(2)
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
                /** The cache must NOT be saved: the file was never transferred */
                assert.strictEqual(fs.existsSync(_cachePath), false);
                const _output = console.log.getCalls().map(el => el.args[0]);
                assert.strictEqual(getOccurrence(_output, 'Process done'), 0);
                done();
            });
        });
    });
});