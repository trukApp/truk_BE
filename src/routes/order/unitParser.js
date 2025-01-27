// utils/unitParser.js (for example)
function parseWeightToKg(weightString = "") {
    const lower = weightString.toLowerCase().trim();
    if (lower.includes("ton")) {
      // e.g. "7 ton" => 7000 kg (1 metric ton = 1000 kg)
      const numericVal = parseFloat(lower) || 0;
      return numericVal * 1000;
    } else if (lower.includes("kg")) {
      // e.g. "10 kg" => 10
      return parseFloat(lower) || 0;
    }
    // Fallback (just parse float if no recognized unit)
    return parseFloat(lower) || 0;
  }
  
  function parseVolumeToM3(volumeString = "") {
    const lower = volumeString.toLowerCase().trim();
    if (lower.includes("m")) {
      // e.g. "3 m^3" => 3. 
      // If your data says "m" but actually means "m^3", confirm your usage.
      return parseFloat(lower) || 0;
    } else if (lower.includes("l")) {
      // e.g. "500 l" => 0.5 m^3 (1 m^3 = 1000 L)
      const numericVal = parseFloat(lower) || 0;
      return numericVal / 1000;
    }
    // Fallback
    return parseFloat(lower) || 0;
  }
  
  module.exports = {
    parseWeightToKg,
    parseVolumeToM3,
  };
  