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

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Ernie API Proxy</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 2rem; max-width: 800px; margin: 0 auto; line-height: 1.6; color: #333; background: #f9f9f9; }
        .container { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
        h1 { color: #2563eb; margin-top: 0; }
        .endpoint { background: #1e293b; color: #a5b4fc; padding: 1rem; border-radius: 6px; font-family: monospace; overflow-x: auto; }
        .status { display: inline-block; padding: 4px 12px; background: #dcfce7; color: #166534; border-radius: 9999px; font-weight: 500; font-size: 0.875rem; margin-bottom: 1rem; }
        form { margin-top: 2rem; border-top: 1px solid #e5e7eb; padding-top: 2rem; }
        textarea { width: 100%; height: 150px; padding: 0.75rem; border: 1px solid #d1d5db; border-radius: 6px; font-family: monospace; font-size: 0.875rem; margin-bottom: 1rem; box-sizing: border-box; }
        button { background: #2563eb; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 6px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
        button:hover { background: #1d4ed8; }
        #message { margin-top: 1rem; padding: 1rem; border-radius: 6px; display: none; }
        .success { background: #dcfce7; color: #166534; }
        .error { background: #fee2e2; color: #991b1b; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Ernie NoAuth Proxy Gateway</h1>
        <div class="status">● System Online</div>
        
        <p>This proxy converts Ernie's proprietary conversational API into a standard OpenAI-compatible format (SSE streaming included).</p>
        
        <h3>API Endpoint</h3>
        <div class="endpoint">POST /v1/chat/completions</div>
        
        <form id="addAccountForm">
            <h3>Add New Account Token</h3>
            <p style="font-size: 0.875rem; color: #6b7280;">Paste the full <strong>Copy as cURL (bash)</strong> string from the browser request to <code>/conversation/v2</code> here:</p>
            <textarea id="curlInput" placeholder="curl 'https://ernie.baidu.com/eb/chat/conversation/v2' \\\n  -H 'Acs-Token: ...' \\\n ..."></textarea>
            <button type="submit">Inject Tokens</button>
            <div id="message"></div>
        </form>
    </div>

    <script>
        document.getElementById('addAccountForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const msgEl = document.getElementById('message');
            const curlStr = document.getElementById('curlInput').value.trim();
            
            if (!curlStr) return;
            
            try {
                msgEl.style.display = 'block';
                msgEl.className = 'message';
                msgEl.textContent = 'Processing...';

                const res = await fetch('/admin/accounts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ curlString: curlStr })
                });
                
                const data = await res.json();
                
                if (res.ok) {
                    msgEl.className = 'success';
                    msgEl.textContent = 'Account successfully configured!';
                    document.getElementById('curlInput').value = '';
                } else {
                    msgEl.className = 'error';
                    msgEl.textContent = 'Error: ' + (data.error || 'Unknown error');
                }
            } catch (err) {
                msgEl.className = 'error';
                msgEl.textContent = 'Network error: ' + err.message;
            }
        });
    </script>
</body>
</html>
    `);
});

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
