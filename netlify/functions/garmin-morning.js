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
  if (!res.ok) return null;
  return res.json();
}

function todayStr() {
  // Use Berlin time (UTC+1 / UTC+2 DST) — approximate with UTC+1 for autumn
  const d = new Date(Date.now() + 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function yesterdayStr() {
  const d = new Date(Date.now() + 60 * 60 * 1000 - 86400000);
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

    // Fetch in parallel
    const [hrvData, sleepData, batteryData, stressData, hrData] = await Promise.all([
      garminGet(token, `/hrv-service/hrv/${yesterday}`),
      garminGet(token, `/sleep-service/sleep/dailySleep?date=${yesterday}`),
      garminGet(token, `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${yesterday}&endDate=${today}`),
      garminGet(token, `/usersummary-service/stats/stress/daily/${yesterday}/${yesterday}`),
      garminGet(token, `/wellness-service/wellness/dailyHeartRate?date=${today}`),
    ]);

    // Extract values safely
    const hrv = hrvData?.hrvSummary?.lastNight ?? hrvData?.lastNight ?? null;
    const hrvBaseline = hrvData?.hrvSummary?.baseline?.balancedLow ?? null;

    const sleepScore = sleepData?.dailySleepDTO?.sleepScores?.overall?.value
      ?? sleepData?.sleepScores?.overall?.value
      ?? sleepData?.overallScore
      ?? null;
    const sleepDurationMin = sleepData?.dailySleepDTO?.sleepTimeSeconds
      ? Math.round(sleepData.dailySleepDTO.sleepTimeSeconds / 60)
      : null;

    // Body battery at wake (last reading of yesterday / start of today)
    let bodyBattery = null;
    if (Array.isArray(batteryData)) {
      const yest = batteryData.find(d => d.date === yesterday || d.calendarDate === yesterday);
      bodyBattery = yest?.charged ?? yest?.endLevel ?? null;
    } else if (batteryData?.startLevel !== undefined) {
      bodyBattery = batteryData.startLevel;
    }

    // Resting HR — from daily heart rate summary
    const restingHR = hrData?.restingHeartRate ?? hrData?.heartRateValues?.[0]?.[1] ?? null;

    // Average stress (0–100, lower = less stressed)
    let stress = null;
    if (Array.isArray(stressData) && stressData.length > 0) {
      stress = stressData[0]?.overallStressLevel ?? stressData[0]?.avgStressLevel ?? null;
    } else if (stressData?.overallStressLevel !== undefined) {
      stress = stressData.overallStressLevel;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        date: today,
        restingHR,
        hrv,
        hrvBaseline,
        bodyBattery,
        sleepScore,
        sleepDurationMin,
        stress,
        raw: { hrv: hrvData, sleep: sleepData, battery: batteryData, stress: stressData, hr: hrData }
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
