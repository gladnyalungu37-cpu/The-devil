import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

dotenv.config();

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
            console.log('\nScan this QR code in WhatsApp:\n');
            qrcode.generate(qr, { small: true });
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
                } catch (err) {
                    console.error('Status view error:', err);
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

            logMessageToDisk(isGroup ? 'Group' : 'Private', senderName, msgContent.conversation

