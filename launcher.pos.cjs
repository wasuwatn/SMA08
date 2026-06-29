// KOTEA POS launcher: starts the API/server (which also serves the built
// client) and opens the POS page in the default browser once it's ready. If
// the server is already running (e.g. started by the Main or Expense
// launcher), this just opens the page instead of starting a second server.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = process.env.PORT || 4000;
const BASE_URL = `http://localhost:${PORT}`;
const PAGE_URL = `${BASE_URL}/pos.html`;

// Base directory of the launcher (the folder containing this exe, or this
// script when run directly with node).
const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;
const logFile = path.join(baseDir, 'kotea-pos.log');

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  try { fs.appendFileSync(logFile, msg); } catch { /* ignore */ }
}

function showError(message) {
  log(`ERROR: ${message}`);
  const script = `Add-Type -AssemblyName System.Windows.Forms; ` +
    `[System.Windows.Forms.MessageBox]::Show(` +
    `'${message.replace(/'/g, "''")}\\n\\nDetails: ${logFile.replace(/\\/g, '\\\\').replace(/'/g, "''")}', ` +
    `'KOTEA POS - Startup Error')`;
  spawn('powershell', ['-NoProfile', '-Command', script], { detached: true, stdio: 'ignore' }).unref();
}

function openBrowser(url) {
  spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
}

function waitForServer(retriesLeft) {
  http.get(BASE_URL, () => openBrowser(PAGE_URL)).on('error', () => {
    if (retriesLeft <= 0) {
      showError('The server did not respond within 20 seconds. It may have failed to connect to the database.');
      return;
    }
    setTimeout(() => waitForServer(retriesLeft - 1), 500);
  });
}

function startServer() {
  // Use the system's Node (the app needs Node 22+ for node:sqlite, which the
  // pkg-bundled runtime may not provide).
  let server;
  try {
    server = spawn('node', [path.join(baseDir, 'server', 'index.js')], {
      cwd: path.join(baseDir, 'server'),
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    showError(`Could not launch the server process: ${e.message}`);
    process.exit(1);
  }

  server.stdout.on('data', (d) => { process.stdout.write(d); log(d.toString().trimEnd()); });
  server.stderr.on('data', (d) => { process.stderr.write(d); log(d.toString().trimEnd()); });

  server.on('error', (err) => {
    if (err.code === 'ENOENT') {
      showError('Node.js was not found on this system. Please install Node.js (v22 or newer) and try again.');
    } else {
      showError(`Failed to start the server: ${err.message}`);
    }
    process.exit(1);
  });

  server.on('exit', (code) => {
    if (code !== 0) {
      showError(`The server exited unexpectedly (code ${code}). It may not have been able to reach the database - check your internet connection.`);
    }
    process.exit(code ?? 0);
  });

  waitForServer(40); // up to ~20 seconds
}

// Reset the log for this run.
try { fs.writeFileSync(logFile, ''); } catch { /* ignore */ }
log(`Starting KOTEA POS from ${baseDir}`);

http.get(BASE_URL, (res) => {
  res.resume();
  log('Server already running - opening browser only.');
  openBrowser(PAGE_URL);
}).on('error', startServer);
