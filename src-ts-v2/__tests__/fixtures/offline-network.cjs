const { Socket } = require('node:net');

function denyNetwork() {
  process.exitCode = 1;
  throw new Error('Network access during offline demo');
}

globalThis.fetch = denyNetwork;
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  // tsx uses a local IPC pipe to communicate with its parent process.
  const [options] = Array.isArray(args[0]) ? args[0] : args;
  if (options?.path && options.port == null) {
    return connect.apply(this, args);
  }
  return denyNetwork();
};
