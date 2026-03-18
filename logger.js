"use strict";

function prefix() {
  return new Date().toISOString() + " -";
}

module.exports = {
  debug(...args) {
    if (process.env.DEBUG_LOGS === "true") {
      console.log(prefix(), "[DEBUG]", ...args);
    }
  },
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
