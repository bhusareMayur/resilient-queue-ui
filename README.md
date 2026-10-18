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

[MIT](./LICENSE) &copy; 2026 Mayur S. Bhusare
