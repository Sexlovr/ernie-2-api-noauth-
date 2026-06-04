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
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Ernie Proxy Gateway</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        :root { --primary: #3b82f6; --primary-hover: #2563eb; --bg: #0f172a; --surface: rgba(30, 41, 59, 0.7); --text: #f8fafc; --text-muted: #94a3b8; --border: rgba(255, 255, 255, 0.1); }
        * { box-sizing: border-box; }
        body { margin: 0; padding: 2rem; font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; justify-content: center; align-items: flex-start; background: radial-gradient(circle at top right, #1e1b4b, #0f172a); }
        .glass-panel { background: var(--surface); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--border); padding: 2.5rem; border-radius: 16px; width: 100%; max-width: 800px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); animation: fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1); margin-top: 2rem; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 2rem; border-bottom: 1px solid var(--border); padding-bottom: 1.5rem; }
        h1 { margin: 0; font-size: 1.875rem; font-weight: 700; background: linear-gradient(to right, #60a5fa, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .badge { background: rgba(16, 185, 129, 0.1); color: #34d399; padding: 0.35rem 0.75rem; border-radius: 9999px; font-size: 0.875rem; font-weight: 500; display: flex; align-items: center; gap: 0.5rem; border: 1px solid rgba(16, 185, 129, 0.2); }
        .badge::before { content: ''; display: block; width: 8px; height: 8px; background: #34d399; border-radius: 50%; box-shadow: 0 0 8px #34d399; }
        h3 { font-size: 1.25rem; font-weight: 600; margin: 1.5rem 0 1rem; color: #e2e8f0; }
        .endpoint-box { background: rgba(0,0,0,0.3); border: 1px solid var(--border); padding: 1.25rem; border-radius: 10px; font-family: monospace; font-size: 0.95rem; color: #a5b4fc; display: flex; align-items: center; letter-spacing: 0.5px; }
        .models-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
        .model-card { background: rgba(255,255,255,0.03); border: 1px solid var(--border); padding: 1.25rem; border-radius: 10px; transition: transform 0.2s, background 0.2s; }
        .model-card:hover { transform: translateY(-3px); background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.2); }
        .model-name { font-weight: 600; color: #f8fafc; margin-bottom: 0.25rem; display: block; }
        .model-id { font-size: 0.85rem; color: var(--text-muted); font-family: monospace; }
        textarea { width: 100%; height: 160px; background: rgba(0,0,0,0.2); border: 1px solid var(--border); color: #e2e8f0; padding: 1rem; border-radius: 10px; font-family: monospace; font-size: 0.9rem; line-height: 1.5; outline: none; transition: border-color 0.2s; resize: vertical; }
        textarea:focus { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2); }
        textarea::placeholder { color: #475569; }
        button { background: var(--primary); color: white; border: none; padding: 0.875rem 1.5rem; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: all 0.2s; margin-top: 1rem; width: 100%; font-family: inherit; }
        button:hover { background: var(--primary-hover); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3); }
        #message { margin-top: 1.25rem; padding: 1rem; border-radius: 8px; display: none; font-size: 0.95rem; font-weight: 500; animation: fadeUp 0.3s ease; }
        .success { background: rgba(16, 185, 129, 0.1); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.2); }
        .error { background: rgba(239, 68, 68, 0.1); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.2); }
    </style>
</head>
<body>
    <div class="glass-panel">
        <header>
            <h1>Ernie Proxy Gateway</h1>
            <div class="badge">System Online</div>
        </header>

        <p style="color: var(--text-muted); margin-bottom: 2rem;">Seamlessly bridge Ernie's proprietary API to OpenAI's completion format supporting native SSE streaming and continuations.</p>
        
        <h3>Available Models</h3>
        <div class="models-grid">
            <div class="model-card">
                <span class="model-name">EB5.1 Thinking</span>
                <span class="model-id">EB5.1-Thinking</span>
            </div>
            <div class="model-card">
                <span class="model-name">EB5.1 Instant</span>
                <span class="model-id">EB5.1-Instant</span>
            </div>
            <div class="model-card">
                <span class="model-name">EB Cobuddy</span>
                <span class="model-id">EB-Cobuddy</span>
            </div>
        </div>
        
        <h3>API Endpoint</h3>
        <div class="endpoint-box">POST /v1/chat/completions</div>
        
        <form id="addAccountForm" style="margin-top: 2rem; border-top: 1px solid var(--border); padding-top: 2rem;">
            <h3>Inject Credentials</h3>
            <p style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 1rem;">Paste the full <strong style="color: #cbd5e1;">Copy as cURL (bash)</strong> string from the <code>/conversation/v2</code> network request below to bypass captchas seamlessly.</p>
            <textarea id="curlInput" placeholder="curl 'https://ernie.baidu.com/eb/chat/conversation/v2' \
  -H 'Acs-Token: xxx...' \
  ..."></textarea>
            <button type="submit">Activate Token</button>
            <div id="message"></div>
        </form>
    </div>

    <script>
        document.getElementById('addAccountForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const msgEl = document.getElementById('message');
            const curlStr = document.getElementById('curlInput').value.trim();
            const btn = e.target.querySelector('button');
            
            if (!curlStr) return;
            
            try {
                btn.textContent = 'Injecting...';
                btn.style.opacity = '0.7';
                
                msgEl.style.display = 'block';
                msgEl.className = 'message';
                msgEl.textContent = 'Processing cURL string...';

                const res = await fetch('/admin/accounts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ curlString: curlStr })
                });
                
                const data = await res.json();
                
                if (res.ok) {
                    msgEl.className = 'success';
                    msgEl.textContent = '✓ Token successfully injected and activated!';
                    document.getElementById('curlInput').value = '';
                } else {
                    msgEl.className = 'error';
                    msgEl.textContent = '✗ Error: ' + (data.error || 'Unknown error');
                }
            } catch (err) {
                msgEl.className = 'error';
                msgEl.textContent = '✗ Network error: ' + err.message;
            } finally {
                btn.textContent = 'Activate Token';
                btn.style.opacity = '1';
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
