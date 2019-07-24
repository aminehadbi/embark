const child_process = require('child_process');
const EventEmitter = require('events');

class ProcessLauncher extends EventEmitter {
  constructor(embark, options) {
    super();

    this.embark = embark;

    this.name = options.name;
    this.command = options.command;
    this.args = options.args || [];
    this.splitLines = !!options.splitLines;
  }

  start() {
    if (this.child) {
      throw new Error('child process already started');
    }

    const stdioHandler = (chunk, fd) => {
      const ev = `output:${fd}`; // output:stdout, output:stderr

      if (!this.splitLines) {
        return this.emit(ev, chunk.toString());
      }

      const lines = chunk.toString().trim().split("\n");
      for (const l of lines) {
        this.emit(ev, l);
      }
    };

    const child = child_process.spawn(
      this.command,
      this.args,
      {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
    );

    child.on('error', (err) => {
      // Make sure we have listeners for errors. If not, we should throw
      // an error to make sure the operator handles it next time.
      const listeners = this.listeners('error');
      if (listeners.length === 0) {
        throw err;
      }

      this.emit('error', err);
    });

    child.on('exit', (code) => this.emit('exit', code));
    child.stdout.on('data', chunk => stdioHandler(chunk, 'stdout'));
    child.stderr.on('data', chunk => stdioHandler(chunk, 'stderr'));

    this.child = child;

    // Ensure we kill child processes when SIGINT is signaled.
    process.on('SIGINT', () => process.exit(0));
    process.on('exit', () => child.kill('SIGINT'));
  }

  send(buf) {
    if (!this.child) {
      throw new Error('child process not started or killed');
    }

    this.child.stdin.write(buf);
  }

  stop() {
    if (!this.child) {
      throw new Error('child process not started or killed');
    }

    const child = this.child;
    this.child = null;

    child.kill('SIGINT');
  }
}




































const constants = require('../../constants');
const path = require('path');
const ProcessLogsApi = require('embark-process-logs-api');

let processCount = 1;
export class ProcessLauncherOld {

  /**
   * Constructor of ProcessLauncher. Forks the module and sets up the message handling
   * @param {Object}    options   Options tp start the process
   *        * modulePath      {String}    Absolute path to the module to fork
   *        * logger          {Object}    Logger
   *        * events          {Function}  Events Emitter instance
   * @return {ProcessLauncher}    The ProcessLauncher instance
   */
  constructor(options) {
    this.name = options.name || path.basename(options.modulePath);

    if (this._isDebug()) {
      const childOptions = {stdio: 'pipe', execArgv: ['--inspect-brk=' + (60000 + processCount)]};
      processCount++;
      this.process = child_process.fork(options.modulePath, [], childOptions);
    } else {
      this.process = child_process.fork(options.modulePath);
    }
    this.logger = options.logger;
    this.events = options.events;
    this.silent = options.silent;
    this.exitCallback = options.exitCallback;
    this.embark = options.embark;
    this.logs = [];
    this.processLogsApi = new ProcessLogsApi({embark: this.embark, processName: this.name, silent: this.silent});

    this.subscriptions = {};
    this._subscribeToMessages();
  }

  _isDebug() {
    const argvString= process.execArgv.join();
    return argvString.includes('--debug') || argvString.includes('--inspect');
  }

  // Subscribes to messages from the child process and delegates to the right methods
  _subscribeToMessages() {
    const self = this;
    this.process.on('message', (msg) => {
      if (msg.error) {
        self.logger.error(msg.error);
      }
      if (msg.result === constants.process.log) {
        return self.processLogsApi.logHandler.handleLog(msg);
      }
      if (msg.event) {
        return self._handleEvent(msg);
      }
      self._checkSubscriptions(msg);
    });

    this.process.on('exit', (code) => {
      if (self.exitCallback) {
        return self.exitCallback(code);
      }
      if (code) {
        self.logger.info(`Child Process ${this.name} exited with code ${code}`);
      }
    });
  }

  // Handle event calls from the child process
  _handleEvent(msg) {
    const self = this;
    if (!self.events[msg.event]) {
      self.logger.warn('Unknown event method called: ' + msg.event);
      return;
    }
    if (!msg.args || !Array.isArray(msg.args)) {
      msg.args = [];
    }
    // Add callback in the args
    msg.args.push((result) => {
      self.process.send({
        event: constants.process.events.response,
        result,
        eventId: msg.eventId
      });
    });
    self.events[msg.event](msg.requestName, ...msg.args);
  }

  // Looks at the subscriptions to see if there is a callback to call
  _checkSubscriptions(msg) {
    const messageKeys = Object.keys(msg);
    const subscriptionsKeys = Object.keys(this.subscriptions);
    let subscriptionsForKey;
    let messageKey;
    // Find if the message contains a key that we are subscribed to
    messageKeys.some(_messageKey => {
      return subscriptionsKeys.some(subscriptionKey => {
        if (_messageKey === subscriptionKey) {
          subscriptionsForKey = this.subscriptions[subscriptionKey];
          messageKey = _messageKey;
          return true;
        }
        return false;
      });
    });

    if (subscriptionsForKey) {
      // Find if we are subscribed to one of the values
      let subsIndex = [];
      const subscriptionsForValue = subscriptionsForKey.filter((sub, index) => {
        if (msg[messageKey] === sub.value) {
          subsIndex.push(index);
          return true;
        }
        return false;
      });

      if (subscriptionsForValue.length) {
        // We are subscribed to that message, call the callback
        subscriptionsForValue.forEach((subscription, index) => {
          subscription.callback(msg);

          if (subscription.once) {
            // Called only once, we can remove it
            subscription = null;
            this.subscriptions[messageKey].splice(subsIndex[index], 1);
          }
        });
      }
    }
  }

  /**
   * Subscribe to a message using a key-value pair
   * @param {String}    key       Message key to subscribe to
   * @param {String}    value     Value that the above key must have for the callback to be called
   * @param {Function}  callback  callback(response)
   * @return {void}
   */
  on(key, value, callback) {
    if (this.subscriptions[key]) {
      this.subscriptions[key].push({value, callback});
      return;
    }
    this.subscriptions[key] = [{value, callback}];
  }

  /**
   * Same as .on, but only triggers once
   * @param {String}    key       Message key to subscribe to
   * @param {String}    value     Value that the above key must have for the callback to be called
   * @param {Function}  callback  callback(response)
   * @return {void}
   */
  once(key, value, callback) {
    const obj = {value, callback, once: true};
    if (this.subscriptions[key]) {
      this.subscriptions[key].push(obj);
      return;
    }
    this.subscriptions[key] = [obj];
  }

  /**
   * Unsubscribes from a previously subscribed key-value pair (or key if no value)
   * @param {String}  key     Message key to unsubscribe
   * @param {String}  value   [Optional] Value of the key to unsubscribe
   *                            If there is no value, unsubscribes from all the values of that key
   * @return {void}
   */
  unsubscribeTo(key, value) {
    if (!value) {
      this.subscriptions[key] = [];
    }
    if (this.subscriptions[key]) {
      this.subscriptions[key].filter((val, index) => {
        if (val.value === value) {
          this.subscriptions[key].splice(index, 1);
        }
      });
    }
  }

  /**
   * Unsubscribes from all subscriptions
   * @return {void}
   */
  unsubscribeToAll() {
    this.subscriptions = {};
  }

  /**
   * Sends a message to the child process. Same as ChildProcess.send()
   * @params {Object}   message     Message to send
   * For other parameters, see:
   *  https://nodejs.org/api/child_process.html#child_process_subprocess_send_message_sendhandle_options_callback
   * @return {void}
   */
  send() {
    if (!this.process.connected) {
      return false;
    }
    return this.process.send(...arguments);
  }

  /**
   * Disconnects the child process. It will exit on its own
   * @return {void}
   */
  disconnect() {
    this.process.disconnect();
  }

  /**
   * Kills the child process
   *  https://nodejs.org/api/child_process.html#child_process_subprocess_kill_signal
   * @return {void}
   */
  kill() {
    this.process.kill(...arguments);
  }
}
