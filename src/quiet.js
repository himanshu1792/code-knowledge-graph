// Suppress the benign "SQLite is an experimental feature" ExperimentalWarning
// emitted by node:sqlite, so CLI output stays clean. Import this first.
const origEmit = process.emit;
process.emit = function emit(name, data, ...rest) {
  if (name === 'warning' && data && data.name === 'ExperimentalWarning' && /SQLite/.test(data.message)) {
    return false;
  }
  return origEmit.call(this, name, data, ...rest);
};
