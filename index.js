"use strict";

const { addLog, getLogs } = require("./logger");
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock } = goals;
const config = require("./settings.json");
const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");

// ============================================================
// EXPRESS SERVER - Dashboard & API Control
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

// Bot state tracking
let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false,
};

// Serve static Dashboard index.html
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  res.send(`<h1>Minecraft AFK Bot Running</h1><p>Server: ${config.server.ip}:${config.server.port}</p>`);
});

app.get("/health", (req, res) => {
  res.json({
    status: botState.connected ? "connected" : "disconnected",
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: bot && bot.entity ? bot.entity.position : { x: 0, y: 100, z: 0 },
    lastActivity: botState.lastActivity,
    reconnectAttempts: botState.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
  });
});

app.get("/ping", (req, res) => res.send("pong"));

app.get("/logs", (req, res) => {
  res.json(getLogs());
});

let botRunning = true;

app.post("/start", (req, res) => {
  if (botRunning) return res.json({ success: false, msg: "Already running" });

  botRunning = true;
  createBot();
  addLog("[Control] Bot started");

  res.json({ success: true });
});

app.post("/stop", (req, res) => {
  if (!botRunning) return res.json({ success: false, msg: "Already stopped" });

  botRunning = false;

  if (bot) {
    bot.end();
    bot = null;
  }

  clearAllIntervals();
  addLog("[Control] Bot stopped");

  res.json({ success: true });
});

app.post("/command", express.json(), (req, res) => {
  const cmd = (req.body.command || "").trim();
  if (!cmd) return res.json({ success: false, msg: "Empty command." });

  addLog(`[Console] > ${cmd}`);

  if (cmd === "/help") {
    const lines = [
      "Available commands:",
      "  /help          - Show this help message",
      "  /pos           - Show bot's current coordinates",
      "  /status        - Show bot connection status",
      "  /list          - Ask server for player list",
      "  /say <message> - Send a chat message in-game",
    ];
    lines.forEach((l) => addLog(`[Console] ${l}`));
    return res.json({ success: true, msg: lines.join("\n") });
  }

  if (cmd === "/pos" || cmd === "/coords") {
    const pos = bot && bot.entity ? bot.entity.position : null;
    const msg = pos
      ? `Position: X=${Math.floor(pos.x)}  Y=${Math.floor(pos.y)}  Z=${Math.floor(pos.z)}`
      : "Position unavailable (bot not spawned).";
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (cmd === "/status") {
    const status = botState.connected ? "Connected" : "Disconnected";
    const uptime = Math.floor((Date.now() - botState.startTime) / 1000);
    const msg = `Status: ${status} | Uptime: ${uptime}s | Reconnects: ${botState.reconnectAttempts}`;
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (!bot || typeof bot.chat !== "function") {
    const msg = bot
      ? "Bot is still connecting — try again in a moment."
      : "Bot is not running.";
    addLog(`[Console] ${msg}`);
    return res.json({ success: false, msg });
  }

  try {
    bot.chat(cmd);
    addLog(`[Console] Sent to server: ${cmd}`);
    return res.json({ success: true, msg: `Sent: ${cmd}` });
  } catch (err) {
    addLog(`[Console] Error: ${err.message}`);
    return res.json({ success: false, msg: err.message });
  }
});

// HTTP Server Launch
const server = app.listen(PORT, "0.0.0.0", () => {
  addLog(`[Server] Dashboard HTTP server active on port ${server.address().port}`);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    const fallbackPort = PORT + 1;
    addLog(`[Server] Port ${PORT} in use - trying fallback port ${fallbackPort}`);
    server.listen(fallbackPort, "0.0.0.0");
  } else {
    addLog(`[Server] HTTP server error: ${err.message}`);
  }
});

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

// Self-Ping System
const SELF_PING_INTERVAL = 10 * 60 * 1000;
function startSelfPing() {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (!renderUrl) return;
  setInterval(() => {
    const protocol = renderUrl.startsWith("https") ? https : http;
    protocol.get(`${renderUrl}/ping`, () => {}).on("error", (err) => {
      addLog(`[KeepAlive] Self-ping failed: ${err.message}`);
    });
  }, SELF_PING_INTERVAL);
  addLog("[KeepAlive] Self-ping system active");
}
startSelfPing();

// Memory Monitoring
setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
  addLog(`[Memory] Heap: ${heapMB} MB`);
}, 5 * 60 * 1000);

// Bot Instance & Reconnection Loop
let bot = null;
let activeIntervals = [];
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let isReconnecting = false;

function clearBotTimeouts() {
  if (reconnectTimeoutId) clearTimeout(reconnectTimeoutId);
  if (connectionTimeoutId) clearTimeout(connectionTimeoutId);
  reconnectTimeoutId = null;
  connectionTimeoutId = null;
}

function clearAllIntervals() {
  activeIntervals.forEach((id) => clearInterval(id));
  activeIntervals = [];
}

function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id);
  return id;
}

function getReconnectDelay() {
  const baseDelay = config.utils["auto-reconnect-delay"] || 3000;
  const maxDelay = config.utils["max-reconnect-delay"] || 120000;
  const delay = Math.min(baseDelay * Math.pow(2, botState.reconnectAttempts), maxDelay);
  return delay + Math.floor(Math.random() * 2000);
}

function createBot() {
  if (isReconnecting) return;

  if (bot) {
    clearAllIntervals();
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (e) {}
    bot = null;
  }

  addLog(`[Bot] Connecting to ${config.server.ip}:${config.server.port}...`);

  try {
    const botVersion = config.server.version && config.server.version.trim() !== "" ? config.server.version : false;
    bot = mineflayer.createBot({
      username: config["bot-account"].username,
      password: config["bot-account"].password || undefined,
      auth: config["bot-account"].type,
      host: config.server.ip,
      port: config.server.port,
      version: botVersion,
      hideErrors: false,
      checkTimeoutInterval: 600000,
    });

    bot.loadPlugin(pathfinder);

    clearBotTimeouts();
    connectionTimeoutId = setTimeout(() => {
      if (!botState.connected) {
        addLog("[Bot] Connection timeout - re-initiating");
        try { bot.end(); } catch (e) {}
        bot = null;
        scheduleReconnect();
      }
    }, 150000);

    let spawnHandled = false;

    bot.once("spawn", () => {
      if (spawnHandled) return;
      spawnHandled = true;

      clearBotTimeouts();
      botState.connected = true;
      botState.lastActivity = Date.now();
      botState.reconnectAttempts = 0;
      isReconnecting = false;

      addLog(`[Bot] [+] Successfully spawned on server! (Version: ${bot.version})`);

      const mcData = require("minecraft-data")(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowFreeMotion = false;
      defaultMove.canDig = false;

      initializeModules(bot, mcData, defaultMove);
    });

    bot.on("kicked", (reason) => {
      addLog(`[Bot] Kicked: ${typeof reason === "object" ? JSON.stringify(reason) : reason}`);
      botState.connected = false;
      clearAllIntervals();
    });

    bot.on("end", (reason) => {
      addLog(`[Bot] Disconnected: ${reason || "Connection closed"}`);
      botState.connected = false;
      clearAllIntervals();
      spawnHandled = false;
      scheduleReconnect();
    });

    bot.on("error", (err) => {
      addLog(`[Bot] Error: ${err.message || err}`);
    });
  } catch (err) {
    addLog(`[Bot] Creation failed: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearBotTimeouts();
  if (isReconnecting) return;

  isReconnecting = true;
  botState.reconnectAttempts++;
  const delay = getReconnectDelay();
  addLog(`[Bot] Reconnecting in ${(delay / 1000).toFixed(0)}s (Attempt #${botState.reconnectAttempts})`);

  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    isReconnecting = false;
    createBot();
  }, delay);
}

function initializeModules(bot, mcData, defaultMove) {
  addLog("[Modules] Initializing Anti-AFK & Automation systems...");

  // Auto Auth
  if (config.utils["auto-auth"] && config.utils["auto-auth"].enabled) {
    const password = config.utils["auto-auth"].password;
    bot.on("messagestr", (msg) => {
      const lower = msg.toLowerCase();
      if (lower.includes("/register")) bot.chat(`/register ${password} ${password}`);
      else if (lower.includes("/login")) bot.chat(`/login ${password}`);
    });
  }

  // Anti-AFK Arm Swing
  addInterval(() => {
    if (bot && botState.connected) {
      try { bot.swingArm(); } catch (e) {}
    }
  }, 15000);

  // Chat Spammer
  if (config.utils["chat-messages"] && config.utils["chat-messages"].enabled) {
    const messages = config.utils["chat-messages"].messages;
    let idx = 0;
    addInterval(() => {
      if (bot && botState.connected && messages.length > 0) {
        bot.chat(messages[idx]);
        idx = (idx + 1) % messages.length;
      }
    }, (config.utils["chat-messages"]["repeat-delay"] || 120) * 1000);
  }
}

// System Crash Protection
process.on("uncaughtException", (err) => {
  addLog(`[FATAL] Recovered from exception: ${err.message}`);
  botState.connected = false;
  clearAllIntervals();
  isReconnecting = false;
  setTimeout(scheduleReconnect, 5000);
});

// Launch Bot
addLog("==================================================");
addLog("  Minecraft AFK Bot v2.5 Control Center");
addLog("==================================================");
createBot();