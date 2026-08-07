// CDP Client wrapper for Comet browser control
// Supports macOS, Windows, and WSL

import CDP from "chrome-remote-interface";
import { spawn, ChildProcess, execSync } from "child_process";
import { platform } from "os";
import { existsSync } from "fs";
import type {
  CDPTarget,
  CDPVersion,
  NavigateResult,
  ScreenshotResult,
  EvaluateResult,
  CometState,
} from "./types.js";
import { evaluateUrl, getActivePolicy } from "./safety/url-policy.js";

// ============ PLATFORM DETECTION ============

/**
 * Detect if running in WSL (Windows Subsystem for Linux)
 */
function isWSL(): boolean {
  if (platform() !== 'linux') return false;
  try {
    const release = execSync('uname -r', { encoding: 'utf8' }).toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

const IS_WSL = isWSL();
const IS_WINDOWS = platform() === "win32" || IS_WSL;

/**
 * Get the appropriate Comet executable path for the current platform
 */
function getCometPath(): string {
  // Allow override via environment variable
  if (process.env.COMET_PATH) {
    return process.env.COMET_PATH;
  }

  const os = platform();

  if (os === "darwin") {
    return "/Applications/Comet.app/Contents/MacOS/Comet";
  }

  if (os === "win32" || IS_WSL) {
    // Common Windows installation paths for Comet
    const possiblePaths = [
      `${process.env.LOCALAPPDATA}\\Perplexity\\Comet\\Application\\comet.exe`,
      `${process.env.APPDATA}\\Perplexity\\Comet\\Application\\comet.exe`,
      "C:\\Program Files\\Perplexity\\Comet\\Application\\comet.exe",
      "C:\\Program Files (x86)\\Perplexity\\Comet\\Application\\comet.exe",
    ];

    for (const p of possiblePaths) {
      if (p && existsSync(p)) {
        return p;
      }
    }

    // Default to LOCALAPPDATA path
    return `${process.env.LOCALAPPDATA}\\Perplexity\\Comet\\Application\\comet.exe`;
  }

  // Fallback for other platforms
  return "/Applications/Comet.app/Contents/MacOS/Comet";
}

const COMET_PATH = getCometPath();
const DEFAULT_PORT = 9222;

// ============ WSL NETWORK HELPERS ============

/**
 * Check if WSL can directly connect to Windows localhost (mirrored networking)
 */
async function canConnectToWindowsLocalhost(port: number): Promise<boolean> {
  if (!IS_WSL) return true;

  const net = await import('net');
  return new Promise((resolve) => {
    const client = net.createConnection({ port, host: '127.0.0.1' }, () => {
      client.destroy();
      resolve(true);
    });
    client.on('error', () => {
      resolve(false);
    });
    client.setTimeout(2000, () => {
      client.destroy();
      resolve(false);
    });
  });
}

/**
 * Get the port to use for CDP WebSocket connection from WSL
 * Throws helpful error if mirrored networking is not enabled
 */
async function getWSLConnectPort(targetPort: number): Promise<number> {
  if (!IS_WSL) return targetPort;

  const canConnect = await canConnectToWindowsLocalhost(targetPort);
  if (canConnect) {
    return targetPort;
  }

  throw new Error(
    `WSL cannot connect to Windows localhost:${targetPort}.\n\n` +
    `To fix this, enable WSL mirrored networking:\n` +
    `1. Create/edit %USERPROFILE%\\.wslconfig with:\n` +
    `   [wsl2]\n` +
    `   networkingMode=mirrored\n` +
    `2. Run: wsl --shutdown\n` +
    `3. Restart WSL and try again\n\n` +
    `Alternatively, run Claude Code from Windows PowerShell instead of WSL.`
  );
}

/**
 * Windows/WSL-compatible fetch using PowerShell
 * On WSL, native fetch connects to WSL's localhost, not Windows where Comet runs
 */
async function windowsFetch(
  url: string,
  method: string = 'GET'
): Promise<{ ok: boolean; status: number; json: () => Promise<any> }> {
  // Use native fetch on macOS/Linux (non-WSL)
  if (platform() !== 'win32' && !IS_WSL) {
    const response = await fetch(url, { method });
    return response;
  }

  // On Windows or WSL, use PowerShell to reach Windows localhost
  try {
    const psCommand = method === 'PUT'
      ? `Invoke-WebRequest -Uri '${url}' -Method PUT -UseBasicParsing | Select-Object -ExpandProperty Content`
      : `Invoke-WebRequest -Uri '${url}' -UseBasicParsing | Select-Object -ExpandProperty Content`;

    const result = execSync(`powershell.exe -NoProfile -Command "${psCommand}"`, {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });

    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(result.trim())
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      json: async () => { throw error; }
    };
  }
}

export class CometCDPClient {
  private client: CDP.Client | null = null;
  private cometProcess: ChildProcess | null = null;
  private state: CometState = {
    connected: false,
    port: DEFAULT_PORT,
  };
  private lastTargetId: string | undefined;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private isReconnecting: boolean = false;

  get isConnected(): boolean {
    return this.state.connected && this.client !== null;
  }

  /**
   * Health check - verify connection is actually alive (not just "connected" in state)
   * This catches cases where WebSocket died silently
   */
  async isHealthy(): Promise<boolean> {
    if (!this.client || !this.state.connected) return false;

    try {
      // Simple evaluation that should always work if connected
      const result = await Promise.race([
        this.client.Runtime.evaluate({ expression: '1+1', returnByValue: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 3000))
      ]);
      return (result as any)?.result?.value === 2;
    } catch {
      // Connection is dead
      this.state.connected = false;
      return false;
    }
  }

  /**
   * Ensure we have a healthy connection, reconnecting if needed
   * Call this before any CDP operation
   */
  async ensureHealthyConnection(): Promise<void> {
    const healthy = await this.isHealthy();
    if (!healthy) {
      await this.reconnect();
    }
  }

  get currentState(): CometState {
    return { ...this.state };
  }

  /**
   * Auto-reconnect wrapper for operations with exponential backoff
   */
  private async withAutoReconnect<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isReconnecting) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    try {
      const result = await operation();
      this.reconnectAttempts = 0;
      return result;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const connectionErrors = [
        'WebSocket', 'CLOSED', 'not open', 'disconnected',
        'ECONNREFUSED', 'ECONNRESET', 'Protocol error', 'Target closed', 'Session closed'
      ];

      if (connectionErrors.some(e => errorMessage.includes(e)) &&
          this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        this.isReconnecting = true;

        try {
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 5000);
          await new Promise(resolve => setTimeout(resolve, delay));
          await this.reconnect();
          this.isReconnecting = false;
          return await operation();
        } catch (reconnectError) {
          this.isReconnecting = false;
          throw reconnectError;
        }
      }

      throw error;
    }
  }

  /**
   * Reconnect to the last connected tab
   */
  async reconnect(): Promise<string> {
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
    }
    this.state.connected = false;
    this.client = null;

    // Verify Comet is running
    try {
      await this.getVersion();
    } catch {
      try {
        await this.startComet(this.state.port);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch {
        throw new Error('Cannot connect to Comet. Ensure Comet is running with --remote-debugging-port=9222');
      }
    }

    // Try to reconnect to last target
    if (this.lastTargetId) {
      try {
        const targets = await this.listTargets();
        if (targets.find(t => t.id === this.lastTargetId)) {
          return await this.connect(this.lastTargetId);
        }
      } catch { /* target gone */ }
    }

    // Find best target
    const targets = await this.listTargets();
    const target = targets.find(t => t.type === 'page' && t.url.includes('perplexity.ai')) ||
                   targets.find(t => t.type === 'page' && t.url !== 'about:blank');

    if (target) {
      return await this.connect(target.id);
    }

    throw new Error('No suitable tab found for reconnection');
  }

  /**
   * List tabs with categorization
   */
  async listTabsCategorized(): Promise<{
    main: CDPTarget | null;
    sidecar: CDPTarget | null;
    agentBrowsing: CDPTarget | null;
    overlay: CDPTarget | null;
    others: CDPTarget[];
  }> {
    const targets = await this.listTargets();

    return {
      main: targets.find(t =>
        t.type === 'page' && t.url.includes('perplexity.ai') && !t.url.includes('sidecar')
      ) || null,
      sidecar: targets.find(t =>
        t.type === 'page' && t.url.includes('sidecar')
      ) || null,
      agentBrowsing: targets.find(t =>
        t.type === 'page' &&
        !t.url.includes('perplexity.ai') &&
        !t.url.includes('chrome-extension') &&
        !t.url.includes('chrome://') &&
        t.url !== 'about:blank'
      ) || null,
      overlay: targets.find(t =>
        t.url.includes('chrome-extension') && t.url.includes('overlay')
      ) || null,
      others: targets.filter(t =>
        t.type === 'page' &&
        !t.url.includes('perplexity.ai') &&
        !t.url.includes('chrome-extension')
      ),
    };
  }

  /**
   * Check if Comet process is running
   */
  private async isCometProcessRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      if (IS_WINDOWS) {
        // Windows: use tasklist to check for comet.exe
        const check = spawn('tasklist', ['/FI', 'IMAGENAME eq comet.exe', '/NH']);
        let output = '';
        check.stdout?.on('data', (data) => { output += data.toString(); });
        check.on('close', () => {
          resolve(output.toLowerCase().includes('comet.exe'));
        });
        check.on('error', () => resolve(false));
      } else {
        // macOS/Linux: use pgrep
        const check = spawn('pgrep', ['-f', 'Comet.app']);
        check.on('close', (code) => resolve(code === 0));
        check.on('error', () => resolve(false));
      }
    });
  }

  /**
   * Kill any running Comet process
   */
  private async killComet(): Promise<void> {
    return new Promise((resolve) => {
      if (IS_WINDOWS) {
        // Windows: use taskkill to kill comet.exe
        const kill = spawn('taskkill', ['/F', '/IM', 'comet.exe']);
        kill.on('close', () => setTimeout(resolve, 1000));
        kill.on('error', () => setTimeout(resolve, 1000));
      } else {
        // macOS/Linux: use pkill
        const kill = spawn('pkill', ['-f', 'Comet.app']);
        kill.on('close', () => setTimeout(resolve, 1000));
        kill.on('error', () => setTimeout(resolve, 1000));
      }
    });
  }

  /**
   * Start Comet browser with remote debugging enabled
   * Handles macOS, Windows, and WSL environments
   */
  async startComet(port: number = DEFAULT_PORT): Promise<string> {
    this.state.port = port;

    // ========== WSL: Use PowerShell to communicate with Windows ==========
    if (IS_WSL) {
      // Check if Comet is already running via PowerShell HTTP
      try {
        const response = await windowsFetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          const version = await response.json() as CDPVersion;
          return `Comet already running on Windows host, port: ${port} (${version.Browser})`;
        }
      } catch {
        // Comet not accessible, need to launch
      }

      // Get Windows LOCALAPPDATA path and construct Comet path
      let cometPath = '';
      try {
        const localAppData = execSync('cmd.exe /c echo %LOCALAPPDATA%', { encoding: 'utf8' })
          .trim().replace(/\r?\n/g, '');
        cometPath = `${localAppData}\\Perplexity\\Comet\\Application\\Comet.exe`;
      } catch {
        cometPath = 'C:\\Users\\' + (process.env.USER || 'user') +
          '\\AppData\\Local\\Perplexity\\Comet\\Application\\Comet.exe';
      }

      try {
        // Launch Comet via PowerShell (Set-Location avoids UNC path issues)
        const psCommand = `Set-Location C:\\; Start-Process -FilePath '${cometPath}' -ArgumentList '--remote-debugging-port=${port}'`;
        spawn('powershell.exe', ['-NoProfile', '-Command', psCommand], {
          detached: true,
          stdio: 'ignore',
        }).unref();

        // Wait for Comet to start
        return new Promise((resolve, reject) => {
          const maxAttempts = 40;
          let attempts = 0;

          const checkReady = async () => {
            attempts++;
            try {
              const response = await windowsFetch(`http://127.0.0.1:${port}/json/version`);
              if (response.ok) {
                resolve(`Comet started via WSL->PowerShell on port ${port}`);
                return;
              }
            } catch { /* keep trying */ }

            if (attempts < maxAttempts) {
              setTimeout(checkReady, 500);
            } else {
              reject(new Error(
                `Timeout waiting for Comet. Tried to launch: ${cometPath}\n` +
                `Try manually: powershell.exe -Command "Start-Process '${cometPath}' -ArgumentList '--remote-debugging-port=${port}'"`
              ));
            }
          };

          setTimeout(checkReady, 2000);
        });
      } catch (launchError) {
        throw new Error(
          `Cannot connect to or launch Comet browser.\n` +
          `Tried path: ${cometPath}\n` +
          `Error: ${launchError instanceof Error ? launchError.message : String(launchError)}`
        );
      }
    }

    // ========== Native Windows: Use windowsFetch for HTTP ==========
    if (platform() === 'win32') {
      try {
        const response = await windowsFetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          const version = await response.json() as CDPVersion;
          return `Comet already running with debug port: ${version.Browser}`;
        }
      } catch {
        const isRunning = await this.isCometProcessRunning();
        if (isRunning) {
          await this.killComet();
        }
      }

      // Start Comet on Windows
      return new Promise((resolve, reject) => {
        this.cometProcess = spawn(COMET_PATH, [`--remote-debugging-port=${port}`], {
          detached: true,
          stdio: "ignore",
        });
        this.cometProcess.unref();

        const maxAttempts = 40;
        let attempts = 0;

        const checkReady = async () => {
          attempts++;
          try {
            const response = await windowsFetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) {
              resolve(`Comet started with debug port ${port}`);
              return;
            }
          } catch { /* keep trying */ }

          if (attempts < maxAttempts) {
            setTimeout(checkReady, 500);
          } else {
            reject(new Error(`Timeout waiting for Comet. Try: "${COMET_PATH}" --remote-debugging-port=${port}`));
          }
        };

        setTimeout(checkReady, 1500);
      });
    }

    // ========== macOS/Linux: Original approach ==========
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(`http://localhost:${port}/json/version`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.ok) {
        const version = await response.json() as CDPVersion;
        return `Comet already running with debug port: ${version.Browser}`;
      }
    } catch {
      const isRunning = await this.isCometProcessRunning();
      if (isRunning) {
        await this.killComet();
      }
    }

    // Start Comet on macOS/Linux
    return new Promise((resolve, reject) => {
      this.cometProcess = spawn(COMET_PATH, [`--remote-debugging-port=${port}`], {
        detached: true,
        stdio: "ignore",
      });
      this.cometProcess.unref();

      const maxAttempts = 40;
      let attempts = 0;

      const checkReady = async () => {
        attempts++;
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000);
          const response = await fetch(`http://localhost:${port}/json/version`, { signal: controller.signal });
          clearTimeout(timeoutId);

          if (response.ok) {
            const version = await response.json() as CDPVersion;
            resolve(`Comet started with debug port ${port}: ${version.Browser}`);
            return;
          }
        } catch { /* keep trying */ }

        if (attempts < maxAttempts) {
          setTimeout(checkReady, 500);
        } else {
          reject(new Error(`Timeout waiting for Comet. Try: ${COMET_PATH} --remote-debugging-port=${port}`));
        }
      };

      setTimeout(checkReady, 1500);
    });
  }

  /**
   * Get CDP version info
   */
  async getVersion(): Promise<CDPVersion> {
    const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/version`);
    if (!response.ok) throw new Error(`Failed to get version: ${response.status}`);
    return response.json() as Promise<CDPVersion>;
  }

  /**
   * List all available tabs/targets
   */
  async listTargets(): Promise<CDPTarget[]> {
    const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/list`);
    if (!response.ok) throw new Error(`Failed to list targets: ${response.status}`);
    return response.json() as Promise<CDPTarget[]>;
  }

  /**
   * Connect to a specific tab
   */
  async connect(targetId?: string): Promise<string> {
    if (this.client) {
      await this.disconnect();
    }

    // On WSL, verify mirrored networking is available for WebSocket connection
    const connectPort = await getWSLConnectPort(this.state.port);

    const options: CDP.Options = { port: connectPort, host: '127.0.0.1' };
    if (targetId) options.target = targetId;

    this.client = await CDP(options);

    await Promise.all([
      this.client.Page.enable(),
      this.client.Runtime.enable(),
      this.client.DOM.enable(),
      this.client.Network.enable(),
    ]);

    // Set window size for consistent UI
    try {
      const { windowId } = await (this.client as any).Browser.getWindowForTarget({ targetId });
      await (this.client as any).Browser.setWindowBounds({
        windowId,
        bounds: { width: 1440, height: 900, windowState: 'normal' },
      });
    } catch {
      try {
        await (this.client as any).Emulation.setDeviceMetricsOverride({
          width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
        });
      } catch { /* continue */ }
    }

    this.state.connected = true;
    this.state.activeTabId = targetId;
    this.lastTargetId = targetId;
    this.reconnectAttempts = 0;

    const { result } = await this.client.Runtime.evaluate({ expression: "window.location.href" });
    this.state.currentUrl = result.value as string;

    return `Connected to tab: ${this.state.currentUrl}`;
  }

  /**
   * Disconnect from current tab
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.state.connected = false;
      this.state.activeTabId = undefined;
    }
  }

  /**
   * Navigate to a URL.
   *
   * Hard-boundary check: evaluateUrl(url, policy, caller) runs before
   * the CDP call. Mirrors Perplexity Comet isInternalPage / isUrlBlocked /
   * isDomainBlacklist. Throws BlockedUrlError on deny (caught by the MCP
   * catch handler and surfaced via formatCaughtError).
   */
  async navigate(url: string, waitForLoad: boolean = true, caller: string = 'manual'): Promise<NavigateResult> {
    this.ensureConnected();
    evaluateUrl(url, getActivePolicy(), caller);
    const result = await this.client!.Page.navigate({ url });
    if (waitForLoad) await this.client!.Page.loadEventFired();
    this.state.currentUrl = url;
    return result as NavigateResult;
  }

  /**
   * Capture screenshot
   */
  async screenshot(format: "png" | "jpeg" = "png"): Promise<ScreenshotResult> {
    this.ensureConnected();
    return this.client!.Page.captureScreenshot({ format }) as Promise<ScreenshotResult>;
  }

  /**
   * Execute JavaScript in the page context
   */
  async evaluate(expression: string): Promise<EvaluateResult> {
    this.ensureConnected();
    return this.client!.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as Promise<EvaluateResult>;
  }

  /**
   * Execute JavaScript with auto-reconnect on connection loss
   * This is the PREFERRED method - always use this instead of evaluate()
   */
  async safeEvaluate(expression: string): Promise<EvaluateResult> {
    // Always check health first to catch silently dead connections
    await this.ensureHealthyConnection();

    return this.withAutoReconnect(async () => {
      this.ensureConnected();
      return this.client!.Runtime.evaluate({
        expression,
        awaitPromise: true,
        returnByValue: true,
      }) as Promise<EvaluateResult>;
    });
  }

  /**
   * Press a key
   */
  async pressKey(key: string): Promise<void> {
    this.ensureConnected();
    await this.client!.Input.dispatchKeyEvent({ type: "keyDown", key });
    await this.client!.Input.dispatchKeyEvent({ type: "keyUp", key });
  }

  /**
   * Create a new tab
   */
  async newTab(url?: string, caller: string = 'manual'): Promise<CDPTarget> {
    if (url !== undefined) {
      evaluateUrl(url, getActivePolicy(), caller);
    }
    const response = await windowsFetch(
      `http://127.0.0.1:${this.state.port}/json/new${url ? `?${url}` : ""}`,
      'PUT'
    );
    if (!response.ok) throw new Error(`Failed to create new tab: ${response.status}`);
    return response.json() as Promise<CDPTarget>;
  }

  /**
   * Close a tab
   */
  async closeTab(targetId: string): Promise<boolean> {
    try {
      if (this.client) {
        const result = await this.client.Target.closeTarget({ targetId });
        return result.success;
      }
    } catch { /* fallback to HTTP */ }

    try {
      const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/close/${targetId}`);
      return response.ok;
    } catch {
      return false;
    }
  }

  private ensureConnected(): void {
    if (!this.client) {
      throw new Error("Not connected to Comet. Call connect() first.");
    }
  }
}

export const cometClient = new CometCDPClient();
