// src/lib/kafka.js
const { Kafka, logLevel } = require('kafkajs');
const cfg = require('../config');

const kafka = new Kafka({
  clientId: cfg.kafka.clientId,
  brokers: cfg.kafka.brokers,
  logLevel: logLevel.NOTHING, // keep logs clean; switch to INFO for debugging
});

const producer = kafka.producer({
  allowAutoTopicCreation: false, // keep explicit creation
  retry: { initialRetryTime: 300, retries: 8 },
});

// include the route.* topics you emit to
const topics = [
  'load.created','load.updated','load.cancelled',
  'vehicle.location','vehicle.status','vehicle.breakdown',
  'driver.assigned','driver.available','driver.overtime',
  'telemetry.gps','telemetry.fuel','telemetry.temperature',
  'plan.updated','plan.optimized',
  'alert.delay','alert.geofence','alert.emergency',
  'route.sampled','route.traffic','route.weather'
];

// idempotent ensure-topics (safe to run on every boot)
async function ensureTopics() {
  const admin = kafka.admin();
  await admin.connect();

  // fetch existing
  const existing = (await admin.listTopics()) || [];
  const toCreate = topics.filter(t => !existing.includes(t));

  if (toCreate.length) {
    await admin.createTopics({
      topics: toCreate.map(name => ({
        topic: name,
        numPartitions: 6,
        replicationFactor: 1, // dev-friendly; bump in prod
        configEntries: [
          { name: 'cleanup.policy', value: 'delete' },
          { name: 'retention.ms', value: String(7 * 24 * 60 * 60 * 1000) }, // 7 days
          { name: 'min.insync.replicas', value: '1' },
        ],
      })),
      waitForLeaders: true,
    });
    console.log('[kafka] created topics:', toCreate.join(', '));
  }

  await admin.disconnect();
}

let ready = false;
async function initKafka() {
  if (ready) return;
  await ensureTopics();
  await producer.connect();
  ready = true;
  console.log('[kafka] producer connected');
}

async function emit(topic, payload, key) {
  try {
    if (!ready) await initKafka();
    await producer.send({
      topic,
      messages: [{ key: key || null, value: JSON.stringify(payload) }],
    });
  } catch (e) {
    console.warn('[kafka] emit failed', topic, e.message);
  }
}

module.exports = { initKafka, emit };
