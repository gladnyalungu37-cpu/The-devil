import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
dotenv.config();

const apiKeys = [];
for (let i = 1; i <= 4; i++) {
    const key = process.env['GEMINI_API_KEY_' + i];
    if (key) apiKeys.push(key.trim());
}
if (apiKeys.length > 0) {
    process.env.GEMINI_API_KEY = apiKeys[0];
}
console.log('🔑 Loaded ' + apiKeys.length + ' Gemini API keys successfully.');

let currentKeyIndex = 0;

function getAIClient() {
    const apiKey = apiKeys[currentKeyIndex] || process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("API key should be set when using the Gemini API");
    }
    return new GoogleGenAI({ apiKey });
}

export async function safeGenerateContent(payload) {
    let attempts = 0;
    while (attempts < apiKeys.length) {
        try {
            const ai = getAIClient();
            const response = await ai.models.generateContent(payload);
            return response;
        } catch (err) {
            if (err.message && (err.message.includes('429') || err.message.includes('ResourceExhausted') || err.message.includes('quota') || err.message.includes('401') || err.message.includes('API key'))) {
                console.log('⚠️ Rate limit or auth error hit on key index ' + currentKeyIndex + '. Rotating to next API key...');
                currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
                attempts++;
            } else {
                throw err;
            }
        }
    }
    throw new Error('❌ All Gemini API keys have exhausted their limits or failed.');
}
