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
  const paths = ['/findings', '/approvals', '/teardown', '/config', '/scan', '/jobs', '/activity'];
  // eslint-disable-next-line no-console
  console.log(`[setupProxy] proxying ${paths.join(', ')} -> ${target}`);

  // Mounted at the root with a filter: Express strips the mount path from req.url
  // when a path is given to app.use, which would drop /findings etc. The API
  // Gateway stage in the target (e.g. /prod) is prepended to each path.
  // /approvals and /findings are also page routes: a browser navigation (Accept:
  // text/html) must get the app, only XHR calls from axios go to the API.
  const isApiCall = (pathname, req) =>
    paths.some((p) => pathname === p || pathname.startsWith(`${p}/`)) &&
    !(req.headers.accept || '').includes('text/html');

  module.exports = function (app) {
    app.use(
      createProxyMiddleware(isApiCall, {
        target,
        changeOrigin: true,
        logLevel: 'warn',
      })
    );
  };
}
