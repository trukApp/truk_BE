require('dotenv').config();

const cfg = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3001),

  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  redisTTL: Number(process.env.REDIS_TTL_ROUTES_SECONDS || 3600),

  ts: {
    host: process.env.TS_HOST || 'localhost',
    port: Number(process.env.TS_PORT || 5432),
    database: process.env.TS_DB || 'truk_metrics',
    user: process.env.TS_USER || 'postgres',
    password: process.env.TS_PASSWORD || 'postgres',
  },

  kafka: {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    clientId: process.env.KAFKA_CLIENT_ID || 'trukapp-api',
    groupId: process.env.KAFKA_GROUP_ID || 'trukapp-workers',
    defaultPartitions: Number(process.env.KAFKA_DEFAULT_PARTITIONS || 6),
    topics:
      (process.env.KAFKA_TOPICS
        ? process.env.KAFKA_TOPICS.split(',').map(s => s.trim()).filter(Boolean)
        : [
            // Phase-1/2 bus per your spec
            'load.created','load.updated','load.cancelled',
            'vehicle.location','vehicle.status','vehicle.breakdown',
            'driver.assigned','driver.available','driver.overtime',
            'telemetry.gps','telemetry.fuel','telemetry.temperature',
            'plan.updated','plan.optimized',
            'alert.delay','alert.geofence','alert.emergency',
            'route.sampled'
          ]),
  },

  routingProvider: (process.env.ROUTING_PROVIDER || 'google').toLowerCase(),
  osrmBaseUrl: process.env.OSRM_BASE_URL || 'http://localhost:5000',

  googleApiKey: process.env.GOOGLE_API_KEY,
};

module.exports = cfg;
