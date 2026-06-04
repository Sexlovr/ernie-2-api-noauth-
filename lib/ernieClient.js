export async function* fetchErnieSSE(account, text, conversation) {
    const url = 'https://ernie.baidu.com/eb/chat/conversation/v2';
    
    // We expect the account to have sign, jt, acs_token, cookie_string
    const payload = {
        sign: account.sign,
        timestamp: Date.now(),
        deviceType: "pc",
        isNewYiyan: true,
        jt: account.jt || "",
        text: text,
        sessionId: conversation.ernie_session_id || "",
        sessionName: "New Chat",
        pluginIds: "",
        type: 10,
        model: "EB50",
        deepThoughtStatus: 1,
        webSearch: 1,
        newAppSessionId: "",
        file_ids: [],
        assistantId: "",
        enableNewTextCreationGoal: false,
        enableAiEditButton: false,
        sessionType: 0,
        plugins: [],
        pluginInfo: [],
        isSlowThought: false,
        isAgentSquare: false,
        noMultiReply: false,
        openAiEditButton: false,
        shareContChat: null,
        parentChatId: conversation.message_count === 0 ? "0" : (conversation.last_msg_id || "0")
    };

    const headers = {
        'Accept': 'text/event-stream,application/json, text/event-stream',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Acs-Token': account.acs_token,
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
        'Cookie': account.cookie_string,
        'Device-Type': 'pc',
        'Origin': 'https://ernie.baidu.com',
        'Referer': 'https://ernie.baidu.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
    };

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    let currentId = null;
    let currentEvent = null;
    let currentData = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // split separates last segment which might be incomplete

        for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, ''); // Strip CRLF '\r' before processing
            if (line === '') {
                if (currentEvent && currentData !== null) {
                    yield { id: currentId, event: currentEvent, data: currentData };
                }
                currentId = currentEvent = currentData = null;
            } else if (line.startsWith('data:')) {
                let content = line.slice(5);
                if (content.startsWith(' ')) content = content.slice(1);
                currentData = currentData === null ? content : currentData + '\n' + content;
            } else if (line.startsWith('event:')) {
                let content = line.slice(6);
                if (content.startsWith(' ')) content = content.slice(1);
                currentEvent = content;
            } else if (line.startsWith('id:')) {
                let content = line.slice(3);
                if (content.startsWith(' ')) content = content.slice(1);
                currentId = content;
            }
        }
    }
}
