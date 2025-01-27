/**
 * Utility to extract numeric values from strings
 * E.g. "7.5 ton" => 7.5
 */
function extractNumber(str = "") {
  const match = str.match(/(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  return parseFloat(match[1]) || 0;
}

/**
 * Convert weight strings to kg
 * Handles "ton", "kg", or numeric-only fallback
 */
function parseWeightToKg(weightString = "") {
  const lower = weightString.toLowerCase();
  const num = extractNumber(lower);

  if (lower.includes("ton")) {
    return num * 1000; // Convert tons to kg
  } else if (lower.includes("kg")) {
    return num; // Already in kg
  }
  return num; // Fallback to numeric value
}

/**
 * Convert volume strings to m^3
 * Handles "m^3", "l", or numeric-only fallback
 */
function parseVolumeToM3(volumeString = "") {
  const lower = volumeString.toLowerCase();
  const num = extractNumber(lower);

  if (lower.includes("m")) {
    return num; // Already in m^3
  } else if (lower.includes("l")) {
    return num / 1000; // Convert liters to m^3
  }
  return num; // Fallback to numeric value
}

/**
 * Combine weight value and unit to parse into kg
 * E.g., weight="50", weight_uom="KG" => "50 KG"
 */
function parseWeightAndUOM(weightVal = "0", weightUOM = "") {
  const combined = `${weightVal} ${weightUOM}`.trim();
  return parseWeightToKg(combined);
}

/**
 * Combine volume value and unit to parse into m^3
 * E.g., volume="15", volume_uom="m^3" => "15 m^3"
 */
function parseVolumeAndUOM(volumeVal = "0", volumeUOM = "") {
  const combined = `${volumeVal} ${volumeUOM}`.trim();
  return parseVolumeToM3(combined);
}

module.exports = {
  parseWeightToKg,
  parseVolumeToM3,
  parseWeightAndUOM,
  parseVolumeAndUOM,
};
