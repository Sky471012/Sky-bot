import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  getContentType,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import qrcode from "qrcode-terminal";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PREFIX = "!";
const CMD_TAGALL = "tagall";

const DATA_DIR = path.join(__dirname, "data");
const GROUPS_DB = path.join(DATA_DIR, "subgroups.json");

let restarting = false;

/* -------------------------- Utils & Persistence -------------------------- */

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

function toJid(id) {
  if (!id) return null;
  const clean = id.replace(/[^\d]/g, "");
  if (!clean) return null;
  return clean.endsWith("@s.whatsapp.net") ? clean : `${clean}@s.whatsapp.net`;
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

  // 1) Collect real mentions
  let jids = Array.isArray(contextInfo?.mentionedJid)
    ? [...contextInfo.mentionedJid]
    : [];

  // Resolve @lid → real JID
  const resolved = [];
  for (const id of jids) {
    if (id.endsWith("@lid")) {
      const num = id.replace("@lid", "");
      // 1️⃣ Try direct onWhatsApp
      try {
        const res = await sock.onWhatsApp(num);
        if (res && res[0]?.jid) {
          resolved.push(res[0].jid);
          continue;
        }
      } catch (err) {
        console.log("⚠️ LID onWhatsApp failed:", err.message);
      }

      // 2️⃣ Fallback → search group participants for partial match
      const match = (meta.participants || []).find((p) => p.id.includes(num));
      if (match?.id) {
        resolved.push(match.id);
        console.log("✅ Resolved LID via group member:", match.id);
      } else {
        console.log("⚠️ Could not resolve LID:", id);
      }
    } else {
      resolved.push(id);
    }
  }

  // 2) If no mentions, allow "reply-to user" (admin replies to a member’s message)
  if (resolved.length === 0 && contextInfo?.participant) {
    const candidate = contextInfo.participant;
    if (groupIds.has(candidate)) resolved.push(candidate);
  }

  // 3) As a last resort, parse inline numbers but STRICTLY validate
  if (resolved.length === 0) {
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      "";

    const inlineNums = Array.from(new Set(text.match(/\b\d{8,15}\b/g) || []));

    for (const n of inlineNums) {
      try {
        const q = await sock.onWhatsApp(n);
        const jid = q?.[0]?.jid;
        if (jid && groupIds.has(jid)) {
          resolved.push(jid);
        }
      } catch {}
    }
  }

  // 4) De-dup & only keep members actually in this group
  const unique = Array.from(new Set(resolved)).filter((j) => groupIds.has(j));
  return unique;
}

function isAdmin(meta, jid) {
  const p = meta.participants.find((x) => x.id === jid);
  return p?.admin === "admin" || p?.admin === "superadmin";
}

/* ------------------------------ Bot Startup ------------------------------ */

async function startBot(backoffMs = 1000) {
  try {
    const authPath = path.join(__dirname, "auth_info");
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const sock = makeWASocket({ auth: state });

    // ✅ Must have this or credentials won't persist
    sock.ev.on("creds.update", saveCreds);

    // 🔁 Handle connection status + QR + reconnect logic
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("📱 Scan this QR to connect your WhatsApp:");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        console.log("✅ Bot connected and ready!");
        restarting = false;
      } else if (connection === "close") {
        const err = lastDisconnect?.error;
        const statusCode =
          (err instanceof Boom && err.output?.statusCode) ||
          err?.output?.statusCode ||
          err?.statusCode;

        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const shouldReconnect = !loggedOut;

        console.log("❌ Disconnected.", {
          statusCode,
          loggedOut,
          shouldReconnect,
        });

        if (shouldReconnect && !restarting) {
          restarting = true;
          const nextBackoff = Math.min(backoffMs * 2, 30000);
          setTimeout(
            () => startBot(nextBackoff).catch(console.error),
            backoffMs
          );
        } else if (loggedOut) {
          console.error(
            "🔒 Logged out. Delete auth_info folder to re-authenticate."
          );
        }
      }
    });

    // 🧠 Handle messages
    sock.ev.on("messages.upsert", async (upsert) => {
      try {
        const msg = upsert.messages?.[0];
        if (!msg) return;

        const remoteJid = msg.key?.remoteJid || "";
        if (!remoteJid.endsWith("@g.us")) return;

        const meta = await sock.groupMetadata(remoteJid);
        const sender =
          msg.key?.participant || msg.participant || msg.key?.remoteJid;

        // --- Parse text ---
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          "";

        const trimmed = (text || "").trim();
        if (!trimmed.startsWith(PREFIX)) return;

        const withoutPrefix = trimmed.slice(PREFIX.length).trim();
        const [cmdRaw, ...args] = withoutPrefix.split(/\s+/);
        const cmd = (cmdRaw || "").toLowerCase();

        // --- Admin-only protection ---
        if (!isAdmin(meta, sender)) {
          await sock.sendMessage(
            remoteJid,
            { text: "🚫 Only *group admins* can use these commands." },
            { quoted: msg }
          );
          return;
        }

        const db = loadDb();
        if (!db[remoteJid]) db[remoteJid] = {};

        /* ---------- 1️⃣ !tagall ---------- */
        if (cmd === CMD_TAGALL) {
          const botBare = (sock.user?.id || "").split(":")[0];
          const members = (meta.participants || [])
            .map((p) => p.id)
            .filter((id) => id && !id.startsWith(botBare || ""));

          if (!members.length) {
            await sock.sendMessage(
              remoteJid,
              { text: "No members found to tag." },
              { quoted: msg }
            );
            return;
          }

          const chunks = chunkArray(members, 20);
          for (const [i, chunk] of chunks.entries()) {
            const tagMessage = chunk
              .map((m) => `@${m.split("@")[0]}`)
              .join(" ");
            await sock.sendMessage(
              remoteJid,
              { text: tagMessage, mentions: chunk },
              { quoted: i === 0 ? msg : undefined }
            );
            await new Promise((r) => setTimeout(r, 400));
          }
          return;
        }

        /* ---------- 2️⃣ !group management ---------- */
        if (cmd === "group") {
          const subcmd = (args.shift() || "").toLowerCase();
          if (!subcmd) {
            await sock.sendMessage(
              remoteJid,
              {
                text: `🧩 *Subgroup commands*
• !group add <name> @mentions
• !group remove <name> @mentions
• !group list
• !group show <name>
• !group delete <name>`,
              },
              { quoted: msg }
            );
            return;
          }

          if (subcmd === "list") {
            const names = Object.keys(db[remoteJid]);
            const lines = names.length
              ? names
                  .map((n) => `• *${n}* (${db[remoteJid][n].length})`)
                  .join("\n")
              : "_No subgroups yet. Use_ `!group add <name> @members`";
            await sock.sendMessage(
              remoteJid,
              { text: `🧩 *Subgroups*\n${lines}` },
              { quoted: msg }
            );
            return;
          }

          if (subcmd === "show") {
            const name = (args.shift() || "").toLowerCase();
            if (!name) {
              await sock.sendMessage(
                remoteJid,
                { text: "Usage: `!group show <name>`" },
                { quoted: msg }
              );
              return;
            }
            const list = db[remoteJid][name] || [];
            if (!list.length) {
              await sock.sendMessage(
                remoteJid,
                { text: `No members in *${name}*.` },
                { quoted: msg }
              );
              return;
            }
            const txt = list.map((j) => `@${j.split("@")[0]}`).join(" ");
            await sock.sendMessage(
              remoteJid,
              { text: `👥 *${name}* (${list.length})\n${txt}`, mentions: list },
              { quoted: msg }
            );
            return;
          }

          if (subcmd === "delete") {
            const name = (args.shift() || "").toLowerCase();
            if (!name) {
              await sock.sendMessage(
                remoteJid,
                { text: "Usage: `!group delete <name>`" },
                { quoted: msg }
              );
              return;
            }
            delete db[remoteJid][name];
            saveDb(db);
            await sock.sendMessage(
              remoteJid,
              { text: `🗑️ Deleted subgroup *${name}*.` },
              { quoted: msg }
            );
            return;
          }

          if (subcmd === "add" || subcmd === "remove") {
            const name = (args.shift() || "").toLowerCase();
            if (!name) {
              await sock.sendMessage(
                remoteJid,
                { text: `Usage: \`!group ${subcmd} <name> @mentions\`` },
                { quoted: msg }
              );
              return;
            }

            console.log(JSON.stringify(msg.message, null, 2));

            const mentions = await extractMentionedJids(msg, sock, meta);
            if (!mentions.length) {
              await sock.sendMessage(
                remoteJid,
                {
                  text: "No valid members found. Please @mention or reply to a member’s message.",
                },
                { quoted: msg }
              );
              return;
            }

            if (!db[remoteJid][name]) db[remoteJid][name] = [];

            const set = new Set(db[remoteJid][name]);
            if (subcmd === "add") {
              mentions.forEach((j) => set.add(j));
              db[remoteJid][name] = Array.from(set);
              saveDb(db);
              await sock.sendMessage(
                remoteJid,
                { text: `✅ Added ${mentions.length} to *${name}*.` },
                { quoted: msg }
              );
            } else {
              mentions.forEach((j) => set.delete(j));
              db[remoteJid][name] = Array.from(set);
              saveDb(db);
              await sock.sendMessage(
                remoteJid,
                { text: `➖ Removed ${mentions.length} from *${name}*.` },
                { quoted: msg }
              );
            }
            return;
          }

          await sock.sendMessage(
            remoteJid,
            { text: "Unknown subcommand. Try `!group list`." },
            { quoted: msg }
          );
          return;
        }

        /* ---------- 3️⃣ Dynamic subgroup tagging: !tag<name> ---------- */
        if (cmd.startsWith("tag") && cmd !== CMD_TAGALL) {
          const name = cmd.slice(3).toLowerCase();
          if (!name) return;

          const list = db[remoteJid][name] || [];
          if (!list.length) {
            await sock.sendMessage(
              remoteJid,
              {
                text: `No members in subgroup *${name}*. Add with \`!group add ${name} @members\``,
              },
              { quoted: msg }
            );
            return;
          }

          const chunks = chunkArray(list, 20);
          for (const [i, chunk] of chunks.entries()) {
            const tagMessage = chunk
              .map((m) => `@${m.split("@")[0]}`)
              .join(" ");
            await sock.sendMessage(
              remoteJid,
              { text: tagMessage, mentions: chunk },
              { quoted: i === 0 ? msg : undefined }
            );
            await new Promise((r) => setTimeout(r, 400));
          }
          return;
        }

        /* ---------- 4️⃣ Help ---------- */
        if (cmd === "help") {
          await sock.sendMessage(
            remoteJid,
            {
              text: `🛠️ *Commands*
• !tagall — tag everyone (admin)
• !tag<name> — tag subgroup (e.g., !tagdesign)
• !group add <name> @mentions
• !group remove <name> @mentions
• !group list
• !group show <name>
• !group delete <name>`,
            },
            { quoted: msg }
          );
        }
      } catch (err) {
        console.error("messages.upsert handler error:", err);
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
