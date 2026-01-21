// ipcHandlers/ipcHandlers.cjs
const axios = require('axios');
const config = require('../config/config.cjs');

function registerIpcHandlers(ipcMain) {

  ipcMain.handle('open-site', async (event, siteId) => {
    try {
      console.log('[open-site] Request for siteId =', siteId);

      const apiUrl = `${config.api.baseUrl}${config.api.accessPath}?accessdetails=${siteId}`;

      let apiResponse;
      try {
        apiResponse = await axios.get(apiUrl, {
          // If later you add API auth, put headers here
          timeout: 10_000
        });
      } catch (err) {
        console.error('[open-site] API request failed:', err.message || err);
        return { ok: false, error: 'API_REQUEST_FAILED' };
      }

      const data = apiResponse.data;
      if (!data || data.ok !== true) {
        console.error('[open-site] API returned error:', data && data.error);
        return { ok: false, error: data && data.error ? data.error : 'API_ERROR' };
      }

      const url = data.url;
      const cookieArray = data.cookies;

      if (!url) {
        console.error('[open-site] API ok but url is empty for siteId =', siteId);
        return { ok: false, error: 'EMPTY_URL' };
      }

      if (!Array.isArray(cookieArray)) {
        console.error('[open-site] cookies is not an array from API');
        return { ok: false, error: 'BAD_COOKIES_FORMAT' };
      }

      // 2) Inject cookies into this tab's session
      const ses = event.sender.session;
      const baseUrl = new URL(url);
      const cookieUrl = `${baseUrl.protocol}//${baseUrl.host}`;

      let injectedCount = 0;

      for (const c of cookieArray) {
        const name = c.name || c.key;
        if (!name) {
          console.warn('[open-site] Skipping cookie with no name:', c);
          continue;
        }

        const value = c.value ?? '';

        const cookieDetails = {
          // Simple: all cookies for this site origin
          url: cookieUrl,
          name,
          value,
          domain: c.domain,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly
        };

        // Expiry fields from Chrome export
        if (c.expirationDate != null) {
          cookieDetails.expirationDate = Number(c.expirationDate);
        } else if (c.expiry != null) {
          cookieDetails.expirationDate = Number(c.expiry);
        }

        try {
          await ses.cookies.set(cookieDetails);
          injectedCount += 1;
        } catch (err) {
          // If Chromium rejects a cookie (e.g. special prefixes), skip it
          console.warn(
            '[open-site] Skipping cookie',
            name,
            'because set() failed:',
            err.message || err
          );
          continue;
        }
      }

      console.log(
        '[open-site] Injected',
        injectedCount,
        'cookies out of',
        cookieArray.length,
        'for site',
        siteId
      );

      // 3) Finally open the URL
      await event.sender.loadURL(url);

      return { ok: true };
    } catch (err) {
      console.error('[open-site] Error:', err);
      return {
        ok: false,
        error: err.code || err.message || String(err)
      };
    }
  });

}

module.exports = registerIpcHandlers;