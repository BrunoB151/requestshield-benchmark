// Build an AnalyzeRequest body for POST /api/v1/analyze.
//
// Profiles produced (distribution chosen at call site):
//   - "benign"  : coherent UA + Sec-CH-UA, common URI, stable JA3 per IP
//   - "noisy"   : odd UAs (curl, wget, postman), generic URIs
//   - "scanner" : scanner UAs + scanner URIs, occasionally incoherent FP
//
// We also flip a small fraction of "benign" payloads into "incoherent_fp"
// (Chrome UA paired with Firefox-shaped Sec-CH-UA) to feed
// fingerprint_coherence training.

import { pickIP } from "./ip_gen.js";

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// Roughly map a UA string to a coherent Sec-CH-UA / platform set.
function secChForUA(ua) {
  if (ua.includes("Chrome/") && !ua.includes("Edg/") && !ua.includes("OPR/")) {
    const m = ua.match(/Chrome\/(\d+)/);
    const v = m ? m[1] : "131";
    return {
      "sec-ch-ua": `"Chromium";v="${v}", "Not_A Brand";v="24", "Google Chrome";v="${v}"`,
      "sec-ch-ua-mobile": ua.includes("Mobile") ? "?1" : "?0",
      "sec-ch-ua-platform": ua.includes("Windows") ? '"Windows"'
                          : ua.includes("Mac OS X") ? '"macOS"'
                          : ua.includes("Android") ? '"Android"'
                          : ua.includes("Linux") ? '"Linux"' : '"Unknown"',
    };
  }
  if (ua.includes("Edg/")) {
    const m = ua.match(/Edg\/(\d+)/);
    const v = m ? m[1] : "131";
    return {
      "sec-ch-ua": `"Chromium";v="${v}", "Not_A Brand";v="24", "Microsoft Edge";v="${v}"`,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    };
  }
  // Firefox / Safari / bots / CLIs — no Sec-CH-UA (correct browser behaviour).
  return { "sec-ch-ua": "", "sec-ch-ua-mobile": "", "sec-ch-ua-platform": "" };
}

// Incoherent fingerprint: Chrome UA + Firefox-shaped Sec-CH-UA (impossible IRL).
function incoherentSecCh() {
  return {
    "sec-ch-ua": `"Firefox";v="131"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
  };
}

const ACCEPTS_BROWSER = [
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "application/json, text/plain, */*",
];
const ACCEPT_LANG = ["fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7", "en-US,en;q=0.9", "de-DE,de;q=0.9", "es-ES,es;q=0.9"];
const ACCEPT_ENC = ["gzip, deflate, br, zstd", "gzip, deflate, br", "gzip, deflate"];
const METHODS_BENIGN = ["GET", "GET", "GET", "GET", "POST"];

// IP → stable JA3 mapping via a tiny in-memory map. ~95 % of IPs keep the same JA3
// across requests (matches real client behaviour). 5 % rotate per request to
// feed ja3_stability with churn signal.
const _ja3Pin = new Map();

function ja3ForIP(rng, ip, ja3Pool, rotateProb) {
  if (rng() < rotateProb) return pick(rng, ja3Pool);
  let pinned = _ja3Pin.get(ip);
  if (!pinned) {
    pinned = pick(rng, ja3Pool);
    _ja3Pin.set(ip, pinned);
  }
  return pinned;
}

// Session affinity for legitimate traffic: a benign IP keeps the same UA,
// session cookie and follows a navigation sequence with chained referers.
// This is what makes the 80 % benign share *actually* legitimate — without it
// every request looks like a fresh visitor, which would skew the learning
// (ua_consistency, signal_correlation, fingerprint_coherence).
const _session = new Map(); // ip -> { ua, sessionId, ja3, accept, lang, lastUri, step }

function sessionForIP(rng, ip, browserUAs, ja3Pool) {
  let s = _session.get(ip);
  if (s) return s;
  const ua = pick(rng, browserUAs);
  s = {
    ua: ua,
    sessionId: hex16(rng),
    persistentId: hex16(rng),
    ja3: pick(rng, ja3Pool),
    accept: pick(rng, ACCEPTS_BROWSER),
    lang: pick(rng, ACCEPT_LANG),
    enc: pick(rng, ACCEPT_ENC),
    lastUri: "/",
    step: 0,
  };
  _session.set(ip, s);
  return s;
}

function hex16(rng) {
  let out = "";
  for (let i = 0; i < 16; i++) out += Math.floor(rng() * 16).toString(16);
  return out;
}

// Cap caches so a long campaign doesn't OOM the VU.
export function trimCaches(maxEntries) {
  for (const cache of [_ja3Pin, _session]) {
    if (cache.size <= maxEntries) continue;
    let toDrop = cache.size - maxEntries;
    for (const k of cache.keys()) {
      if (toDrop-- <= 0) break;
      cache.delete(k);
    }
  }
}

// Realistic browsing sequences. A benign session walks one of these paths,
// each request referring to the previous one. Loops back to "/" at the end.
const BROWSE_FLOWS = [
  ["/", "/api/v1/products", "/api/v1/products/123", "/api/v1/cart", "/api/v1/cart/items", "/api/v1/checkout"],
  ["/", "/blog", "/blog/article-1", "/blog/category/news", "/contact"],
  ["/", "/dashboard", "/dashboard/overview", "/api/v1/users/me", "/api/v1/notifications"],
  ["/", "/login", "/account", "/account/orders", "/account/settings"],
  ["/", "/api/v1/search?q=laptop", "/api/v1/products/456", "/api/v1/recommendations"],
  ["/", "/docs", "/docs/getting-started", "/docs/api", "/help/faq"],
];

export function buildPayload(rng, pools, opts) {
  const {
    burstPool,
    burstShare = 0.05,
    benignShare = 0.80,
    noisyShare = 0.15,
    // scannerShare = remainder
    incoherentFPProb = 0.02,
    ja3RotateProb = 0.05,
    host,
  } = opts;

  const ip = pickIP(rng, {
    burstPool: burstPool,
    rdnsPool: opts.rdnsPool || [],
    residentialRanges: opts.residentialRanges || [],
    burstShare: burstShare,
    rdnsShare: opts.rdnsShare,
    residentialShare: opts.residentialShare,
  });

  const r = rng();
  let profile;
  if (r < benignShare) profile = "benign";
  else if (r < benignShare + noisyShare) profile = "noisy";
  else profile = "scanner";

  let ua, uri, method, ja3, referer, cookie, accept, lang, enc;

  if (profile === "benign") {
    // Legitimate session: same UA, same JA3, walks a browse flow with chained referers.
    const sess = sessionForIP(rng, ip, pools.browserUAs, pools.ja3);
    const flow = BROWSE_FLOWS[Math.floor(rng() * BROWSE_FLOWS.length) % BROWSE_FLOWS.length];
    // Advance one step in the flow (or restart at 0 with small probability to mimic re-visits).
    sess.step = (sess.step + 1) % flow.length;
    uri = flow[sess.step];
    referer = sess.lastUri ? `https://${host}${sess.lastUri}` : `https://${host}/`;
    sess.lastUri = uri;
    ua = sess.ua;
    ja3 = sess.ja3;
    accept = sess.accept;
    lang = sess.lang;
    enc = sess.enc;
    method = pick(rng, METHODS_BENIGN);
    cookie = `sid=${sess.sessionId}; uid=${sess.persistentId}`;
  } else if (profile === "noisy") {
    ua = pick(rng, pools.noisyUAs);
    uri = pick(rng, pools.benignURIs);
    method = pick(rng, METHODS_BENIGN);
    ja3 = ja3ForIP(rng, ip, pools.ja3, ja3RotateProb);
    accept = pick(rng, ACCEPTS_BROWSER);
    lang = pick(rng, ACCEPT_LANG);
    enc = pick(rng, ACCEPT_ENC);
    referer = null;
    cookie = null;
  } else { // scanner
    ua = pick(rng, pools.scannerUAs);
    uri = pick(rng, pools.scannerURIs);
    method = rng() < 0.7 ? "GET" : "POST";
    ja3 = ja3ForIP(rng, ip, pools.ja3, ja3RotateProb);
    accept = "*/*";
    lang = "en-US,en;q=0.9";
    enc = "gzip";
    referer = null;
    cookie = null;
  }

  let sec = secChForUA(ua);
  if (profile === "benign" && rng() < incoherentFPProb) sec = incoherentSecCh();

  const headers = {
    "User-Agent": ua,
    "Accept": accept,
    "Accept-Language": lang,
    "Accept-Encoding": enc,
  };
  if (cookie) headers["Cookie"] = cookie;
  if (referer) headers["Referer"] = referer;
  if (sec["sec-ch-ua"]) {
    headers["Sec-CH-UA"] = sec["sec-ch-ua"];
    headers["Sec-CH-UA-Mobile"] = sec["sec-ch-ua-mobile"];
    headers["Sec-CH-UA-Platform"] = sec["sec-ch-ua-platform"];
  }

  return {
    source_ip: ip,
    uri: uri,
    method: method,
    host: host,
    domain: host,
    headers: headers,
    user_agent: ua,
    cookie: cookie,
    referer: referer,
    sec_ch_ua: sec["sec-ch-ua"] || null,
    sec_ch_ua_mobile: sec["sec-ch-ua-mobile"] || null,
    sec_ch_ua_platform: sec["sec-ch-ua-platform"] || null,
    ja3: ja3,
    request_size: 200 + Math.floor(rng() * 800),
    protocol: "HTTP/1.1",
    content_type: method === "POST" ? "application/x-www-form-urlencoded" : null,
  };
}

// Split user_agents.txt into 3 buckets based on heuristics on the line content.
export function partitionUAs(lines) {
  const browser = [], noisy = [], scanner = [];
  for (const raw of lines) {
    const ua = (raw || "").trim();
    if (!ua) continue;
    const low = ua.toLowerCase();
    const isBrowser = ua.startsWith("Mozilla/") && !/bot|crawler|spider|sqlmap|nuclei|nmap|masscan|zgrab|censys|nimbostratus/i.test(ua);
    const isScanner = /sqlmap|nuclei|nmap|masscan|zgrab|censys|nimbostratus/i.test(ua);
    if (isScanner) scanner.push(ua);
    else if (isBrowser) browser.push(ua);
    else noisy.push(ua); // bots, curl, wget, libraries, blank → noisy bucket
  }
  return { browser, noisy, scanner };
}
