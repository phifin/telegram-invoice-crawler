"use strict";

const express = require("express");
const config = require("../config");
const logger = require("../logger");
const webhookRouter = require("./routes/webhook");

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(webhookRouter);

app.listen(config.PORT, () => {
  logger.info(`Server running on port ${config.PORT}`);
  logger.info(`Webhook path: /telegram/webhook/${config.WEBHOOK_SECRET}`);
});
