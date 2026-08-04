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
