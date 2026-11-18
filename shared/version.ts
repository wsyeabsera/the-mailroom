// The code version, shared by the Hub and the daemon. Bump it with package.json when a release changes behaviour the other side relies on.
// The daemon reports its own copy in hello; the Hub compares it with its own and tells the owner when the daemon is older.
export const VERSION = "0.4.0";

const VERSION_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][\w.-]{1,30})?$/;
const COMMIT_RE = /^[0-9a-f]{4,40}$/;

/** A version string from a hello (untrusted): a plain x.y.z, else null. */
export const cleanVersion = (v: unknown): string | null => (typeof v === "string" && v.length <= 40 && VERSION_RE.test(v) ? v : null);
/** A git commit from a hello (untrusted): lowercase hex, else null. */
export const cleanCommit = (v: unknown): string | null => (typeof v === "string" && COMMIT_RE.test(v) ? v : null);

const parts = (v: string): number[] | null => { const m = VERSION_RE.exec(v); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };

/** Is version `a` older than `b`? False when either is unreadable. */
export function isOlder(a: string, b: string): boolean {
  const x = parts(a), y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/** The notice the owner sees, or null. A daemon that reported no version is an older daemon than this feature. */
export function daemonNotice(daemonVersion: string | null, hubVersion: string, connected: boolean): string | null {
  if (!connected) return null;
  if (!daemonVersion) return `The connected daemon did not report a version, so it is older than ${hubVersion}. Restart it: mailroom service restart`;
  if (isOlder(daemonVersion, hubVersion)) return `The connected daemon runs ${daemonVersion}, older than the Hub (${hubVersion}). Restart it on the laptop: mailroom service restart`;
  return null;
}
