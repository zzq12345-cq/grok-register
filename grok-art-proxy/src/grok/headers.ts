const BASE_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "Baggage": "sentry-environment=production,sentry-release=d6add6fb0460641fd482d767a335ef72b9b6abb8,sentry-public_key=b311e0f2690c81f25e2c4cf6d4f7ce1c",
  "Cache-Control": "no-cache",
  Origin: "https://grok.com",
  Pragma: "no-cache",
  Priority: "u=1, i",
  Referer: "https://grok.com/",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Sec-Ch-Ua": '"Google Chrome";v="136", "Chromium";v="136", "Not(A:Brand";v="24"',
  "Sec-Ch-Ua-Arch": "arm",
  "Sec-Ch-Ua-Bitness": "64",
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Model": "",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

function randomString(length: number, lettersOnly = true): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const chars = lettersOnly ? letters : letters + digits;
  let out = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) out += chars[bytes[i]! % chars.length]!;
  return out;
}

export function generateStatsigId(): string {
  let msg: string;
  if (Math.random() < 0.5) {
    const rand = randomString(5, false);
    msg = `e:TypeError: Cannot read properties of null (reading 'children['${rand}']')`;
  } else {
    const rand = randomString(10, true);
    msg = `e:TypeError: Cannot read properties of undefined (reading '${rand}')`;
  }
  return btoa(msg);
}

export function getHeaders(cookie: string, referer?: string): Record<string, string> {
  const headers: Record<string, string> = { ...BASE_HEADERS };
  headers["Cookie"] = cookie;
  headers["x-statsig-id"] = generateStatsigId();
  headers["x-xai-request-id"] = crypto.randomUUID();
  headers["Content-Type"] = "application/json";
  if (referer) headers["Referer"] = referer;
  return headers;
}

export function getWebSocketHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    Origin: "https://grok.com",
    Host: "grok.com",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };
}

export function buildCookie(sso: string, sso_rw?: string, user_id?: string, cf_clearance?: string): string {
  let cookie = `sso=${sso}`;
  if (sso_rw) cookie += `; sso-rw=${sso_rw}`;
  if (user_id) cookie += `; x-userid=${user_id}`;
  if (cf_clearance) cookie += `; cf_clearance=${cf_clearance}`;
  return cookie;
}
