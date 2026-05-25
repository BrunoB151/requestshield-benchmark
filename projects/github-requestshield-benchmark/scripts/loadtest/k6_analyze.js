// k6 load test for RequestShield Edge AI — POST /api/v1/analyze.
//
// Distribution (default at campaign start):
//   80 % benign  — real browsing sessions: stable UA + JA3 + sid cookie,
//                  chained referers through a multi-step flow.
//   15 % noisy   — bots, libraries, CLIs hitting plausible URIs.
//    5 % scanner — sqlmap/nuclei/zgrab UAs against /wp-admin, /.env, etc.
//
// IP pool mix:
//    5 % from a burst pool of ~500 stable IPs (exercises ip_rate). Rotated
//        every BENCH_BURST_ROTATE_MIN minutes to keep the model exposed to
//        fresh aggressors instead of saturating per-IP state.
//    3 % from rdns_pool.txt — datacenter / bot ranges with known PTRs, so
//        the rdns model has something to discriminate.
//   30 % from residential_ranges.txt — IPs inside real ISP CIDRs, so the
//        residential_proxy model isn't blind.
//   62 % diffuse synthetic IPs (70/30 v4/v6).
//
// Distribution drift (optional, opt-in via BENCH_DRIFT_ENABLED=1):
//   scanner share ramps from 5 % → 15 % linearly across the campaign duration
//   to exercise change-detection on the scoring side.
//
// Usage:
//   k6 run -e BENCH_PHASE=target_150k \
//          -e BENCH_RPS_SHARE=12500 \
//          -e BENCH_TARGET=https://api.preprod.example/api/v1/analyze \
//          -e BENCH_HOST=api.preprod.example \
//          -e BENCH_SEED=42 \
//          scripts/loadtest/k6_analyze.js
//
// Phases (BENCH_PHASE): smoke | baseline | warm | mid | high | target_150k | spike | soak

import http from "k6/http";
import { check } from "k6";
import { SharedArray } from "k6/data";
import { Counter, Trend } from "k6/metrics";
import { rngFromSeed, buildBurstPool, refreshBurstPool, parseCIDRList } from "./lib/ip_gen.js";
import { buildPayload, partitionUAs, trimCaches } from "./lib/payload_gen.js";

// ----- config from env --------------------------------------------------------

const PHASE = __ENV.BENCH_PHASE || "smoke";
const RPS_SHARE = parseInt(__ENV.BENCH_RPS_SHARE || "100", 10);
const TARGET = __ENV.BENCH_TARGET || "http://localhost:8000/api/v1/analyze";
const HOST = __ENV.BENCH_HOST || "localhost";
const SEED = parseInt(__ENV.BENCH_SEED || "42", 10);
const API_KEY = __ENV.BENCH_API_KEY || "";
const BURST_POOL_SIZE = parseInt(__ENV.BENCH_BURST_POOL_SIZE || "500", 10);
const BURST_ROTATE_MIN = parseFloat(__ENV.BENCH_BURST_ROTATE_MIN || "5"); // 0 = no rotation
const CACHE_TRIM_AT = parseInt(__ENV.BENCH_CACHE_TRIM_AT || "200000", 10);
const DRIFT_ENABLED = (__ENV.BENCH_DRIFT_ENABLED || "0") === "1";
const SCANNER_SHARE_START = parseFloat(__ENV.BENCH_SCANNER_SHARE_START || "0.05");
const SCANNER_SHARE_END = parseFloat(__ENV.BENCH_SCANNER_SHARE_END || "0.15");

// ----- load payload pools once ------------------------------------------------

const uaLines = new SharedArray("user_agents", () =>
  open("./payloads/user_agents.txt").split("\n").filter((l) => l.trim().length > 0 && !l.startsWith("#"))
);
const ja3Lines = new SharedArray("ja3", () =>
  open("./payloads/ja3.txt").split("\n").filter((l) => l.trim().length > 0 && !l.startsWith("#"))
);
const benignUris = new SharedArray("uris_benign", () =>
  open("./payloads/uris_benign.txt").split("\n").filter((l) => l.trim().length > 0 && !l.startsWith("#"))
);
const scannerUris = new SharedArray("uris_scanner", () =>
  open("./payloads/uris_scanner.txt").split("\n").filter((l) => l.trim().length > 0 && !l.startsWith("#"))
);
const rdnsPoolLines = new SharedArray("rdns_pool", () =>
  open("./payloads/rdns_pool.txt").split("\n").filter((l) => l.trim().length > 0 && !l.startsWith("#"))
);
const residentialRanges = new SharedArray("residential_ranges", () =>
  parseCIDRList(open("./payloads/residential_ranges.txt"))
);

const uaParts = partitionUAs(uaLines.slice());
const pools = {
  browserUAs: uaParts.browser,
  noisyUAs: uaParts.noisy,
  scannerUAs: uaParts.scanner.length > 0 ? uaParts.scanner : uaParts.noisy,
  ja3: ja3Lines.slice(),
  benignURIs: benignUris.slice(),
  scannerURIs: scannerUris.slice(),
  rdnsPool: rdnsPoolLines.slice(),
  residentialRanges: residentialRanges.slice(),
};

// Burst pool is a SharedArray so all VUs read the same content. To rotate, we
// rebuild it as a regular array indexed by the current "epoch" (campaign
// minutes / BURST_ROTATE_MIN). Each iteration we recompute the epoch and
// regenerate locally if it changed — cheap because BURST_POOL_SIZE is small.
const initialBurstPool = new SharedArray("burst_pool_seed", () => buildBurstPool(SEED, BURST_POOL_SIZE));
let _localBurst = initialBurstPool.slice();
let _burstEpoch = 0;

function maybeRotateBurst() {
  if (BURST_ROTATE_MIN <= 0) return;
  const elapsedMin = (Date.now() - CAMPAIGN_START) / 60000;
  const epoch = Math.floor(elapsedMin / BURST_ROTATE_MIN);
  if (epoch !== _burstEpoch) {
    refreshBurstPool(_localBurst, SEED ^ (epoch * 0x9e3779b9));
    _burstEpoch = epoch;
  }
}

// ----- custom metrics ---------------------------------------------------------

const decisionCounter = new Counter("rsedge_decisions_total");
const decisionLatency = new Trend("rsedge_decision_latency_ms", true);

// ----- k6 options -------------------------------------------------------------

// Plateau durations per phase (in seconds) — used to compute drift progress.
const PHASE_PLATEAU_S = {
  smoke: 120,
  baseline: 300,
  warm: 600,
  mid: 600,
  high: 900,
  target_150k: 1800,
  spike: 60,
  soak: 7200,
};

const PHASE_STAGES = {
  smoke:        [{ duration: "2m",  target: Math.min(100, RPS_SHARE) }],
  baseline:     [{ duration: "30s", target: RPS_SHARE }, { duration: "5m", target: RPS_SHARE }],
  warm:         [{ duration: "1m",  target: RPS_SHARE }, { duration: "10m", target: RPS_SHARE }],
  mid:          [{ duration: "1m",  target: RPS_SHARE }, { duration: "10m", target: RPS_SHARE }],
  high:         [{ duration: "2m",  target: RPS_SHARE }, { duration: "15m", target: RPS_SHARE }],
  target_150k:  [{ duration: "2m",  target: RPS_SHARE }, { duration: "30m", target: RPS_SHARE }],
  spike:        [{ duration: "10s", target: RPS_SHARE }, { duration: "60s", target: RPS_SHARE }],
  soak:         [{ duration: "5m",  target: RPS_SHARE }, { duration: "2h",  target: RPS_SHARE }],
};

const stages = PHASE_STAGES[PHASE];
if (!stages) throw new Error(`Unknown BENCH_PHASE=${PHASE}`);
const PHASE_DURATION_MS = (PHASE_PLATEAU_S[PHASE] || 600) * 1000;
const CAMPAIGN_START = Date.now();

const preAllocatedVUs = Math.min(2000, Math.max(50, Math.ceil(RPS_SHARE / 50)));
const maxVUs = Math.min(4000, preAllocatedVUs * 3);

export const options = {
  discardResponseBodies: true,
  scenarios: {
    analyze: {
      executor: "ramping-arrival-rate",
      startRate: 1,
      timeUnit: "1s",
      preAllocatedVUs: preAllocatedVUs,
      maxVUs: maxVUs,
      stages: stages,
    },
  },
  thresholds: {
    "http_req_failed":   ["rate<0.01"],
    "http_req_duration": ["p(95)<100", "p(99)<300"],
  },
  noConnectionReuse: false,
  userAgent: "k6/rsedge-benchmark",
};

// ----- per-VU rng + drift helper ---------------------------------------------

function vuRng() {
  const s = (SEED ^ (__VU * 2654435761) ^ (__ITER * 40503)) >>> 0;
  return rngFromSeed(s);
}

function currentScannerShare() {
  if (!DRIFT_ENABLED) return SCANNER_SHARE_START;
  const elapsed = Math.max(0, Date.now() - CAMPAIGN_START);
  const t = Math.min(1, elapsed / PHASE_DURATION_MS);
  return SCANNER_SHARE_START + (SCANNER_SHARE_END - SCANNER_SHARE_START) * t;
}

let iterCount = 0;

// ----- main iteration ---------------------------------------------------------

export default function () {
  maybeRotateBurst();
  const rng = vuRng();
  const scannerShare = currentScannerShare();
  const benignShare = Math.max(0, 0.95 - scannerShare); // noisy = remainder
  const body = buildPayload(rng, pools, {
    burstPool: _localBurst,
    rdnsPool: pools.rdnsPool,
    residentialRanges: pools.residentialRanges,
    burstShare: 0.05,
    rdnsShare: 0.03,
    residentialShare: 0.30,
    benignShare: benignShare,
    noisyShare: 1 - benignShare - scannerShare,
    incoherentFPProb: 0.02,
    ja3RotateProb: 0.05,
    host: HOST,
  });

  const headers = {
    "Content-Type": "application/json",
    "X-Request-ID": `bench-${__VU}-${__ITER}`,
  };
  if (API_KEY) headers["X-API-Key"] = API_KEY;

  const res = http.post(TARGET, JSON.stringify(body), {
    headers: headers,
    tags: { endpoint: "/api/v1/analyze" },
  });

  decisionLatency.add(res.timings.duration);

  const ok = check(res, {
    "status 200": (r) => r.status === 200,
  });

  if (ok && res.json) {
    try {
      const j = res.json();
      if (j && j.decision) {
        decisionCounter.add(1, { decision: j.decision, risk_level: j.risk_level || "unknown" });
      }
    } catch (_) { /* discardResponseBodies = true may strip body; ignore */ }
  }

  if ((++iterCount & 0xfff) === 0) trimCaches(CACHE_TRIM_AT);
}
