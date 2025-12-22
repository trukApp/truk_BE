const express = require('express');
const router = express.Router();

const { setJSON, getJSON } = require('../../lib/redis');
const { emit } = require('../../lib/kafka');
const { logApiPerf } = require('../../lib/tsdb');

router.get('/stack', async (req, res) => {
  const t0 = Date.now();
  try {
    // Redis round-trip
    await setJSON('health:ping', { at: new Date().toISOString() }, 60);
    const back = await getJSON('health:ping');

    // Kafka fire-and-forget
    await emit('plan.optimized', { _healthPing: true, at: Date.now() });

    // Timescale metric
    await logApiPerf('/health/stack', Date.now() - t0, true);

    res.json({ ok: true, redis: !!back, kafka: 'sent', tsdb: 'logged' });
  } catch (e) {
    await logApiPerf('/health/stack', Date.now() - t0, false);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
