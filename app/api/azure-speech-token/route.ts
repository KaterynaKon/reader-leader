import { NextResponse } from "next/server";

export async function POST() {
  try {
    const key = process.env.AZURE_SPEECH_KEY;
    const region = process.env.AZURE_SPEECH_REGION;

    if (!key || !region) {
      return NextResponse.json(
        {
          error: "Azure Speech environment variables are missing",
        },
        { status: 500 }
      );
    }

    const response = await fetch(
      `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Length": "0",
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      console.error(
        "[Azure] Token request failed:",
        response.status,
        errorText
      );

      return NextResponse.json(
        {
          error: "Could not get Azure Speech token",
        },
        { status: response.status }
      );
    }

    const token = await response.text();

    return NextResponse.json({
      token,
      region,
    });
  } catch (error) {
    console.error("[Azure] Token endpoint error:", error);

    return NextResponse.json(
      {
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}