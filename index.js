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
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running!\n');
}).listen(PORT, '0.0.0.0');

process.on('uncaughtException', (err) => console.error(err));
process.on('unhandledRejection', (err) => console.error(err));

const geminiKeys = [process.env.GEMINI_KEY_1, process.env.GEMINI_KEY_2, process.env.GEMINI_KEY_3, process.env.GEMINI_KEY_4].filter(Boolean);
let activeKeyIndex = 0;

async function callGemini(payload) {
    if (geminiKeys.length === 0) throw new Error("No API keys found.");
    let attempts = 0;
    while (attempts < geminiKeys.length) {
        try {
            const ai = new GoogleGenAI({ apiKey: geminiKeys[activeKeyIndex] });
            return await ai.models.generateContent(payload);
        } catch (e) {
            activeKeyIndex = (activeKeyIndex + 1) % geminiKeys.length;
            attempts++;
            if (attempts >= geminiKeys.length) throw new Error("All API keys exhausted.");
        }
    }
}

const chatBuffers = new Map(), activeTrivia = new Map(), userModes = new Map();
const cooldowns = new Map(), messageStore = new Map(), todoLists = new Map();
let botSleeping = false;
const startTime = Date.now();

function runCmd(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout) => err ? reject(err) : resolve(stdout));
    });
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({ auth: state, printQRInTerminal: false });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, qr }) => {
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'close') startBot();
        else if (connection === 'open') console.log('✅ Bot is online!');
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;
        for (const msg of messages) {
            if (!msg.message) continue;
            if (msg.key?.id) {
                messageStore.set(msg.key.id, { remoteJid: msg.key.remoteJid, sender: msg.pushName || 'Someone', message: msg.message, time: new Date().toLocaleTimeString() });
                if (messageStore.size > 300) messageStore.delete(messageStore.keys().next().value);
            }

            if (msg.key?.remoteJid === 'status@broadcast') {
                try {
                    await sock.readMessages([msg.key]);
                    if (msg.key.participant) await sock.sendMessage('status@broadcast', { react: { text: '❤️', key: msg.key } }, { statusJidList: [msg.key.participant] });
                } catch (e) {}
                continue;
            }

            let content = msg.message;
            if (content.ephemeralMessage) content = content.ephemeralMessage.message;

            const remoteJid = msg.key.remoteJid;
            const senderJid = msg.key.participant || remoteJid;
            const isGroup = remoteJid.endsWith('@g.us');
            const rawText = content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || '';
            const text = rawText.trim();
            const lower = text.toLowerCase();
            const baseWord = lower.replace(/^!/, '').split(' ')[0];

            if (baseWord === 'neymar') {
                botSleeping = !botSleeping;
                await sock.sendMessage(remoteJid, { text: botSleeping ? '💤 *Bot is resting.*' : '⚡ *Bot is awake!*' });
                continue;
            }
            if (botSleeping && !msg.key.fromMe) continue;

            const isViewOnce = content.viewOnceMessage || content.viewOnceMessageV2 || content.imageMessage?.viewOnce;
            if (isViewOnce) {
                try {
                    const actual = content.viewOnceMessage?.message || content.viewOnceMessageV2?.message || content;
                    const buf = await downloadMediaMessage({ message: actual, key: msg.key }, 'buffer', {});
                    const p = path.join(process.cwd(), `vo_${Date.now()}.jpg`);
                    fs.writeFileSync(p, buf);
                    await sock.sendMessage(remoteJid, { image: { url: p }, caption: '🔓 *View-Once Unlocked!*' });
                    fs.unlinkSync(p);
                } catch (e) {}
                continue;
            }

            const isCmd = ['menu','help','commands','ai','talk','mode','imagine','match','tagall','hidetag','meme','summarize','analyze','analyzechat','describe','song','video','wiki','trivia','sticker','tts','tr','remind','search','calc','ping','status','map','nav','weather','qr','todo','todos','cleartodos'].includes(baseWord);

            if (activeTrivia.has(remoteJid) && ['A','B','C','D'].includes(text.toUpperCase()) && text.length === 1) {
                const correct = activeTrivia.get(remoteJid);
                await sock.sendMessage(remoteJid, { text: text.toUpperCase() === correct ? `🎉 Correct!` : `❌ Incorrect! Answer was ${correct}.` });
                activeTrivia.delete(remoteJid);
                continue;
            }

            if (isCmd && Date.now() - (cooldowns.get(senderJid) || 0) < 2000) continue;
            if (isCmd) cooldowns.set(senderJid, Date.now());

            const isQuotingBot = content.extendedTextMessage?.contextInfo?.participant === sock.user?.id;
            if ((!isGroup && text && !isCmd) || (isQuotingBot && text && !isCmd)) {
                try {
                    const res = await callGemini({ model: 'gemini-1.5-flash', contents: text });
                    await sock.sendMessage(remoteJid, { text: res.text });
                } catch (e) {}
                continue;
            }

            if (['menu','help','commands'].includes(baseWord) || lower === 'commands') {
                const menu = `📖 *BOT COMMAND GUIDE* 📖\n⚡ *Powered by cold.era10*\n───────────────────────────\n\n` +
                    `🧠 *AI-POWERED COMMANDS*\n` +
                    `• Direct Chat / !ai <prompt>\n` +
                    `• !talk <prompt> (Voice note)\n` +
                    `• !imagine <prompt> (AI Art)\n` +
                    `• !match <team> (Live scores)\n` +
                    `• !summarize / !analyze\n` +
                    `• !analyzechat / !describe\n` +
                    `• !mode <persona> / !tr <lang> <text>\n` +
                    `• !trivia (Interactive quiz)\n\n` +
                    `⚡ *AI-FREE UTILITIES*\n` +
                    `• !map <destination>\n` +
                    `• !weather <city>\n` +
                    `• !qr <text/link>\n` +
                    `• !todo <task> / !todos / !cleartodos\n` +
                    `• !song <title> / !video <title>\n` +
                    `• !wiki <topic> / !sticker\n` +
                    `• !meme <top | bottom>\n` +
                    `• !tts <text> / !calc <expr>\n` +
                    `• !remind <mins> <text>\n` +
                    `• !search <query> / !ping\n\n` +
                    `👥 *GROUP TOOLS*\n` +
                    `• !tagall <msg> / !hidetag <msg>\n\n` +
                    `🔓 *AUTOMATION*\n` +
                    `• !Neymar (Sleep/Wake)\n` +
                    `• View-Once Saver & Status Liker\n` +
                    `• Anti-Delete Recovery Active\n───────────────────────────`;
                await sock.sendMessage(remoteJid, { text: menu });
                continue;
            }

            if (baseWord === 'ai') {
                const p = text.replace(/^[!]?ai\s*/i, '').trim();
                if (p) {
                    const res = await callGemini({ model: 'gemini-1.5-flash', contents: p });
                    await sock.sendMessage(remoteJid, { text: res.text });
                }
            } else if (baseWord === 'map' || baseWord === 'nav') {
                const q = text.replace(/^[!]?(map|nav)\s*/i, '').trim();
                if (q) await sock.sendMessage(remoteJid, { text: `🗺️ *Map:* https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` });
            } else if (baseWord === 'weather') {
                const c = text.replace(/^[!]?weather\s*/i, '').trim();
                if (c) {
                    const res = await fetch(`https://wttr.in/${encodeURIComponent(c)}?format=3`);
                    await sock.sendMessage(remoteJid, { text: `🌤️ ${(await res.text()).trim()}` });
                }
            } else if (baseWord === 'qr') {
                const d = text.replace(/^[!]?qr\s*/i, '').trim();
                if (d) await sock.sendMessage(remoteJid, { image: { url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(d)}` } });
            } else if (baseWord === 'todo') {
                const t = text.replace(/^[!]?todo\s*/i, '').trim();
                if (t) {
                    if (!todoLists.has(remoteJid)) todoLists.set(remoteJid, []);
                    todoLists.get(remoteJid).push(t);
                    await sock.sendMessage(remoteJid, { text: `✅ Task added!` });
                }
            } else if (baseWord === 'todos') {
                const list = todoLists.get(remoteJid) || [];
                await sock.sendMessage(remoteJid, { text: list.length ? `📋 *To-Do:*\n` + list.map((x, i) => `${i+1}. ${x}`).join('\n') : '📋 Empty list.' });
            } else if (baseWord === 'cleartodos') {
                todoLists.set(remoteJid, []);
                await sock.sendMessage(remoteJid, { text: '🗑️ Cleared!' });
            } else if (baseWord === 'calc') {
                const e = text.replace(/^[!]?calc\s*/i, '').trim();
                try { await sock.sendMessage(remoteJid, { text: `🔢 Result: ${eval(e.replace(/[^0-9+\-*/().%]/g, ''))}` }); } catch (err) {}
            } else if (baseWord === 'ping' || baseWord === 'status') {
                const up = Math.floor((Date.now() - startTime) / 1000);
                await sock.sendMessage(remoteJid, { text: `🟢 Active | Uptime: ${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m` });
            }
        }
    });

    sock.ev.on('messages.update', async (ups) => {
        for (const up of ups) {
            if (up.update?.message === null) {
                const orig = messageStore.get(up.key.id);
                if (orig) await sock.sendMessage(orig.remoteJid, { text: `🚨 *Anti-Delete:* ${orig.sender} deleted: "${orig.message.conversation || '[Media]'}"` });
            }
        }
    });
}

startBot();

