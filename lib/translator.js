export function parseDirectives(messages) {
    let settings = {
        think: false,
        search: false
    };

    const sysMsg = messages.find(m => m.role === 'system')?.content || '';
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';

    const textToParse = sysMsg + '\n' + lastUserMsg;

    if (textToParse.includes('[think=on]')) settings.think = true;
    if (textToParse.includes('[think=off]')) settings.think = false;
    
    if (textToParse.includes('[search=on]')) settings.search = true;
    if (textToParse.includes('[search=off]')) settings.search = false;

    return settings;
}

export function buildFullContext(messages) {
    let context = '';
    for (const msg of messages) {
        let role = msg.role === 'user' ? 'User' : (msg.role === 'assistant' ? 'Assistant' : 'System');
        // Clean out directives string before sending upstream
        let content = msg.content
            .replace(/\[think=(on|off)\]/ig, '')
            .replace(/\[search=(on|off)\]/ig, '')
            .trim();
            
        context += `${role}: ${content}\n\n`;
    }
    return context.trim();
}

export function getLatestUserMessage(messages) {
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'user') return "Continue.";
    return lastMsg.content
        .replace(/\[think=(on|off)\]/ig, '')
        .replace(/\[search=(on|off)\]/ig, '')
        .trim();
}

export function buildOpenAIChunk(responseId, model, delta, finishReason = null) {
    return `data: ${JSON.stringify({
        id: responseId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
            index: 0,
            delta: delta,
            finish_reason: finishReason
        }]
    })}\n\n`;
}
