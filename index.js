import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, jidNormalizedUser } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import fs from 'fs';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const geminiKeys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4
].filter(Boolean);

let activeKeyIndex = 0;

async function callGemini(payload) {
    if (geminiKeys.length === 0) throw new Error("No API keys found in environment variables.");
    let attempts = 0;
    while (attempts < geminiKeys.length) {
        try {
            const currentKey = geminiKeys[activeKeyIndex];
            const aiClient = new GoogleGenAI({ apiKey: currentKey });
            
            const requestPayload = { model: 'gemini-2.5-flash', ...payload };

            const response = await aiClient.models.generateContent(requestPayload);
            return response;
        } catch (err) {
            console.warn(`⚠️ API Key [Index ${activeKeyIndex}] failed: ${err.message}. Rotating...`);
            activeKeyIndex = (activeKeyIndex + 1) % geminiKeys.length;
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (attempts >= geminiKeys.length) {
                throw new Error("All Gemini API keys have exhausted their quotas or are experiencing high demand.");
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

// Blocked phone numbers (stripped of non-numeric characters for reliable matching)
const blockedNumbers = ['27780141352', '27738262921'];

function saveToBuffer(remoteJid, sender, text) {
    if (!chatBuffers.has(remoteJid)) chatBuffers.set(remoteJid, []);
    const buffer = chatBuffers.get(remoteJid);
    buffer.push({ sender, text, timestamp: new Date().toLocaleTimeString() });
    if (buffer.length > MAX_BUFFER_SIZE) buffer.shift();
}

function runCommand(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout) => {
            if (error) return reject(error);
            resolve(stdout);
        });
    });
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    // Added socket stability configs to prevent Render network drops
    const sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: true,
        browser: ["Ubuntu", "Chrome", "22.04.4"],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('\nScan this QR code in WhatsApp:\n');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`🔌 Connection closed due to status code: ${statusCode}. Reconnecting...`);
            
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('❌ Device logged out. Please clear session files and re-scan QR.');
                if (fs.existsSync('auth_info_baileys')) {
                    fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                }
            }

            setTimeout(() => {
                startBot();
            }, 5000);
        } else if (connection === 'open') {
            console.log('\n✅ Ultimate WhatsApp AI Bot (Powered by cold.era10) is active!\n');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`📥 [messages.upsert triggered] Type: ${type}, Count: ${messages.length}`);
        if (type !== 'notify' && type !== 'append') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const remoteJid = msg.key.remoteJid;
            const senderJid = msg.key.participant || msg.key.remoteJid;

            // Prevent chatting with or processing messages from specific blocked numbers
            const cleanSender = senderJid.replace(/[^0-9]/g, '');
            const cleanRemote = remoteJid.replace(/[^0-9]/g, '');
            if (blockedNumbers.some(num => cleanSender.includes(num) || cleanRemote.includes(num))) {
                continue;
            }
            
            if (msg.key && msg.key.id) {
                messageStore.set(msg.key.id, {
                    remoteJid: msg.key.remoteJid,
                    sender: msg.pushName || 'Someone',
                    message: msg.message,
                    timestamp: new Date().toLocaleTimeString()
                });
                if (messageStore.size > 500) {
                    messageStore.delete(messageStore.keys().next().value);
                }
            }

            if (msg.key && msg.key.remoteJid === 'status@broadcast') {
                try { await sock.readMessages([msg.key]); } catch (err) {}
                continue;
            }

            let msgContent = msg.message;
            if (msgContent.ephemeralMessage) msgContent = msgContent.ephemeralMessage.message;

            const isGroup = remoteJid.endsWith('@g.us');
            const senderName = msg.pushName || (msg.key.fromMe ? 'Bot Owner' : 'Friend');

            const rawText = msgContent.conversation || msgContent.extendedTextMessage?.text || msgContent.imageMessage?.caption || '';
            const text = rawText.trim();

            console.log(`💬 Message from [${senderName}] in [${remoteJid}]: "${text || '[Media]'}"`);

            logMessageToDisk(isGroup ? 'Group' : 'Private', senderName, text || '[Media]');

            const lowerText = text.toLowerCase();
            const baseWord = lowerText.replace(/^!/, '').split(' ')[0];

            if (baseWord === 'neymar') {
                botSleeping = !botSleeping;
                await sock.sendMessage(remoteJid, { text: botSleeping ? '💤 *Bot is now resting (Sleeping Mode ON).*' : '⚡ *Bot is fully awake and active!*' });
                continue;
            }

            // Completely stop execution if bot is sleeping and message is not from owner
            if (botSleeping && !msg.key.fromMe) continue;

            const commandKeywords = [
                'menu', 'help', 'ai', 'talk', 'mode', 'imagine', 'match',
                'football', 'tagall', 'hidetag', 'meme', 'summarize', 'analyze',
                'analyzechat', 'describe', 'song', 'video', 'wiki',
                'trivia', 'sticker', 'tts', 'tr', 'remind', 'search', 'calc', 'ping', 'status',
                'map', 'nav', 'weather', 'qr', 'todo', 'todos', 'cleartodos'
            ];
            const isCommand = commandKeywords.includes(baseWord);

            if (activeTrivia.has(remoteJid) && ['A', 'B', 'C', 'D'].includes(text.toUpperCase()) && text.length === 1) {
                const correct = activeTrivia.get(remoteJid);
                if (text.toUpperCase() === correct) {
                    await sock.sendMessage(remoteJid, { text: `🎉 Correct ${senderName}! Option *${correct}* is right.` });
                } else {
                    await sock.sendMessage(remoteJid, { text: `❌ Incorrect ${senderName}! It was *${correct}*.` });
                }
                activeTrivia.delete(remoteJid);
                continue;
            }

            if (text && !isCommand) saveToBuffer(remoteJid, senderName, text);

            if (isCommand) {
                const now = Date.now();
                if (now - (cooldowns.get(senderJid) || 0) < 3000) {
                    await sock.sendMessage(remoteJid, { text: '⏳ *Please wait a few seconds before using another command!*' });
                    continue;
                }
                cooldowns.set(senderJid, now);
            }

            const quotedContext = msgContent.extendedTextMessage?.contextInfo;
            const botJidNormalized = sock.user?.id ? jidNormalizedUser(sock.user.id) : '';
            const quotedParticipantNormalized = quotedContext?.participant ? jidNormalizedUser(quotedContext.participant) : '';
            const isQuotingBot = botJidNormalized && quotedParticipantNormalized && quotedParticipantNormalized === botJidNormalized;

            if ((!isGroup && text && !isCommand) || (isQuotingBot && text && !isCommand)) {
                if (botSleeping) continue;
                const currentMode = userModes.get(remoteJid) || 'friend';
                let sysInstruction = "You are a warm, casual, and supportive friend on WhatsApp.";
                if (currentMode === 'normal') sysInstruction = "You are a fast WhatsApp assistant.";
                if (currentMode === 'roast') sysInstruction = "You are a witty assistant with sarcastic banter.";
                if (currentMode === 'tutor') sysInstruction = "You are an educational tutor.";
                if (currentMode === 'hype') sysInstruction = "You are a high-energy hype assistant!";

                try {
                    const response = await callGemini({
                        contents: text,
                        config: { systemInstruction: sysInstruction }
                    });
                    if (botSleeping) continue;
                    await sock.sendMessage(remoteJid, { text: response.text });
                    continue;
                } catch (err) {
                    console.error("❌ Direct DM/AI Error:", err.message);
                    continue;
                }
            }

            if (baseWord === 'menu' || baseWord === 'help') {
                const menuText = `📖 *COMPLETE BOT COMMAND GUIDE* 📖\n` +
                    `⚡ *Powered by cold.era10*\n` +
                    `───────────────────────────\n\n` +
                    `🤖 *AI-POWERED FEATURES*\n` +
                    `• Direct DM Chat : Text bot directly (No prefix)\n` +
                    `• !ai <prompt> : Ask Gemini a question\n` +
                    `• !talk <prompt> : Get AI voice note response\n` +
                    `• !analyze : Reply to message to analyze tone\n` +
                    `• !analyzechat : Complete chat history analytics\n` +
                    `• !describe : Photo AI vision inspection\n` +
                    `• !mode <persona> : Change AI tone (friend, roast, tutor, hype)\n` +
                    `• !imagine <prompt> : Generate AI artwork from text\n` +
                    `• !match <team> : Live scores & upcoming match status\n` +
                    `• !summarize : Reply to text for bullet summary\n` +
                    `• !tr <lang> <text> : Instant translation\n` +
                    `• !trivia : Play interactive AI quiz\n\n` +
                    `⚡ *AI-FREE UTILITIES*\n` +
                    `• !song <title/artist> : Download MP3 audio\n` +
                    `• !video <title> : Download MP4 video\n` +
                    `• !sticker : Convert image to sticker\n` +
                    `• !meme <top | bottom> : Overlay meme text on photos\n` +
                    `• !tts <text> : Text to custom voice note\n` +
                    `• !wiki <topic> : Wikipedia facts summary\n` +
                    `• !remind <mins> <text> : Timer reminder notification\n` +
                    `• !search <query> : Search saved local chat logs\n` +
                    `• !calc <expr> : Math calculation engine\n` +
                    `• !ping / !status : Check bot uptime & active keys\n` +
                    `• !map <destination> : GPS map links\n` +
                    `• !weather <city> : Real-time weather forecast lookup (°C)\n` +
                    `• !qr <text/link> : Generate QR code image\n` +
                    `• !todo / !todos : Chat to-do list manager\n\n` +
                    `👥 *GROUP TOOLS (AI-FREE)*\n` +
                    `• !tagall <msg> : Mention all group members visibly\n` +
                    `• !hidetag <msg> : Invisible mass group mention\n\n` +
                    `🔓 *AUTOMATION & CONTROLS (AI-FREE)*\n` +
                    `• !Neymar : Sleep / Wake bot toggle\n` +
                    `• Anti-Delete Recovery : Auto-reposts deleted texts\n` +
                    `• Background Logger : Silently indexes chat activity\n` +
                    `───────────────────────────`;
                await sock.sendMessage(remoteJid, { text: menuText });
                continue;
            }

            if (baseWord === 'ai') {
                if (botSleeping) continue;
                const prompt = text.replace(/^[!]?ai\s*/i, '').trim();
                if (!prompt) {
                    await sock.sendMessage(remoteJid, { text: 'Please ask a question! Example: ai What is gravity?' });
                    continue;
                }
                try {
                    const response = await callGemini({ contents: prompt });
                    if (botSleeping) continue;
                    await sock.sendMessage(remoteJid, { text: response.text });
                } catch (err) {
                    console.error("❌ AI Error:", err.message);
                }
            }

            if (baseWord === 'map' || baseWord === 'nav') {
                const query = text.replace(/^[!]?(map|nav)\s*/i, '').trim();
                if (!query) {
                    await sock.sendMessage(remoteJid, { text: '⚠️ Please specify a destination!\nExample: `!map Johannesburg`' });
                    continue;
                }
                const encoded = encodeURIComponent(query);
                await sock.sendMessage(remoteJid, { 
                    text: `🗺️ *GPS & Navigation Finder*\n\n📍 *Destination:* ${query}\n\n🌐 *View on Map:* https://www.google.com/maps/search/?api=1&query=${encoded}\n🚗 *Get Directions:* https://www.google.com/maps/dir/?api=1&destination=${encoded}\n\n⚡ _Zero AI quota used!_` 
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
                    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3&m`);
                    const weatherText = await res.text();
                    await sock.sendMessage(remoteJid, { text: `🌤️ *Weather Forecast (°C)*\n\n${weatherText.trim()}\n\n⚡ _Zero AI quota used!_` });
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
                    await sock.sendMessage(remoteJid, { text: '⚠️ Please specify a task!\nExample: `!todo Finish math homework`' });
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
                if (botSleeping) continue;
                const prompt = text.replace(/^[!]?talk\s*/i, '').trim();
                if (!prompt) {
                    await sock.sendMessage(remoteJid, { text: 'Say something! Example: talk How are you today?' });
                    continue;
                }
                try {
                    await sock.sendMessage(remoteJid, { text: '🎙️ Thinking and recording response...' });
                    const aiResponse = await callGemini({
                        contents: prompt,
                        config: { systemInstruction: "Respond like a close friend in 2-3 short, spoken sentences." }
                    });
                    if (botSleeping) continue;
                    const audioPath = path.join(process.cwd(), `talk_${Date.now()}.mp3`);
                    const pyScript = `from gtts import gTTS; tts = gTTS(text='${aiResponse.text.replace(/'/g, "\\'")}', lang='en'); tts.save('${audioPath}')`;
                    await runCommand(`python -c "${pyScript}"`);
                    if (fs.existsSync(audioPath)) {
                        if (botSleeping) {
                            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
                            continue;
                        }
                        await sock.sendMessage(remoteJid, { audio: { url: audioPath }, mimetype: 'audio/mp4', ptt: true });
                        fs.unlinkSync(audioPath);
                    }
                } catch (err) {
                    console.error("❌ Talk Error:", err.message);
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
                if (botSleeping) continue;
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
                        if (botSleeping) {
                            if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
                            continue;
                        }
                        await sock.sendMessage(remoteJid, { image: { url: imagePath }, caption: `✨ *AI Artwork:* ${prompt}\n\n⚡ *Powered by cold.era10*` });
                        fs.unlinkSync(imagePath);
                    }
                } catch (err) {
                    console.error("❌ Imagine Error:", err.message);
                }
            }

            if (baseWord === 'match' || baseWord === 'football') {
                if (botSleeping) continue;
                const team = text.replace(/^[!]?(match|football)\s*/i, '').trim();
                if (!team) {
                    await sock.sendMessage(remoteJid, { text: 'Specify a team! Example: match FC Barcelona' });
                    continue;
                }
                try {
                    await sock.sendMessage(remoteJid, { text: `⚽ Fetching latest updates for *${team}*...` });
                    const response = await callGemini({
                        contents: `Provide the latest match scores, upcoming fixtures, and team news for ${team}. Format nicely with emojis.`
                    });
                    if (botSleeping) continue;
                    await sock.sendMessage(remoteJid, { text: response.text });
                } catch (err) {
                    console.error("❌ Match Info Error:", err.message);
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
                        if (botSleeping) {
                            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                            continue;
                        }
                        await sock.sendMessage(remoteJid, { image: { url: outputPath } });
                        fs.unlinkSync(inputPath);
                        fs.unlinkSync(outputPath);
                    }
                } catch (err) {
                    console.error("❌ Meme Error:", err.message);
                }
            }

            if (baseWord === 'summarize') {
                if (botSleeping) continue;
                const context = msgContent.extendedTextMessage?.contextInfo;
                const quotedText = context?.quotedMessage?.conversation || context?.quotedMessage?.extendedTextMessage?.text;
                if (!quotedText) {
                    await sock.sendMessage(remoteJid, { text: 'Please reply to a long text message or thread with summarize.' });
                    continue;
                }
                try {
                    const response = await callGemini({
                        contents: `Summarize the following text into 3 clear bullet points:\n\n"${quotedText}"`,
                    });
                    if (botSleeping) continue;
                    await sock.sendMessage(remoteJid, { text: `📝 *Summary:*\n\n${response.text}` });
                } catch (err) {
                    console.error("❌ Summary Error:", err.message);
                }
            }

            if (baseWord === 'analyze') {
                if (botSleeping) continue;
                const context = msgContent.extendedTextMessage?.contextInfo;
                const quotedText = context?.quotedMessage?.conversation || context?.quotedMessage?.extendedTextMessage?.text;
                if (!quotedText) {
                    await sock.sendMessage(remoteJid, { text: 'Please reply to a message and type analyze.' });
                    continue;
                }
                try {
                    const response = await callGemini({
                        contents: `Analyze this message: "${quotedText}". Provide key insights, tone, and a brief summary.`,
                    });
                    if (botSleeping) continue;
                    await sock.sendMessage(remoteJid, { text: response.text });
                } catch (err) {
                    console.error("❌ Analysis Error:", err.message);
                }
            }

            if (baseWord === 'analyzechat') {
                if (botSleeping) continue;
                const buffer = chatBuffers.get(remoteJid) || [];
                if (buffer.length < 2) {
                    await sock.sendMessage(remoteJid, { text: '⚠️ Not enough chat history captured yet.' });
                    continue;
                }
                const formattedHistory = buffer.map(m => `[${m.timestamp}] ${m.sender}: ${m.text}`).join('\n');
                try {
                    await sock.sendMessage(remoteJid, { text: '🔍 Analyzing full chat history...' });
                    const response = await callGemini({
                        contents: `Here is a transcript of recent messages from this WhatsApp chat:\n\n${formattedHistory}\n\nPlease analyze the interaction. Summarize key topics, emotional tone, and main takeaways.`,
                    });
                    if (botSleeping) continue;
                    await sock.sendMessage(remoteJid, { text: response.text });
                } catch (err) {
                    console.error("❌ Chat Analysis Error:", err.message);
                }
            }

            if (baseWord === 'describe') {
                if (botSleeping) continue;
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
                        contents: [
                            { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
                            { text: 'Describe what you see in this image in detail, including text, objects, and overall context.' }
                        ]
                    });
                    if (botSleeping) continue;
                    await sock.sendMessage(remoteJid, { text: response.text });
                } catch (err) {
                    console.error("❌ Vision Error:", err.message);
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
                        if (botSleeping) {
                            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                            continue;
                        }
                        await sock.sendMessage(remoteJid, { audio: { url: outputPath }, mimetype: 'audio/mp4', fileName: `${query}.mp3` });
                        fs.unlinkSync(outputPath);
                    } else {
                        await sock.sendMessage(remoteJid, { text: '❌ Failed to locate audio file.' });
                    }
                } catch (err) {
                    console.error("❌ Download Error:", err.message);
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
                        if (botSleeping) {
                            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                            continue;
                        }
                        await sock.sendMessage(remoteJid, { video: { url: outputPath }, caption: `Here is your video for: ${query}` });
                        fs.unlinkSync(outputPath);
                    } else {
                        await sock.sendMessage(remoteJid, { text: '❌ Failed to locate video file.' });
                    }
                } catch (err) {
                    console.error("❌ Download Error:", err.message);
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
                        if (botSleeping) continue;
                        await sock.sendMessage(remoteJid, { text: `📖 *Wikipedia: ${data.title}*\n\n${data.extract}\n\n🔗 ${data.content_urls?.desktop?.page || ''}` });
                    } else {
                        await sock.sendMessage(remoteJid, { text: '❌ No Wikipedia article found.' });
                    }
                } catch (err) {
                    await sock.sendMessage(remoteJid, { text: '❌ Error fetching Wikipedia entry.' });
                }
            }

            if (baseWord === 'trivia') {
                if (botSleeping) continue;
                try {
                    const prompt = "Generate a fun trivia question. Format strictly as:\nQUESTION: [question]\nA) [opt1]\nB) [opt2]\nC) [opt3]\nD) [opt4]\nANSWER: [A/B/C/D]";
                    const response = await callGemini({ contents: prompt });
                    if (botSleeping) continue;
                    const content = response.text;
                    const answerMatch = content.match(/ANSWER:\s*([A-D])/i);
                    const correctAnswer = answerMatch ? answerMatch[1].toUpperCase() : 'A';
                    activeTrivia.set(remoteJid, correctAnswer);
                    await sock.sendMessage(remoteJid, { text: `🧠 *Trivia Time!*\n\n${content}\n\n_Reply with A, B, C, or D to answer!_` });
                } catch (err) {
                    console.error("❌ Trivia Error:", err.message);
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
                        if (botSleeping) {
                            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                            continue;
                        }
                        await sock.sendMessage(remoteJid, { sticker: { url: outputPath } });
                        fs.unlinkSync(inputPath);
                        fs.unlinkSync(outputPath);
                    }
                } catch (err) {
                    console.error("❌ Sticker Error:", err.message);
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
                        if (botSleeping) {
                            if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
                            continue;
                        }
                        await sock.sendMessage(remoteJid, { audio: { url: audioPath }, mimetype: 'audio/mp4', ptt: true });
                        fs.unlinkSync(audioPath);
                    }
                } catch (err) {
                    console.error("❌ TTS Error:", err.message);
                }
            }

            if (baseWord === 'tr') {
                if (botSleeping) continue;
                const args = text.replace(/^[!]?tr\s*/i, '').trim();
                if (!args) {
                    await sock.sendMessage(remoteJid, { text: 'Usage: tr <language> <text>' });
                    continue;
                }
                try {
                    const response = await callGemini({
                        contents: `Translate the following statement strictly into ${args}. Only return the translation text.`,
                    });
                    if (botSleeping) continue;
                    await sock.sendMessage(remoteJid, { text: `🌐 *Translation:*\n${response.text}` });
                } catch (err) {
                    console.error("❌ Translation Error:", err.message);
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
                    if (botSleeping) return;
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
        if (botSleeping) return;
        
        for (const update of updates) {
            if (update.update && update.update.message === null) {
                const deletedKeyId = update.key.id;
                const originalMsg = messageStore.get(deletedKeyId);
                if (originalMsg) {
                    try {
                        if (botSleeping) continue;
                        await sock.sendMessage(originalMsg.remoteJid, { 
                            text: `🚨 *ANTI-DELETE RECOVERY*\n👤 *Sender:* ${originalMsg.sender}\n⏰ *Time:* ${originalMsg.timestamp}\n\nDeleted message was:\n"${originalMsg.message.conversation || originalMsg.message.extendedTextMessage?.text || '[Media/Attachment]'}"` 
                        });
                    } catch (e) {}
                }
            }
        }
    });
}

function logMessageToDisk(chatType, senderName, messageText) {
    const logFile = 'chats-log.json';
    let logs = [];
    if (fs.existsSync(logFile)) {
        try { logs = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch (e) { logs = []; }
    }
    logs.push({
        date: new Date().toLocaleDateString(),
        time: new Date().toLocaleTimeString(),
        chat: chatType,
        sender: senderName,
        content: messageText
    });
    if (logs.length > 1500) logs.shift();
    fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
}

// Global safety catch blocks to prevent terminal/Render drops from unhandled bugs
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled Rejection:', reason);
});

startBot();

// Dummy HTTP Server for Render port detection
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WhatsApp Bot is running!');
}).listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 HTTP server listening on port ${PORT}`);
});

