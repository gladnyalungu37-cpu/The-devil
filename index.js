import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';

dotenv.config();

// -------------------------------------------------------------
// DUMMY HTTP SERVER (Explicitly bound to 0.0.0.0 for Render)
// -------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('The-devil WhatsApp Bot is running!\n');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP server listening on port ${PORT} for Render health checks.`);
});

// Catch unexpected errors so the server doesn't crash
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

// -------------------------------------------------------------
// MULTI-KEY ROTATION POOL (Securely read from Environment Variables)
// -------------------------------------------------------------
const geminiKeys = [
    process.env.GEMINI_KEY_1,
    process.env.GEMINI_KEY_2,
    process.env.GEMINI_KEY_3,
    process.env.GEMINI_KEY_4
].filter(Boolean);
let activeKeyIndex = 0;

// Automatic fallback wrapper function for Gemini API requests
async function callGemini(payload) {
    if (geminiKeys.length === 0) {
        throw new Error("No Gemini API keys found in environment variables.");
    }
    let attempts = 0;
    while (attempts < geminiKeys.length) {
        try {
            const currentKey = geminiKeys[activeKeyIndex];
            const aiClient = new GoogleGenAI({ apiKey: currentKey });
            const response = await aiClient.models.generateContent(payload);
            return response;
        } catch (err) {
            console.warn(`⚠️ API Key [Index ${activeKeyIndex}] hit quota/limit or failed: ${err.message}. Rotating to next key...`);
            activeKeyIndex = (activeKeyIndex + 1) % geminiKeys.length;
            attempts++;
            if (attempts >= geminiKeys.length) {
                throw new Error("All Gemini API keys have exhausted their daily quotas or failed.");
            }
        }
    }
}

// In-memory state tracking
const chatBuffers = new Map();
const activeTrivia = new Map();
const userModes = new Map();
const cooldowns = new Map();
const messageStore = new Map();
const todoLists = new Map();
const MAX_BUFFER_SIZE = 25;
let botSleeping = false;
const startTime = Date.now();

function saveToBuffer(remoteJid, sender, text) {
    if (!chatBuffers.has(remoteJid)) {
        chatBuffers.set(remoteJid, []);
    }
    const buffer = chatBuffers.get(remoteJid);
    buffer.push({ sender, text, timestamp: new Date().toLocaleTimeString() });
    if (buffer.length > MAX_BUFFER_SIZE) {
        buffer.shift();
    }
}

function runCommand(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
            if (error) return reject(error);
            resolve(stdout);
        });
    });
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n========================================');
            console.log('🔗 SCAN THIS QR CODE IN WHATSAPP:');
            console.log('========================================\n');
            qrcode.generate(qr, { small: true });
            console.log('\n========================================\n');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('\n✅ Ultimate WhatsApp AI Bot (Powered by cold.era10) is active with Multi-Key Rotation!\n');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;

        for (const msg of messages) {
            if (!msg.message) continue;
            
            if (msg.key && msg.key.id) {
                messageStore.set(msg.key.id, {
                    remoteJid: msg.key.remoteJid,
                    sender: msg.pushName || 'Someone',
                    message: msg.message,
                    timestamp: new Date().toLocaleTimeString()
                });
                if (messageStore.size > 500) {
                    const firstKey = messageStore.keys().next().value;
                    messageStore.delete(firstKey);
                }
            }

            // AUTO STATUS VIEWER & LIKER
            if (msg.key && msg.key.remoteJid === 'status@broadcast') {
                try {
                    await sock.readMessages([msg.key]);
                    const participant = msg.key.participant;
                    if (participant) {
                        await sock.sendMessage('status@broadcast', {
                            react: {
                                text: '❤️',
                                key: msg.key
                            }
                        }, { statusJidList: [participant] });
                    }
                } catch (err) {
                    console.error('Status view & like error:', err);
                }
                continue;
            }

            let msgContent = msg.message;
            if (msgContent.ephemeralMessage) {
                msgContent = msgContent.ephemeralMessage.message;
            }

            const remoteJid = msg.key.remoteJid;
            const senderJid = msg.key.participant || msg.key.remoteJid;
            const isGroup = remoteJid.endsWith('@g.us');
            const senderName = msg.pushName || (msg.key.fromMe ? 'Bot Owner' : 'Friend');

            logMessageToDisk(isGroup ? 'Group' : 'Private', senderName, msgContent.conversation || msgContent.extendedTextMessage?.text || '[Media]');

            const rawText = msgContent.conversation || msgContent.extendedTextMessage?.text || msgContent.imageMessage?.caption || '';
            const text = rawText.trim();
            const lowerText = text.toLowerCase();
            const baseWord = lowerText.replace(/^!/, '').split(' ')[0];

            if (baseWord === 'neymar') {
                botSleeping = !botSleeping;
                await sock.sendMessage(remoteJid, { text: botSleeping ? '💤 *Bot is now resting (Sleeping Mode ON).* Send `!Neymar` again to wake up.' : '⚡ *Bot is fully awake and active!*' });
                continue;
            }

            if (botSleeping && !msg.key.fromMe) continue;

            const isViewOnce = msgContent.viewOnceMessage || msgContent.viewOnceMessageV2 || msgContent.imageMessage?.viewOnce || msgContent.videoMessage?.viewOnce;
            if (isViewOnce) {
                try {
                    const actualMsg = msgContent.viewOnceMessage?.message || msgContent.viewOnceMessageV2?.message || msgContent;
                    const isImage = actualMsg.imageMessage;
                    const isVideo = actualMsg.videoMessage;

                    if (isImage || isVideo) {
                        await sock.sendMessage(remoteJid, { text: '🔓 *Intercepting View-Once Media...*' });
                        const buffer = await downloadMediaMessage({ message: actualMsg, key: msg.key }, 'buffer', {});
                        const ext = isImage ? 'jpg' : 'mp4';
                        const savePath = path.join(process.cwd(), `viewonce_${Date.now()}.${ext}`);
                        fs.writeFileSync(savePath, buffer);
                        if (isImage) {
                            await sock.sendMessage(remoteJid, { image: { url: savePath }, caption: '🔓 *View-Once Photo Unlocked & Saved!*' });
                        } else {
                            await sock.sendMessage(remoteJid, { video: { url: savePath }, caption: '🔓 *View-Once Video Unlocked & Saved!*' });
                        }
                        if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
                        continue;
                    }
                } catch (err) {
                    console.error('View-Once Intercept Error:', err);
                }
            }

            const commandKeywords = [
                'menu', 'help', 'commands', 'ai', 'talk', 'mode', 'imagine', 'match',
                'football', 'tagall', 'hidetag', 'meme', 'summarize', 'analyze',
                'analyzechat', 'describe', 'song', 'video', 'wiki',
                'trivia', 'sticker', 'tts', 'tr', 'remind', 'search', 'calc', 'ping', 'status',
                'map', 'nav', 'weather', 'qr', 'todo', 'todos', 'cleartodos'
            ];
            const isCommand = commandKeywords.includes(baseWord) || lowerText === 'commands';

            if (activeTrivia.has(remoteJid) && ['A', 'B', 'C', 'D'].includes(text.toUpperCase()) && text.length === 1) {
                const correct = activeTrivia.get(remoteJid);
                if (text.toUpperCase() === correct) {
                    await sock.sendMessage(remoteJid, { text: `🎉 Correct ${senderName}! Option *${correct}* is the right answer.` });
                } else {
                    await sock.sendMessage(remoteJid, { text: `❌ Incorrect ${senderName}! The correct answer was *${correct}*.` });
                }
                activeTrivia.delete(remoteJid);
                continue;
            }

            if (text && !isCommand) {
                saveToBuffer(remoteJid, senderName, text);
            }

            if (isCommand) {
                const now = Date.now();
                const userCooldown = cooldowns.get(senderJid) || 0;
                if (now - userCooldown < 3000) {
                    await sock.sendMessage(remoteJid, { text: '⏳ *Please wait a few seconds before using another command!*' });
                    continue;
                }
                cooldowns.set(senderJid, now);
            }

            const quotedContext = msgContent.extendedTextMessage?.contextInfo;
            const isQuotingBot = quotedContext?.participant === sock.user?.id;
            const shouldAutoReply = (!isGroup && text && !isCommand) || (isQuotingBot && text && !isCommand);

            if (shouldAutoReply) {
                const currentMode = userModes.get(remoteJid) || 'friend';
                let sysInstruction = "You are a warm, casual, and supportive friend on WhatsApp. Keep responses friendly, quick, and engaging.";
                if (currentMode === 'normal') sysInstruction = "You are a fast WhatsApp assistant. Keep responses brief and direct.";
                if (currentMode === 'roast') sysInstruction = "You are a witty assistant. Respond with sarcastic, lighthearted banter.";
                if (currentMode === 'tutor') sysInstruction = "You are an educational tutor. Explain concepts step-by-step clearly.";
                if (currentMode === 'hype') sysInstruction = "You are a high-energy hype assistant with intense commentator energy!";

                try {
                    const response = await callGemini({
                        model: 'gemini-1.5-flash',
                        contents: text,
                        config: { systemInstruction: sysInstruction }
                    });
                    await sock.sendMessage(remoteJid, { text: response.text });
                    continue;
                } catch (err) {
                    console.error('Auto-reply error:', err);
                }
            }

            // COMMAND: menu / help / commands (prefixless)
            if (baseWord === 'menu' || baseWord === 'help' || baseWord === 'commands' || lowerText === 'commands') {
                const menuText = `📖 *COMPLETE BOT COMMAND GUIDE* 📖\n` +
                    `⚡ *Powered by cold.era10*\n` +
                    `───────────────────────────\n\n` +
                    `🧠 *AI-POWERED COMMANDS (Consumes API Quota)*\n` +
                    `• Direct DM Chat : Text the bot directly (Friend Mode)\n` +
                    `• !ai <prompt> : Ask Gemini a direct question\n` +
                    `• !talk <prompt> : AI response as a Voice Note\n` +
                    `• !analyze : Reply to message for tone & context analysis\n` +
                    `• !analyzechat : Full chat history summary & analytics\n` +
                    `• !describe : Send/reply to a photo for AI vision inspection\n` +
                    `• !mode <persona> : Change AI tone (normal, friend, roast, tutor, hype)\n` +
                    `• !summarize : Reply to text for bullet point summary\n` +
                    `• !tr <lang> <text> : AI instant translation\n` +
                    `• !match <team> : Live scores & team news via AI search\n` +
                    `• !trivia : Generate AI quiz questions\n\n` +
                    `⚡ *AI-FREE UTILITIES (Zero Quota / Unlimited)*\n` +
                    `• !map <destination> : Instant GPS map & direction links\n` +
                    `• !weather <city> : Real-time weather forecast lookup\n` +
                    `• !qr <text/link> : Generate a scannable QR code image\n` +
                    `• !todo <task> : Add a task to your chat to-do list\n` +
                    `• !todos : View your active chat to-do list\n` +
                    `• !cleartodos : Clear your chat to-do list\n` +
                    `• !song <title> : Download MP3 audio (yt-dlp)\n` +
                    `• !video <title> : Download MP4 video (yt-dlp)\n` +
                    `• !wiki <topic> : Fetch Wikipedia summaries\n` +
                    `• !sticker : Convert image to WhatsApp sticker\n` +
                    `• !meme <top | bottom> : Create photo memes with text overlay\n` +
                    `• !calc <expr> : Fast math evaluation engine\n` +
                    `• !remind <mins> <text> : Timer reminder notification\n` +
                    `• !search <query> : Search through local chat logs\n` +
                    `• !ping / !status : Check bot uptime & key rotation slot\n\n` +
                    `👥 *GROUP TOOLS*\n` +
                    `• !tagall <msg> : Mention all group members (Visible)\n` +
                    `• !hidetag <msg> : Hidden mass tag notification\n\n` +
                    `🔓 *AUTOMATION & CONTROLS*\n` +
                    `• !Neymar : Sleep / Wake bot toggle\n` +
                    `• View Once Saver : Auto-captures View-Once media\n` +
                    `• Auto Status Viewer & Liker : Auto-views & likes statuses (❤️)\n` +
                    `• Anti-Delete Recovery : Auto-reposts deleted messages\n` +
                    `• Background Logger : Silently indexes chat activity\n` +
                    `───────────────────────────`;
                await sock.sendMessage(remoteJid, { text: menuText });
                continue;
            }

            // COMMAND: ai
            if (baseWord === 'ai') {
                const prompt = text.replace(/^[!]?ai\s*/i, '').trim();
                if (!prompt) {
                    await sock.sendMessage(remoteJid, { text: 'Please ask a question! Example: ai What is gravity?' });
                    continue;
                }
                try {
                    const response = await callGemini({ model: 'gemini-1.5-flash', contents: prompt });
                    await sock.sendMessage(remoteJid, { text: response.text });
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ AI Error: ${err.message}` });
                }
            }

            // COMMAND: map / nav (AI-free direct link generator)
            if (baseWord === 'map' || baseWord === 'nav') {
                const query = text.replace(/^[!]?(map|nav)\s*/i, '').trim();
                if (!query) {
                    await sock.sendMessage(remoteJid, { text: '⚠️ Please specify a destination!\nExample: `!map Johannesburg`' });
                    continue;
                }
                const encoded = encodeURIComponent(query);
                const mapSearchUrl = `https://www.google.com/maps/search/?api=1&query=${encoded}`;
                const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encoded}`;

                await sock.sendMessage(remoteJid, { 
                    text: `🗺️ *GPS & Navigation Finder*\n\n📍 *Destination:* ${query}\n\n🌐 *View on Map:* ${mapSearchUrl}\n🚗 *Get Directions:* ${directionsUrl}\n\n⚡ _Zero AI quota used!_` 

