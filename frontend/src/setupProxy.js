// Dev-server proxy (Create React App picks this up automatically).
//
// Without it, `npm start` sends /findings, /approvals, ... to the dev server
// itself, which replies "Cannot GET /findings" because axios does not send an
// `Accept: text/html` header and historyApiFallback does not apply. With the
// proxy in place the browser only ever talks to localhost:3000, so there is no
// CORS preflight in development at all.
//
// The target comes from REACT_APP_API_URL in .env — see .env.example.
// Production builds do not use this file; they call the API directly.

const { createProxyMiddleware } = require('http-proxy-middleware');

const target = process.env.REACT_APP_API_URL;

if (!target) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n[setupProxy] REACT_APP_API_URL is not set, so API calls are NOT being proxied.\n' +
      '             Copy .env.example to .env and set it to your API base URL,\n' +
      '             then restart npm start.\n'
  );
  module.exports = function () {};
} else {
  // eslint-disable-next-line no-console
  console.log(`[setupProxy] proxying /findings, /approvals, /teardown, /config -> ${target}`);

  module.exports = function (app) {
    app.use(
      '/findings',
      '/approvals',
      '/teardown',
      '/config',
      createProxyMiddleware({
        target,
        changeOrigin: true,
        // API Gateway stages are part of the path and must be preserved.
        pathRewrite: (path) => path,
        logLevel: 'warn',
      })
    );
  };
}
