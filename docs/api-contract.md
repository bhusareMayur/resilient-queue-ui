# REST API Contract: ResilientQueue Admin Dashboard

**Target Package**: `@mayurbhusare/resilient-queue-ui`  
**Core Library Version**: `@mayurbhusare/resilient-queue` v2.0.2  
**Specification Version**: `1.1.0-milestone1`  
**Scope**: Read-Only Dashboard API (Milestone 1)

---

## Table of Contents

- [1. Overview & Architecture](#1-overview--architecture)
- [2. Queue Registry & Instance Supply](#2-queue-registry--instance-supply)
- [3. Security & Access Control](#3-security--access-control)
- [4. Protocol & Error Handling](#4-protocol--error-handling)
- [5. Endpoints Specification](#5-endpoints-specification)
  - [5.1 `GET /api/queues`](#51-get-apiqueues)
  - [5.2 `GET /api/queues/:queueName/metrics`](#52-get-apiqueuesqueuenamemetrics)
  - [5.3 `GET /api/queues/:queueName/dlq`](#53-get-apiqueuesqueuenamedlq)
  - [5.4 `GET /api/queues/:queueName/jobs/:jobId`](#54-get-apiqueuesqueuenamejobsjobid)
- [6. Schema & Type Mapping](#6-schema--type-mapping)
- [7. Package Portability & Import Interface Guidelines](#7-package-portability--import-interface-guidelines)
- [8. Unresolved API Questions & Limitations](#8-unresolved-api-questions--limitations)

---

## 1. Overview & Architecture

This document specifies a framework-independent REST API contract for a standalone, read-only administration dashboard.

The contract is designed exclusively around verified, tested public methods exposed by `ResilientQueue`:
1. `queue.getMetrics()`
2. `queue.isPaused(options?)`
3. `queue.getDLQ(options?)`
4. `queue.getJob(id)`

### Framework Independence

The endpoints described herein represent pure request-to-response contracts. The HTTP layer will decouple framework-specific HTTP adapters from the dashboard dispatchers:

```
[HTTP Request] 
  --> [Adapter (Express / Fastify / Next.js / Koa)] 
  --> [Dashboard Controller / Dispatcher] 
  --> [ResilientQueue Public Package Interface] 
  --> [JSON Response]
```

No mutation operations (pause, resume, retry, purge, delete) are permitted in Milestone 1.

---

## 2. Queue Registry & Instance Supply

### Lack of Automatic Discovery

`ResilientQueue` instances connect independently to Redis and namespace their keys using a configured `keyPrefix` (default: `"rq"`). There is no central registry, metadata key, or automatic queue discovery mechanism in Redis.

Therefore, host applications must explicitly register their queue instances with the dashboard adapter at setup time.

### Proposed Adapter Configuration Interface

```typescript
export interface RegisteredQueueEntry {
  /**
   * Explicit, unique display and routing name for the queue.
   * Used as the :queueName path parameter in the API.
   */
  name: string;

  /**
   * An active instance of ResilientQueue.
   */
  queue: ResilientQueue;
}

export interface DashboardAdapterOptions {
  /**
   * Explicit list or dictionary of ResilientQueue instances supplied by the host application.
   * Every queue MUST be assigned an explicit name. The adapter never guesses or auto-discovers names.
   */
  queues: Record<string, ResilientQueue> | Map<string, ResilientQueue> | RegisteredQueueEntry[];

  /**
   * Optional base path prefix for all dashboard routes.
   * @default ""
   * @example "/admin/queues"
   */
  basePath?: string;

  /**
   * Whether isPaused() queries should inspect only local memory instead of Redis.
   * @default false (queries Redis key for distributed accuracy)
   */
  localOnlyPaused?: boolean;
}
```

### Registry Normalization & Isolation Rules

When initializing the adapter:
1. **Explicit Registration Only**: `GET /api/queues` enumerates **only** the queues that were explicitly supplied in `options.queues`. The adapter will never auto-discover or introspect Redis for un-registered queues.
2. **Key Normalization**:
   - **`Record<string, ResilientQueue>`**: The dictionary key becomes the explicit `:queueName` URL slug.
   - **`Map<string, ResilientQueue>`**: The map key becomes the explicit `:queueName` URL slug.
   - **`RegisteredQueueEntry[]`**: Each item's `entry.name` becomes the explicit `:queueName` URL slug.
3. **Collision Rejection**: If duplicate queue names are registered, adapter initialization must throw an error immediately.
4. **Lookup Handling**: Incoming requests matching `:queueName` are validated against this in-memory registry. If the slug does not exist in the explicit registry, a `404 Not Found` response is returned immediately.

---

## 3. Security & Access Control

### Sensitive Data Warning

> [!WARNING]
> Job payloads (`job.data`), execution results (`job.result` / `job.returnValue`), and failure diagnostics (`job.failureReason` / `job.lastError`) frequently contain sensitive business data, personally identifiable information (PII), user tokens, or internal system details.

### Host-Application Protection Requirement

1. **No Embedded Authentication**: The `@mayurbhusare/resilient-queue-ui` dashboard adapter is deliberately unauthenticated at the library level to avoid enforcing specific auth frameworks.
2. **Mandatory Host Auth Barrier**: Host applications **MUST** mount dashboard routes behind appropriate authentication and authorization (role-based access control / RBAC) middleware (e.g. session auth, JWT verification, OAuth2 reverse proxy, or API gateway protection).
3. **No Unprotected Public Exposure**: Dashboard endpoints must never be exposed unauthenticated to the public internet.

---

## 4. Protocol & Error Handling

### HTTP Status Codes

| Code | Meaning | Condition |
| :---: | :--- | :--- |
| `200` | OK | Successful query and data retrieval. |
| `400` | Bad Request | Parameter validation failed (e.g. negative `start`, non-integer `limit`, invalid `order`, empty `jobId`). |
| `404` | Not Found | Requested `queueName` is not in the explicit registry, or `jobId` does not exist or has expired. |
| `500` | Internal Server Error | Unhandled Redis command failure or pipeline execution error. |
| `503` | Service Unavailable | Target `ResilientQueue` instance is closed (`queue.close()` was executed). |

### Closed Queue Detection Mechanism

When `queue.close()` is invoked on a `ResilientQueue` instance:
- In the core implementation, calling `queue.getMetrics()` or `queue.getJob(id)` throws an explicit `Error("Queue is closed")`.
- Additionally, `queue.close()` sets the runtime boolean flag `this.isClosed = true`. Note that `isClosed` is an internal runtime property of `ResilientQueue` and is currently not declared in `index.d.ts`.
- **Adapter Detection Strategy**:
  1. The adapter checks `Boolean((queue as any).isClosed)`. If `true`, it immediately responds with `503 Service Unavailable`.
  2. As a defense-in-depth safeguard, if `queue.getMetrics()` or `queue.getJob()` throws an error matching `/Queue is closed/i`, the adapter catches it and converts it to a `503 Service Unavailable` response.

### Standard Error Response Shape

All non-2xx responses MUST adhere to this uniform JSON envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "start must be a non-negative integer",
    "details": null
  }
}
```

Standard error codes:
- `QUEUE_NOT_FOUND`: The `:queueName` slug is not present in the explicit adapter registry.
- `JOB_NOT_FOUND`: The `:jobId` was not found in Redis or expired according to retention policy.
- `VALIDATION_ERROR`: One or more path/query parameters failed validation.
- `QUEUE_CLOSED`: The queue instance has been closed via `queue.close()`.
- `INTERNAL_ERROR`: Unexpected internal exception or Redis connection failure.

---

## 5. Endpoints Specification

### 5.1 `GET /api/queues`

Returns a list of all explicitly registered queues, their current pause state, and a real-time metrics summary. Internal implementation details such as `keyPrefix` are omitted.

- **HTTP Method**: `GET`
- **Route**: `/api/queues`
- **Core Library Methods**:
  - `queue.isPaused({ localOnly: options.localOnlyPaused })`
  - `queue.getMetrics()`
- **Parameters**: None.

#### Example Response (`200 OK`)

```json
{
  "queues": [
    {
      "name": "email-notifications",
      "isPaused": false,
      "metrics": {
        "waiting": 142,
        "active": 8,
        "delayed": 23,
        "dlq": 3
      }
    },
    {
      "name": "video-transcoding",
      "isPaused": true,
      "metrics": {
        "waiting": 0,
        "active": 0,
        "delayed": 0,
        "dlq": 12
      }
    }
  ]
}
```

#### Error Responses

- **`500 Internal Server Error`**:
  ```json
  {
    "error": {
      "code": "INTERNAL_ERROR",
      "message": "Redis command timed out",
      "details": null
    }
  }
  ```

---

### 5.2 `GET /api/queues/:queueName/metrics`

Retrieves instantaneous job metrics and paused status for a single specified queue. Internal Redis key details are omitted.

- **HTTP Method**: `GET`
- **Route**: `/api/queues/:queueName/metrics`
- **Core Library Methods**:
  - `queue.isPaused({ localOnly: options.localOnlyPaused })`
  - `queue.getMetrics()`
- **Parameters**:
  - `queueName` (`string`, path parameter, required): The explicitly registered queue identifier.

#### Example Response (`200 OK`)

```json
{
  "queue": "email-notifications",
  "isPaused": false,
  "metrics": {
    "waiting": 142,
    "active": 8,
    "delayed": 23,
    "dlq": 3
  }
}
```

#### Error Responses

- **`404 Not Found`** (Queue not registered):
  ```json
  {
    "error": {
      "code": "QUEUE_NOT_FOUND",
      "message": "Queue 'unknown-queue' is not registered with the dashboard adapter",
      "details": null
    }
  }
  ```
- **`503 Service Unavailable`** (Queue closed):
  ```json
  {
    "error": {
      "code": "QUEUE_CLOSED",
      "message": "Queue is closed",
      "details": null
    }
  }
  ```

---

### 5.3 `GET /api/queues/:queueName/dlq`

Retrieves a paginated list of failed jobs from the Dead-Letter Queue (DLQ), including failure diagnostics and corrupted entry detection.

- **HTTP Method**: `GET`
- **Route**: `/api/queues/:queueName/dlq`
- **Core Library Method**:
  - `queue.getDLQ(options)`
- **Path Parameters**:
  - `queueName` (`string`, required): The explicitly registered queue identifier.
- **Query Parameters**:

| Parameter | Type | Default | Validation Rules (matches core library) |
| :--- | :---: | :---: | :--- |
| `start` | `integer` | `0` | Must be an integer >= 0. Rejects negative numbers, non-numeric strings, or floats. |
| `limit` | `integer` | `50` | Must be an integer >= 0. Rejects negative numbers, non-numeric strings, or floats. |
| `order` | `string` | `"asc"` | Case-insensitive. Must be either `"asc"` or `"desc"`. |

#### Example Response (`200 OK`)

```json
{
  "queue": "email-notifications",
  "total": 3,
  "start": 0,
  "limit": 50,
  "order": "desc",
  "jobs": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "data": {
        "to": "user@example.com",
        "template": "welcome"
      },
      "attempt": 4,
      "stalledCount": 0,
      "createdAt": 1776500000000,
      "failedAt": 1776500030000,
      "failureReason": "SMTP 550: User unknown",
      "lastError": "SMTP 550: User unknown",
      "retriedAt": 1776500025000
    },
    {
      "id": "custom-task-batch-92",
      "data": {
        "to": "invalid@domain",
        "template": "reset"
      },
      "attempt": 1,
      "stalledCount": 2,
      "createdAt": 1776499800000,
      "failedAt": 1776499900000,
      "lastStalledAt": 1776499895000,
      "failureReason": "Stalled more than maxStalledCount"
    },
    {
      "id": null,
      "raw": "{\"corrupted_json_payload...",
      "corrupted": true,
      "error": "Unexpected end of JSON input"
    }
  ]
}
```

#### Error Responses

- **`400 Bad Request`** (Invalid query parameters):
  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "order must be \"asc\" or \"desc\"",
      "details": {
        "parameter": "order",
        "value": "alphabetical"
      }
    }
  }
  ```
- **`404 Not Found`** (Queue not registered):
  ```json
  {
    "error": {
      "code": "QUEUE_NOT_FOUND",
      "message": "Queue 'billing-queue' is not registered with the dashboard adapter",
      "details": null
    }
  }
  ```

---

### 5.4 `GET /api/queues/:queueName/jobs/:jobId`

Retrieves the persisted job descriptor, current execution state, progress percentage, timestamps, payload, and result/error by unique job ID.

- **HTTP Method**: `GET`
- **Route**: `/api/queues/:queueName/jobs/:jobId`
- **Core Library Method**:
  - `queue.getJob(jobId)`
- **Path Parameters**:
  - `queueName` (`string`, required): The explicitly registered queue identifier.
  - `jobId` (`string`, required): The job ID string.
- **Validation Rules for `jobId`**:
  - Must be a non-empty string (`typeof jobId === "string" && jobId.trim().length > 0`).
  - **Do NOT assume UUID v4 format**: The core library accepts any valid string or number as a job identifier (e.g. custom idempotency keys or application-defined identifiers). Non-UUID string IDs must be handled transparently.

#### Example Response (`200 OK`)

```json
{
  "queue": "email-notifications",
  "job": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "data": {
      "to": "user@example.com",
      "template": "welcome"
    },
    "state": "completed",
    "progress": 100,
    "attempt": 0,
    "stalledCount": 0,
    "createdAt": 1776500000000,
    "startedAt": 1776500001000,
    "completedAt": 1776500002500,
    "result": {
      "messageId": "<abc-123@smtp.example.com>",
      "accepted": true
    },
    "returnValue": {
      "messageId": "<abc-123@smtp.example.com>",
      "accepted": true
    },
    "idempotencyKey": "welcome-user-123",
    "ttlSeconds": 86400,
    "removeOnComplete": {
      "age": 86400,
      "count": 5000
    }
  }
}
```

#### Example Response for Active Job with Progress (`200 OK`)

```json
{
  "queue": "video-transcoding",
  "job": {
    "id": "custom-video-render-job-001",
    "data": {
      "source": "s3://bucket/input.mp4",
      "resolution": "1080p"
    },
    "state": "active",
    "progress": 65,
    "attempt": 0,
    "stalledCount": 0,
    "createdAt": 1776501000000,
    "startedAt": 1776501002000
  }
}
```

#### Error Responses

- **`404 Not Found`** (Job missing or expired):
  ```json
  {
    "error": {
      "code": "JOB_NOT_FOUND",
      "message": "Job 'custom-video-render-job-001' not found or expired under retention policy",
      "details": null
    }
  }
  ```
- **`400 Bad Request`** (Missing or empty job ID):
  ```json
  {
    "error": {
      "code": "VALIDATION_ERROR",
      "message": "jobId must be a non-empty string",
      "details": null
    }
  }
  ```

---

## 6. Schema & Type Mapping

The JSON payloads map directly to the public TypeScript definitions exported by `@mayurbhusare/resilient-queue`:

| API Schema Field | Core TypeScript Type | Notes |
| :--- | :--- | :--- |
| `metrics` | `QueueMetrics` | `{ waiting: number, active: number, delayed: number, dlq: number }` |
| `isPaused` | `boolean` | Queried via `queue.isPaused()` |
| `jobs[]` (DLQ) | `DLQJob<T>` | If JSON parsing in Redis fails, returns `{ id: null, raw: string, corrupted: true, error: string }` |
| `job` | `Job<T>` | `job.updateProgress` function is omitted during JSON serialization |
| `job.id` | `string` | Any non-empty string identifier (not strictly UUID v4) |
| `job.state` | `JobState` | `"waiting"` \| `"active"` \| `"delayed"` \| `"completed"` \| `"failed"` |
| `job.progress` | `number` | Integer or float between `0` and `100` |
| `job.removeOnComplete` | `RetentionOption` | `boolean` \| `number` \| `{ age?: number, count?: number }` |
| `job.removeOnFail` | `RetentionOption` | `boolean` \| `number` \| `{ age?: number, count?: number }` |

---

## 7. Package Portability & Import Interface Guidelines

To ensure the contents of `Frontend/` can be published cleanly as `@mayurbhusare/resilient-queue-ui` in an independent repository:

1. **Strict Public Package Imports Only**:
   - The UI package MUST import classes and types exclusively through the published package interface:
     ```typescript
     import { ResilientQueue } from "@mayurbhusare/resilient-queue";
     import type { Job, DLQJob, QueueMetrics, JobState, RetentionOption } from "@mayurbhusare/resilient-queue";
     ```
   - **Forbidden**: Never use relative path traversal (`../../src/...`) or internal submodule imports (`@mayurbhusare/resilient-queue/src/...`).
2. **Dependency Declaration**:
   - `@mayurbhusare/resilient-queue` must be declared as a `peerDependency` (and `devDependency` for local testing) in `Frontend/package.json`.
3. **Framework-Agnostic Core**:
   - The adapter handlers must take standard plain-JS parameters:
     ```typescript
     export function handleGetMetrics(queue: ResilientQueue): Promise<QueueMetricsResponse>;
     export function handleGetDLQ(queue: ResilientQueue, query: DLQQueryParams): Promise<DLQResponse>;
     export function handleGetJob(queue: ResilientQueue, jobId: string): Promise<JobResponse>;
     ```
   - Framework wrappers (e.g. Express middleware, Fastify plugins) simply adapt `req` parameters into these pure handler calls.
4. **No Root-Level Coupling**:
   - Do not rely on root Jest configurations, root dependencies, or root npm scripts.

---

## 8. Unresolved API Questions & Limitations

The following limitations and open questions in the core library affect dashboard capabilities:

1. **No Non-DLQ Job Pagination or Listing**:
   - While `queue.getDLQ(options)` allows listing failed jobs, there is **no public method** to list jobs in `"waiting"`, `"active"`, `"delayed"`, or `"completed"` states.
   - *Impact*: In Milestone 1, the dashboard cannot display a table of currently waiting, active, or completed jobs. Users can only look up specific non-DLQ jobs if they know the `jobId`.
2. **Missing `completed` and `failed` Metrics in `getMetrics()`**:
   - `getMetrics()` returns `{ waiting, active, delayed, dlq }`. It does not report total counts from the `<keyPrefix>:completed` or `<keyPrefix>:failed` sorted sets.
   - *Impact*: Total completed job counts cannot be displayed without querying Redis sorted sets directly.
3. **Completed Job Retention Eviction**:
   - If a queue does not configure `removeOnComplete` (or sets `removeOnComplete: true` / count: 0), completed jobs are deleted immediately from Redis.
   - *Impact*: `GET /api/queues/:queueName/jobs/:jobId` will return `404 Not Found` for completed jobs once evicted.
4. **No Real-Time Event Push / WebSocket in Milestone 1**:
   - `ResilientQueue` emits events locally via Node.js `EventEmitter`. In distributed deployments, events occurring on remote worker processes are not broadcast via Redis Pub/Sub.
   - *Impact*: Milestone 1 dashboard must rely on periodic polling of `getMetrics()` and `getDLQ()`. Real-time event streaming would require adding a Redis Pub/Sub layer in the core library.
5. **No Queue Mutation Controls**:
   - `pause()`, `resume()`, `retryDLQJob()`, `retryAllDLQ()`, and `purgeDLQ()` are intentionally excluded from this read-only contract. A separate mutation contract will be created for Milestone 2.
