"use strict";

const http = require("node:http");
const { createExpressAdapter } = require("../src/index");

// Sample queues with live-like metrics & DLQ payloads for local UI testing (no Redis required)
const adapter = createExpressAdapter({
  queues: {
    "email-notifications": {
      isPaused: async () => false,
      getMetrics: async () => ({ waiting: 142, active: 8, delayed: 23, dlq: 3 }),
      getDLQ: async ({ start = 0, limit = 50, order = "asc" } = {}) => {
        const allJobs = [
          {
            id: "job-email-8492",
            attempt: 3,
            stalledCount: 1,
            createdAt: Date.now() - 3600000,
            failedAt: Date.now() - 1800000,
            retriedAt: Date.now() - 2000000,
            failureReason: "SMTPConnectionError: Connection to smtp.sendgrid.net timed out after 30000ms",
            data: { to: "sarah.connor@example.com", template: "welcome_onboarding", campaignId: "camp_892" }
          },
          {
            id: "job-email-8493",
            attempt: 3,
            stalledCount: 0,
            createdAt: Date.now() - 7200000,
            failedAt: Date.now() - 3600000,
            retriedAt: Date.now() - 4000000,
            failureReason: "RecipientMailboxFullError: 552 5.2.2 Mailbox is full / quota exceeded",
            data: { to: "john.doe@example.org", template: "invoice_receipt", invoiceId: "inv_9044" }
          },
          {
            id: null,
            corrupted: true,
            raw: '{"id": "corrupted-entry", "data": broken_json_payload',
            error: "SyntaxError: Unexpected token 'b', \"broken_jso\"... is not valid JSON"
          }
        ];
        const sorted = order === "desc" ? [...allJobs].reverse() : allJobs;
        const paged = sorted.slice(start, start + limit);
        return { total: allJobs.length, jobs: paged };
      }
    },
    "video-transcoding": {
      isPaused: async () => true,
      getMetrics: async () => ({ waiting: 0, active: 0, delayed: 0, dlq: 2 }),
      getDLQ: async ({ start = 0, limit = 50, order = "asc" } = {}) => {
        const allJobs = [
          {
            id: "job-video-102",
            attempt: 5,
            stalledCount: 3,
            createdAt: Date.now() - 10000000,
            failedAt: Date.now() - 500000,
            retriedAt: Date.now() - 600000,
            failureReason: "FFmpegError: Codec not supported or damaged bitstream in chunk_4.mp4",
            data: { resolution: "4k", format: "h265", sourceUri: "s3://media/raw/vid_102.mov" }
          },
          {
            id: "job-video-103",
            attempt: 2,
            stalledCount: 0,
            createdAt: Date.now() - 5000000,
            failedAt: Date.now() - 400000,
            retriedAt: null,
            failureReason: "DiskQuotaExceededError: ENOSPC: no space left on device, write '/tmp/ffmpeg_temp'",
            data: { resolution: "1080p", format: "webm", sourceUri: "s3://media/raw/vid_103.mp4" }
          }
        ];
        const sorted = order === "desc" ? [...allJobs].reverse() : allJobs;
        const paged = sorted.slice(start, start + limit);
        return { total: allJobs.length, jobs: paged };
      }
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

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Error: Port ${PORT} is already in use by another process.`);
    console.log(`💡 To resolve this:`);
    console.log(`   1) Specify a different port:`);
    console.log(`      $env:PORT=3001; npm run dev   (PowerShell)`);
    console.log(`      PORT=3001 npm run dev         (Bash/Zsh)`);
    console.log(`   2) Or terminate the process currently using port ${PORT}:`);
    console.log(`      Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess -Force\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(` ResilientQueue Dashboard UI is running!`);
  console.log(` Open in your browser: http://localhost:${PORT}/`);
  console.log(` REST API available:   http://localhost:${PORT}/api/queues`);
  console.log(` Press Ctrl+C to stop.`);
  console.log(`======================================================\n`);
});
