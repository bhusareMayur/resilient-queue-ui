"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");

/**
 * Finds a suitable Chromium or Edge executable on the current system.
 * @returns {string|null}
 */
function findChromiumPath() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  if (process.env.BROWSER_PATH && fs.existsSync(process.env.BROWSER_PATH)) {
    return process.env.BROWSER_PATH;
  }

  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";

  let candidates = [];
  if (isWindows) {
    candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
    ];
  } else if (isMac) {
    candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    ];
  } else {
    // Linux
    candidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium"
    ];
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

/**
 * Minimal RFC 6455 WebSocket client using Node.js built-ins.
 */
class CdpWebSocket {
  constructor(wsUrl) {
    this.wsUrl = new URL(wsUrl);
    this.socket = null;
    this.nextId = 1;
    this.callbacks = new Map();
    this.eventListeners = new Map();
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.isClosed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const req = http.request({
        host: this.wsUrl.hostname,
        port: this.wsUrl.port,
        path: this.wsUrl.pathname + this.wsUrl.search,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": 13
        }
      });

      req.on("upgrade", (res, socket, head) => {
        this.socket = socket;
        if (head && head.length > 0) {
          this._handleData(head);
        }
        socket.on("data", (chunk) => this._handleData(chunk));
        socket.on("close", () => this._handleClose());
        socket.on("error", () => {
          // Handled in _handleClose
        });
        resolve();
      });

      req.on("error", reject);
      req.end();
    });
  }

  send(method, params = {}, timeoutMs = 15000) {
    if (this.isClosed) {
      return Promise.reject(new Error("CDP connection is closed"));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.callbacks.has(id)) {
          this.callbacks.delete(id);
          reject(new Error(`CDP command timed out after ${timeoutMs}ms: ${method}`));
        }
      }, timeoutMs);

      this.callbacks.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
      const msg = JSON.stringify({ id, method, params });
      this._sendFrame(msg);
    });
  }

  on(event, handler) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(handler);
  }

  _sendFrame(text) {
    if (!this.socket || this.isClosed) return;
    const payload = Buffer.from(text, "utf8");
    const len = payload.length;
    let header;
    let offset;
    if (len < 126) {
      header = Buffer.alloc(2 + 4);
      header[0] = 0x81;
      header[1] = 0x80 | len;
      offset = 2;
    } else if (len <= 0xffff) {
      header = Buffer.alloc(4 + 4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      offset = 4;
    } else {
      header = Buffer.alloc(10 + 4);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      offset = 10;
    }
    const mask = crypto.randomBytes(4);
    mask.copy(header, offset);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      masked[i] = payload[i] ^ mask[i % 4];
    }
    this.socket.write(Buffer.concat([header, masked]));
  }

  _handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let headerLen = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        headerLen = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        headerLen = 10;
      }

      let maskKey = null;
      if (masked) {
        if (this.buffer.length < headerLen + 4) return;
        maskKey = this.buffer.subarray(headerLen, headerLen + 4);
        headerLen += 4;
      }

      if (this.buffer.length < headerLen + payloadLen) return;

      let payload = this.buffer.subarray(headerLen, headerLen + payloadLen);
      if (masked && maskKey) {
        const unmasked = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ maskKey[i % 4];
        }
        payload = unmasked;
      }

      this.buffer = this.buffer.subarray(headerLen + payloadLen);

      // Fragmentation reassembly (opcode 0x0 is continuation, 0x1 is text)
      if (opcode === 0x1 || opcode === 0x0) {
        if (!fin) {
          this.fragments.push(payload);
          continue;
        }

        let fullPayload = payload;
        if (this.fragments.length > 0) {
          this.fragments.push(payload);
          fullPayload = Buffer.concat(this.fragments);
          this.fragments = [];
        }

        try {
          const msg = JSON.parse(fullPayload.toString("utf8"));
          if (msg.id && this.callbacks.has(msg.id)) {
            const { resolve, reject } = this.callbacks.get(msg.id);
            this.callbacks.delete(msg.id);
            if (msg.error) {
              reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
              resolve(msg.result);
            }
          } else if (msg.method) {
            const listeners = this.eventListeners.get(msg.method) || [];
            for (const l of listeners) {
              try {
                l(msg.params);
              } catch {}
            }
          }
        } catch {}
      } else if (opcode === 0x8) {
        // Close frame -> reply with masked close frame per RFC 6455
        if (this.socket && !this.isClosed) {
          try {
            const mask = crypto.randomBytes(4);
            const closeFrame = Buffer.concat([Buffer.from([0x88, 0x80]), mask]);
            this.socket.write(closeFrame);
          } catch {}
        }
        this.close();
      } else if (opcode === 0x9) {
        // ping -> reply pong with client masking per RFC 6455
        if (this.socket && !this.isClosed) {
          const mask = crypto.randomBytes(4);
          const pong = Buffer.concat([Buffer.from([0x8a, 0x80]), mask]);
          this.socket.write(pong);
        }
      }
    }
  }

  _handleClose() {
    this.isClosed = true;
    for (const [, cb] of this.callbacks) {
      cb.reject(new Error("CDP Connection closed"));
    }
    this.callbacks.clear();
  }

  close() {
    this.isClosed = true;
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {}
      this.socket = null;
    }
    this._handleClose();
  }
}

/**
 * Checks whether a suitable Chromium executable is available.
 * @returns {boolean}
 */
function isBrowserAvailable() {
  return findChromiumPath() !== null;
}

/**
 * Headless Browser Session Controller.
 */
class HeadlessBrowserSession {
  constructor(options = {}) {
    this.chromePath = options.chromePath !== undefined ? options.chromePath : findChromiumPath();
    this.launchTimeoutMs = Number(
      options.launchTimeoutMs || process.env.BROWSER_LAUNCH_TIMEOUT_MS || 30000
    );
    this.userDataDir = null;
    this.chromeProc = null;
    this.port = null;
    this.browserCdp = null;
    this.pageCdp = null;
    this.targetId = null;
    this.consoleMessages = [];
    this.consoleErrors = [];
    this.pageErrors = [];
    this.networkResponses = [];
  }

  async launch() {
    if (!this.chromePath) {
      throw new Error("No Chromium or Chrome binary found on system");
    }

    this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rq-ui-e2e-"));
    const args = [
      "--headless=new",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=${this.userDataDir}`,
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,800",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-component-extensions-with-background-pages",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints",
      "--disable-ipc-flooding-protection",
      "--disable-popup-blocking",
      "--disable-prompt-on-repost",
      "--disable-renderer-backgrounding",
      "--disable-sync",
      "--force-color-profile=srgb",
      "--metrics-recording-only",
      "--password-store=basic",
      "--use-mock-keychain"
    ];

    let stderrOutput = "";
    this.chromeProc = spawn(this.chromePath, args, {
      stdio: ["ignore", "ignore", "pipe"]
    });
    if (this.chromeProc.stderr) {
      this.chromeProc.stderr.on("data", (chunk) => {
        stderrOutput += chunk.toString("utf8");
      });
    }

    // Wait for DevToolsActivePort file
    const activePortPath = path.join(this.userDataDir, "DevToolsActivePort");
    const maxRetries = Math.max(10, Math.ceil(this.launchTimeoutMs / 100));
    for (let i = 0; i < maxRetries; i++) {
      if (this.chromeProc.exitCode !== null) {
        await this.close();
        throw new Error(
          `Chrome process exited prematurely with code ${this.chromeProc.exitCode}. Stderr: ${stderrOutput.trim() || "(none)"}`
        );
      }
      if (fs.existsSync(activePortPath)) {
        try {
          const content = fs.readFileSync(activePortPath, "utf8").trim().split("\n");
          if (content[0] && parseInt(content[0], 10)) {
            this.port = parseInt(content[0], 10);
            break;
          }
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!this.port) {
      await this.close();
      throw new Error(
        `Failed to detect DevToolsActivePort from Chrome process within ${this.launchTimeoutMs}ms. Stderr: ${stderrOutput.trim() || "(none)"}`
      );
    }

    try {
      // Connect to browser target
      const versionData = await new Promise((resolve, reject) => {
        const req = http
          .get(`http://127.0.0.1:${this.port}/json/version`, (res) => {
            let b = "";
            res.on("data", (c) => (b += c));
            res.on("end", () => {
              try {
                resolve(JSON.parse(b));
              } catch (e) {
                reject(e);
              }
            });
          })
          .on("error", reject);
        req.setTimeout(10000, () => {
          req.destroy(new Error("Timeout connecting to /json/version"));
        });
      });

      this.browserCdp = new CdpWebSocket(versionData.webSocketDebuggerUrl);
      await this.browserCdp.connect();

      // Create a new blank page target
      const target = await this.browserCdp.send("Target.createTarget", { url: "about:blank" });
      this.targetId = target.targetId;

      // Get page ws url from /json/list
      const targets = await new Promise((resolve, reject) => {
        const req = http
          .get(`http://127.0.0.1:${this.port}/json/list`, (res) => {
            let b = "";
            res.on("data", (c) => (b += c));
            res.on("end", () => {
              try {
                resolve(JSON.parse(b));
              } catch (e) {
                reject(e);
              }
            });
          })
          .on("error", reject);
        req.setTimeout(10000, () => {
          req.destroy(new Error("Timeout querying /json/list"));
        });
      });

      const pageTarget = targets.find((t) => t.id === this.targetId);
      if (!pageTarget) {
        throw new Error(`Target ${this.targetId} not found in targets list`);
      }

      this.pageCdp = new CdpWebSocket(pageTarget.webSocketDebuggerUrl);
      await this.pageCdp.connect();

      await this.pageCdp.send("Page.enable");
      await this.pageCdp.send("Runtime.enable");
      await this.pageCdp.send("DOM.enable");
      await this.pageCdp.send("Network.enable");

      // Track network responses
      this.networkResponses = [];
      this.pageCdp.on("Network.responseReceived", (params) => {
        this.networkResponses.push({
          url: params.response?.url,
          status: params.response?.status,
          headers: params.response?.headers,
          mimeType: params.response?.mimeType
        });
      });

      // Track console and runtime errors
      this.pageCdp.on("Runtime.consoleAPICalled", (params) => {
        const text = params.args ? params.args.map((a) => a.value ?? a.description ?? "").join(" ") : "";
        this.consoleMessages.push({ type: params.type, text });
        if (params.type === "error") {
          this.consoleErrors.push(text);
        }
      });

      this.pageCdp.on("Runtime.exceptionThrown", (params) => {
        const desc = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "Unknown exception";
        this.pageErrors.push(desc);
        this.consoleErrors.push(desc);
      });
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  async navigate(url) {
    this.consoleMessages = [];
    this.consoleErrors = [];
    this.pageErrors = [];

    await new Promise(async (resolve) => {
      let resolved = false;
      const onDone = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      this.pageCdp.on("Page.loadEventFired", onDone);
      this.pageCdp.on("Page.navigatedWithinDocument", onDone);

      try {
        await this.pageCdp.send("Page.navigate", { url });
      } catch (err) {
        onDone();
      }

      setTimeout(onDone, 2500);
    });
  }

  async setHash(hash) {
    await this.evaluate((h) => {
      window.location.hash = h;
    }, hash);
  }

  async evaluate(fnOrExpr, ...args) {
    let expression;
    if (typeof fnOrExpr === "function") {
      expression = `(${fnOrExpr.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;
    } else {
      expression = fnOrExpr;
    }

    const res = await this.pageCdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });

    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          "Evaluation error"
      );
    }

    return res.result?.value;
  }

  async waitForFunction(fn, timeoutMs = 5000, intervalMs = 50) {
    const fnStr = typeof fn === "function" ? fn.toString() : `() => (${fn})`;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const val = await this.evaluate(`Boolean((${fnStr})())`);
        if (val) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`waitForFunction timed out after ${timeoutMs}ms: ${fnStr}`);
  }

  async waitForSelector(selector, timeoutMs = 5000) {
    return this.waitForFunction(
      `document.querySelector(${JSON.stringify(selector)}) !== null`,
      timeoutMs
    );
  }

  async click(selector) {
    await this.waitForSelector(selector);
    const clicked = await this.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      el.click();
      return true;
    }, selector);
    if (!clicked) {
      throw new Error(`Failed to click selector: ${selector}`);
    }
  }

  async type(selector, text) {
    await this.waitForSelector(selector);
    await this.evaluate(
      (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error("Element not found: " + sel);
        el.focus();
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      selector,
      text
    );
  }

  async selectOption(selector, value) {
    await this.waitForSelector(selector);
    const selected = await this.evaluate((sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }, selector, value);
    if (!selected) {
      throw new Error(`Failed to select option for ${selector} with value ${value}`);
    }
  }

  async submitForm(selector) {
    await this.waitForSelector(selector);
    await this.evaluate((sel) => {
      const form = document.querySelector(sel);
      if (!form) throw new Error("Form not found: " + sel);
      const ev = new Event("submit", { bubbles: true, cancelable: true });
      form.dispatchEvent(ev);
    }, selector);
  }

  async pressKey(key, code) {
    if (this.pageCdp) {
      await this.pageCdp.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key,
        code: code || key
      });
      await this.pageCdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code: code || key
      });
    }
  }

  async setViewport(width, height) {
    await this.pageCdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 768
    });
  }

  async close() {
    if (this.pageCdp) {
      try {
        this.pageCdp.close();
      } catch {}
      this.pageCdp = null;
    }
    if (this.browserCdp) {
      try {
        if (!this.browserCdp.isClosed) {
          await this.browserCdp.send("Browser.close", {}, 2000).catch(() => {});
        }
        this.browserCdp.close();
      } catch {}
      this.browserCdp = null;
    }
    if (this.chromeProc) {
      const pid = this.chromeProc.pid;
      try {
        if (process.platform === "win32" && pid) {
          const { execSync } = require("node:child_process");
          try {
            execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
          } catch {}
        }
        this.chromeProc.kill("SIGKILL");
      } catch {}
      this.chromeProc = null;
    }
    if (this.userDataDir) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(this.userDataDir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      this.userDataDir = null;
    }
  }
}

module.exports = {
  findChromiumPath,
  isBrowserAvailable,
  HeadlessBrowserSession,
  CdpWebSocket
};
