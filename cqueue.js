const fs = require('fs');
const path = require('path');
const NS_PER_SEC = 1e9;
const MS_PER_NS = 1e-6;

module.exports = (() => {

  function unpackGenericQueue(index, lists, functionToExecute, timeout, callback) {
    if (!callback) {
      callback = timeout;
      timeout = 10;
    }

    const _list = lists[index].list;
    const _queueTime = lists[index].time;
    const _listLength = lists[index].listLength

    if (index === lists[index].logIndex) {
      printQueueStatus(lists);
    }

    if (_list.length === 0) {
      lists[index].done = true;
      printQueueStatus(lists);
      return callback(null, { errors: lists[index].errors, results: lists[index].results, logs: lists[index].logs });
    }

    const _time = process.hrtime();
    functionToExecute(_list[0], (err, res, actions) => {
      const _diff = process.hrtime(_time);
      if (err) {
        lists[index].errors.push({
          element: _list[0],
          message: err.toString()
        });
      }
      if (res) {
        lists[index].results.push(res);
      }
      const _logs = actions?.logs && actions?.logs instanceof Array ? actions?.logs : [];
      if (_logs) {
        lists[index].logs.push(..._logs);
      }
      const _stop = actions?.stop === true ? actions?.stop : false;
      if (_stop && _stop === true) {
        lists[index].done = true;
        printQueueStatus(lists);
        return callback(null, { errors: lists[index].errors, results: lists[index].results, logs: lists[index].logs });
      }
      _list.shift();
      _queueTime.requestTime = Math.round((_diff[0] * NS_PER_SEC + _diff[1]) * MS_PER_NS);
      _queueTime.passedTime += _queueTime.requestTime;
      _queueTime.averageTime = Math.round(_queueTime.averageTime + ((_queueTime.requestTime - _queueTime.averageTime) / (_listLength - _list.length === 0 ? 1 : _listLength - _list.length)));
      _queueTime.leftTime = _queueTime.averageTime * _list.length;
      _queueTime.done = _listLength - _list.length;
      _queueTime.percentage = Math.round((_queueTime.done) * 100 / _listLength);
      setTimeout(function(){ unpackGenericQueue(index, lists, functionToExecute, timeout, callback) }, timeout);
    });
  }

  function unpackGenericQueuePromisify(index, list, functionToExecute, execDelay) {
    return new Promise (function (resolve, reject) {
      unpackGenericQueue(index, list, functionToExecute, execDelay, (err, res) => {
        if (err) {
          return reject(err);
        }
        return resolve(res);
      })
    });
  }

  function msToTime(ms) {
    let seconds = (ms / 1000).toFixed(1);
    let minutes = (ms / (1000 * 60)).toFixed(1);
    let hours = (ms / (1000 * 60 * 60)).toFixed(1);
    let days = (ms / (1000 * 60 * 60 * 24)).toFixed(1);
    if (seconds < 1) return ms + " ms";
    else if (seconds < 60) return seconds + " Sec";
    else if (minutes < 60) return minutes + " Min";
    else if (hours < 24) return hours + " Hrs";
    else return days + " Days"
  }

  function printQueueStatus(lists) {
    let _text = '';

    if (!lists || lists.length === 0 || lists[0]?.logQueueStatus === false) {
      return '';
    }

    // Choose the slowest queue to print the log
    let _slowest = lists.reduce(function(prev, current) {
      return (prev.time.leftTime > current.time.leftTime) ? prev : current
    })
    if (!_slowest) {
      return '';
    }
    if (lists[0].logged === true) {
      process.stdout.moveCursor(0, (lists.length * -1));
    }
    for (let i = 0; i < lists.length; i++) {
      const _time = lists[i].time;
      lists[i].logIndex = _slowest.id;
      lists[i].logged = true;
      _text += `[${lists[i].id}] ${_time.percentage}% - ${_time.done}/${lists[i].listLength} - Passed time: ${msToTime(_time.passedTime)} | Left Time: ${msToTime(_time.leftTime)} | Avg time/exec: ${msToTime(_time.averageTime)}`
      if (lists[i].done === true) {
        _text += ' ✅ Done';
      }
      if (lists[i].errors.length > 0) {
        _text += ` 🚩 ${lists[i].errors.length} errors`
      }
      if (i !== lists.length) {
        _text += '\n'
      }
    }
    process.stdout.write(_text);
  }

  /**
   *
   * @description Create a new queue process
   *
   * @param {String} queueName
   * @param {Array} list Array of objects/string
   * @param {Function} functionToExecute function to execute for each element
   * @param {Object} options [OPTIONAL]
   * @param {Function} callback Callback function called when the process is finised
   * @returns
   */
  async function execQueue (queueName, list, functionToExecute, options, callback) {
    if (!callback) {
      callback = options;
      options = {
        concurrency   : 1, // Option - number of queues
        delay         : 0, // Option - MS delay between each execution
        retry         : 1, // Option - Number of retries if an error is thrown
        logEnabled    : true, // Option - Log Start and End Performance summary, if false errors are still logged
        logQueueStatus: true // Option - Log on the console each queue status and performances
      };
    }
    options.delay = options?.delay ?? 0;
    options.retry = options?.retry ?? 1;
    options.try = options?.try ?? 0;
    options.concurrency = options?.concurrency ?? 1;
    options.results = options?.results ?? [];
    options.logEnabled = options?.logEnabled ?? true;
    options.logQueueStatus = options?.logQueueStatus ?? true;

    if (options.logEnabled === true) {
      log(`[${queueName}] START - ${list.length} total elements - ${options.concurrency} queue(s) - ${options.delay}ms delay - ${options.try}/${options.retry} retrie(s)`);
    }
    /** Create child-lists based on the concurrency option */
    const _lists = chunkify(list, options.concurrency, options.logQueueStatus);
    /** Create an array of promises, each promise is a queue */
    const _listPromises = []
    _lists.forEach((el, index) => {
      _listPromises.push(unpackGenericQueuePromisify(index, _lists, functionToExecute, options.delay))
    })
    try {
      /** Execute all queues in parrallel, end only when all queues are done */
      const _res = await Promise.allSettled(_listPromises);
      const _errors = _res.map(el => el?.value?.errors).flat().filter(x => x !== undefined && x !== null);
      const _results = _res.map(el => el?.value?.results).flat().filter(x => x !== undefined && x !== null);
      const _logs = _res.map(el => el?.value?.logs).flat().filter(x => x !== undefined && x !== null);
      if (_results.length > 0) {
        options.results = [...options.results, ..._results];
      }
      if (_logs.length > 0) {
        createLogFile(queueName, _logs, 'logs');
      }
      if (_errors.length > 0) {
        log(`[${queueName}] 🚩 ${_errors.length} errors`)
        createLogFile(queueName, _errors, 'errors');
        const _toRetry = _errors.map(value => value.element);
        if (options.try < options.retry) {
          options.try += 1;
          log(`[${queueName}] Retry to re-execute the process on failled elements...`)
          return execQueue(queueName, _toRetry, functionToExecute, options, callback);
        } else {
          log(`[${queueName}] END - Stop retrying, check the error file!`)
        }
      } else {
        if (options.logEnabled === true) {
          log(`[${queueName}] END - ${getPerfSummary(_lists, _results.length, _errors.length, _logs.length)}`)
        }
      }
    } catch (err) {
      log(`[${queueName}] 🚩 Error: Promise All Catched: ${err.toString()}`);
      return callback(`[${queueName}] 🚩 Error: Promise All Catched: ${err.toString()}`);
    }
    return callback(null, options.results);
  }

  function createLogFile(queueName, content, label) {
    const _filename = new Date().toISOString().slice(0, 16) + `-${queueName.replace(/\s/g, '-').toLowerCase()}${label ? '-' + label : ''}.json`
    const _path = path.join(__dirname, 'logs', _filename);
    log(`[${queueName}] Created ${label ? label + ' ' : ''}file: ${_path}`);

    fs.writeFile(_path, JSON.stringify(content), (err) => {
      if (err) {
        log(`[${queueName}] 🚩 Error Create Log File: ${err.toString()}`);
      }
    });
  }

  function chunkify(list, size, logQueueStatus) {
    let result = [];
    let array = [...list];
    for (let i = size; i > 0; i--) {
      const _chunkList = array.splice(0, Math.ceil(array.length / i));
      result.push(
        {
          id  : result.length,
          time: {
            requestTime: 0,
            averageTime: 0,
            leftTime   : 0,
            passedTime : 0,
            percentage : 0,
            done       : 0
          },
          list          : _chunkList,
          listLength    : _chunkList.length,
          done          : false,
          logQueueStatus: logQueueStatus ?? true,
          logIndex      : 0,
          logged        : false,
          errors        : [],
          results       : [],
          logs          : []
        }
      );
    }
    return result;
  }

  function getPerfSummary(lists, resultsLength, errorsLength, logsLength) {
    // Choose the slowest queue to print the log
    let _slowest = lists.reduce(function(prev, current) {
      return (prev.time.passedTime > current.time.passedTime) ? prev : current
    })
    if (_slowest) {
      return `Duration: ${msToTime(_slowest.time.passedTime)} | Avg time/exec: ${msToTime(_slowest.time.averageTime)} | ${errorsLength > 0 ? '🚩 ' : ''}Errors: ${errorsLength} | Returned: ${resultsLength} | Logs: ${logsLength}`
    } else {
      return `Error get performances summary`
    }
  }

  /**
   * log messages
   *
   * @param {String} msg Message
   * @param {type} type warning, error
   */
  function log (msg, level = 'info') {
    return console.log(level === 'error' ? `❗️ ${msg}` : msg );
  }
  return execQueue;
})()