// server.js
const http = require('http');
const app = require('./app');
const { logger } = require('./src/logger/logger');
const port = process.env.PORT || 8088;

const server = http.createServer(app);

// ---- Kafka boot (producer + consumers) ----
const { initKafka } = require('./src/lib/kafka');
const { startConsumers } = require('./src/consumers/events');

(async () => {
  try {
    await initKafka();                 // producer
    startConsumers().catch(err => logger.warn('[consumer] ' + err.message));
    logger.info('[boot] Kafka producer+consumer started');
  } catch (e) {
    logger.warn('[boot] Kafka init failed: ' + e.message);
  }
})();
// -------------------------------------------

server.listen(port, () => {
  logger.info('Node server running on port ' + port);
});

// (optional) graceful shutdown
process.on('SIGINT', () => { logger.info('SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('SIGTERM'); process.exit(0); });
