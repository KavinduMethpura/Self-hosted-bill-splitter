// Hybrid Logical Clock. Timestamps are strings that sort lexicographically
// in causal order:  "<wall ms, 15 digits>:<counter base36, 5>:<node id>"
// Because every client advances its clock past every timestamp it receives,
// an edit made after seeing another edit always gets a larger timestamp,
// even if the device's wall clock is wrong.

export interface Clock {
  wall: number;
  counter: number;
  node: string;
}

export function formatHlc(c: Clock): string {
  return `${c.wall.toString().padStart(15, '0')}:${c.counter.toString(36).padStart(5, '0')}:${c.node}`;
}

export function parseHlc(s: string): Clock {
  const m = /^(\d{15}):([0-9a-z]{5}):([A-Za-z0-9_-]{1,64})$/.exec(s);
  if (!m) throw new Error(`Invalid HLC: ${s}`);
  return { wall: Number(m[1]), counter: parseInt(m[2]!, 36), node: m[3]! };
}

export function isHlc(s: unknown): s is string {
  return typeof s === 'string' && /^\d{15}:[0-9a-z]{5}:[A-Za-z0-9_-]{1,64}$/.test(s);
}

/** Produce the next local timestamp. Mutates and returns the clock. */
export function tick(c: Clock, now: number = Date.now()): string {
  if (now > c.wall) {
    c.wall = now;
    c.counter = 0;
  } else {
    c.counter += 1;
  }
  return formatHlc(c);
}

/** Merge a remote timestamp into the local clock. */
export function receive(c: Clock, remote: string, now: number = Date.now()): void {
  const r = parseHlc(remote);
  const wall = Math.max(c.wall, r.wall, now);
  if (wall === c.wall && wall === r.wall) c.counter = Math.max(c.counter, r.counter) + 1;
  else if (wall === c.wall) c.counter += 1;
  else if (wall === r.wall) c.counter = r.counter + 1;
  else c.counter = 0;
  c.wall = wall;
}
