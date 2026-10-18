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
      },
      getJob: async (jobId) => {
        const mockDatabase = {
          "job-email-8492": {
            id: "job-email-8492",
            state: "failed",
            progress: 100,
            attempt: 3,
            stalledCount: 1,
            createdAt: Date.now() - 3600000,
            startedAt: Date.now() - 3500000,
            failedAt: Date.now() - 1800000,
            retriedAt: Date.now() - 2000000,
            failureReason: "SMTPConnectionError: Connection to smtp.sendgrid.net timed out after 30000ms",
            idempotencyKey: "idem-email-8492",
            delay: 0,
            ttlSeconds: 86400,
            removeOnComplete: true,
            removeOnFail: false,
            data: { to: "sarah.connor@example.com", template: "welcome_onboarding", campaignId: "camp_892" },
            returnValue: null
          },
          "job-email-9001": {
            id: "job-email-9001",
            state: "active",
            progress: 68,
            attempt: 1,
            stalledCount: 0,
            createdAt: Date.now() - 120000,
            startedAt: Date.now() - 60000,
            failedAt: null,
            retriedAt: null,
            failureReason: null,
            idempotencyKey: null,
            delay: 0,
            ttlSeconds: null,
            removeOnComplete: true,
            removeOnFail: false,
            data: { to: "newsletter-subscribers@example.com", batchId: "b_4021", count: 1250 },
            returnValue: null
          }
        };
        return mockDatabase[jobId] || null;
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
      // Note: video-transcoding intentionally omits getJob() to test the 501 NOT_SUPPORTED compatibility warning!
    },
    "order-processing": {
      isPaused: async () => false,
      getMetrics: async () => ({ waiting: 35, active: 4, delayed: 2, dlq: 0 }),
      getDLQ: async () => ({ total: 0, jobs: [] }),
      getJob: async (jobId) => {
        if (jobId === "ord-checkout-771") {
          return {
            id: "ord-checkout-771",
            state: "completed",
            progress: 100,
            attempt: 1,
            stalledCount: 0,
            createdAt: Date.now() - 900000,
            startedAt: Date.now() - 850000,
            completedAt: Date.now() - 800000,
            failedAt: null,
            retriedAt: null,
            failureReason: null,
            idempotencyKey: "checkout-token-xyz99",
            delay: 0,
            ttlSeconds: 604800,
            removeOnComplete: false,
            removeOnFail: false,
            data: { customerId: "cust_99182", cartItems: 3, totalAmount: 49.99 },
            returnValue: { status: "PAID", transactionId: "ch_3NabcXYZ123", receiptSent: true }
          };
        }
        return null;
      }
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
