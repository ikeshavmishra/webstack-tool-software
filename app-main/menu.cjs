// app-main/menu.cjs
const { Menu } = require('electron');

function createMenuManager({
  getTabs,
  getActiveTabId,
  getDashboardTabId,
  getMaxVisibleTabs,
  getTabScrollIndex,
  setTabScrollIndex,
  getStatusLabel,
  setAppMenu,
  getActiveTab,
  setActiveTab,
  closeTab,
  makeTabLabel
}) {
  function rebuildMenu() {
    const template = [];

    const tabsForMenu = getTabs();
    const totalTabs = tabsForMenu.length;
    const activeTabId = getActiveTabId();
    const dashboardTabId = getDashboardTabId();
    const MAX_VISIBLE_TABS = getMaxVisibleTabs();
    const statusLabel = getStatusLabel();

    let tabScrollIndex = getTabScrollIndex();

    // 1) Tab list directly in the menu bar (with slider + per-tab close)
    if (totalTabs > 0) {
      template.push({ type: 'separator' });

      if (totalTabs > MAX_VISIBLE_TABS) {
        // Left arrow
        template.push({
          label: '◀',
          enabled: tabScrollIndex > 0,
          click: () => {
            let currentIndex = getTabScrollIndex();
            if (currentIndex > 0) {
              currentIndex -= 1;
              if (currentIndex < 0) currentIndex = 0;
              setTabScrollIndex(currentIndex);
              rebuildMenu();
            }
          }
        });
      }

      const visibleTabs = tabsForMenu.slice(
        tabScrollIndex,
        tabScrollIndex + MAX_VISIBLE_TABS
      );

      for (const tab of visibleTabs) {
        const isDashboard = tab.id === dashboardTabId;
        const label = isDashboard ? '🏠 Dashboard' : makeTabLabel(tab);

        // Main tab item (select tab)
        template.push({
          label,
          type: 'radio',
          checked: tab.id === activeTabId,
          click: () => setActiveTab(tab.id)
        });

        // Close button for this tab (but not for Dashboard)
        if (!isDashboard) {
          template.push({
            label: '✕',
            click: () => closeTab(tab.id)
          });
        }
      }

      if (totalTabs > MAX_VISIBLE_TABS) {
        // Right arrow
        template.push({
          label: '▶',
          enabled: tabScrollIndex + MAX_VISIBLE_TABS < totalTabs,
          click: () => {
            let currentIndex = getTabScrollIndex();
            if (currentIndex + MAX_VISIBLE_TABS < totalTabs) {
              currentIndex += 1;
              setTabScrollIndex(currentIndex);
              rebuildMenu();
            }
          }
        });
      }

      template.push({ type: 'separator' });
    }

    // 2) Refresh
    template.push({
      label: '🔄 Refresh',
      accelerator: 'CmdOrCtrl+R',
      click: () => {
        const active = getActiveTab();
        if (active && active.view) {
          active.view.webContents.reload();
        }
      }
    });

    // 3) Status
    template.push({
      label: `🟢 ${statusLabel}`,
      enabled: false
    });

    const appMenu = Menu.buildFromTemplate(template);
    setAppMenu(appMenu);
    Menu.setApplicationMenu(appMenu);
  }

  return { rebuildMenu };
}

module.exports = { createMenuManager };
