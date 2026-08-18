import pino from "pino";
import { Writable } from "node:stream";
import pretty from "pino-pretty";

const level = process.env.LOG_LEVEL ?? "info";

/**
 * Decoupled sink for the admin live-log SSE stream. Registered by
 * {@link AdminServer.start} (and cleared on stop). Keeping this indirection
 * here — instead of importing the admin server — avoids a logger↔admin import
 * cycle. When unset (admin disabled, or not started) the tee below is a no-op.
 */
let adminSink: ((line: string) => void) | null = null;
export function setLogSink(fn: ((line: string) => void) | null): void {
  adminSink = fn;
}

/**
 * Tee destination: every formatted log line goes to stdout AND, when an admin
 * sink is registered, to the admin SSE buffer so the "实时日志" panel streams
 * live. Sink failures are swallowed so a flaky admin stream can never break
 * application logging.
 */
const teedDest = new Writable({
  write(chunk, _enc, cb) {
    process.stdout.write(chunk);
    try {
      if (adminSink) adminSink(chunk.toString().trimEnd());
    } catch {
      /* never let the sink break logging */
    }
    cb();
  },
});

// Pretty logs in dev (when not forced to JSON), JSON otherwise. pino-pretty is
// used as an in-process prettifier stream (not a worker transport) so its
// output can be teed into the admin sink above.
const destination = process.env.NO_PRETTY
  ? teedDest
  : pretty({
      colorize: true,
      translateTime: "HH:MM:ss.l",
      ignore: "pid,hostname",
      destination: teedDest,
    });

export const logger = pino({ level }, destination);

export type Logger = typeof logger;

export function getLogLevel(): string {
  return logger.level;
}

export function setLogLevel(newLevel: string): boolean {
  const validLevels = ["trace", "debug", "info", "warn", "error", "fatal"];
  const normalized = newLevel.toLowerCase().trim();
  if (validLevels.includes(normalized)) {
    logger.level = normalized;
    return true;
  }
  return false;
}
