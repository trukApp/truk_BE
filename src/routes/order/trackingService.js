async function createTrackingSession({
  conn,
  order_ID,
  vehicle_ID,
  device_ID,
  loadArrangement,
  packToLocMap,
  route
}) {
  // 1. Create tracking session
  const [res] = await conn.query(
    `INSERT INTO order_tracking_sessions
     (order_id, vehicle_ID, device_id, status, created_at)
     VALUES (?, ?, ?, 'created', NOW())`,
    [order_ID, vehicle_ID, device_ID || null]
  );

  const trackingId = res.insertId;

  // 2. Build stops from loadArrangement
  let stopNo = 0;
  for (const stop of loadArrangement || []) {
    stopNo++;

    // derive ship_to from first package
    const firstPack = stop.packages?.[0];
    if (!firstPack) continue;

    const pkgMeta = packToLocMap[firstPack];
    if (!pkgMeta) continue;

    await conn.query(
      `INSERT INTO order_stop_tracking
       (tracking_id, stop_no, loc_ID, radius_m, planned_eta, status)
       VALUES (?, ?, ?, ?, ?, 'PLANNED')`,
      [
        trackingId,
        stopNo,
        pkgMeta.ship_to,
        parseRadius(pkgMeta.destination_radius),
        stop.eta || null
      ]
    );
  }

  return trackingId;
}

function parseRadius(val) {
  if (!val) return 200;
  if (typeof val === 'string' && val.endsWith('m')) {
    return parseInt(val.replace('m', ''), 10);
  }
  return Number(val) || 200;
}

module.exports = { createTrackingSession };
