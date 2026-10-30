// Garmin Personal API — morning health snapshot
// Returns: restingHR, hrv, bodyBattery, sleepScore, stress for today/last night

const BASE = "https://personal.connectapi.garmin.com";

async function getToken(apiKey) {
  const res = await fetch(
    `${BASE}/personalapitoken-service/personal-api/personal-api-key/token`,
    { method: "POST", headers: { Authorization: `ApiKey ${apiKey}` } }
  );
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const text = await res.text();
  // Garmin returns the JWT as a plain string, not JSON
  try {
    const data = JSON.parse(text);
    return data.access_token || data.accessToken || data.token || text.trim();
  } catch {
    return text.trim(); // plain JWT string
  }
}

async function garminGet(token, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return { _error: res.status, _path: path };
  }
  try {
    return await res.json();
  } catch {
    return { _parseError: true, _path: path };
  }
}

function todayStr() {
  // Use Berlin time (UTC+1 in autumn / UTC+2 in summer)
  const offset = 1; // CET
  const d = new Date(Date.now() + offset * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function yesterdayStr() {
  const offset = 1;
  const d = new Date(Date.now() + offset * 3600 * 1000 - 86400000);
  return d.toISOString().slice(0, 10);
}

exports.handler = async () => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  const apiKey = process.env.GARMIN_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "No Garmin API key configured" }) };
  }

  try {
    const token = await getToken(apiKey);
    const today = todayStr();
    const yesterday = yesterdayStr();

    // Fetch in parallel — try multiple endpoint variants for HRV/sleep
    const [
      hrvData,
      sleepData,
      sleepData2,
      batteryData,
      stressData,
      hrData,
      userSummary,
    ] = await Promise.all([
      garminGet(token, `/hrv-service/hrv/${today}`),           // HRV for today (may include last night)
      garminGet(token, `/sleep-service/sleep/${today}`),        // alternate sleep endpoint
      garminGet(token, `/sleep-service/sleep/${yesterday}`),    // sleep for yesterday night
      garminGet(token, `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${yesterday}&endDate=${today}`),
      garminGet(token, `/wellness-service/wellness/dailyStress?date=${today}`),
      garminGet(token, `/wellness-service/wellness/dailyHeartRate?date=${today}`),
      garminGet(token, `/usersummary-service/usersummary/daily/${today}`),
    ]);

    // --- HRV ---
    // Try today first (morning reading), fall back to yesterday
    const hrv =
      hrvData?.hrvSummary?.lastNight ??
      hrvData?.lastNight ??
      hrvData?.hrvSummary?.weekly?.lastNight ??
      null;
    const hrvBaseline =
      hrvData?.hrvSummary?.baseline?.balancedLow ??
      hrvData?.baseline?.balancedLow ??
      null;

    // --- Sleep ---
    // Try both endpoints; Garmin sleep API often uses different path per region
    const sleepRaw = sleepData2?._error ? sleepData : (sleepData || sleepData2);
    const sleepScore =
      sleepRaw?.dailySleepDTO?.sleepScores?.overall?.value ??
      sleepRaw?.sleepScores?.overall?.value ??
      sleepRaw?.overallScore ??
      sleepRaw?.score ??
      null;
    const sleepDurationSec =
      sleepRaw?.dailySleepDTO?.sleepTimeSeconds ??
      sleepRaw?.sleepTimeSeconds ??
      null;
    const sleepDurationMin = sleepDurationSec ? Math.round(sleepDurationSec / 60) : null;

    // --- Body Battery ---
    let bodyBattery = null;
    if (Array.isArray(batteryData)) {
      // Find today's entry (charged = level when you woke up)
      const entry = batteryData.find(d => d.date === today || d.calendarDate === today)
        || batteryData.find(d => d.date === yesterday || d.calendarDate === yesterday);
      bodyBattery = entry?.charged ?? entry?.endLevel ?? entry?.startLevel ?? null;
    } else if (batteryData && !batteryData._error) {
      bodyBattery = batteryData.startLevel ?? batteryData.charged ?? null;
    }

    // --- Resting HR ---
    const restingHR =
      hrData?.restingHeartRate ??
      userSummary?.restingHeartRate ??
      null;

    // --- Stress ---
    let stress = null;
    if (stressData && !stressData._error) {
      if (Array.isArray(stressData)) {
        stress = stressData[0]?.overallStressLevel ?? stressData[0]?.avgStressLevel ?? null;
      } else {
        stress =
          stressData?.overallStressLevel ??
          stressData?.avgStressLevel ??
          stressData?.stressLevel ??
          null;
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        date: today,
        yesterday,
        restingHR,
        hrv,
        hrvBaseline,
        bodyBattery,
        sleepScore,
        sleepDurationMin,
        stress,
        // Keep raw for debugging — can remove once shapes confirmed
        raw: {
          hrv: hrvData,
          sleep: sleepData,
          sleep2: sleepData2,
          battery: batteryData,
          stress: stressData,
          hr: hrData,
          summary: userSummary,
        }
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
