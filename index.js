import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import path from "path";
import { fileURLToPath } from "url";

// Fix __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startBot() {
  const authPath = path.join(__dirname, "auth_info");
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true, // shows QR automatically in terminal
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      console.log("📲 Scan the QR code below:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("❌ Disconnected. Reconnecting:", shouldReconnect);
      if (shouldReconnect) startBot();
    }

    if (connection === "open") {
      console.log("✅ Bot connected and ready.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || !msg.key.remoteJid.endsWith("@g.us")) return;

    const text =
      msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
    const mentionedJids =
      msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const quotedContext = msg.message?.extendedTextMessage?.contextInfo;
    const botId = sock.user.id;

    const isTagAll = text.toLowerCase().includes("tagall");
    const isBotMentioned = mentionedJids.some(jid => jid.startsWith(botId.split(":")[0]));
    const isReply = Boolean(quotedContext?.quotedMessage);

    if (isTagAll) {
      const groupMeta = await sock.groupMetadata(msg.key.remoteJid);
      const members = groupMeta.participants
        .map((p) => p.id)
        .filter((id) => id !== botId);

      const tagMessage = members.map((m) => `@${m.split("@")[0]}`).join(" ");

      if (isReply) {
        const quotedMessage = {
          key: {
            remoteJid: msg.key.remoteJid,
            fromMe: false,
            id: quotedContext.stanzaId,
            participant: quotedContext.participant,
          },
          message: quotedContext.quotedMessage,
        };

        await sock.sendMessage(
          msg.key.remoteJid,
          { text: tagMessage, mentions: members },
          { quoted: quotedMessage }
        );
      } else {
        await sock.sendMessage(msg.key.remoteJid, {
          text: tagMessage,
          mentions: members,
        });
      }
    }
  });
}

startBot();