import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";

// Pretty logs in dev (when not forced to JSON), JSON otherwise.
const transport = process.env.NO_PRETTY
  ? undefined
  : {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
    };

export const logger = pino({ level, ...(transport ? { transport } : {}) });

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
