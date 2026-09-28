// Netlify function: handles Strava OAuth token exchange
// Called when Strava redirects back to wykeswatts.com/callback?code=xxx
// Redirects back to the app with token data in URL fragment

exports.handler = async (event) => {
  const { code, error } = event.queryStringParameters || {};

  if (error) {
    return {
      statusCode: 302,
      headers: { Location: `/?strava_error=${encodeURIComponent(error)}` }
    };
  }

  if (!code) {
    return {
      statusCode: 302,
      headers: { Location: "/?strava_error=no_code" }
    };
  }

  try {
    const response = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: "authorization_code"
      })
    });

    const data = await response.json();

    if (data.errors || !data.access_token) {
      return {
        statusCode: 302,
        headers: { Location: "/?strava_error=token_exchange_failed" }
      };
    }

    // Encode token data and redirect back to app
    const tokenData = encodeURIComponent(JSON.stringify({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      athlete: {
        id: data.athlete.id,
        firstname: data.athlete.firstname,
        weight: data.athlete.weight
      }
    }));

    return {
      statusCode: 302,
      headers: { Location: `/?strava_token=${tokenData}` }
    };

  } catch (err) {
    return {
      statusCode: 302,
      headers: { Location: `/?strava_error=${encodeURIComponent(err.message)}` }
    };
  }
};
