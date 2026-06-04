import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db, getNextAccount, bumpAccountUsage, disableAccount } from './lib/database.js';
import { fetchErnieSSE } from './lib/ernieClient.js';
import { parseDirectives, buildFullContext, getLatestUserMessage, buildOpenAIChunk } from './lib/translator.js';
import { parseErnieCurl } from './lib/curlParser.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 7860;

app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Basic Admin API to add accounts via cURL string (Optional manual fallback)
app.post('/admin/accounts', (req, res) => {
    try {
        const { curlString } = req.body;
        if (!curlString) return res.status(400).json({ error: 'curlString required in body' });

        const parsed = parseErnieCurl(curlString);
        
        db.prepare(`
            INSERT INTO accounts (name, acs_token, sign, jt, cookie_string)
            VALUES (?, ?, ?, ?, ?)
        `).run(parsed.name, parsed.acs_token, parsed.sign, parsed.jt, parsed.cookie_string);
        
        res.json({ success: true, message: 'Account added successfully via manual fallback' });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/v1/chat/completions', async (req, res) => {
    try {
        let account = getNextAccount();
        if (!account) {
            return res.status(500).json({ error: { message: "No active accounts available. Automated Harvester has not grabbed one yet. Please wait 10 seconds or add one via /admin/accounts using an Ernie cURL." } });
        }

        const { messages, model, stream } = req.body;
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'messages array is required' });
        }

        // Generate conversation key based on system prompt and first message
        const sysMsg = messages.find(m => m.role === 'system')?.content || '';
        const firstUser = messages.find(m => m.role === 'user')?.content || '';
        const convKey = crypto.createHash('sha256').update(sysMsg + '_' + firstUser).digest('hex');
        
        const apiKey = req.headers.authorization || 'no-auth';
        const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

        let conv = db.prepare(`SELECT * FROM conversations WHERE conv_key = ? AND api_key_hash = ?`).get(convKey, apiKeyHash);
        let isContinuation = false;

        const directives = parseDirectives(messages);
        let promptText = '';

        if (conv) {
            if (messages.length > conv.message_count) {
                // Continuation
                isContinuation = true;
                promptText = getLatestUserMessage(messages);
                db.prepare(`UPDATE conversations SET message_count = ?, last_used = CURRENT_TIMESTAMP WHERE conv_key = ?`).run(messages.length, convKey);
            } else if (messages.length === conv.message_count) {
                // Reroll/Swipe -> send same text
                promptText = getLatestUserMessage(messages);
                db.prepare(`UPDATE conversations SET last_used = CURRENT_TIMESTAMP WHERE conv_key = ?`).run(convKey);
            } else {
                // History shrunk (reset to specific point), Ernie can't gracefully do this on same ID, start fresh
                db.prepare(`DELETE FROM conversations WHERE conv_key = ? AND api_key_hash = ?`).run(convKey, apiKeyHash);
                conv = null;
                promptText = buildFullContext(messages);
            }
        } 
        
        if (!conv) {
            promptText = buildFullContext(messages);
            conv = {
                ernie_session_id: '',
                message_count: messages.length
            };
        }
        
        res.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const responseId = 'chatcmpl-' + uuidv4();
        let fullResponse = '';

        try {
            const streamIterator = fetchErnieSSE(account, promptText, conv);
            bumpAccountUsage(account.id);

            for await (const event of streamIterator) {
                if (event.data) {
                    try {
                        const parsed = JSON.parse(event.data);
                        const payloadData = parsed.data || {};
                        
                        // Capture new session ID back from Ernie and map it in DB
                        // Ernie uses sessionId as number in data or base64 in sessionId field, we just grab sessionId
                        if (payloadData.sessionId && !conv.ernie_session_id) {
                            conv.ernie_session_id = payloadData.sessionId.toString();
                            
                            // Insert only if we don't have this conv in DB yet
                            const exists = db.prepare(`SELECT 1 FROM conversations WHERE conv_key = ? AND api_key_hash = ?`).get(convKey, apiKeyHash);
                            if (!exists) {
                                db.prepare(`
                                    INSERT INTO conversations (conv_key, api_key_hash, ernie_session_id, account_id, message_count)
                                    VALUES (?, ?, ?, ?, ?)
                                `).run(convKey, apiKeyHash, conv.ernie_session_id, account.id, messages.length);
                            }
                        }

                        if (payloadData.content) {
                            let text = payloadData.content; 
                            text = text.replace(/\0/g, ''); // Remove null bytes

                            if (stream) {
                                res.write(buildOpenAIChunk(responseId, model, { content: text }));
                            }
                            fullResponse += text;
                        }
                    } catch (e) {
                         // Some chunks (major event lines) might throw parsing errors gently ignore them
                    }
                }
            }

            if (stream) {
                res.write('data: [DONE]\n\n');
                res.end();
            } else {
                res.json({
                    id: responseId,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: fullResponse
                        },
                        finish_reason: 'stop'
                    }]
                });
            }

        } catch (apiError) {
            console.error('Ernie API Error:', apiError);
            if (apiError.message.includes('401') || apiError.message.includes('403') || apiError.message.includes('signature')) {
                disableAccount(account.id);
            }
            if (stream) {
                res.write(`data: ${JSON.stringify({ error: apiError.message })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            } else if (!res.headersSent) {
                res.status(500).json({ error: apiError.message });
            }
        }

    } catch (err) {
        console.error('Proxy Error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});


app.listen(port, () => {
    console.log(`Ernie-Proxy server running on port ${port}`);
});
