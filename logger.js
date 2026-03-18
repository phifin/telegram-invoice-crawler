"use strict";

function prefix() {
  return new Date().toISOString() + " -";
}

module.exports = {
  info(...args) {
    console.log(prefix(), "[INFO]", ...args);
  },
  warn(...args) {
    console.warn(prefix(), "[WARN]", ...args);
  },
  error(...args) {
    console.error(prefix(), "[ERROR]", ...args);
  },
};
