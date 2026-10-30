// Garmin Personal API — morning health snapshot

const BASE = "https://personal.connectapi.garmin.com";

async function getToken(apiKey) {
  const res = await fetch(
    `${BASE}/personalapitoken-service/personal-api/personal-api-key/token`,
    { method: "POST", headers: { Authorization: `ApiKey ${apiKey}` } }
  );
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    return data.access_token || data.accessToken || data.token || text.trim();
  } catch {
    return text.trim();
  }
}

async function garminGet(token, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { _error: res.status, _path: path };
  try { return await res.json(); }
  catch { return { _parseError: true, _path: path }; }
}

// Deep search for a key anywhere in an object (handles unknown nesting)
function deepFind(obj, key, maxDepth = 6) {
  if (!obj || typeof obj !== "object" || maxDepth === 0) return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = deepFind(v, key, maxDepth - 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function berlinDate(offsetDays = 0) {
  // CET = UTC+1 (autumn), CEST = UTC+2 (summer). Use +1 conservatively.
  const d = new Date(Date.now() + 3600 * 1000 + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

exports.handler = async () => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  const apiKey = process.env.GARMIN_API_KEY;
  if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "No GARMIN_API_KEY" }) };

  try {
    const token = await getToken(apiKey);
    const today = berlinDate(0);
    const yesterday = berlinDate(-1);

    const [hrvData, sleepToday, sleepYest, batteryData, stressData, hrData, summaryToday] = await Promise.all([
      garminGet(token, `/hrv-service/hrv/${today}`),
      garminGet(token, `/sleep-service/sleep/${today}`),
      garminGet(token, `/sleep-service/sleep/${yesterday}`),
      garminGet(token, `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${yesterday}&endDate=${today}`),
      garminGet(token, `/wellness-service/wellness/dailyStress?date=${today}`),
      garminGet(token, `/wellness-service/wellness/dailyHeartRate?date=${today}`),
      garminGet(token, `/usersummary-service/usersummary/daily/${today}`),
    ]);

    // ── HRV ──
    // Garmin HRV structure: hrvData.hrvSummary.lastNight (number, ms)
    //                    or hrvData.hrvSummary.lastNight5MinHigh
    // Baseline: hrvData.hrvSummary.baseline.balancedLow / balancedHigh
    const hrvSummary = hrvData?.hrvSummary ?? {};
    const hrv = hrvSummary.lastNight ?? deepFind(hrvData, "lastNight") ?? null;
    const hrvBaseline = hrvSummary.baseline?.balancedLow
      ?? hrvSummary.baseline?.low
      ?? deepFind(hrvData, "balancedLow")
      ?? null;

    // ── SLEEP ──
    // Pick whichever endpoint returned real data (not an error marker)
    const sleepRaw = (sleepToday && !sleepToday._error) ? sleepToday
                   : (sleepYest && !sleepYest._error) ? sleepYest
                   : null;
    // Garmin sleep: sleepRaw.dailySleepDTO.sleepScores.overall.value  OR  sleepRaw.sleepScore
    const sleepDTO = sleepRaw?.dailySleepDTO ?? sleepRaw ?? {};
    const sleepScore =
      sleepDTO?.sleepScores?.overall?.value ??
      sleepDTO?.sleepScore ??
      deepFind(sleepRaw, "overallSleepScore") ??
      deepFind(sleepRaw, "sleepScore") ??
      null;
    const sleepDurationSec = sleepDTO?.sleepTimeSeconds ?? deepFind(sleepRaw, "sleepTimeSeconds") ?? null;
    const sleepDurationMin = sleepDurationSec ? Math.round(sleepDurationSec / 60) : null;

    // ── BODY BATTERY ──
    let bodyBattery = null;
    if (Array.isArray(batteryData)) {
      const entry = batteryData.find(d => d.calendarDate === today || d.date === today)
                 ?? batteryData.find(d => d.calendarDate === yesterday || d.date === yesterday)
                 ?? batteryData[batteryData.length - 1];
      bodyBattery = entry?.charged ?? entry?.endLevel ?? entry?.startLevel ?? null;
    } else if (batteryData && !batteryData._error) {
      bodyBattery = deepFind(batteryData, "charged") ?? deepFind(batteryData, "endLevel") ?? null;
    }

    // ── RESTING HR ──
    const restingHR =
      hrData?.restingHeartRate ??
      summaryToday?.restingHeartRate ??
      deepFind(hrData, "restingHeartRate") ??
      null;

    // ── STRESS ──
    let stress = null;
    const stressObj = Array.isArray(stressData) ? stressData[0] : stressData;
    if (stressObj && !stressObj._error) {
      stress =
        stressObj.overallStressLevel ??
        stressObj.avgStressLevel ??
        stressObj.stressLevel ??
        deepFind(stressObj, "overallStressLevel") ??
        null;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        date: today, yesterday,
        restingHR, hrv, hrvBaseline,
        bodyBattery, sleepScore, sleepDurationMin, stress,
        // Raw kept for debugging — remove once shapes confirmed
        raw: { hrv: hrvData, sleepToday, sleepYest, battery: batteryData, stress: stressData, hr: hrData, summary: summaryToday }
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
