import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  getContentType,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { fetchLatestBaileysVersion } from "@whiskeysockets/baileys";

const app = express();
const port = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PREFIX = "!";
const CMD_TAGALL = "tagall";
const DATA_DIR = path.join(__dirname, "data");
const GROUPS_DB = path.join(DATA_DIR, "subgroups.json");

let restarting = false;
let sock;

/* ----------------- 🔐 OWNER CONFIG ----------------- */
const OWNER_JIDS = [
  "918929676776@s.whatsapp.net", // 🟢 Your WhatsApp number
];

/* ----------------- 🔧 FILE HELPERS ----------------- */
function ensureDataStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(GROUPS_DB))
    fs.writeFileSync(GROUPS_DB, JSON.stringify({}), "utf8");
}

function loadDb() {
  ensureDataStore();
  try {
    const raw = fs.readFileSync(GROUPS_DB, "utf8");
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function saveDb(db) {
  ensureDataStore();
  fs.writeFileSync(GROUPS_DB, JSON.stringify(db, null, 2), "utf8");
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ----------------- 🧠 MESSAGE HELPERS ----------------- */
function extractNumbersFromText(text) {
  const nums = Array.from(new Set(text.match(/\b\d{8,15}\b/g) || []));
  return nums.map((n) => `${n}@s.whatsapp.net`);
}

async function extractMentionedJids(msg, sock, meta) {
  const type = getContentType(msg.message);
  let contextInfo;

  if (type === "extendedTextMessage") {
    contextInfo = msg.message.extendedTextMessage.contextInfo;
  } else if (type === "conversation") {
    contextInfo = {};
  } else {
    const inner = msg.message[type];
    contextInfo = inner?.contextInfo || {};
  }

  const groupIds = new Set((meta?.participants || []).map((p) => p.id));
  let jids = Array.isArray(contextInfo?.mentionedJid)
    ? [...contextInfo.mentionedJid]
    : [];

  const resolved = [];
  for (const id of jids) {
    if (id.endsWith("@lid")) {
      const num = id.replace("@lid", "");
      // Try to resolve via group members
      const match = (meta.participants || []).find((p) => p.id.includes(num));
      if (match?.id) resolved.push(match.id);
      else console.log("⚠️ Could not resolve LID:", id);
    } else resolved.push(id);
  }

  if (resolved.length === 0 && contextInfo?.participant) {
    const candidate = contextInfo.participant;
    if (groupIds.has(candidate)) resolved.push(candidate);
  }

  return Array.from(new Set(resolved)).filter((j) => groupIds.has(j));
}

/* ----------------- 👤 SELF-JID HELPERS ----------------- */
function normalizeJid(jid = "") {
  const match = jid.match(/(\d{6,15})/);
  return match ? match[1] : "";
}

function getSelfJid(sock) {
  return normalizeJid(sock?.user?.id || sock?.user?.jid || "");
}

function resolveLidToPhone(lidJid) {
  // Extract the LID number
  const lid = normalizeJid(lidJid);
  if (!lid) return null;

  try {
    // Try to find the reverse mapping file: lid-mapping-{LID}_reverse.json
    const authPath = path.join(__dirname, "auth_info");
    const reverseMappingPath = path.join(authPath, `lid-mapping-${lid}_reverse.json`);
    
    if (fs.existsSync(reverseMappingPath)) {
      const raw = fs.readFileSync(reverseMappingPath, "utf8");
      // The file contains just the phone number as a JSON string
      const phoneNumber = JSON.parse(raw);
      if (phoneNumber) {
        return `${phoneNumber}@s.whatsapp.net`;
      }
    }
  } catch (err) {
    console.log(`⚠️ Failed to resolve LID ${lid}:`, err.message);
  }
  
  return null;
}

function getQuotedMessage(msg) {
  const type = getContentType(msg.message);
  const ctx =
    msg.message?.[type]?.contextInfo ||
    msg.message?.extendedTextMessage?.contextInfo;

  if (!ctx?.quotedMessage) return null;

  return {
    key: {
      remoteJid: msg.key.remoteJid,
      fromMe: false,
      id: ctx.stanzaId,
      participant: ctx.participant || ctx.remoteJid,
    },
    message: ctx.quotedMessage,
  };
}

/* ----------------- 🧩 BOT START ----------------- */
async function startBot(backoffMs = 1000) {
  if (sock) {
    console.log("⚠️ Socket already exists, skipping restart");
    return;
  }

  try {
    const authPath = path.join(__dirname, "auth_info");

    // ✅ Validate and clean up corrupted credentials
    const credsPath = path.join(authPath, "creds.json");
    if (fs.existsSync(credsPath)) {
      try {
        const creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));

        // Check if credentials are corrupted or incomplete
        const hasValidMe =
          creds.me?.id && creds.me.id.includes("@s.whatsapp.net");
        const isRegistered = creds.registered === true;

        if (isRegistered && !hasValidMe) {
          console.log(
            "⚠️ Corrupted credentials detected (incomplete registration)"
          );
          console.log("🗑️ Deleting auth_info folder...");
          fs.rmSync(authPath, { recursive: true, force: true });
        } else if (isRegistered && hasValidMe) {
          console.log("✅ Found existing valid credentials");
          console.log("📱 Account:", creds.me.id);
        }
      } catch (parseErr) {
        console.log("⚠️ Failed to parse credentials, cleaning up...");
        fs.rmSync(authPath, { recursive: true, force: true });
      }
    }

    if (!fs.existsSync(authPath)) {
      fs.mkdirSync(authPath, { recursive: true });
      console.log("🆕 Starting fresh authentication...");
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    console.log("📡 Baileys version:", version.join("."));

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,

      // ✅ Disable QR generation completely
      generateHighQualityLinkPreview: true,

      // ✅ Correct SMBA fingerprint
      browser: ["Android", "Chrome", "121.0.0"],
      platform: "smba",

      keepAliveIntervalMs: 30000,
      markOnlineOnConnect: true,

      // ✅ Force mobile connection type
      defaultQueryTimeoutMs: undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    let pairingRequested = false;

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr, isNewLogin } = update;

      // Log all connection states for debugging
      if (connection) {
        console.log("🔄 Connection status:", connection);
      }

      // ❌ Ignore QR codes - we only use pairing codes
      if (qr) {
        console.log(
          "⚠️ QR code generated (ignored - using pairing code instead)"
        );
        return; // Don't process QR
      }

      // Request pairing code ONLY ONCE when first connecting
      if (connection === "connecting" && !pairingRequested) {
        // Check if already registered
        if (state.creds.registered) {
          console.log("✅ Using existing credentials...");
          pairingRequested = true; // Prevent re-requesting
          return;
        }

        pairingRequested = true;

        // ⏳ Wait for connection to stabilize
        await new Promise((r) => setTimeout(r, 3000)); // Increased to 3s

        try {
          const code = await sock.requestPairingCode("919911595299");
          console.log("");
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          console.log("🔐 PAIRING CODE:", code);
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          console.log("⏳ Steps:");
          console.log("1. Open WhatsApp on your phone");
          console.log("2. Settings → Linked Devices");
          console.log("3. Link a Device → Link with phone number");
          console.log("4. Enter code:", code);
          console.log("5. Wait for connection (don't restart bot!)");
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          console.log("");
        } catch (err) {
          console.error("❌ Pairing failed:", err.message);

          // If pairing fails, clean up and retry
          if (
            err.message.includes("Conflict") ||
            err.message.includes("rate")
          ) {
            console.log("⏳ Waiting 10s before retry...");
            await new Promise((r) => setTimeout(r, 10000));
          }

          pairingRequested = false;
        }
      }

      // Connection successful
      if (connection === "open") {
        console.log("");
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("✅ BOT CONNECTED SUCCESSFULLY!");
        console.log("📱 Account:", sock.user?.id);
        console.log("📛 Name:", sock.user?.name || "N/A");
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("");
        pairingRequested = false;
      }

      // Handle disconnections
      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMsg = lastDisconnect?.error?.message || "Unknown";

        console.log("");
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("🔴 DISCONNECTED");
        console.log("Code:", statusCode);
        console.log("Reason:", errorMsg);
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        // Check if should reconnect
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        // Handle specific error codes
        if (statusCode === 401 || statusCode === 403 || statusCode === 440) {
          console.log("🗑️ Invalid session - deleting credentials...");
          fs.rmSync(authPath, { recursive: true, force: true });
          sock = null;
          pairingRequested = false;

          // Restart fresh
          setTimeout(() => {
            startBot().catch(console.error);
          }, 2000);
          return;
        }

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("❌ Logged out - manual re-authentication required");
          console.log("Delete auth_info folder and restart bot");
          sock = null;
          return;
        }

        // Reconnect with backoff
        if (shouldReconnect && !restarting) {
          restarting = true;
          sock = null;
          pairingRequested = false;

          const delay = Math.min(backoffMs * 1.5, 15000);
          console.log(`⏳ Reconnecting in ${delay / 1000}s...`);

          setTimeout(() => {
            restarting = false;
            startBot(delay).catch(console.error);
          }, delay);
        }
      }
    });

    /* ----------------- 📩 MESSAGE HANDLER ----------------- */
    sock.ev.on("messages.upsert", async (upsert) => {
      try {
        const msg = upsert.messages?.[0];
        if (!msg || !msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const isGroup = remoteJid.endsWith("@g.us");
        const sender = msg.key.participant || msg.key.remoteJid;
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          "";
        const trimmed = text.trim();
        if (!trimmed.startsWith(PREFIX)) return;

        const withoutPrefix = trimmed.slice(PREFIX.length).trim();
        const [cmdRaw, ...args] = withoutPrefix.split(/\s+/);
        const cmd = (cmdRaw || "").toLowerCase();

        const db = loadDb();
        const groupKey = isGroup ? remoteJid : "global";
        if (!db[groupKey]) db[groupKey] = {};

        /* 🧩 DM PERMISSION CHECK */
        if (!isGroup) {
          let isOwner = false;
          
          // Try to resolve sender to phone number
          let phoneToCheck = sender;
          
          // If sender is a LID, try to resolve it using auth mappings
          if (sender.endsWith('@lid')) {
            const resolved = resolveLidToPhone(sender);
            if (resolved) {
              phoneToCheck = resolved;
            }
          }
          
          const normalizedPhone = normalizeJid(phoneToCheck);
          isOwner = OWNER_JIDS.some(ownerJid => normalizeJid(ownerJid) === normalizedPhone);
          
          if (!isOwner) {
            console.log(`❌ Ignored DM from unauthorized user: ${sender}`);
            return;
          }
        }

        /* ----------------- !tagall ----------------- */
        if (cmd === CMD_TAGALL && isGroup) {
          const meta = await sock.groupMetadata(remoteJid);
          const selfDigits = getSelfJid(sock);
          const members = meta.participants
            .filter((p) => {
              // Use phoneNumber for comparison if available (LID groups)
              const phoneToCheck = p?.phoneNumber || p?.jid || p?.id;
              return normalizeJid(phoneToCheck) !== selfDigits;
            })
            .map((p) => p.jid || p.id) // Return the actual JID for tagging
            .filter(Boolean);

          const chunks = chunkArray(members, 20);
          for (const chunk of chunks) {
            const tagMessage = chunk
              .map((m) => `@${m.split("@")[0]}`)
              .join(" ");
            const quoted = getQuotedMessage(msg);
            await sock.sendMessage(
              remoteJid,
              { text: tagMessage, mentions: chunk },
              quoted ? { quoted } : {}
            );
            await new Promise((r) => setTimeout(r, 400));
          }
          return;
        }

        /* ----------------- !group ----------------- */
        if (cmd === "group") {
          const subcmd = (args.shift() || "").toLowerCase();

          // Help for group command
          if (!subcmd) {
            await sock.sendMessage(remoteJid, {
              text: `🧩 *Subgroup Commands*
• !group add <name> <numbers or @mentions>
• !group remove <name> <numbers or @mentions>
• !group show <name>
• !group list
• !group delete <name>`,
            });
            return;
          }

          // Manage permissions: only owners can edit
          let resolvedSender = sender;
          if (sender.endsWith('@lid')) {
            const resolved = resolveLidToPhone(sender);
            if (resolved) resolvedSender = resolved;
          }
          
          const isOwner = OWNER_JIDS.some(ownerJid => 
            normalizeJid(ownerJid) === normalizeJid(resolvedSender)
          );
          
          if (!isOwner) {
            await sock.sendMessage(remoteJid, {
              text: "🚫 You don’t have permission to manage subgroups.",
            });
            return;
          }

          /* !group list */
          if (subcmd === "list") {
            const names = Object.keys(db[groupKey]);
            const lines = names.length
              ? names
                  .map((n) => `• *${n}* (${db[groupKey][n].length})`)
                  .join("\n")
              : "_No subgroups yet._";
            await sock.sendMessage(remoteJid, {
              text: `🧩 *${
                groupKey === "global" ? "Global" : "Group"
              } Subgroups*\n${lines}`,
            });
            return;
          }

          /* !group show <name> */
          if (subcmd === "show") {
            const name = (args.shift() || "").toLowerCase();
            const list = db[groupKey][name] || [];
            if (!list.length) {
              await sock.sendMessage(remoteJid, {
                text: `No members in *${name}*.`,
              });
              return;
            }
            const txt = list.map((j) => `@${j.split("@")[0]}`).join(" ");
            await sock.sendMessage(remoteJid, {
              text: `👥 *${name}* (${list.length})\n${txt}`,
              mentions: list,
            });
            return;
          }

          /* !group delete <name> */
          if (subcmd === "delete") {
            const name = (args.shift() || "").toLowerCase();
            delete db[groupKey][name];
            saveDb(db);
            await sock.sendMessage(remoteJid, {
              text: `🗑️ Deleted subgroup *${name}*.`,
            });
            return;
          }

          /* !group add/remove */
          if (["add", "remove"].includes(subcmd)) {
            const name = (args.shift() || "").toLowerCase();
            let mentions = [];
            if (isGroup) {
              const meta = await sock.groupMetadata(remoteJid);
              mentions = await extractMentionedJids(msg, sock, meta);
            } else {
              mentions = extractNumbersFromText(text);
            }

            if (!mentions.length) {
              await sock.sendMessage(remoteJid, {
                text: "No valid members found. Mention in group or use numbers in DM.",
              });
              return;
            }

            if (!db[groupKey][name]) db[groupKey][name] = [];
            const set = new Set(db[groupKey][name]);
            if (subcmd === "add") mentions.forEach((j) => set.add(j));
            else mentions.forEach((j) => set.delete(j));

            db[groupKey][name] = Array.from(set);
            saveDb(db);
            await sock.sendMessage(remoteJid, {
              text: `✅ Updated *${name}* (${db[groupKey][name].length} members).`,
            });
            return;
          }
        }

        /* ----------------- !tag<name> (only tag members present in THIS group) ----------------- */
        if (cmd.startsWith("tag") && cmd !== CMD_TAGALL) {
          const name = cmd.slice(3).toLowerCase();

          // 1) Fetch saved subgroup list (group-local first, then global fallback)
          const rawList = db[remoteJid]?.[name] || db.global?.[name] || [];
          
          if (!rawList.length) {
            await sock.sendMessage(remoteJid, {
              text: `No members in subgroup *${name}*.`,
            });
            return;
          }

          // 2) Build a map of current group's participants -> normalized digits
          const meta = await sock.groupMetadata(remoteJid);
          const selfDigits = getSelfJid(sock);

          const presentMap = new Map(); // digits -> actual JID in this group
          for (const p of meta.participants || []) {
            // Use phoneNumber if available (for LID groups), otherwise fall back to jid/id
            const phoneNumber = p?.phoneNumber;
            const actualJid = p?.jid || p?.id;
            
            if (phoneNumber) {
              const d = normalizeJid(phoneNumber);
              if (d && d !== selfDigits) presentMap.set(d, actualJid);
            } else {
              const d = normalizeJid(actualJid);
              if (d && d !== selfDigits) presentMap.set(d, actualJid);
            }
          }

          // 3) Intersect subgroup members with present participants
          const finalMentions = [];
          for (const j of rawList) {
            const d = normalizeJid(j);
            const mapped = d && presentMap.get(d);
            if (mapped) finalMentions.push(mapped);
          }

          // 4) Dedupe and send
          const mentions = Array.from(new Set(finalMentions));
          
          if (!mentions.length) {
            await sock.sendMessage(remoteJid, {
              text: `No members of subgroup *${name}* are present in this group.`,
            });
            return;
          }

          const chunks = chunkArray(mentions, 20);
          for (const chunk of chunks) {
            const msgText = chunk.map((m) => `@${m.split("@")[0]}`).join(" ");
            const quoted = getQuotedMessage(msg);
            await sock.sendMessage(
              remoteJid,
              { text: msgText, mentions: chunk },
              quoted ? { quoted } : {}
            );
            await new Promise((r) => setTimeout(r, 400));
          }
          return;
        }

        /* ----------------- !arnav bhai ----------------- */
        if (trimmed.toLowerCase() === "!arnav bhai") {
          try {
            // Path to your sticker (must be in .webp format)
            const stickerPath = path.join(__dirname, "stickers", "arnav.webp");

            if (!fs.existsSync(stickerPath)) {
              await sock.sendMessage(remoteJid, {
                text: "⚠️ Sticker not found! Please add `arnav.webp` in /stickers folder.",
              });
              return;
            }

            const stickerBuffer = fs.readFileSync(stickerPath);

            await sock.sendMessage(remoteJid, {
              sticker: stickerBuffer,
            });
          } catch (err) {
            console.error("💥 Error sending sticker:", err);
          }
          return;
        }

        /* ----------------- !help ----------------- */
        if (cmd === "help") {
          await sock.sendMessage(remoteJid, {
            text: `🛠️ *Available Commands*
• !tagall — tag everyone (group)
• !tag<name> — tag subgroup
• !group add/remove/show/list/delete — manage subgroups (only owner in DM)`,
          });
        }
      } catch (err) {
        console.error("💥 Message handler error:", err);
      }
    });
  } catch (err) {
    console.error("Fatal startBot error:", err);
    if (!restarting) {
      restarting = true;
      setTimeout(
        () => startBot(Math.min(backoffMs * 2, 30000)).catch(console.error),
        backoffMs
      );
    }
  }
}

startBot().catch(console.error);

// 🔴 this is REQUIRED for Render
app.get("/", (req, res) => {
  res.send("WhatsApp Bot is running 🚀");
});

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
