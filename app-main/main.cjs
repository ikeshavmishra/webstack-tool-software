// app-main/main.cjs

// ────────────────────────────────────────────
// Imports
// ────────────────────────────────────────────

// const { app, BrowserWindow, BrowserView, ipcMain, Menu } = require('electron');
const { app, BrowserWindow, BrowserView, ipcMain, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { checkForUpdatesInBackground } = require('../update/autoUpdate.cjs');

const config = require('../config/config.cjs');
const registerIpcHandlers = require('../ipcHandlers/ipcHandlers.cjs');
const { createMenuManager } = require('./menu.cjs');


// ────────────────────────────────────────────
// User-Agent – make app look like a real browser
// ────────────────────────────────────────────

// Pretend to be Chrome on Windows (desktop)
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Apply our browser-like User-Agent to a given webContents.
 */
function applyBrowserUserAgent(webContents) {
  if (!webContents || webContents.isDestroyed()) return;
  webContents.setUserAgent(BROWSER_USER_AGENT);
}


// ────────────────────────────────────────────
// User CSS – global custom styles for all tabs
// This lets us:
//   - keep all "blocking / hiding / customizing" CSS in one file
//   - inject it into every BrowserView
//   - and tag <html> with data-domain="hostname" for per-site rules
// ────────────────────────────────────────────

const userCssPath = path.join(__dirname, 'userStyles.css');
let userCss = '';

try {
  // Load userStyles.css once at startup (if the file exists)
  userCss = fs.readFileSync(userCssPath, 'utf8');
} catch (err) {
  console.error('[UserStyles] Failed to load userStyles.css:', err.message);
}

/**
 * Attach global user CSS + per-domain data attribute behavior
 * to a given webContents (each tab's BrowserView has its own).
 *
 * - Injects userStyles.css once (persists for that webContents)
 * - On each navigation / in-page navigation, sets:
 *       <html data-domain="hostname">
 *   so CSS can target specific sites.
 */
// Attach user CSS + per-domain data attribute to any webContents
function attachUserStyles(webContents) {
  if (!userCss) return;

  const applyUserCssAndDomain = () => {
    const url = webContents.getURL();
    let hostname = '';

    try {
      hostname = new URL(url).hostname;
    } catch (e) {
      hostname = '';
    }

    // 1) Inject (or re-inject) our CSS for the current page
    webContents.insertCSS(userCss).catch(() => {
      // ignore errors if contents destroyed
    });

    // 2) Tag <html> with data-domain="hostname" so CSS can be per-site
    const script = `
      (function() {
        try {
          document.documentElement.setAttribute('data-domain', ${JSON.stringify(
            hostname
          )});
        } catch (e) {}
      })();
    `;

    webContents.executeJavaScript(script, true).catch(() => {
      // ignore errors if navigation changed or contents destroyed
    });
  };

  // Run after full page load
  webContents.on('did-finish-load', applyUserCssAndDomain);

  // Also run on in-page navigations (SPA, hash changes, etc.)
  webContents.on('did-navigate-in-page', applyUserCssAndDomain);
}



// ────────────────────────────────────────────
// Globals – shared app state
// ────────────────────────────────────────────

const SPLASH_MIN_DURATION = 2000; // 2 seconds minimum
let appStartTime = null;
let splashCloseScheduled = false;

let mainWindow = null;       // Main application window
let splashWindow = null;     // Splash screen window
let appMenu = null;          // Current application menu

let statusLabel = 'Status: Offline';  // Online/offline state shown in menu

// tabs = [{ id, view, title, url, isDashboard? }]
let tabs = [];               // All open tabs
let activeTabId = null;      // ID of the currently active tab
let nextTabId = 1;           // Incrementing ID for new tabs

let dashboardTabId = null;   // The special "Dashboard" tab that can't be closed

// Max number of tabs shown at once in the menu tab list
const MAX_VISIBLE_TABS = 15;
let tabScrollIndex = 0;      // "Slider" position in the logical tab list


// ────────────────────────────────────────────
// Tab Helpers – querying and labeling tabs
// These are core building blocks used by many other functions.
// ────────────────────────────────────────────

/**
 * Returns the currently active tab object or null.
 */
function getActiveTab() {
  return tabs.find(t => t.id === activeTabId) || null;
}

/**
 * Returns the index of a tab in the tabs array by its ID.
 * If not found, returns -1.
 */
function getTabIndexById(id) {
  return tabs.findIndex(t => t.id === id);
}

/**
 * Creates a short label for a tab to show in the menu.
 * We prefer the domain name (hostname) instead of the full URL.
 */
function makeTabLabel(tab) {
  if (!tab.url) return `Tab ${tab.id}`;

  try {
    const u = new URL(tab.url);
    const host = u.hostname.replace(/^www\./, ''); // strip leading "www."
    return host || `Tab ${tab.id}`;
  } catch (e) {
    // If URL parsing fails, fall back to a generic label
    return `Tab ${tab.id}`;
  }
}

// ────────────────────────────────────────────
// Permissions – allow protected content
// ────────────────────────────────────────────

function setupProtectedContentPermissions() {
  const ses = session.defaultSession;

  // When a site actually requests a permission (popup in normal Chrome)
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission === 'protectedMediaIdentifier') {
      // Always allow "protected content" / DRM IDs
      return callback(true);
    }

    // For everything else you can decide:
    // - always allow (true)
    // - always deny (false)
    // - or add more conditions here
    return callback(true);
  });

  // When the site just *checks* if it is allowed
  ses.setPermissionCheckHandler((webContents, permission, origin, details) => {
    if (permission === 'protectedMediaIdentifier') {
      return true; // say "yes, this is allowed"
    }

    // Default: allow everything else as well (tweak if you want stricter rules)
    return true;
  });
}


/**
 * Ensures that the active tab is inside the "visible window"
 * of the tab list in the menu.
 *
 * - We show up to MAX_VISIBLE_TABS at once.
 * - tabScrollIndex indicates the first visible tab index.
 * - This keeps active tab from "falling off" the visible range.
 */
function ensureActiveTabVisible() {

  // No need to adjust tab slider when the Dashboard tab is active
  if (activeTabId === dashboardTabId) {
    return;
  }
  
  const totalTabs = tabs.length;
  if (totalTabs === 0) {
    tabScrollIndex = 0;
    return;
  }

  const idx = getTabIndexById(activeTabId);
  if (idx === -1) {
    // If we somehow don't have a valid active tab, just clamp slider index
    if (tabScrollIndex > totalTabs - 1) {
      tabScrollIndex = Math.max(0, totalTabs - MAX_VISIBLE_TABS);
    }
    return;
  }

  // If active tab is before the current window, move window left
  if (idx < tabScrollIndex) {
    tabScrollIndex = idx;
  }
  // If active tab is after the current window, move window right
  else if (idx >= tabScrollIndex + MAX_VISIBLE_TABS) {
    tabScrollIndex = idx - (MAX_VISIBLE_TABS - 1);
  }

  // Clamp tabScrollIndex to valid range
  if (tabScrollIndex < 0) tabScrollIndex = 0;
  if (tabScrollIndex > Math.max(0, totalTabs - MAX_VISIBLE_TABS)) {
    tabScrollIndex = Math.max(0, totalTabs - MAX_VISIBLE_TABS);
  }
}


// ────────────────────────────────────────────
// Tab Lifecycle – events, switching, creating, closing
// These functions are the core "browser tab" behavior.
// ────────────────────────────────────────────

/**
 * Wire all the tab-related webContents events for a BrowserView.
 *
 * - Updates stored title + URL for menu display
 * - Rebuilds the menu when things change
 * - Handles window.open / target="_blank" to open new tabs
 */
function wireTabEvents(tab) {
  const wc = tab.view.webContents;

  // When the page title changes, update tab.title and rebuild menu
  wc.on('page-title-updated', (_event, title) => {
    tab.title = title; // stored but not shown directly in menu (menu uses domain)
    rebuildMenu();
  });

  // When navigation occurs (full load), update tab.url and menu
  wc.on('did-navigate', (_event, url) => {
    tab.url = url;
    rebuildMenu();
  });

  // When in-page navigation occurs (hash change, SPA routing)
  wc.on('did-navigate-in-page', (_event, url) => {
    tab.url = url;
    rebuildMenu();
  });

  // When the page finishes loading, sync URL and rebuild menu
  wc.on('did-finish-load', () => {
    const url = wc.getURL();
    if (url) {
      tab.url = url;
      rebuildMenu();
    }

    scheduleSplashClose();
    // NOTE: Splash closing + main showing now handled by a global timeout
  });

  // Handle window.open / target="_blank" within this tab:
  // Instead of opening a new window, we create a new tab in the same main window.
  wc.setWindowOpenHandler(({ url }) => {
    createTab(url);
    return { action: 'deny' }; // Prevent Electron from creating a separate window
  });
}

/**
 * Switches the active tab by ID:
 * - Detaches the previous tab's BrowserView
 * - Attaches the new tab's BrowserView
 * - Resizes it to match the main window
 * - Updates activeTabId and tabScrollIndex
 * - Rebuilds the menu to show the new active tab
 */
function setActiveTab(id) {
  const tab = tabs.find(t => t.id === id);
  if (!tab || !mainWindow) return;

  // Remove currently active BrowserView (if any)
  const current = getActiveTab();
  if (current && current.view) {
    mainWindow.removeBrowserView(current.view);
  }

  // Attach new tab's BrowserView
  mainWindow.setBrowserView(tab.view);

  // Resize the BrowserView to fill the window content area
  const [width, height] = mainWindow.getContentSize();
  tab.view.setBounds({ x: 0, y: 0, width, height });
  tab.view.setAutoResize({ width: true, height: true });

  // Update active tab state and keep it visible in the menu
  activeTabId = id;
  ensureActiveTabVisible();
  rebuildMenu();
}

/**
 * Creates a new tab (BrowserView) and makes it active.
 *
 * - initialUrl: optional URL to load, defaults to config.app.startUrl
 * - Tabs are tracked in the global tabs array
 * - User CSS is attached for blocking/hiding/custom styles
 */
function createTab(initialUrl) {
  if (!mainWindow) return null;

  // Create a new BrowserView for this tab
  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // 👇 Apply browser-like User-Agent so platforms see this as a browser
  applyBrowserUserAgent(view.webContents);

  // Create the tab object with a unique ID and initial state
  const id = nextTabId++;
  const tab = {
    id,
    view,
    title: 'Loading...',
    url: initialUrl || config.app.startUrl
  };

  // Store it in global tab list
  tabs.push(tab);

  // Wire events for navigation, title updates, and window.open
  wireTabEvents(tab);

  // Attach global user CSS behavior (blocking/hiding/custom site tweaks)
  attachUserStyles(view.webContents);

  // Start loading the URL
  view.webContents.loadURL(tab.url);

  // Make this the active tab (show it)
  setActiveTab(id);

  return tab;
}

/**
 * Closes a tab by ID and selects a new active tab if needed.
 *
 * - Protects the Dashboard tab from being closed
 * - Safely removes the BrowserView and destroys webContents
 * - If no tabs remain, creates a new one at startUrl
 */
function closeTab(id) {
  // Don't allow closing the fixed Dashboard tab
  if (id === dashboardTabId) {
    console.log('[closeTab] Ignoring request to close Dashboard tab');
    return;
  }

  const index = getTabIndexById(id);
  if (index === -1) return;

  const tab = tabs[index];

  // 1) Detach the BrowserView from the main window (if attached)
  if (mainWindow && tab.view) {
    try {
      mainWindow.removeBrowserView(tab.view);
    } catch (e) {
      console.warn('[closeTab] removeBrowserView error:', e);
    }
  }

  // 2) Destroy the webContents backing this tab's view (if not already destroyed)
  if (tab.view && tab.view.webContents && !tab.view.webContents.isDestroyed()) {
    try {
      tab.view.webContents.destroy();
    } catch (e) {
      console.warn('[closeTab] webContents.destroy error:', e);
    }
  }

  // 3) Remove the tab from our global tabs array
  tabs.splice(index, 1);

  // 4) Decide which tab should become active now
  if (tabs.length === 0) {
    // If no tabs remain, create a brand new tab on the start URL
    const newTab = createTab(config.app.startUrl);
    activeTabId = newTab ? newTab.id : null;
    tabScrollIndex = 0;
  } else {
    // Otherwise, pick the next tab at the same index, or the last one
    const newActive = tabs[index] || tabs[tabs.length - 1];
    activeTabId = newActive.id;
    ensureActiveTabVisible();
    setActiveTab(activeTabId);
  }

  // Rebuild menu to reflect changed tab list
  rebuildMenu();
}


// ────────────────────────────────────────────
// Splash Window – startup logo / loading screen
// ────────────────────────────────────────────

function scheduleSplashClose() {
  // Only schedule once
  if (splashCloseScheduled) return;
  splashCloseScheduled = true;

  const now = Date.now();
  const elapsed = appStartTime ? (now - appStartTime) : 0;
  const remaining = Math.max(0, SPLASH_MIN_DURATION - elapsed);

  setTimeout(() => {
    if (splashWindow) {
      splashWindow.close();
      splashWindow = null;
    }
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, remaining);
}

/**
 * Creates the splash screen window (full-screen style window showing a logo).
 * This appears immediately and is closed after a short delay.
 */
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 1980,
    height: 1080,
    frame: false,
    resizable: false,
    transparent: false,
    alwaysOnTop: true,
    show: true,
    icon: path.join(__dirname, '../build/icon.ico')
  });

  // Load the splash HTML (static screen)
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));

  // When splash is closed, clear its reference
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}


// ────────────────────────────────────────────
// Main Window – main app shell & initial Dashboard tab
// ────────────────────────────────────────────

/**
 * Creates the main application window and initial Dashboard tab.
 *
 * - Starts hidden; it will be shown after splash finishes (2s timeout)
 * - Creates one Dashboard tab using config.app.startUrl
 * - Handles resize to resize the active tab's BrowserView
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1980,
    height: 1080,
    title: 'Webstack Tool - From research to design to distribution, all inside one app.',
    icon: path.join(__dirname, '../build/icon.ico'),
    show: false, // start hidden, show after splash
    webPreferences: {
      sandbox: true
    }
  });

  // When main window is closed, clear the reference
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // When main window is resized, resize the active BrowserView to match
  mainWindow.on('resize', () => {
    const active = getActiveTab();
    if (active && active.view) {
      const [width, height] = mainWindow.getContentSize();
      active.view.setBounds({ x: 0, y: 0, width, height });
    }
  });

  // Create initial Dashboard tab pointing to the app's start URL
  const dashboardTab = createTab(config.app.startUrl);
  if (dashboardTab) {
    dashboardTab.isDashboard = true;
    dashboardTabId = dashboardTab.id; // Remember which tab is the Dashboard
  }
}


// ────────────────────────────────────────────
// Menu – build everything from current state
// This is wired AFTER core tab/window functions are defined,
// so it can call setActiveTab, closeTab, etc.
// ────────────────────────────────────────────

// NOTE: rebuildMenu implementation is defined in menu.cjs.
// Here we pass state getters/setters and helpers so that
// menu.cjs can rebuild the entire menu based on current app state.
const { rebuildMenu } = createMenuManager({
  getTabs: () => tabs,
  getActiveTabId: () => activeTabId,
  getDashboardTabId: () => dashboardTabId,
  getMaxVisibleTabs: () => MAX_VISIBLE_TABS,
  getTabScrollIndex: () => tabScrollIndex,
  setTabScrollIndex: (val) => {
    tabScrollIndex = val;
  },
  getStatusLabel: () => statusLabel,
  setAppMenu: (menu) => {
    appMenu = menu;
  },
  getActiveTab,
  setActiveTab,
  closeTab,
  makeTabLabel
});


// ────────────────────────────────────────────
// App Lifecycle – startup, activation, updates, splash timing
// ────────────────────────────────────────────

app.whenReady().then(() => {
  // Build initial menu (even before main window shows)
  appStartTime = Date.now();
  rebuildMenu();

  // Register IPC handlers for renderer <-> main communication
  registerIpcHandlers(ipcMain);

  setupProtectedContentPermissions();

  // Show splash screen immediately
  createSplashWindow();

  // Create main window (initially hidden)
  createWindow();

  // // 🔹 Close splash & show main after 2 seconds (2000 ms)
  // setTimeout(() => {
  //   if (splashWindow) {
  //     splashWindow.close();
  //     splashWindow = null;
  //   }
  //   if (mainWindow && !mainWindow.isVisible()) {
  //     mainWindow.show();
  //   }
  // }, 2000);

  // 🔽 Fire-and-forget: runs in background, won’t block UI
  checkForUpdatesInBackground().catch(err => {
    console.error('[Update] Background check error:', err);
  });

  // macOS behavior: recreate a window when dock icon is clicked
  // and there are no open windows.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});


// ────────────────────────────────────────────
// IPC – Online / offline status from preload
// ────────────────────────────────────────────

/**
 * Renderer notifies us when online/offline status changes.
 * We update statusLabel and rebuild the menu so the label is updated.
 */
ipcMain.on('online-status-changed', (_event, online) => {
  statusLabel = online ? 'Status: Online' : 'Status: Offline';
  rebuildMenu();
});


// ────────────────────────────────────────────
// App Quit behavior
// ────────────────────────────────────────────

/**
 * Quit the app when all windows are closed (except on macOS).
 * On macOS, it's common to keep the app running with no windows open.
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
