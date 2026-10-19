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

### Runtime & Peer Dependency Requirements

| Requirement | Supported Version Range |
| :--- | :--- |
| **Node.js** | `>=18.0.0` (LTS 18, 20, 22) |
| [`@mayurbhusare/resilient-queue`](https://www.npmjs.com/package/@mayurbhusare/resilient-queue) | `^2.0.0` |

---

## Integration Examples

The package is designed with a decoupled architecture where core dashboard dispatchers are wrapped by lightweight framework adapters.

### 1. Express Integration

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

### 2. Fastify Integration

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
  - **Queue Overview**: Consumes `GET /api/queues` with real-time aggregate telemetry cards, paused/active/closed/unavailable/error badges, client-side search and status filtering, multi-column sorting (with strict non-zero distinction for unavailable metrics), direct row-level navigation to DLQ Explorer and Job Inspector, and configurable background polling.
  - **Dead Letter Queue (DLQ) Explorer**: Read-only browser for dead-letter jobs with pagination, sort order toggle, corrupted JSON resilience, failure diagnostics, payload inspection, and cross-linking to Job Inspector.
  - **Job Inspector**: Comprehensive job inspection view supporting lookups by queue and job ID (`GET /api/queues/:queueName/jobs/:jobId`), displaying execution state badges, progress bar, lifecycle timestamps, failure diagnostics, input data payloads, and return values.
- **Operational Diagnostics**: Actionable, structured guidance for known API error codes (`QUEUE_CLOSED`, `QUEUE_NOT_FOUND`, `JOB_NOT_FOUND`, `NOT_SUPPORTED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`), clearly distinguishing core library version compatibility disclosures from missing queues, closed queue instances, and server errors.
- **Robust UI States**: Handles loading spinners, empty states (with server configuration snippets), empty search filter states, and temporary sync failure banners with cached queue retention.
- **Accessibility & Keyboard Usability**:
  - **Full Keyboard Operability**: Complete keyboard accessibility across search filters, sort headers, drawer navigation, and table actions with high-contrast `:focus-visible` focus rings.
  - **Skip to Main Content**: Accessible skip link (`#content-container`) enables assistive technology users to bypass repetitive navigation.
  - **Discrete Screen-Reader Announcements**: Dedicated polite ARIA live announcer (`#live-announcer`) provides non-intrusive status updates during navigation and metric refreshes without DOM chattering.
  - **Color-Independent Status**: Badges pair semantic colors with distinct visual glyphs (`●`, `⏸`, `■`, `⚠️`, `—`) and explicit ARIA labels so status is never conveyed by color alone.
  - **Mobile Drawer Usability**: Includes focus trapping inside the mobile navigation menu, backdrop tap-to-dismiss, and Escape key dismissal with focus restoration to the trigger button.
  - **Focus & Cursor Preservation**: Preserves active focus, input text, and cursor selection ranges across background metric auto-refresh cycles.
  - **Reduced Motion Support**: Honored via `@media (prefers-reduced-motion: reduce)` to freeze animated spinners and disable non-essential transitions.
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

1. **No Built-in Authentication or Authorization**: The package provides zero built-in authentication, user models, or permission schemes. Host applications **must** guard both static UI routes and `/api/*` endpoints with authentication middleware.
2. **Apply Authentication Barriers**: Protect all dashboard routes behind your application's existing authentication stack (e.g., Express sessions/JWT, Fastify `preHandler` hooks, or reverse-proxy authentication such as OAuth2-Proxy / Cloudflare Access / AWS ALB).
3. **Queue-Level Authorization**: If different teams or tenants share the same service, apply queue-level authorization in host middleware to restrict specific queues by user role.
4. **CORS is NOT Authentication**: Permissive CORS headers (e.g. `Access-Control-Allow-Origin: *`) do **not** protect or authenticate endpoints. Never enable unauthenticated cross-origin access to dashboard routes.
5. **Caching Protection**: All API endpoints emit `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` to prevent proxy or browser caching of sensitive job data.
6. **Credential Redaction**: Internal Redis and database connection URIs (e.g., `redis://user:pass@host:port`) and auth tokens in 500 internal error responses are automatically scrubbed and redacted to `[redacted]`.
7. **Never Expose Publicly**: Never mount `@mayurbhusare/resilient-queue-ui` routes on an unauthenticated, publicly accessible endpoint. Bind management processes to private VPC networks or loopback interfaces where possible.

For full architectural details, threat models, Express and Fastify integration patterns, and the production checklist, see the [Security Guide (docs/security.md)](./docs/security.md) and runnable [Examples (examples/)](./examples/README.md).

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
