// Netlify function: fetches Strava activities and calculates ATL/CTL/TSB
// POST with { access_token, refresh_token, expires_at }

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid body" }) };
  }

  let { access_token, refresh_token, expires_at } = body;

  // Refresh token if expired
  if (Date.now() / 1000 > expires_at - 300) {
    try {
      const refreshRes = await fetch("https://www.strava.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.STRAVA_CLIENT_ID,
          client_secret: process.env.STRAVA_CLIENT_SECRET,
          refresh_token,
          grant_type: "refresh_token"
        })
      });
      const refreshData = await refreshRes.json();
      access_token = refreshData.access_token;
      refresh_token = refreshData.refresh_token;
      expires_at = refreshData.expires_at;
    } catch (err) {
      return { statusCode: 401, body: JSON.stringify({ error: "Token refresh failed" }) };
    }
  }

  // Fetch last 60 days of activities for CTL calculation
  const sixtyDaysAgo = Math.floor(Date.now() / 1000) - (60 * 86400);
  
  try {
    const activitiesRes = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${sixtyDaysAgo}&per_page=100`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const activities = await activitiesRes.json();

    // Build daily TSS map for last 60 days
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const dailyTSS = {};
    for (let i = 0; i < 60; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dailyTSS[d.toISOString().split('T')[0]] = 0;
    }

    // Estimate TSS from each activity
    // TSS = (duration_seconds * NP * IF) / (FTP * 3600) * 100
    // For activities without power: use HR-based estimate
    for (const act of activities) {
      if (act.type !== 'Ride' && act.type !== 'VirtualRide') continue;
      
      const dateKey = act.start_date.split('T')[0];
      if (!(dateKey in dailyTSS)) continue;

      let tss = 0;
      if (act.weighted_average_watts && act.moving_time) {
        // Power-based TSS
        const ftp = 220; // Use athlete's FTP
        const np = act.weighted_average_watts;
        const if_ = np / ftp;
        tss = (act.moving_time * np * if_) / (ftp * 3600) * 100;
      } else if (act.moving_time) {
        // Rough estimate: 50 TSS/hour for easy ride
        tss = (act.moving_time / 3600) * 50;
      }
      
      dailyTSS[dateKey] = (dailyTSS[dateKey] || 0) + Math.round(tss);
    }

    // Calculate ATL (7-day exponential weighted), CTL (42-day), TSB
    // Using exponential moving average: decay constants
    const ATL_DECAY = Math.exp(-1/7);   // 7-day time constant
    const CTL_DECAY = Math.exp(-1/42);  // 42-day time constant

    const sortedDays = Object.keys(dailyTSS).sort();
    let atl = 0, ctl = 0;

    for (const day of sortedDays) {
      const tss = dailyTSS[day];
      atl = tss * (1 - ATL_DECAY) + atl * ATL_DECAY;
      ctl = tss * (1 - CTL_DECAY) + ctl * CTL_DECAY;
    }

    const tsb = Math.round(ctl - atl);
    const atlRounded = Math.round(atl);
    const ctlRounded = Math.round(ctl);

    // Last 7 days summary
    const last7 = sortedDays.slice(-7).map(d => ({
      date: d,
      tss: dailyTSS[d]
    }));

    const weeklyTSS = last7.reduce((s, d) => s + d.tss, 0);
    const ridesLast7 = activities.filter(a => {
      const d = new Date(a.start_date);
      return (Date.now() - d.getTime()) < 7 * 86400 * 1000 &&
             (a.type === 'Ride' || a.type === 'VirtualRide');
    }).length;

    // TSB interpretation
    let form = "";
    if (tsb > 10) form = "Fresh — good form, ready to train hard";
    else if (tsb > 0) form = "Neutral — balanced fatigue and fitness";
    else if (tsb > -10) form = "Tired — some fatigue, train carefully";
    else if (tsb > -20) form = "Fatigued — consider reducing load";
    else form = "Very fatigued — rest or easy riding only";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        atl: atlRounded,
        ctl: ctlRounded,
        tsb,
        form,
        weeklyTSS,
        ridesLast7,
        last7,
        // Return updated tokens in case they were refreshed
        access_token,
        refresh_token,
        expires_at
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
