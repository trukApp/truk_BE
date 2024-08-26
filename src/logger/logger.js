const winston = require('winston');


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

module.exports = logger;

