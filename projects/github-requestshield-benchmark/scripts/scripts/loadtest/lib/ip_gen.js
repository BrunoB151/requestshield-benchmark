// Deterministic IPv4 / IPv6 pseudo-random generators.
//
// We don't need crypto strength; we need:
//   - reproducibility per VU+iter so a given seed replays an identical campaign,
//   - a "burst pool" of small cardinality to hammer ip_rate (rotatable mid-run),
//   - a "diffuse pool" of large cardinality for everything else,
//   - a "residential pool" derived from real ISP CIDR ranges, so the
//     residential_proxy model has something to discriminate,
//   - an "rdns pool" of IPs with known PTR records to feed the rdns model.

// xorshift32 — small, fast, deterministic
export function rngFromSeed(seed) {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0xffffffff;
  };
}

// --- IPv4 random (excluding reserved/private) ----------------------------

function v4OctetA(rng) {
  for (;;) {
    const a = Math.floor(rng() * 224) + 1; // 1..224 → excludes 0 and 224-255
    if (a === 10 || a === 127 || a === 169) continue;
    return a;
  }
}

export function randIPv4(rng) {
  for (;;) {
    const a = v4OctetA(rng);
    const b = Math.floor(rng() * 256);
    if (a === 172 && b >= 16 && b <= 31) continue;
    if (a === 192 && b === 168) continue;
    const c = Math.floor(rng() * 256);
    const d = Math.floor(rng() * 254) + 1; // .1..254
    return `${a}.${b}.${c}.${d}`;
  }
}

// --- IPv6 random in 2000::/3 (global unicast) ----------------------------

function hex4(rng) {
  return Math.floor(rng() * 0x10000).toString(16).padStart(4, "0");
}

export function randIPv6(rng) {
  for (;;) {
    const first = (0x2000 + Math.floor(rng() * 0x2000)).toString(16).padStart(4, "0");
    const second = hex4(rng);
    if (first === "2001" && second === "0db8") continue; // documentation
    const groups = [first, second, hex4(rng), hex4(rng), hex4(rng), hex4(rng), hex4(rng), hex4(rng)];
    return groups.join(":");
  }
}

// --- CIDR helpers --------------------------------------------------------
// Minimal IPv4-only CIDR parser. residential_ranges.txt entries are v4.

function parseV4(addr) {
  const parts = addr.split(".").map((x) => parseInt(x, 10));
  return ((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + (parts[3] >>> 0);
}
function intToV4(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

// Parse residential_ranges.txt content (text) into [{ base, size }, ...].
export function parseCIDRList(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [cidr, maskStr] = line.split("/");
    if (!cidr || !maskStr) continue;
    const mask = parseInt(maskStr, 10);
    if (Number.isNaN(mask) || mask < 0 || mask > 32) continue;
    const base = parseV4(cidr) & (mask === 0 ? 0 : (0xffffffff << (32 - mask)) >>> 0);
    const size = mask === 32 ? 1 : 2 ** (32 - mask);
    out.push({ base: base >>> 0, size });
  }
  return out;
}

// Pick a random IPv4 within one of the parsed CIDR ranges (uniform over the
// union, weighted by range size).
export function randIPv4FromCIDRs(rng, ranges) {
  if (!ranges || ranges.length === 0) return randIPv4(rng);
  // Weighted pick by range size.
  let total = 0;
  for (const r of ranges) total += r.size;
  let pick = Math.floor(rng() * total);
  for (const r of ranges) {
    if (pick < r.size) {
      const off = r.size <= 1 ? 0 : Math.floor(rng() * (r.size - 2)) + 1; // avoid network/broadcast
      return intToV4((r.base + off) >>> 0);
    }
    pick -= r.size;
  }
  return intToV4(ranges[ranges.length - 1].base);
}

// --- Burst pool ----------------------------------------------------------
// Stable IPs reused across VUs so the API sees concentrated rates from them.
// Rotated periodically (k6 driver controls when) to prevent saturation of
// per-IP state and to keep the ip_rate model exposed to new aggressors.

export function buildBurstPool(seed, size) {
  const rng = rngFromSeed(seed);
  const pool = [];
  for (let i = 0; i < size; i++) {
    pool.push(i % 4 === 0 ? randIPv6(rng) : randIPv4(rng));
  }
  return pool;
}

// Refresh a burst pool in-place. Caller passes a fresh seed (e.g. SEED+epoch).
// Keeping the array reference stable means VUs that captured it earlier still
// see updated content. Returns the mutated array.
export function refreshBurstPool(pool, seed) {
  const rng = rngFromSeed(seed);
  for (let i = 0; i < pool.length; i++) {
    pool[i] = i % 4 === 0 ? randIPv6(rng) : randIPv4(rng);
  }
  return pool;
}

// --- IP picker with profile mix ------------------------------------------
// Probabilities are independent and applied in priority order:
//   1. burstShare       → from burst pool (overrides others)
//   2. rdnsShare        → from rdns pool (only when not burst)
//   3. residentialShare → from residential CIDRs
//   4. otherwise        → diffuse random (~70 % v4, 30 % v6)
//
// Defaults are tuned to give every model some signal without drowning the
// diffuse traffic that drives raw throughput.

export function pickIP(rng, opts) {
  const {
    burstPool,
    rdnsPool = [],
    residentialRanges = [],
    burstShare = 0.05,
    rdnsShare = 0.03,
    residentialShare = 0.30,
  } = opts;

  const r = rng();
  if (burstPool && burstPool.length > 0 && r < burstShare) {
    return burstPool[Math.floor(rng() * burstPool.length)];
  }
  if (rdnsPool.length > 0 && r < burstShare + rdnsShare) {
    return rdnsPool[Math.floor(rng() * rdnsPool.length)];
  }
  if (residentialRanges.length > 0 && r < burstShare + rdnsShare + residentialShare) {
    return randIPv4FromCIDRs(rng, residentialRanges);
  }
  return rng() < 0.3 ? randIPv6(rng) : randIPv4(rng);
}
