// Helper to parse pasted cURL scripts from browser Network tab
export function parseErnieCurl(curlString) {
    const account = {
        name: `Ernie-${Math.floor(Math.random() * 1000)}`,
        acs_token: '',
        sign: '',
        jt: '',
        cookie_string: ''
    };

    // Extract headers using regex
    const acsMatch = curlString.match(/-H\s+['"]Acs-Token:\s*([^'"]+)['"]/i);
    if (acsMatch) account.acs_token = acsMatch[1];

    const cookieHeaderMatch = curlString.match(/-H\s+['"]Cookie:\s*([^'"]+)['"]/i);
    const cookieFlagMatch = curlString.match(/-b\s+['"]([^'"]+)['"]/i);
    
    if (cookieHeaderMatch) account.cookie_string = cookieHeaderMatch[1];
    else if (cookieFlagMatch) account.cookie_string = cookieFlagMatch[1];

    // Extract JSON payload
    const dataMatch = curlString.match(/--data-raw\s+['"]({[^]+})['"]/i);
    if (dataMatch) {
        try {
            const data = JSON.parse(dataMatch[1]);
            if (data.sign) {
                account.sign = data.sign;
            }
            if (data.jt) {
                account.jt = data.jt;
            }
        } catch (e) {
            console.error('Failed to parse data-raw JSON from curl string', e);
        }
    }

    if (!account.acs_token || !account.sign || !account.cookie_string || !account.jt) {
        throw new Error('Invalid cURL string. Ensure it is copied from Ernie chat endpoint and includes Acs-Token, Cookie/BAIDUID, jt, and sign body element.');
    }

    return account;
}
