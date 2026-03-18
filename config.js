"use strict";

const required = ["BOT_TOKEN", "TELEGRAM_API", "TELEGRAM_FILE_API", "TARGET_API"];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required ENV variable: ${key}`);
  }
}

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "telegram-secret",
  PORT: Number(process.env.PORT || 3000),
  TELEGRAM_API: process.env.TELEGRAM_API,
  TELEGRAM_FILE_API: process.env.TELEGRAM_FILE_API,
  TARGET_API: process.env.TARGET_API,
};
