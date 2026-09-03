// app/api/azure-speech-token/route.ts
//
// NOTE: I don't have your actual current file for this route, so this is
// the standard Azure Speech STS token exchange. It expects two env vars:
//   AZURE_SPEECH_KEY
//   AZURE_SPEECH_REGION
// If your existing route uses different env var names or a different
// endpoint shape, send it over and I'll adapt page.tsx to match instead.

export async function POST() {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;

  if (!key || !region) {
    return Response.json(
      {
        error: "AZURE_SPEECH_KEY or AZURE_SPEECH_REGION is missing",
      },
      { status: 500 }
    );
  }

  try {
    const response = await fetch(
      `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": "0",
        },
      }
    );

    if (!response.ok) {
      const text = await response.text();

      return Response.json(
        {
          error: "Azure rejected the token request",
          status: response.status,
          details: text,
        },
        { status: response.status }
      );
    }

    const token = await response.text();

    return Response.json({
      token,
      region,
    });
  } catch (error) {
    console.error("Azure speech token error:", error);

    return Response.json(
      {
        error: "Internal server error",
        details: String(error),
      },
      { status: 500 }
    );
  }
}