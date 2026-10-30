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

    const [hrvData, sleepToday, sleepYest, sleepWellness, batteryData, stressData, stressYest, hrData, summaryToday] = await Promise.all([
      garminGet(token, `/hrv-service/hrv/${today}`),
      garminGet(token, `/sleep-service/sleep/${today}`),
      garminGet(token, `/sleep-service/sleep/${yesterday}`),
      garminGet(token, `/wellness-service/wellness/dailySleep?date=${today}`),
      garminGet(token, `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${yesterday}&endDate=${today}`),
      garminGet(token, `/wellness-service/wellness/dailyStress/${today}`),
      garminGet(token, `/wellness-service/wellness/dailyStress/${yesterday}`),
      garminGet(token, `/wellness-service/wellness/dailyHeartRate?date=${today}`),
      garminGet(token, `/usersummary-service/usersummary/daily/${today}`),
    ]);

    // ── HRV ──
    // Confirmed field: hrvData.hrvSummary.lastNightAvg (number)
    // Status: hrvData.hrvSummary.lastNight5MinHigh, or status field
    const hrvSummary = hrvData?.hrvSummary ?? {};
    const hrv = hrvSummary.lastNightAvg
      ?? hrvSummary.lastNight
      ?? deepFind(hrvData, "lastNightAvg")
      ?? deepFind(hrvData, "lastNight")
      ?? null;
    const hrvStatus = hrvSummary.status
      ?? hrvSummary.hrvStatus
      ?? deepFind(hrvData, "status")
      ?? null;
    const hrvBaseline = hrvSummary.baseline?.balancedLow
      ?? hrvSummary.baseline?.low
      ?? deepFind(hrvData, "balancedLow")
      ?? null;

    // ── SLEEP ──
    // Try multiple endpoints: sleep-service/sleep/{date}, wellness dailySleep
    const sleepRaw = (sleepToday && !sleepToday._error) ? sleepToday
                   : (sleepYest && !sleepYest._error) ? sleepYest
                   : (sleepWellness && !sleepWellness._error) ? sleepWellness
                   : null;
    const sleepDTO = sleepRaw?.dailySleepDTO ?? sleepRaw ?? {};
    const sleepScore =
      sleepDTO?.sleepScores?.overall?.value ??
      sleepDTO?.sleepScore ??
      sleepDTO?.overallSleepScore ??
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
    // Try path-style endpoint (dailyStress/{date}) — falls back to yesterday
    let stress = null;
    const stressRaw = (stressData && !stressData._error) ? stressData
                    : (stressYest && !stressYest._error) ? stressYest
                    : null;
    const stressObj = Array.isArray(stressRaw) ? stressRaw[0] : stressRaw;
    if (stressObj) {
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
        restingHR, hrv, hrvStatus, hrvBaseline,
        bodyBattery, sleepScore, sleepDurationMin, stress,
        // Raw kept for debugging — remove once shapes confirmed
        raw: { hrv: hrvData, sleepToday, sleepYest, sleepWellness, battery: batteryData, stress: stressData, stressYest, hr: hrData, summary: summaryToday }
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
