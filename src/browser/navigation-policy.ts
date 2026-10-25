import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const BLOCKED_NAMES = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "metadata.google.internal",
  "metadata.google.com",
]);

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
] as const) {
  blocked.addSubnet(address, prefix, "ipv4");
}
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");

export class NavigationBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NavigationBlocked";
  }
}

export interface NavOptions {
  /** Local test servers. Off unless the process opts in. */
  allowLoopback?: boolean;
  lookup?: (host: string) => Promise<Array<{ address: string }>>;
}

/** Same host rules as navigation, without a DNS lookup. Hostnames that are not
 * IP addresses stay allowed here; the route handler already resolved them. */
export function snapshotHostAllowed(raw: string, options: NavOptions = {}): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || BLOCKED_NAMES.has(host) || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^\d+$/.test(host)) return false;
  if (host === "localhost") return options.allowLoopback === true;
  const family = isIP(host);
  if (family === 4 || family === 6) return allowedAddress(host, options.allowLoopback === true);
  return true;
}

export interface PublicDestination {
  url: URL;
  addresses: string[];
}

/** Allow public http(s). Loopback is allowed only when the caller opts in.
 * Private, link-local, and metadata targets are refused. */
export async function assertNavigable(raw: string, options: NavOptions = {}): Promise<URL> {
  return (await inspectDestination(raw, options)).url;
}

export async function inspectDestination(raw: string, options: NavOptions = {}): Promise<PublicDestination> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NavigationBlocked("URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new NavigationBlocked("only http and https URLs are allowed");
  if (url.username || url.password) throw new NavigationBlocked("URLs with credentials are blocked");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || BLOCKED_NAMES.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new NavigationBlocked("that host is blocked");
  }
  if (/^\d+$/.test(host)) throw new NavigationBlocked("numeric hostnames are blocked");
  const allowLoopback = options.allowLoopback === true;
  if (host === "localhost" && !allowLoopback) throw new NavigationBlocked("that host is blocked");
  const family = isIP(host);
  if (family === 4 || family === 6) {
    if (!allowedAddress(host, allowLoopback)) throw new NavigationBlocked("that address is blocked");
    return { url, addresses: [normalize(host).address] };
  }
  let records: { address: string }[];
  try {
    records = options.lookup ? await options.lookup(host) : await lookup(host, { all: true, verbatim: true });
  } catch (caught) {
    if (caught instanceof NavigationBlocked) throw caught;
    throw new NavigationBlocked("that host did not resolve");
  }
  if (records.length === 0) throw new NavigationBlocked("that host did not resolve");
  const addresses: string[] = [];
  for (const record of records) {
    if (!allowedAddress(record.address, allowLoopback)) throw new NavigationBlocked("that host resolves to a blocked address");
    addresses.push(normalize(record.address).address);
  }
  return { url, addresses };
}

function allowedAddress(address: string, allowLoopback: boolean): boolean {
  const normalized = normalize(address);
  if (isLoopback(normalized.address, normalized.family)) return allowLoopback;
  return !blocked.check(normalized.address, normalized.family);
}

function normalize(address: string): { address: string; family: "ipv4" | "ipv6" } {
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    if (isIP(mapped) === 4) return { address: mapped, family: "ipv4" };
  }
  return { address: lower, family: isIP(lower) === 6 ? "ipv6" : "ipv4" };
}

function isLoopback(address: string, family: "ipv4" | "ipv6"): boolean {
  if (family === "ipv6") return address === "::1";
  const first = Number(address.split(".")[0]);
  return first === 127;
}
