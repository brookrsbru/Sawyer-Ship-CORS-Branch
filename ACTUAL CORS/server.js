// Listen on a specific host via the HOST environment variable
var host = process.env.HOST || '0.0.0.0';
// Listen on a specific port via the PORT environment variable
var port = process.env.PORT || 5072;

var originBlacklist = [];
var originWhitelist = [
  'http://localhost:5072', 
  'http://127.0.0.1:5072',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:9101', 
  'https://brookrsbru.github.io', 
  'https://fedex.com', 
  'https://bearingsrus.co.uk', 
  'https://apis-sandbox.fedex.com', 
  'https://apis.fedex.com', 
  'https://wwwcie.ups.com', 
  'https://onlinetools.ups.com', 
  'https://ais-dev-uztsdrd7k5dayqylvxsa3v-220604063459.europe-west1.run.app',
  'https://ais-pre-uztsdrd7k5dayqylvxsa3v-220604063459.europe-west1.run.app',
  'https://aistudio.google.com',
  'https://sandbox.api.ups.com',
  'https://api.ups.com',
];

function parseEnvList(env) {
  if (!env) return [];
  return env.split(',');
}

var http = require('http');
var checkRateLimit = require('./lib/rate-limit')(process.env.CORSANYWHERE_RATELIMIT);
var cors_proxy = require('./lib/cors-anywhere');

var proxyServer = cors_proxy.createServer({
  originBlacklist: originBlacklist,
  originWhitelist: originWhitelist,
  requireHeader: ['origin', 'x-requested-with'],
  checkRateLimit: checkRateLimit,
  removeHeaders: [
    'cookie',
    'cookie2',
    'x-request-start',
    'x-request-id',
    'via',
    'connect-time',
    'total-route-time',
  ],
  setHeaders: {
    // We force the User-Agent to look like a server, not a browser
    'user-agent': 'node.js',
  },
// 1. MASK THE REQUEST (Going to UPS)
  handleInitialRequest: function(req, res, location) {
    if (location.host.includes('ups.com')) {
      req.headers['origin'] = 'https://onlinetools.ups.com';
      req.headers['x-requested-with'] = 'XMLHttpRequest';
      delete req.headers['referer'];
      console.log(`[UPS-PROXY] Masking request for: ${location.href}`);
    }
    return false;
  },

  // 2. REWRITE THE RESPONSE (Coming back from UPS)
  // This prevents the "Redirect" error you just saw
  onProxyRes: function(proxyRes, req, res) {
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      console.log(`[UPS-PROXY] Redirect detected to: ${proxyRes.headers.location}`);
      // If UPS tries to redirect, we tell the browser the redirect is okay
      // and keep it pointed at our proxy instead of letting it fly to UPS
      var originalLocation = proxyRes.headers.location;
      if (originalLocation.includes('ups.com')) {
         proxyRes.headers.location = 'http://localhost:5072/' + originalLocation;
      }
    }
  },

  httpProxyOptions: {
    xfwd: false,
    followRedirects: false, // We handle them manually now via onProxyRes
  },
});

// Dedicated HTTP wrapper with ping / health response
var server = http.createServer(function(req, res) {
  var cleanUrl = (req.url || '').split('?')[0];

  // Dedicated ping endpoint for latency and reachability testing
  if (cleanUrl === '/ping' || cleanUrl === '/ping/' || cleanUrl === '/health' || cleanUrl === '/status' || cleanUrl === '/test') {
    var origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control, Pragma');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      message: 'Proxy is online and responding',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      port: port,
      host: host,
      proxy: 'CORS Proxy'
    }));
    return;
  }

  // Forward all other proxy requests to CORS Anywhere
  proxyServer.emit('request', req, res);
});

server.on('upgrade', function(req, socket, head) {
  proxyServer.emit('upgrade', req, socket, head);
});

server.listen(port, host, function() {
  console.log('Running CORS Proxy on ' + host + ':' + port);
});