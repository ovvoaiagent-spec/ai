const { createLogger, format, transports } = require('winston');

const { combine, timestamp, colorize, printf, json, errors } = format;

const isProd = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT === 'production';

const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, service, ...meta }) => {
    const svc = service ? `[${service}]` : '';
    const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${ts} ${level} ${svc} ${message}${extra}`;
  })
);

const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: isProd ? prodFormat : devFormat,
  transports: [new transports.Console()]
});

// Child loggers per service — carry a `service` tag in every line
logger.child = function(service) {
  return {
    info:  (msg, meta) => logger.info(msg,  { service, ...meta }),
    warn:  (msg, meta) => logger.warn(msg,  { service, ...meta }),
    error: (msg, meta) => logger.error(msg, { service, ...meta }),
    debug: (msg, meta) => logger.debug(msg, { service, ...meta })
  };
};

module.exports = logger;
