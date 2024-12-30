const winston = require('winston');
const expressWinston = require('express-winston');


const logLevels = {
  error: 'error',
  warn: 'warn',
  info: 'info',
  verbose: 'verbose',
  debug: 'debug',
};

const logColors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  verbose: 'cyan',
  debug: 'blue',
};


const logger = winston.createLogger({
  levels: logLevels,
  format: winston.format.simple(),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
      level: 'info', 
    }),
    new winston.transports.Stream({
      stream: process.stdout,
      level: 'warn',
    }),
    new winston.transports.Stream({
      stream: process.stderr,
      level: 'error',
    }),
  ],
});


logger.stream = {
  write: (message) => {
    logger.info(message.trim());
  },
};

const sanitizeRequestData = (req) => {
  if (req.headers.authorization) {
    req.headers.authorization = '[REDACTED]'; // Remove authorization token
  }
  if (req.headers['postman-token']) {
    req.headers['postman-token'] = '[REDACTED]'; // Remove Postman token
  }
  return req;
};

// Middleware for logging HTTP requests
const requestLogger = expressWinston.logger({
  transports: [
    new winston.transports.Console(),
  ],
  format: winston.format.combine(
    winston.format.json(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' })
  ),
  meta: true,
  dynamicMeta: (req, res) => {
    req = sanitizeRequestData(req); // Sanitize sensitive data
    return {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      responseTime: res.responseTime,
    };
  },
  expressFormat: true,
  colorize: false,
  ignoreRoute: function (req, res) { return false; },
});



module.exports = { logger, requestLogger };

