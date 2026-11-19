'use strict';
// Startup file. Works with `npm start` and with cPanel "Setup Node.js App" (Passenger),
// so it always starts listening instead of checking require.main.
const { load } = require('./src/config');
const { createApp } = require('./src/app');

const config = load();
const app = createApp(config);

app.server.listen(config.port, config.host, () => {
  console.log(`Idea Map listening on ${config.host}:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
  if (!config.cookieSecure) console.warn('COOKIE_SECURE is off. Set COOKIE_SECURE=1 when serving over HTTPS.');
});

const shutdown = () => app.close().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
