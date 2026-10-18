"use strict";

const http = require("node:http");
const { createExpressAdapter } = require("../src/index");

// Sample queues with live-like metrics for local UI testing (no Redis required)
const adapter = createExpressAdapter({
  queues: {
    "email-notifications": {
      isPaused: async () => false,
      getMetrics: async () => ({ waiting: 142, active: 8, delayed: 23, dlq: 3 }),
      getDLQ: async () => ({ total: 3, jobs: [] })
    },
    "video-transcoding": {
      isPaused: async () => true,
      getMetrics: async () => ({ waiting: 0, active: 0, delayed: 0, dlq: 12 }),
      getDLQ: async () => ({ total: 12, jobs: [] })
    },
    "order-processing": {
      isPaused: async () => false,
      getMetrics: async () => ({ waiting: 35, active: 4, delayed: 2, dlq: 0 }),
      getDLQ: async () => ({ total: 0, jobs: [] })
    }
  }
});

const server = http.createServer(adapter);
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(` ResilientQueue Dashboard UI is running!`);
  console.log(` Open in your browser: http://localhost:${PORT}/`);
  console.log(` REST API available:   http://localhost:${PORT}/api/queues`);
  console.log(` Press Ctrl+C to stop.`);
  console.log(`======================================================\n`);
});
