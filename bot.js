const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth()
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('Please scan the QR code above with WhatsApp.');
});

client.on('ready', () => {
    console.log('Bot is online! Listening for View-Once media to capture...');
});

client.on('message', async (msg) => {
    try {
        if (msg.isViewOnce) {
            console.log(`[!] View Once media detected from: ${msg.author || msg.from}`);
            const media = await msg.downloadMedia();

            if (media) {
                const myJid = client.info.wid._serialized;
                const captionText = `🔓 *View Once Media Saved*\n\n` +
                    `📁 *Type:* ${media.mimetype}\n` +
                    `👤 *From:* ${msg.author || msg.from}\n` +
                    `🕒 *Timestamp:* ${new Date().toLocaleTimeString()}`;

                await client.sendMessage(myJid, media, { caption: captionText });
                console.log('[✓] Media successfully captured and sent to your personal chat!');
            }
        }
    } catch (error) {
        console.error('[X] Failed to extract or forward view-once media:', error);
    }
});

client.initialize();
