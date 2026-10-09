import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

/**
 * STANDALONE SAWYER SHIP SERVER (Node.js ESM)
 * Port: 3000 (Configurable)
 * Dependencies: express, cors (npm install express cors)
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const ENCRYPTION_KEY = process.env.SERVER_STORAGE_KEY || 'sawyer-ship-secure-v2-dev-key-32ch';
const IV_LENGTH = 16;
const STORAGE_DIR = path.join(__dirname, 'storage');
const CREDS_FILE = path.join(STORAGE_DIR, 'carrier-credentials.enc');
const APP_DATA_FILE = path.join(STORAGE_DIR, 'app-data.enc');

console.log('--- Sawyer Ship Standalone Server ---');
console.log(`Node Version: ${process.version}`);
console.log(`Working Directory: ${process.cwd()}`);
console.log(`Storage Path: ${STORAGE_DIR}`);
console.log('-------------------------------------');

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit for full data sync and labels

// --- Encryption Utility ---
function getEncryptionKey(customPassword = null) {
  const baseKey = process.env.SERVER_STORAGE_KEY || 'sawyer-ship-secure-v2-dev-key-32ch';
  const finalKey = customPassword ? `${baseKey}:${customPassword}` : baseKey;
  // Normalize key to exactly 32 bytes using SHA-256 to avoid "Invalid key length" errors
  return crypto.createHash('sha256').update(String(finalKey)).digest();
}

function encrypt(text, password = null) {
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = getEncryptionKey(password);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch (error) {
    console.error('[Encryption] Encrypt failed:', error.message);
    throw new Error(`Encryption failed: ${error.message}`);
  }
}

function decrypt(text, password = null) {
  try {
    const textParts = text.split(':');
    const ivStr = textParts.shift();
    if (!ivStr) throw new Error('Invalid encrypted format');
    const iv = Buffer.from(ivStr, 'hex');
    const key = getEncryptionKey(password);
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (error) {
    console.error('[Encryption] Decrypt failed:', error.message);
    throw new Error(`Decryption failed: ${error.message}`);
  }
}

// --- Storage Logic ---
async function writeStore(filePath, data, password = null) {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  const encrypted = encrypt(JSON.stringify(data), password);
  await fs.writeFile(filePath, encrypted, 'utf8');
}

async function readStore(filePath, password = null) {
  if (!(await fs.access(filePath).then(() => true).catch(() => false))) {
    return null;
  }
  const encrypted = await fs.readFile(filePath, 'utf8');
  return JSON.parse(decrypt(encrypted, password));
}

async function saveCredentials(data) {
  console.log('[Storage] Saving credentials to disk...');
  await writeStore(CREDS_FILE, data);
  console.log('[Storage] Success: Credentials saved.');
}

async function loadCredentials() {
  try {
    return await readStore(CREDS_FILE);
  } catch (err) {
    console.error('[Storage] Load Credentials Error:', err.message);
    return null;
  }
}

// --- UPS Client Implementation ---
class UPSClient {
  constructor(apiKey, secretKey, accountNumber, isSandbox) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.accountNumber = accountNumber;
    this.baseUrl = isSandbox ? 'https://sandbox.api.ups.com' : 'https://api.ups.com';
  }

  async getAccessToken() {
    const auth = Buffer.from(`${this.apiKey}:${this.secretKey}`).toString('base64');
    console.log(`[UPS] Requesting OAuth token (${this.baseUrl})...`);
    const response = await fetch(`${this.baseUrl}/security/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials' })
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`[UPS] Auth failed: ${response.status}`, text);
      throw new Error(`UPS Auth Failed (${response.status}): ${text}`);
    }
    const data = await response.json();
    return data.access_token;
  }

  async request(endpoint, options = {}) {
    try {
      const token = await this.getAccessToken();
      console.log(`[UPS] Request: ${options.method || 'GET'} ${endpoint}`);
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(this.accountNumber ? { 'x-merchant-id': this.accountNumber } : {}),
          'transId': `sawyer-${Date.now()}`,
          'transactionSrc': 'sawyer-ship',
          ...options.headers
        }
      });

      const contentType = response.headers.get('content-type');
      let data;
      if (contentType && contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = { message: await response.text() };
      }

      if (!response.ok) {
        console.error(`[UPS] API Error (${response.status}):`, data);
        const errMsg = data?.response?.errors?.[0]?.message || data?.errors?.[0]?.message || data?.message || 'UPS API Error';
        throw new Error(errMsg);
      }
      return data;
    } catch (error) {
      console.error(`[UPS] Request failed:`, error.message);
      throw error;
    }
  }
}

// --- FedEx Client Implementation ---
class FedExClient {
  constructor(apiKey, secretKey, accountNumber, isSandbox) {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.accountNumber = accountNumber;
    this.baseUrl = isSandbox ? 'https://apis-sandbox.fedex.com' : 'https://apis.fedex.com';
  }

  async getAccessToken() {
    try {
      console.log(`[FedEx] Requesting OAuth token (${this.baseUrl})...`);
      const response = await fetch(`${this.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ 
          grant_type: 'client_credentials', 
          client_id: this.apiKey, 
          client_secret: this.secretKey 
        })
      });

      if (!response.ok) {
        const text = await response.text();
        console.error(`[FedEx] Auth failed: ${response.status}`, text);
        throw new Error(`FedEx Auth Failed (${response.status}): ${text}`);
      }
      const data = await response.json();
      return data.access_token;
    } catch (error) {
      console.error(`[FedEx] OAuth failed:`, error.message);
      throw error;
    }
  }

  async request(endpoint, options = {}) {
    try {
      const token = await this.getAccessToken();
      console.log(`[FedEx] Request: ${options.method || 'GET'} ${endpoint}`);
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...options.headers
        }
      });

      const contentType = response.headers.get('content-type');
      let data;
      if (contentType && contentType.includes('application/json')) {
        data = await response.json();
      } else {
        data = { message: await response.text() };
      }

      if (!response.ok) {
        console.error(`[FedEx] API Error (${response.status}):`, data);
        const errMsg = data?.errors?.[0]?.message || data?.message || 'FedEx API Error';
        throw new Error(errMsg);
      }
      return data;
    } catch (error) {
      console.error(`[FedEx] Request failed:`, error.message);
      throw error;
    }
  }
}

// --- Magento Client Implementation ---
class MagentoClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  async fetch(endpoint, options = {}) {
    const url = `${this.baseUrl}/rest/V1/${endpoint}`;
    console.log(`[Magento] Request: ${options.method || 'GET'} ${url}`);
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data.message || response.statusText || 'Magento API Error';
      throw new Error(`Magento Error (${response.status}): ${msg}`);
    }
    return data;
  }
}

// --- API Routes ---
app.get('/api/health', (req, res) => {
  console.log('[Server] Health check ping');
  res.json({ status: 'ok', version: '4.0.0' });
});

app.post('/api/magento/:action', async (req, res) => {
  const { action } = req.params;
  try {
    console.log(`[Magento Proxy] Starting action: ${action}`);
    const creds = await loadCredentials();
    if (!creds?.magento) throw new Error('Magento credentials not configured on server');
    
    const magento = new MagentoClient(creds.magento.url || creds.magento.baseUrl, creds.magento.token);
    let result;
    const { params } = req.body;

    if (action === 'orders') {
      const { query } = params;
      const searchCriteria = `searchCriteria[filter_groups][0][filters][0][field]=increment_id&searchCriteria[filter_groups][0][filters][0][value]=%25${query}%25&searchCriteria[filter_groups][0][filters][0][condition_type]=like`;
      result = await magento.fetch(`orders?${searchCriteria}`);
    } 
    else if (action === 'order') {
      const { id } = params;
      try {
        result = await magento.fetch(`orders/${id}`);
      } catch (e) {
        if (e.message.includes('404')) {
          const searchCriteria = `searchCriteria[filter_groups][0][filters][0][field]=increment_id&searchCriteria[filter_groups][0][filters][0][value]=${id}&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`;
          const data = await magento.fetch(`orders?${searchCriteria}`);
          if (data.items?.length > 0) result = data.items[0];
          else throw e;
        } else throw e;
      }
    }
    else if (action === 'products') {
      const { skus } = params;
      const searchCriteria = `searchCriteria[filter_groups][0][filters][0][field]=sku&searchCriteria[filter_groups][0][filters][0][value]=${skus.map(s => encodeURIComponent(s)).join(',')}&searchCriteria[filter_groups][0][filters][0][condition_type]=in`;
      result = await magento.fetch(`products?${searchCriteria}`);
    }
    else if (action === 'ship') {
      const { orderId, tracks } = params;
      result = await magento.fetch(`order/${orderId}/ship`, {
        method: 'POST',
        body: JSON.stringify({
          items: [],
          notify: true,
          appendComment: true,
          comment: { extension_attributes: {}, comment: "Shipment created via Sawyer-Ship Server", is_visible_on_front: 1 },
          tracks: tracks
        })
      });
    }
    else if (action === 'attribute-options') {
      const { attributeCode } = params;
      result = await magento.fetch(`products/attributes/${attributeCode}/options`);
    }
    else throw new Error(`Unknown Magento action: ${action}`);

    res.json(result);
  } catch (e) {
    console.error(`[Magento Proxy] Action ${action} failed:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings/credentials', async (req, res) => {
  try {
    console.log('[Server] Received credential sync request');
    await saveCredentials(req.body.credentials);
    res.json({ success: true });
  } catch (e) {
    console.error('[Server] Sync failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings/credentials', async (req, res) => {
  try {
    const creds = await loadCredentials();
    res.json({ credentials: creds });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/data/save', async (req, res) => {
  try {
    const { data, password } = req.body;
    console.log('[Server] Saving full application data...');
    await writeStore(APP_DATA_FILE, data, password);
    res.json({ success: true });
  } catch (e) {
    console.error('[Server] Data save failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/data/load', async (req, res) => {
  try {
    const { password } = req.body;
    console.log('[Server] Loading full application data...');
    const data = await readStore(APP_DATA_FILE, password);
    res.json({ data });
  } catch (e) {
    console.error('[Server] Data load failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ups/:action', async (req, res) => {
  const { action } = req.params;
  try {
    console.log(`[UPS Proxy] Starting action: ${action}`);
    const creds = await loadCredentials();
    if (!creds?.ups) throw new Error('UPS credentials not configured on server');
    
    const ups = new UPSClient(creds.ups.apiKey, creds.ups.secretKey, creds.ups.accountNumber, creds.ups.isSandbox);
    let result;
    const { params } = req.body;

    if (action === 'rates') result = await ups.request('/api/rating/v1/shop', { method: 'POST', body: JSON.stringify(params) });
    else if (action === 'ship') result = await ups.request('/api/shipments/v1/ship', { method: 'POST', body: JSON.stringify(params) });
    else if (action === 'track') {
      const trackingNum = params.trackingNumber || params;
      result = await ups.request(`/api/track/v1/details/${trackingNum}?locale=en_US`);
    }
    else if (action === 'cancel') result = await ups.request(`/api/shipments/v1/void/cancel/${params.trackingNumber}`, { method: 'PUT' });
    else if (action === 'validate-address') result = await ups.request('/api/addressvalidation/v1/1', { method: 'POST', body: JSON.stringify(params) });
    else throw new Error(`Unknown UPS action: ${action}`);

    res.json(result);
  } catch (e) {
    console.error(`[UPS Proxy] Action ${action} failed:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fedex/:action', async (req, res) => {
  const { action } = req.params;
  try {
    console.log(`[FedEx Proxy] Starting action: ${action}`);
    const creds = await loadCredentials();
    if (!creds?.fedex) throw new Error('FedEx credentials not configured on server');
    
    const isSandbox = creds.fedex.isSandbox;
    let apiKey, secretKey, accountNumber;

    if (action === "track") {
      const isTrackingSandbox = creds.fedex.isTrackingSandbox;
      apiKey = isTrackingSandbox 
        ? (creds.fedex.sandboxTrackingApiKey || creds.fedex.sandboxApiKey)
        : (creds.fedex.productionTrackingApiKey || creds.fedex.productionApiKey || creds.fedex.apiKey);
      secretKey = isTrackingSandbox
        ? (creds.fedex.sandboxTrackingSecretKey || creds.fedex.sandboxSecretKey)
        : (creds.fedex.productionTrackingSecretKey || creds.fedex.productionSecretKey || creds.fedex.secretKey);
      accountNumber = isTrackingSandbox
        ? (creds.fedex.sandboxTrackingAccountNumber || creds.fedex.accountNumber)
        : (creds.fedex.productionTrackingAccountNumber || creds.fedex.productionAccountNumber || creds.fedex.accountNumber);
    } else {
      apiKey = isSandbox 
        ? creds.fedex.sandboxApiKey 
        : (creds.fedex.productionApiKey || creds.fedex.apiKey);
      secretKey = isSandbox 
        ? creds.fedex.sandboxSecretKey 
        : (creds.fedex.productionSecretKey || creds.fedex.secretKey);
      accountNumber = isSandbox 
        ? creds.fedex.accountNumber 
        : (creds.fedex.productionAccountNumber || creds.fedex.accountNumber);
    }

    const fedex = new FedExClient(
      apiKey,
      secretKey,
      accountNumber,
      action === "track" ? creds.fedex.isTrackingSandbox : isSandbox
    );

    let result;
    const { params } = req.body;

    if (action === 'rates') result = await fedex.request('/rate/v1/rates/quotes', { method: 'POST', body: JSON.stringify(params) });
    else if (action === 'ship') result = await fedex.request('/ship/v1/shipments', { method: 'POST', body: JSON.stringify(params) });
    else if (action === 'track') {
      const trackingNum = params.trackingNumber || params;
      result = await fedex.request('/track/v1/trackingnumbers', { method: 'POST', body: JSON.stringify({ trackingInfo: [{ trackingNumberInfo: { trackingNumber: trackingNum } }], includeDetailedScans: true }) });
    }
    else if (action === 'cancel') {
      result = await fedex.request('/ship/v1/shipments/cancel', { 
        method: 'PUT', 
        body: JSON.stringify({ 
          accountNumber: { value: accountNumber }, 
          trackingNumber: params.trackingNumber 
        }) 
      });
    }
    else if (action === 'validate-address') result = await fedex.request('/address/v1/addresses/resolve', { method: 'POST', body: JSON.stringify(params) });
    else throw new Error(`Unknown FedEx action: ${action}`);

    res.json(result);
  } catch (e) {
    console.error(`[FedEx Proxy] Action ${action} failed:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- Static File Serving ---
// Serve frontend assets if they exist (for standalone deployment)
const distPath = path.join(__dirname, 'dist');
fs.access(distPath)
  .then(() => {
    console.log(`[Server] Serving frontend from: ${distPath}`);
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      // Don't intercept API routes
      if (req.url.startsWith('/api/')) return res.status(404).json({ error: 'Endpoint not found' });
      res.sendFile(path.join(distPath, 'index.html'));
    });
  })
  .catch(() => {
    console.log('[Server] "dist" folder not found. Frontend serving disabled.');
  });

app.listen(PORT, '0.0.0.0', () => console.log(`Standalone Sawyer Server running on http://0.0.0.0:${PORT}`));
