import { MsEdgeTTS, type Voice } from "msedge-tts"
import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const revalidate = 86400

let cache: { at: number; voices: Voice[] } | null = null
const TTL_MS = 1000 * 60 * 60 * 24

export async function GET() {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json(cache.voices)
  }
  try {
    const tts = new MsEdgeTTS()
    const voices = await tts.getVoices()
    cache = { at: Date.now(), voices }
    return NextResponse.json(voices)
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch voices" },
      { status: 502 },
    )
  }
}
