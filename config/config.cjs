// config/config.cjs
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load .env from project root (both for dev and build)
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const config = {
  api: {

    baseUrl: process.env.API_BASE_URL,

    accessPath: process.env.API_ACCESS_PATH,

    //token: process.env.API_TOKEN || ''
  },

  app: {
    startUrl: process.env.APP_START_URL
  }
};

module.exports = config;