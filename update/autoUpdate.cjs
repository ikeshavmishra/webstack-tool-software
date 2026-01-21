// app-main/autoUpdate.cjs
const { app, BrowserWindow, shell, dialog } = require('electron');
const https = require('https');
const pkg = require('../package.json'); // project root package.json

// current app version from package.json
const CURRENT_VERSION = pkg.version;

const UPDATE_INFO_URL = 'https://webstackocean.com/webstack-tool/latest.json';

// ────────────────────────────────────────────
// Version helpers
// ────────────────────────────────────────────

function parseVersion(v) {
  // "1.2.3" -> [1,2,3]
  return String(v)
    .split('.')
    .map(n => parseInt(n, 10) || 0);
}

function isRemoteNewer(remote, local) {
  const r = parseVersion(remote);
  const l = parseVersion(local);

  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

// ────────────────────────────────────────────
// HTTP JSON fetch helper
// ────────────────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, res => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} while fetching ${url}`));
          return;
        }

        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

// ────────────────────────────────────────────
// Public function: run update check in background
// ────────────────────────────────────────────

async function checkForUpdatesInBackground() {
  try {
    console.log('[Update] Checking for updates from', UPDATE_INFO_URL);
    const info = await fetchJson(UPDATE_INFO_URL);

    if (!info || !info.version) {
      console.warn('[Update] JSON has no "version" field');
      return;
    }

    if (!isRemoteNewer(info.version, CURRENT_VERSION)) {
      console.log(
        `[Update] Up to date. Current ${CURRENT_VERSION}, remote ${info.version}`
      );
      return;
    }

    console.log(
      `[Update] New version available: ${info.version} (current ${CURRENT_VERSION})`
    );

    const win =
      BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;

    const result = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Download update and quit'],
      defaultId: 0,
      cancelId: 0,
      title: 'Update required',
      message: 'A new version of Webstack Tool is available.',
      detail: `Current version: ${CURRENT_VERSION}\nNew version: ${info.version}\n\nYou must install the new version to continue.`
    });

    if (result.response === 0 && info.downloadUrl) {
      await shell.openExternal(info.downloadUrl);
    }

    // Force app to quit so user installs new build
    app.quit();
  } catch (err) {
    console.error('[Update] Failed to check for updates:', err.message || err);
    // Fail silently – app continues running
  }
}

module.exports = {
  checkForUpdatesInBackground
};
