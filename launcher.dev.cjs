// KOTEA DEV launcher: starts the server + client dev servers (with hot
// reload) and opens the app in the default browser once Vite is ready.
// Use this to preview source changes without rebuilding KOTEA.exe.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = process.env.PORT || 5173;
const URL = `http://localhost:${PORT}`;

// Base directory of the launcher (the folder containing this exe, or this
// script when run directly with node). Must be the project root (where
// package.json lives).
const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;
const logFile = path.join(baseDir, 'kotea-dev.log');

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.appendFileSync(logFile, msg); } catch { /* ignore */ }
}

function showError(message) {
  log(`ERROR: ${message}`);
  const script = `Add-Type -AssemblyName System.Windows.Forms; ` +
    `[System.Windows.Forms.MessageBox]::Show(` +
    `'${message.replace(/'/g, "''")}\\n\\nDetails: ${logFile.replace(/\\/g, '\\\\').replace(/'/g, "''")}', ` +
    `'KOTEA DEV - Startup Error')`;
  spawn('powershell', ['-NoProfile', '-Command', script], { detached: true, stdio: 'ignore' }).unref();
}

// Reset the log for this run.
try { fs.writeFileSync(logFile, ''); } catch { /* ignore */ }
log(`Starting KOTEA DEV from ${baseDir}`);

// Run the same "npm run dev" used during development (server + client with
// hot reload), via cmd so npm.cmd resolves correctly on Windows.
let proc;
try {
  proc = spawn('cmd', ['/c', 'npm', 'run', 'dev'], {
    cwd: baseDir,
    stdio: ['ignore', 'pipe', 'pipe']
  });
} catch (e) {
  showError(`Could not launch the dev servers: ${e.message}`);
  process.exit(1);
}

proc.stdout.on('data', (d) => { process.stdout.write(d); log(d.toString().trimEnd()); });
proc.stderr.on('data', (d) => { process.stderr.write(d); log(d.toString().trimEnd()); });

proc.on('error', (err) => {
  if (err.code === 'ENOENT') {
    showError('npm was not found on this system. Please install Node.js (v22 or newer) and try again.');
  } else {
    showError(`Failed to start the dev servers: ${err.message}`);
  }
  process.exit(1);
});

proc.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    showError(`The dev servers exited unexpectedly (code ${code}).`);
  }
  process.exit(code ?? 0);
});

function openBrowser(url) {
  spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
}

function ping(url) {
  return new Promise((resolve) => {
    http.get(url, () => resolve(true)).on('error', () => resolve(false));
  });
}

// Wait for both Vite (client) and the API server to respond before opening
// the browser, so the first page load doesn't hit "ECONNREFUSED" on /api/*.
async function waitForServers(retriesLeft) {
  const [clientUp, apiUp] = await Promise.all([ping(URL), ping('http://localhost:4000')]);
  if (clientUp && apiUp) return openBrowser(URL);
  if (retriesLeft <= 0) {
    showError('The dev servers did not respond within 60 seconds.');
    return;
  }
  setTimeout(() => waitForServers(retriesLeft - 1), 1000);
}

waitForServers(60); // Vite + concurrently can take longer to boot than the prod server
