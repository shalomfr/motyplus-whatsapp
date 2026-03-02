const express = require("express");
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const QRCode = require("qrcode");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || "motyplus-whatsapp-secret";
const AUTH_DIR = "./auth_info";

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

// State
let sock = null;
let qrBase64 = null;
let qrString = null;
let connectionStatus = "disconnected"; // disconnected | connecting | connected
let phoneNumber = null;
let reconnectTimer = null;

// Auth middleware
function authCheck(req, res, next) {
  const key = req.headers["apikey"] || req.headers["x-api-key"] || req.query.apikey;
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Initialize WhatsApp connection
async function connectWhatsApp() {
  if (sock) {
    try { sock.end(undefined); } catch (e) { /* ignore */ }
    sock = null;
  }

  qrBase64 = null;
  qrString = null;
  connectionStatus = "connecting";

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`Connecting with Baileys version ${version.join(".")}...`);

    sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: true,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      browser: ["MotyPlus CRM", "Chrome", "1.0.0"],
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrString = qr;
        try {
          qrBase64 = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          console.log("QR code generated!");
        } catch (e) {
          console.error("QR generation error:", e);
        }
      }

      if (connection === "open") {
        connectionStatus = "connected";
        qrBase64 = null;
        qrString = null;
        phoneNumber = sock.user?.id?.split(":")[0] || sock.user?.id?.split("@")[0] || null;
        console.log(`Connected! Phone: ${phoneNumber}`);
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`Connection closed. Code: ${statusCode}, Reconnect: ${shouldReconnect}`);

        connectionStatus = "disconnected";
        sock = null;

        if (shouldReconnect) {
          console.log("Reconnecting in 5 seconds...");
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connectWhatsApp, 5000);
        } else {
          console.log("Logged out. Not reconnecting.");
          phoneNumber = null;
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);
  } catch (error) {
    console.error("Connection error:", error);
    connectionStatus = "disconnected";
    // Retry in 10 seconds
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWhatsApp, 10000);
  }
}

// ===== API Routes =====

// Health check
app.get("/", (req, res) => {
  res.json({
    status: 200,
    message: "MotyPlus WhatsApp Service",
    version: "1.0.0",
    whatsapp: connectionStatus,
  });
});

// Get connection status + QR
app.get("/status", authCheck, (req, res) => {
  res.json({
    configured: true,
    status: connectionStatus,
    phone: phoneNumber,
    qrcode: qrBase64 || null,
  });
});

// Connect / reconnect (QR mode)
app.post("/connect", authCheck, async (req, res) => {
  if (connectionStatus === "connected") {
    return res.json({ status: "connected", phone: phoneNumber });
  }
  connectWhatsApp();
  // Wait a bit for QR
  let waited = 0;
  while (!qrBase64 && connectionStatus !== "connected" && waited < 15000) {
    await new Promise((r) => setTimeout(r, 500));
    waited += 500;
  }
  res.json({
    status: connectionStatus,
    qrcode: qrBase64 || null,
    phone: phoneNumber,
  });
});

// Connect via pairing code (phone number)
app.post("/pair", authCheck, async (req, res) => {
  if (connectionStatus === "connected") {
    return res.json({ status: "connected", phone: phoneNumber });
  }

  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "phone number required" });

  // Format phone: remove non-digits, ensure 972 prefix
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("0")) digits = "972" + digits.slice(1);
  if (!digits.startsWith("972")) digits = "972" + digits;

  // Need a fresh connection for pairing code
  if (sock) {
    try { sock.end(undefined); } catch (e) { /* ignore */ }
    sock = null;
  }
  qrBase64 = null;
  qrString = null;
  connectionStatus = "connecting";

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      browser: ["MotyPlus CRM", "Chrome", "1.0.0"],
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        connectionStatus = "connected";
        qrBase64 = null;
        phoneNumber = sock.user?.id?.split(":")[0] || sock.user?.id?.split("@")[0] || null;
        console.log(`Connected via pairing! Phone: ${phoneNumber}`);
      }
      if (connection === "close") {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        connectionStatus = "disconnected";
        sock = null;
        if (shouldReconnect) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(connectWhatsApp, 5000);
        }
      }
    });
    sock.ev.on("creds.update", saveCreds);

    // Wait for socket to be ready, then request pairing code
    let waited = 0;
    while (!sock.authState?.creds?.registered && connectionStatus === "connecting" && waited < 10000) {
      await new Promise((r) => setTimeout(r, 500));
      waited += 500;
    }

    if (sock.authState?.creds?.registered) {
      return res.json({ status: connectionStatus, phone: phoneNumber });
    }

    const code = await sock.requestPairingCode(digits);
    console.log(`Pairing code for ${digits}: ${code}`);

    res.json({
      status: "pairing",
      pairingCode: code,
      message: `Enter code ${code} in WhatsApp > Linked Devices > Link a Device > Link with phone number`,
    });
  } catch (error) {
    console.error("Pairing error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Disconnect / logout
app.post("/disconnect", authCheck, (req, res) => {
  clearTimeout(reconnectTimer);
  if (sock) {
    try { sock.logout(); } catch (e) { /* ignore */ }
    try { sock.end(undefined); } catch (e) { /* ignore */ }
    sock = null;
  }
  connectionStatus = "disconnected";
  phoneNumber = null;
  qrBase64 = null;
  res.json({ message: "Disconnected" });
});

// Send text message
app.post("/send", authCheck, async (req, res) => {
  if (!sock || connectionStatus !== "connected") {
    return res.status(400).json({ error: "WhatsApp not connected" });
  }
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: "phone and message required" });
  }

  // Format phone number to WhatsApp JID
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("0")) digits = "972" + digits.slice(1);
  if (!digits.startsWith("972")) digits = "972" + digits;
  const jid = digits + "@s.whatsapp.net";

  try {
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true, jid });
  } catch (error) {
    console.error("Send error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Start server + connect
app.listen(PORT, () => {
  console.log(`WhatsApp service running on port ${PORT}`);
  connectWhatsApp();
});
