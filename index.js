cat << 'EOF' > index.js
import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';

dotenv.config();

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('The-devil WhatsApp Bot is running!\n');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP server listening on port ${PORT} for Render health checks.`);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

const geminiKeys = [
    process.env.GEMINI_KEY_1,
    process.env.GEMINI_KEY_2,
    process.env.GEMINI_KEY_3,
    process.env.GEMINI_KEY_4
].filter(Boolean);
let activeKeyIndex = 0;

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

            if (msg.key && msg.key.remoteJid === 'status@broadcast') {
                try {
                    await sock.readMessages([msg.key]);
                    const participant = msg.key.participant;
                    if (participant) {
                        await sock.sendMessage('status@broadcast', {
                            react: { text: '❤️', key: msg.key }
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
                });
                continue;
            }

            if (baseWord === 'weather') {
                const city = text.replace(/^[!]?weather\s*/i, '').trim();
                if (!city) {
                    await sock.sendMessage(remoteJid, { text: '⚠️ Please specify a city!\nExample: `!weather Bushbuckridge`' });
                    continue;
                }
                try {
                    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
                    const weatherText = await res.text();
                    await sock.sendMessage(remoteJid, { text: `🌤️ *Weather Forecast*\n\n${weatherText.trim()}\n\n⚡ _Zero AI quota used!_` });
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: '❌ Error fetching weather data.' });
                }
                continue;
            }

            if (baseWord === 'qr') {
                const qrData = text.replace(/^[!]?qr\s*/i, '').trim();
                if (!qrData) {
                    await sock.sendMessage(remoteJid, { text: '⚠️ Please provide text or a link for the QR code!\nExample: `!qr https://google.com`' });
                    continue;
                }
                try {
                    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrData)}`;
                    await sock.sendMessage(remoteJid, { image: { url: qrUrl }, caption: `📱 *Generated QR Code*\nData: ${qrData}\n\n⚡ _Zero AI quota used!_` });
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: '❌ Error generating QR code.' });
                }
                continue;
            }

            if (baseWord === 'todo') {
                const task = text.replace(/^[!]?todo\s*/i, '').trim();
                if (!task) {
                    await sock.sendMessage(remoteJid, { text: '⚠️ Please specify a task!\nExample: `!todo Finish science homework`' });
                    continue;
                }
                if (!todoLists.has(remoteJid)) todoLists.set(remoteJid, []);
                const list = todoLists.get(remoteJid);
                list.push(task);
                await sock.sendMessage(remoteJid, { text: `✅ *Task Added (#${list.length}):*\n${task}\n\n_Type \`!todos\` to view your list._` });
                continue;
            }

            if (baseWord === 'todos') {
                const list = todoLists.get(remoteJid) || [];
                if (list.length === 0) {
                    await sock.sendMessage(remoteJid, { text: '📋 Your to-do list is empty! Add a task using `!todo <task>`.' });
                    continue;
                }
                let responseText = `📋 *Your To-Do List:*\n\n` + list.map((t, index) => `${index + 1}. ${t}`).join('\n');
                responseText += `\n\n_Type \`!cleartodos\` to clear the list._`;
                await sock.sendMessage(remoteJid, { text: responseText });
                continue;
            }

            if (baseWord === 'cleartodos') {
                todoLists.set(remoteJid, []);
                await sock.sendMessage(remoteJid, { text: '🗑️ Your to-do list has been cleared!' });
                continue;
            }

            if (baseWord === 'talk') {
                const prompt = text.replace(/^[!]?talk\s*/i, '').trim();
                if (!prompt) {
                    await sock.sendMessage(remoteJid, { text: 'Say something! Example: talk How are you today?' });
                    continue;
                }
                try {
                    await sock.sendMessage(remoteJid, { text: '🎙️ Thinking and recording response...' });
                    const aiResponse = await callGemini({
                        model: 'gemini-1.5-flash',
                        contents: prompt,
                        config: { systemInstruction: "Respond like a close friend in 2-3 short, spoken sentences." }
                    });
                    const audioPath = path.join(process.cwd(), `talk_${Date.now()}.mp3`);
                    const pyScript = `from gtts import gTTS; tts = gTTS(text='${aiResponse.text.replace(/'/g, "\\'")}', lang='en'); tts.save('${audioPath}')`;
                    await runCommand(`python -c "${pyScript}"`);
                    if (fs.existsSync(audioPath)) {
                        await sock.sendMessage(remoteJid, { audio: { url: audioPath }, mimetype: 'audio/mp4', ptt: true });
                        fs.unlinkSync(audioPath);
                    }
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ Talk Error: ${err.message}` });
                }
            }

            if (baseWord === 'mode') {
                const modeInput = text.replace(/^[!]?mode\s*/i, '').trim().toLowerCase();
                if (['normal', 'friend', 'roast', 'tutor', 'hype'].includes(modeInput)) {
                    userModes.set(remoteJid, modeInput);
                    await sock.sendMessage(remoteJid, { text: `🎭 AI Personality mode set to: *${modeInput.toUpperCase()}*` });
                } else {
                    await sock.sendMessage(remoteJid, { text: 'Available modes: `mode friend`, `mode normal`, `mode roast`, `mode tutor`, `mode hype`' });
                }
            }

            if (baseWord === 'imagine') {
                const prompt = text.replace(/^[!]?imagine\s*/i, '').trim();
                if (!prompt) {
                    await sock.sendMessage(remoteJid, { text: 'Specify what to draw! Example: imagine futuristic sports car on Mars' });
                    continue;
                }
                try {
                    await sock.sendMessage(remoteJid, { text: `🎨 Generating image for: "${prompt}"...` });
                    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
                    const imagePath = path.join(process.cwd(), `art_${Date.now()}.jpg`);
                    const res = await fetch(imageUrl);
                    const arrayBuffer = await res.arrayBuffer();
                    fs.writeFileSync(imagePath, Buffer.from(arrayBuffer));
                    if (fs.existsSync(imagePath)) {
                        await sock.sendMessage(remoteJid, { image: { url: imagePath }, caption: `✨ *AI Artwork:* ${prompt}\n\n⚡ *Powered by cold.era10*` });
                        fs.unlinkSync(imagePath);
                    }
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ Imagine Error: ${err.message}` });
                }
            }

            if (baseWord === 'match' || baseWord === 'football') {
                const team = text.replace(/^[!]?(match|football)\s*/i, '').trim();
                if (!team) {
                    await sock.sendMessage(remoteJid, { text: 'Specify a team! Example: match FC Barcelona' });
                    continue;
                }
                try {
                    await sock.sendMessage(remoteJid, { text: `⚽ Fetching latest updates for *${team}*...` });
                    const response = await callGemini({
                        model: 'gemini-1.5-flash',
                        contents: `Provide the latest match scores, upcoming fixtures, and team news for ${team}. Format nicely with emojis.`
                    });
                    await sock.sendMessage(remoteJid, { text: response.text });
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ Match Info Error: ${err.message}` });
                }
            }

            if (baseWord === 'tagall') {
                if (!isGroup) {
                    await sock.sendMessage(remoteJid, { text: '⚠️ This command can only be used in group chats!' });
                    continue;
                }
                const customMsg = text.replace(/^[!]?tagall\s*/i, '').trim() || 'Attention everyone!';
                try {
                    const groupMetadata = await sock.groupMetadata(remoteJid);
                    const participants = groupMetadata.participants;
                    const mentions = participants.map(p => p.id);
                    let tagMsg = `📢 *GROUP ANNOUNCEMENT*\n⚡ *Powered by cold.era10*\n\n${customMsg}\n\n`;
                    for (const p of participants) {
                        tagMsg += `@${p.id.split('@')[0]} `;
                    }
                    await sock.sendMessage(remoteJid, { text: tagMsg, mentions });
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ TagAll Error: ${err.message}` });
                }
            }

            if (baseWord === 'hidetag') {
                if (!isGroup) {
                    await sock.sendMessage(remoteJid, { text: '⚠️ This command can only be used in group chats!' });
                    continue;
                }
                const customMsg = text.replace(/^[!]?hidetag\s*/i, '').trim() || 'Attention everyone!';
                try {
                    const groupMetadata = await sock.groupMetadata(remoteJid);
                    const participants = groupMetadata.participants;
                    const mentions = participants.map(p => p.id);
                    await sock.sendMessage(remoteJid, { text: customMsg, mentions });
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ HideTag Error: ${err.message}` });
                }
            }

            if (baseWord === 'calc') {
                const expr = text.replace(/^[!]?calc\s*/i, '').trim();
                if (!expr) {
                    await sock.sendMessage(remoteJid, { text: 'Usage: calc <expression>\nExample: calc (450 * 2) / 5 + 10' });
                    continue;
                }
                try {
                    const sanitized = expr.replace(/[^0-9+\-*/().%]/g, '');
                    const result = eval(sanitized);
                    await sock.sendMessage(remoteJid, { text: `🔢 *Calculation Result:*\n\`${expr}\` = *${result}*` });
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: '❌ Invalid mathematical expression.' });
                }
            }

            if (baseWord === 'ping' || baseWord === 'status') {
                const uptimeMs = Date.now() - startTime;
                const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
                const mins = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
                await sock.sendMessage(remoteJid, { text: `🟢 *Bot Status: ACTIVE*\n⏱️ Uptime: ${hours}h ${mins}m\n🔑 Active API Key Slot: #${activeKeyIndex + 1} of ${geminiKeys.length}\n⚡ Powered by cold.era10` });
                continue;
            }

            if (baseWord === 'meme') {
                const quotedMsg = msgContent.extendedTextMessage?.contextInfo?.quotedMessage;
                const isImage = msgContent.imageMessage || quotedMsg?.imageMessage;
                if (!isImage) {
                    await sock.sendMessage(remoteJid, { text: '⚠️ Send or reply to an image with meme Top Text | Bottom Text' });
                    continue;
                }
                const args = text.replace(/^[!]?meme\s*/i, '').trim().split('|');
                const topText = args[0] ? args[0].trim() : '';
                const bottomText = args[1] ? args[1].trim() : '';
                try {
                    await sock.sendMessage(remoteJid, { text: '🤡 Creating meme...' });
                    const targetMsg = msgContent.imageMessage ? msg : { message: quotedMsg, key: { remoteJid } };
                    const buffer = await downloadMediaMessage(targetMsg, 'buffer', {});
                    const inputPath = path.join(process.cwd(), `meme_in_${Date.now()}.jpg`);
                    const outputPath = path.join(process.cwd(), `meme_out_${Date.now()}.jpg`);
                    fs.writeFileSync(inputPath, buffer);
                    const drawText = `drawtext=text='${topText.replace(/'/g, "\\'")}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=20:bordercolor=black:borderw=3,drawtext=text='${bottomText.replace(/'/g, "\\'")}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=h-th-20:bordercolor=black:borderw=3`;
                    await runCommand(`ffmpeg -i "${inputPath}" -vf "${drawText}" "${outputPath}"`);
                    if (fs.existsSync(outputPath)) {
                        await sock.sendMessage(remoteJid, { image: { url: outputPath } });
                        fs.unlinkSync(inputPath);
                        fs.unlinkSync(outputPath);
                    }
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ Meme Error: ${err.message}` });
                }
            }

            if (baseWord === 'summarize') {
                const context = msgContent.extendedTextMessage?.contextInfo;
                const quotedText = context?.quotedMessage?.conversation || context?.quotedMessage?.extendedTextMessage?.text;
                if (!quotedText) {
                    await sock.sendMessage(remoteJid, { text: 'Please reply to a long text message or thread with summarize.' });
                    continue;
                }
                try {
                    const response = await callGemini({
                        model: 'gemini-1.5-flash',
                        contents: `Summarize the following text into 3 clear bullet points:\n\n"${quotedText}"`,
                    });
                    await sock.sendMessage(remoteJid, { text: `📝 *Summary:*\n\n${response.text}` });
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ Summary Error: ${err.message}` });
                }
            }

            if (baseWord === 'analyze') {
                const context = msgContent.extendedTextMessage?.contextInfo;
                const quotedText = context?.quotedMessage?.conversation || context?.quotedMessage?.extendedTextMessage?.text;
                if (!quotedText) {
                    await sock.sendMessage(remoteJid, { text: 'Please reply to a message and type analyze.' });
                    continue;
                }
                try {
                    const response = await callGemini({
                        model: 'gemini-1.5-flash',
                        contents: `Analyze this message: "${quotedText}". Provide key insights, tone, and a brief summary.`,
                    });
                    await sock.sendMessage(remoteJid, { text: response.text });
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ Analysis Error: ${err.message}` });
                }
            }

            if (baseWord === 'analyzechat') {
                const buffer = chatBuffers.get(remoteJid) || [];
                if (buffer.length < 2) {
                    await sock.sendMessage(remoteJid, { text: '⚠️ Not enough chat history captured yet.' });
                    continue;
                }
                const formattedHistory = buffer.map(m => `[${m.timestamp}] ${m.sender}: ${m.text}`).join('\n');
                try {
                    await sock.sendMessage(remoteJid, { text: '🔍 Analyzing full chat history...' });
                    const response = await callGemini({
                        model: 'gemini-1.5-flash',
                        contents: `Here is a transcript of recent messages from this WhatsApp chat:\n\n${formattedHistory}\n\nPlease analyze the interaction. Summarize key topics, emotional tone, and main takeaways.`,
                    });
                    await sock.sendMessage(remoteJid, { text: response.text });
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ Chat Analysis Error: ${err.message}` });
                }
            }

            if (baseWord === 'describe') {
                const quotedMsg = msgContent.extendedTextMessage?.contextInfo?.quotedMessage;
                const isImage = msgContent.imageMessage || quotedMsg?.imageMessage;
                if (!isImage) {
                    await sock.sendMessage(remoteJid, { text: '⚠️ Send or reply to an image with describe!' });
                    continue;
                }
                try {
                    await sock.sendMessage(remoteJid, { text: '👁️ Inspecting image...' });
                    const targetMsg = msgContent.imageMessage ? msg : { message: quotedMsg, key: { remoteJid } };
                    const buffer = await downloadMediaMessage(targetMsg, 'buffer', {});
                    const base64Image = buffer.toString('base64');
                    const response = await callGemini({
                        model: 'gemini-1.5-flash',
                        contents: [
                            { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
                            { text: 'Describe what you see in this image in detail, including text, objects, and overall context.' }
                        ]
                    });
                    await sock.sendMessage(remoteJid, { text: response.text });
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ Vision Error: ${err.message}` });
                }
            }

            if (baseWord === 'song') {
                const query = text.replace(/^[!]?song\s*/i, '').trim();
                if (!query) {
                    await sock.sendMessage(remoteJid, { text: 'Please provide a song title!' });
                    continue;
                }
                const outputPath = path.join(process.cwd(), `song_${Date.now()}.mp3`);
                await sock.sendMessage(remoteJid, { text: `🎵 Downloading audio for: "${query}"...` });
                try {
                    await runCommand(`yt-dlp --extract-audio --audio-format mp3 -o "${outputPath}" "ytsearch1:${query}"`);
                    if (fs.existsSync(outputPath)) {
                        await sock.sendMessage(remoteJid, { audio: { url: outputPath }, mimetype: 'audio/mp4', fileName: `${query}.mp3` });
                        fs.unlinkSync(outputPath);
                    } else {
                        await sock.sendMessage(remoteJid, { text: '❌ Failed to locate audio file.' });
                    }
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ Download Error: ${err.message}` });
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                }
            }

            if (baseWord === 'video') {
                const query = text.replace(/^[!]?video\s*/i, '').trim();
                if (!query) {
                    await sock.sendMessage(remoteJid, { text: 'Please provide a video title!' });
                    continue;
                }
                const outputPath = path.join(process.cwd(), `video_${Date.now()}.mp4`);
                await sock.sendMessage(remoteJid, { text: `🎥 Downloading video for: "${query}"...` });
                try {
                    await runCommand(`yt-dlp --extractor-args "youtube:player_client=android" -o "${outputPath}" "ytsearch1:${query}"`);
                    if (fs.existsSync(outputPath)) {
                        await sock.sendMessage(remoteJid, { video: { url: outputPath }, caption: `Here is your video for: ${query}` });
                        fs.unlinkSync(outputPath);
                    } else {
                        await sock.sendMessage(remoteJid, { text: '❌ Failed to locate video file.' });
                    }
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ Download Error: ${err.message}` });
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                }
            }

            if (baseWord === 'wiki') {
                const query = text.replace(/^[!]?wiki\s*/i, '').trim();
                if (!query) {
                    await sock.sendMessage(remoteJid, { text: 'Please specify a topic!' });
                    continue;
                }
                try {
                    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
                    const data = await res.json();
                    if (data.extract) {
                        await sock.sendMessage(remoteJid, { text: `📖 *Wikipedia: ${data.title}*\n\n${data.extract}\n\n🔗 ${data.content_urls?.desktop?.page || ''}` });
                    } else {
                        await sock.sendMessage(remoteJid, { text: '❌ No Wikipedia article found.' });
                    }
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: '❌ Error fetching Wikipedia entry.' });
                }
            }

            if (baseWord === 'trivia') {
                try {
                    const prompt = "Generate a fun trivia question. Format strictly as:\nQUESTION: [question]\nA) [opt1]\nB) [opt2]\nC) [opt3]\nD) [opt4]\nANSWER: [A/B/C/D]";
                    const response = await callGemini({ model: 'gemini-1.5-flash', contents: prompt });
                    const content = response.text;
                    const answerMatch = content.match(/ANSWER:\s*([A-D])/i);
                    const correctAnswer = answerMatch ? answerMatch[1].toUpperCase() : 'A';
                    activeTrivia.set(remoteJid, correctAnswer);
                    await sock.sendMessage(remoteJid, { text: `🧠 *Trivia Time!*\n\n${content}\n\n_Reply with A, B, C, or D to answer!_` });
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: '❌ Error generating trivia.' });
                }
            }

            if (baseWord === 'sticker') {
                const quotedMsg = msgContent.extendedTextMessage?.contextInfo?.quotedMessage;
                const isImage = msgContent.imageMessage || quotedMsg?.imageMessage;
                if (!isImage) {
                    await sock.sendMessage(remoteJid, { text: '⚠️ Send or reply to an image with sticker!' });
                    continue;
                }
                try {
                    await sock.sendMessage(remoteJid, { text: '🎨 Converting image to sticker...' });
                    const targetMsg = msgContent.imageMessage ? msg : { message: quotedMsg, key: { remoteJid } };
                    const buffer = await downloadMediaMessage(targetMsg, 'buffer', {});
                    const inputPath = path.join(process.cwd(), `img_${Date.now()}.jpg`);
                    const outputPath = path.join(process.cwd(), `sticker_${Date.now()}.webp`);
                    fs.writeFileSync(inputPath, buffer);
                    await runCommand(`ffmpeg -i "${inputPath}" -vcodec libwebp -vf "scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-ih)/2:(oh-ih)/2:color=#00000000" -q:v 60 "${outputPath}"`);
                    if (fs.existsSync(outputPath)) {
                        await sock.sendMessage(remoteJid, { sticker: { url: outputPath } });
                        fs.unlinkSync(inputPath);
                        fs.unlinkSync(outputPath);
                    }
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ Sticker Error: ${err.message}` });
                }
            }

            if (baseWord === 'tts') {
                const prompt = text.replace(/^[!]?tts\s*/i, '').trim();
                if (!prompt) {
                    await sock.sendMessage(remoteJid, { text: 'Please provide text!' });
                    continue;
                }
                try {
                    await sock.sendMessage(remoteJid, { text: '🎙️ Generating voice note...' });
                    const audioPath = path.join(process.cwd(), `voice_${Date.now()}.mp3`);
                    const pyScript = `from gtts import gTTS; tts = gTTS(text='${prompt.replace(/'/g, "\\'")}', lang='en'); tts.save('${audioPath}')`;
                    await runCommand(`python -c "${pyScript}"`);
                    if (fs.existsSync(audioPath)) {
                        await sock.sendMessage(remoteJid, { audio: { url: audioPath }, mimetype: 'audio/mp4', ptt: true });
                        fs.unlinkSync(audioPath);
                    }
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ TTS Error: ${err.message}` });
                }
            }

            if (baseWord === 'tr') {
                const args = text.replace(/^[!]?tr\s*/i, '').trim();
                if (!args) {
                    await sock.sendMessage(remoteJid, { text: 'Usage: tr <language> <text>' });
                    continue;
                }
                try {
                    const response = await callGemini({
                        model: 'gemini-1.5-flash',
                        contents: `Translate the following statement strictly into ${args}. Only return the translation text.`,
                    });
                    await sock.sendMessage(remoteJid, { text: `🌐 *Translation:*\n${response.text}` });
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: `❌ Translation Error: ${err.message}` });
                }
            }

            if (baseWord === 'remind') {
                const body = text.replace(/^[!]?remind\s*/i, '').trim();
                const parts = body.split(' ');
                const minutes = parseInt(parts[0]);
                const reminderMsg = parts.slice(1).join(' ');
                if (isNaN(minutes) || !reminderMsg) {
                    await sock.sendMessage(remoteJid, { text: 'Usage: remind <minutes> <message>' });
                    continue;
                }
                await sock.sendMessage(remoteJid, { text: `⏰ Reminder set for ${minutes} minute(s) from now!` });
                setTimeout(async () => {
                    await sock.sendMessage(remoteJid, { text: `🔔 *REMINDER:* ${reminderMsg}` });
                }, minutes * 60 * 1000);
            }

            if (baseWord === 'search') {
                const query = text.replace(/^[!]?search\s*/i, '').trim();
                if (!query) {
                    await sock.sendMessage(remoteJid, { text: '⚠️ Please provide a search term.' });
                    continue;
                }
                if (!fs.existsSync('chats-log.json')) {
                    await sock.sendMessage(remoteJid, { text: '📂 No chat logs found yet.' });
                    continue;
                }
                try {
                    let logs = JSON.parse(fs.readFileSync('chats-log.json', 'utf8'));
                    let results = logs.filter(entry => entry.content.toLowerCase().includes(query.toLowerCase()) || entry.sender.toLowerCase().includes(query.toLowerCase()));
                    let responseText = results.slice(-10).map(r => `[${r.date} ${r.time}] Chat: ${r.chat} | ${r.sender}: ${r.content}`).join('\n\n');
                    await sock.sendMessage(remoteJid, { text: responseText ? `🔍 *Search Results for "${query}":*\n\n${responseText}` : `❌ No matching messages found for "${query}".` });
                } catch (e) {
                    await sock.sendMessage(remoteJid, { text: '⚠️ Error reading local log file.' });
                }
                continue;
            }
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update && update.update.message === null) {
                const deletedKeyId = update.key.id;
                const originalMsg = messageStore.get(deletedKeyId);
                if (originalMsg) {
                    try {
                        await sock.sendMessage(originalMsg.remoteJid, { 
                            text: `🚨 *ANTI-DELETE RECOVERY*\n👤 *Sender:* ${originalMsg.sender}\n⏰ *Time:* ${originalMsg.timestamp}\n\nDeleted message was:\n"${originalMsg.message.conversation || originalMsg.message.extendedTextMessage?.text || '[Media/Attachment]'}"` 
                        });
                    } catch (e) {
                        console.error('Anti-delete repost error:', e);
                    }
                }
            }
        }
    });
}

function logMessageToDisk(chatType, senderName, messageText) {
    const logFile = 'chats-log.json';
    let logs = [];
    if (fs.existsSync(logFile)) {
        try {
            logs = JSON.parse(fs.readFileSync(logFile, 'utf8'));
        } catch (e) {
            logs = [];
        }
    }
    logs.push({
        date: new Date().toLocaleDateString(),
        time: new Date().toLocaleTimeString(),
        chat: chatType,
        sender: senderName,
        content: messageText
    });
    if (logs.length > 1500) {
        logs.shift();
    }
    fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
}

startBot();
EOF

