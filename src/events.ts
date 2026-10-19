// One live connection to the server's /api/events for the whole page. Browsers allow only six
// connections to a host at a time, and each EventSource holds one open for good, so every part of
// the page that wants updates (saved state, Discord, clips) listens here instead of opening its own.

type Handler = (data: string) => void;

let source: EventSource | null = null;
const handlers = new Map<string, Set<Handler>>();
const opens = new Set<() => void>();
const errors = new Set<() => void>();

function connect(): EventSource {
  if (source) return source;
  source = new EventSource('/api/events');
  source.onopen = () => opens.forEach((f) => f());
  source.onerror = () => errors.forEach((f) => f());
  for (const name of handlers.keys()) attach(source, name);
  return source;
}

function attach(es: EventSource, name: string) {
  es.addEventListener(name, (e) => handlers.get(name)?.forEach((f) => f((e as MessageEvent).data)));
}

/**
 * Calls fn with each event's data. "message" is the unnamed event (state sync); others are the
 * server's named events. Returns a function that stops listening.
 */
export function listen(name: string, fn: Handler): () => void {
  let set = handlers.get(name);
  if (!set) {
    set = new Set();
    handlers.set(name, set);
    if (source) attach(source, name);
  }
  set.add(fn);
  connect();
  return () => void handlers.get(name)?.delete(fn);
}

/**
 * Calls onOpen each time the connection (re)opens, which is the time to re-read anything that
 * only arrives on change, and onError when it drops.
 */
export function onConnection(onOpen: () => void, onError: () => void = () => {}): () => void {
  opens.add(onOpen);
  errors.add(onError);
  connect();
  return () => {
    opens.delete(onOpen);
    errors.delete(onError);
  };
}
