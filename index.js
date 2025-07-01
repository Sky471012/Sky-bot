const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { Boom } = require('@hapi/boom');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({ auth: state });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            console.log("📲 Scan the QR code below:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("❌ Disconnected. Reconnecting:", shouldReconnect);
            if (shouldReconnect) startBot();
        }

        if (connection === 'open') {
            console.log("✅ Bot connected and ready.");
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || !msg.key.remoteJid.endsWith('@g.us')) return;

    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const quotedContext = msg.message?.extendedTextMessage?.contextInfo;
    const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';

    const isTagAll = text.toLowerCase().includes('tagall');
    const isBotMentioned = mentionedJids.includes(botId);
    const isReply = Boolean(quotedContext?.quotedMessage);

    if (isTagAll && isBotMentioned) {
        const groupMeta = await sock.groupMetadata(msg.key.remoteJid);
        const members = groupMeta.participants
            .map(p => p.id)
            .filter(id => id !== botId); // remove bot from tag list

        const tagMessage = members.map(m => `@${m.split('@')[0]}`).join(' ');

        if (isReply) {
            // ✅ Reply to original message that was replied to
            const quotedMessage = {
                key: {
                    remoteJid: msg.key.remoteJid,
                    fromMe: false,
                    id: quotedContext.stanzaId,
                    participant: quotedContext.participant
                },
                message: quotedContext.quotedMessage
            };

            await sock.sendMessage(msg.key.remoteJid, {
                text: tagMessage,
                mentions: members
            }, {
                quoted: quotedMessage
            });
        } else {
            // ✅ Send a regular group message
            await sock.sendMessage(msg.key.remoteJid, {
                text: tagMessage,
                mentions: members
            });
        }
    }
});

}

startBot();