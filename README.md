# @mayurbhusare/resilient-queue-ui

An administration dashboard and REST API adapter for [`@mayurbhusare/resilient-queue`](https://www.npmjs.com/package/@mayurbhusare/resilient-queue).

Provides real-time queue observability, metrics inspection, Dead-Letter Queue (DLQ) exploration, and deep job diagnostics with zero framework lock-in.

---

## Features

- **Real-Time Queue Telemetry**: Inspect waiting, active, delayed, and dead-letter job counts in real time via atomic queue metrics.
- **Dead-Letter Queue (DLQ) Explorer**: Browse and inspect failed jobs, complete with failure reasons, retry counts, stall metadata, and corrupted JSON resilience.
- **Deep Job Diagnostics**: Search and inspect individual job descriptors by ID, displaying execution progress (0–100%), timestamps, data payloads, and return values.
- **Framework-Agnostic Adapters**: Mount the dashboard seamlessly into existing **Express** or **Fastify** applications, or run it as a standalone monitoring server.
- **Distributed Safety**: Supports multi-queue configurations and distributed Redis deployments without requiring invasive hooks in worker processes.

---

## Installation

Install `@mayurbhusare/resilient-queue-ui` alongside its peer dependency, `@mayurbhusare/resilient-queue`:

```bash
# npm
npm install @mayurbhusare/resilient-queue-ui @mayurbhusare/resilient-queue

# yarn
yarn add @mayurbhusare/resilient-queue-ui @mayurbhusare/resilient-queue

# pnpm
pnpm add @mayurbhusare/resilient-queue-ui @mayurbhusare/resilient-queue
```

### Peer Dependency Requirements

| Package | Supported Version Range |
| :--- | :--- |
| [`@mayurbhusare/resilient-queue`](https://www.npmjs.com/package/@mayurbhusare/resilient-queue) | `^2.0.0` |

---

## Planned Integration Examples

The package is designed with a decoupled architecture where core dashboard dispatchers are wrapped by lightweight framework adapters.

### 1. Express Integration (Planned)

```javascript
const express = require("express");
const { ResilientQueue } = require("@mayurbhusare/resilient-queue");
const { createExpressAdapter } = require("@mayurbhusare/resilient-queue-ui");

const app = express();

const emailQueue = new ResilientQueue({ redisUrl: "redis://127.0.0.1:6379", keyPrefix: "rq:emails" });
const videoQueue = new ResilientQueue({ redisUrl: "redis://127.0.0.1:6379", keyPrefix: "rq:video" });

// Host application authentication (MANDATORY)
app.use("/admin/queues", authMiddleware);

// Mount dashboard UI & REST API
app.use(
  "/admin/queues",
  createExpressAdapter({
    queues: {
      "emails": emailQueue,
      "video-transcoding": videoQueue
    }
  })
);

app.listen(3000, () => {
  console.log("Admin dashboard active at http://localhost:3000/admin/queues");
});
```

### 2. Fastify Integration (Planned)

```javascript
const fastify = require("fastify")();
const { ResilientQueue } = require("@mayurbhusare/resilient-queue");
const { fastifyDashboardPlugin } = require("@mayurbhusare/resilient-queue-ui");

const orderQueue = new ResilientQueue({ redisUrl: "redis://127.0.0.1:6379", keyPrefix: "rq:orders" });

// Register dashboard plugin under a prefix with auth hook
fastify.register(fastifyDashboardPlugin, {
  prefix: "/admin/queues",
  queues: {
    "orders": orderQueue
  },
  preHandler: fastifyAuthHook
});

fastify.listen({ port: 3000 });
```

---

## Dashboard UI & Frontend Architecture

The package includes a built-in, lightweight administration dashboard served directly by the Express and Fastify adapters:

- **Clean, Responsive Layout**: Includes a sidebar navigation area and responsive drawer for mobile devices.
- **Views**:
  - **Queue Overview**: Consumes `GET /api/queues` with real-time aggregate telemetry cards, paused/active badges, and queue metrics table.
  - **Dead Letter Queue (DLQ) Explorer**: Read-only browser for dead-letter jobs with pagination, sort order toggle, corrupted JSON resilience, failure diagnostics, and payload inspection.
  - **Job Inspector**: Comprehensive job inspection view supporting lookups by queue and job ID (`GET /api/queues/:queueName/jobs/:jobId`), displaying execution state badges, progress bar, lifecycle timestamps, failure diagnostics, input data payloads, and return values.
- **Robust UI States**: Handles loading spinners, empty states (with configuration snippet), 404 not found states, and API error states with an interactive "Retry" action.
- **Zero External Frontend Dependencies**: Pure semantic HTML5, modern CSS3 with CSS variables, and modular vanilla JavaScript.

### Reusable Frontend API Client

You can use the frontend API client directly in Node.js, bundlers, or the browser:

```javascript
const { ApiClient, ApiError } = require("@mayurbhusare/resilient-queue-ui");

const client = new ApiClient({
  baseUrl: "http://localhost:3000/admin/queues"
});

// Fetch all registered queues and metrics
const { queues } = await client.getQueues();

// Fetch metrics for a specific queue
const metrics = await client.getQueueMetrics("emails");

// Fetch DLQ entries with pagination
const dlq = await client.getQueueDLQ("emails", { start: 0, limit: 25, order: "desc" });

// Fetch individual job descriptor
const { job } = await client.getJob("emails", "job-123");
```

### Core Compatibility Requirement

> [!NOTE]
> The published `@mayurbhusare/resilient-queue@2.0.2` release does not expose the public `queue.getJob(jobId)` method. When paired with published `@mayurbhusare/resilient-queue@2.0.2`, the dashboard adapter returns `501 NOT_SUPPORTED` and the UI gracefully renders a clear compatibility disclosure notice without crashing. Full live job inspection automatically activates once an updated core release containing `getJob()` is installed.

---

## Testing & Development

Run the complete test suite:

```bash
# Run all tests (unit, integration, and frontend)
npm test

# Run frontend tests (ApiClient and UI views)
npm run test:frontend

# Run unit tests
npm run test:unit

# Run adapter integration tests
npm run test:integration
```

## Security Considerations

> [!CAUTION]
> **Host Authentication & Authorization Required**:  
> Job payloads (`job.data`), execution results (`job.result`), and error diagnostics (`job.failureReason`) may contain sensitive user information, credentials, financial details, or internal system errors.

1. **No Built-in Authentication**: The dashboard package is deliberately unauthenticated to avoid imposing opinions on your application's security stack.
2. **Apply Authentication Barriers**: Always mount the dashboard routes behind your application's existing authentication and role-based access control (RBAC) middleware (e.g., Express Passport/sessions, Fastify JWT, or reverse-proxy authentication like OAuth2-Proxy / Cloudflare Access).
3. **Never Expose Publicly**: Never mount `@mayurbhusare/resilient-queue-ui` routes on an unauthenticated, publicly accessible endpoint.

---

## API Specification

The REST API contract powering the dashboard is detailed in [docs/api-contract.md](./docs/api-contract.md).

---

## Architecture & Portability

- **No Root Coupling**: This package maintains independent dependencies, configuration, and documentation, allowing seamless extraction into a dedicated repository.
- **Strict Public API Usage**: The package interacts with `@mayurbhusare/resilient-queue` exclusively through its published public interface (`import { ResilientQueue } from "@mayurbhusare/resilient-queue"`), avoiding any reliance on internal submodule paths.

---

## License

[MIT](./LICENSE) &copy; 2026 Resilient Queue.
