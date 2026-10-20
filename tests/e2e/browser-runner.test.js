"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { CdpWebSocket, findChromiumPath, isBrowserAvailable, HeadlessBrowserSession } = require("./browser-runner");

describe("CDP WebSocket & Browser Runner Protocol Unit Tests", () => {
  it("should find browser or report status without error", () => {
    const browserPath = findChromiumPath();
    const available = isBrowserAvailable();
    if (browserPath) {
      assert.equal(available, true);
      assert.equal(typeof browserPath, "string");
    } else {
      assert.equal(available, false);
      assert.equal(browserPath, null);
    }
  });

  it("should perform WebSocket handshake and exchange masked messages", async () => {
    let receivedClientFrame = null;
    let upgradedSocket = null;

    const server = http.createServer((req, res) => {
      res.statusCode = 404;
      res.end();
    });

    server.on("upgrade", (req, socket, head) => {
      upgradedSocket = socket;
      const key = req.headers["sec-websocket-key"];
      const accept = crypto
        .createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );

      socket.on("data", (chunk) => {
        receivedClientFrame = chunk;
        // Verify client frame has mask bit set (b1 & 0x80)
        const b1 = chunk[1];
        assert.equal((b1 & 0x80) !== 0, true, "Client frames must be masked");

        // Send response back: unmasked server frame
        const resText = JSON.stringify({ id: 1, result: { success: true } });
        const resPayload = Buffer.from(resText, "utf8");
        const resHeader = Buffer.from([0x81, resPayload.length]);
        socket.write(Buffer.concat([resHeader, resPayload]));
      });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const ws = new CdpWebSocket(`ws://127.0.0.1:${port}/devtools/page/test`);
    try {
      await ws.connect();
      const res = await ws.send("Test.method", { foo: "bar" });
      assert.deepEqual(res, { success: true });
      assert.ok(receivedClientFrame !== null);
    } finally {
      ws.close();
      if (upgradedSocket) {
        try { upgradedSocket.destroy(); } catch {}
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("should handle ping frame and reply with masked pong per RFC 6455", async () => {
    let receivedPong = null;
    let upgradedSocket = null;

    const server = http.createServer();
    server.on("upgrade", (req, socket) => {
      upgradedSocket = socket;
      const key = req.headers["sec-websocket-key"];
      const accept = crypto
        .createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );

      socket.on("data", (chunk) => {
        const opcode = chunk[0] & 0x0f;
        if (opcode === 0x0a) {
          // Pong received!
          receivedPong = chunk;
        }
      });

      // Send ping frame (unmasked from server to client: 0x89 0x00)
      setTimeout(() => {
        socket.write(Buffer.from([0x89, 0x00]));
      }, 50);
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const ws = new CdpWebSocket(`ws://127.0.0.1:${port}/test`);
    try {
      await ws.connect();
      // Wait for pong
      const start = Date.now();
      while (!receivedPong && Date.now() - start < 2000) {
        await new Promise((r) => setTimeout(r, 20));
      }

      assert.ok(receivedPong !== null, "Did not receive pong from client");
      // Opcode must be 0x0a (pong)
      assert.equal(receivedPong[0] & 0x0f, 0x0a);
      // Client frame MUST have MASK bit set
      assert.equal((receivedPong[1] & 0x80) !== 0, true, "Pong frame from client must be masked");
      // Length is 6 bytes (2 byte header + 4 byte mask)
      assert.equal(receivedPong.length, 6);
    } finally {
      ws.close();
      if (upgradedSocket) {
        try { upgradedSocket.destroy(); } catch {}
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("should reassemble fragmented WebSocket frames (FIN=0 followed by FIN=1 continuation)", async () => {
    let upgradedSocket = null;

    const server = http.createServer();
    server.on("upgrade", (req, socket) => {
      upgradedSocket = socket;
      const key = req.headers["sec-websocket-key"];
      const accept = crypto
        .createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );

      socket.on("data", () => {
        // Send fragmented response:
        // Full message: {"id":1,"result":{"fragmented":true}}
        const full = JSON.stringify({ id: 1, result: { fragmented: true } });
        const part1 = Buffer.from(full.slice(0, 10), "utf8");
        const part2 = Buffer.from(full.slice(10), "utf8");

        // Frame 1: FIN=0 (0x01 opcode text), unmasked
        const f1 = Buffer.concat([Buffer.from([0x01, part1.length]), part1]);
        // Frame 2: FIN=1 (0x80 | 0x00 continuation opcode), unmasked
        const f2 = Buffer.concat([Buffer.from([0x80, part2.length]), part2]);

        socket.write(f1);
        setTimeout(() => {
          socket.write(f2);
        }, 30);
      });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const ws = new CdpWebSocket(`ws://127.0.0.1:${port}/test`);
    try {
      await ws.connect();
      const res = await ws.send("Test.fragmented");
      assert.deepEqual(res, { fragmented: true });
    } finally {
      ws.close();
      if (upgradedSocket) {
        try { upgradedSocket.destroy(); } catch {}
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("should reject send command when timeout is exceeded", async () => {
    let upgradedSocket = null;

    const server = http.createServer();
    server.on("upgrade", (req, socket) => {
      upgradedSocket = socket;
      const key = req.headers["sec-websocket-key"];
      const accept = crypto
        .createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      // Intentionally do NOT respond to any commands
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const ws = new CdpWebSocket(`ws://127.0.0.1:${port}/test`);
    try {
      await ws.connect();
      // Send command with 100ms timeout
      await assert.rejects(
        async () => {
          await ws.send("Test.hangingCommand", {}, 100);
        },
        /CDP command timed out after 100ms/
      );
    } finally {
      ws.close();
      if (upgradedSocket) {
        try { upgradedSocket.destroy(); } catch {}
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("should cleanly reject pending callbacks when connection closes", async () => {
    let upgradedSocket = null;

    const server = http.createServer();
    server.on("upgrade", (req, socket) => {
      upgradedSocket = socket;
      const key = req.headers["sec-websocket-key"];
      const accept = crypto
        .createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const ws = new CdpWebSocket(`ws://127.0.0.1:${port}/test`);
    try {
      await ws.connect();
      const sendPromise = ws.send("Test.willClose", {}, 5000);
      // Sever socket
      ws.close();
      await assert.rejects(async () => {
        await sendPromise;
      }, /CDP Connection closed/);
    } finally {
      ws.close();
      if (upgradedSocket) {
        try { upgradedSocket.destroy(); } catch {}
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });
  it("should initialize HeadlessBrowserSession with default or customized launch timeout", () => {
    const sessionDefault = new HeadlessBrowserSession();
    assert.equal(sessionDefault.launchTimeoutMs, 30000);

    const sessionCustom = new HeadlessBrowserSession({ launchTimeoutMs: 15000 });
    assert.equal(sessionCustom.launchTimeoutMs, 15000);

    const origEnv = process.env.BROWSER_LAUNCH_TIMEOUT_MS;
    try {
      process.env.BROWSER_LAUNCH_TIMEOUT_MS = "45000";
      const sessionEnv = new HeadlessBrowserSession();
      assert.equal(sessionEnv.launchTimeoutMs, 45000);
    } finally {
      if (origEnv !== undefined) {
        process.env.BROWSER_LAUNCH_TIMEOUT_MS = origEnv;
      } else {
        delete process.env.BROWSER_LAUNCH_TIMEOUT_MS;
      }
    }
  });

  it("should fail gracefully and clean up if browser binary does not exist", async () => {
    const session = new HeadlessBrowserSession({ chromePath: null });
    await assert.rejects(async () => {
      await session.launch();
    }, /No Chromium or Chrome binary found on system/);
  });
});
