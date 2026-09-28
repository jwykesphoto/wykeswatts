// Netlify function: fetches yesterday's activity and analyses vs planned workout
// POST with { access_token, refresh_token, expires_at, planned_workout_id, ftp }

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid body" }) }; }

  let { access_token, refresh_token, expires_at, ftp } = body;

  // Refresh token if needed
  if (Date.now() / 1000 > expires_at - 300) {
    try {
      const r = await fetch("https://www.strava.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.STRAVA_CLIENT_ID,
          client_secret: process.env.STRAVA_CLIENT_SECRET,
          refresh_token,
          grant_type: "refresh_token"
        })
      });
      const d = await r.json();
      access_token = d.access_token;
      refresh_token = d.refresh_token;
      expires_at = d.expires_at;
    } catch {
      return { statusCode: 401, body: JSON.stringify({ error: "Token refresh failed" }) };
    }
  }

  // Get yesterday's date range
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  const yesterdayEnd = new Date(yesterday);
  yesterdayEnd.setHours(23, 59, 59, 999);

  const after = Math.floor(yesterday.getTime() / 1000);
  const before = Math.floor(yesterdayEnd.getTime() / 1000);

  try {
    const res = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${after}&before=${before}&per_page=10`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const activities = await res.json();

    // Filter to cycling only
    const rides = activities.filter(a =>
      a.type === "Ride" || a.type === "VirtualRide" || a.type === "EBikeRide"
    );

    if (!rides.length) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          found: false,
          message: "No ride recorded yesterday.",
          access_token, refresh_token, expires_at
        })
      };
    }

    // Use the longest ride if multiple
    const ride = rides.sort((a, b) => b.moving_time - a.moving_time)[0];

    const avgPower = ride.average_watts || null;
    const np = ride.weighted_average_watts || avgPower;
    const avgHR = ride.average_heartrate || null;
    const maxHR = ride.max_heartrate || null;
    const duration = ride.moving_time; // seconds
    const distance = Math.round(ride.distance / 1000 * 10) / 10; // km
    const elevGain = ride.total_elevation_gain || 0;
    const isVirtual = ride.type === "VirtualRide";

    // Calculate TSS
    let tss = 0;
    if (np && ftp && duration) {
      const if_ = np / ftp;
      tss = Math.round((duration * np * if_) / (ftp * 3600) * 100);
    } else {
      tss = Math.round((duration / 3600) * 50);
    }

    // Zone analysis
    const zones = [
      { id: 1, name: "Recovery", min: 0,   max: ftp * 0.55 },
      { id: 2, name: "Endurance", min: ftp * 0.56, max: ftp * 0.75 },
      { id: 3, name: "Tempo",     min: ftp * 0.76, max: ftp * 0.90 },
      { id: 4, name: "Threshold", min: ftp * 0.91, max: ftp * 1.05 },
      { id: 5, name: "VO2 Max",   min: ftp * 1.06, max: ftp * 1.20 },
    ];

    // Determine which zone average power falls in
    const powerZone = avgPower
      ? zones.find(z => avgPower >= z.min && avgPower <= z.max) || zones[4]
      : null;

    // HR appropriateness — rough check
    let hrAssessment = null;
    if (avgHR && avgPower && ftp) {
      const ifRatio = avgPower / ftp;
      // Expected HR for intensity — rough model
      if (ifRatio < 0.75 && avgHR > 145) {
        hrAssessment = "elevated";
      } else if (ifRatio < 0.75 && avgHR < 130) {
        hrAssessment = "good";
      } else if (ifRatio > 0.9 && avgHR > 160) {
        hrAssessment = "expected";
      } else {
        hrAssessment = "normal";
      }
    }

    // Structured vs free ride detection
    // If virtual ride, likely structured. If outdoor, likely free.
    const likelyStructured = isVirtual;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        found: true,
        ride: {
          name: ride.name,
          date: yesterday.toISOString().split("T")[0],
          duration: Math.round(duration / 60), // minutes
          distance,
          elevGain: Math.round(elevGain),
          avgPower,
          np,
          avgHR,
          maxHR,
          tss,
          powerZone: powerZone ? powerZone.name : null,
          powerZoneId: powerZone ? powerZone.id : null,
          hrAssessment,
          isVirtual,
          likelyStructured,
          type: ride.type,
        },
        access_token, refresh_token, expires_at
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
