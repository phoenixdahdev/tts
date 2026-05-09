import { MsEdgeTTS, OUTPUT_FORMAT, type ProsodyOptions } from "msedge-tts"

export const runtime = "nodejs"
export const maxDuration = 120

const MAX_TEXT_LENGTH = 100_000
const CHUNK_TARGET = 2500

type Body = {
  text?: string
  voice?: string
  rate?: number
  pitch?: number
}

export async function POST(req: Request) {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return jsonError("Invalid JSON body", 400)
  }

  const text = (body.text ?? "").trim()
  if (!text) return jsonError("Text is required", 400)
  if (text.length > MAX_TEXT_LENGTH) {
    return jsonError(`Text too long (max ${MAX_TEXT_LENGTH} chars)`, 413)
  }

  const voice = body.voice?.trim() || "en-US-AriaNeural"
  const rate = clamp(body.rate ?? 1, 0.5, 2)
  const pitch = clamp(body.pitch ?? 1, 0, 2)

  const prosody: ProsodyOptions = {
    rate: percentString(rate - 1, 100),
    pitch: percentString(pitch - 1, 50),
  }

  const chunks = chunkText(text, CHUNK_TARGET)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const abort = req.signal
      try {
        for (const chunk of chunks) {
          if (abort.aborted) break
          const tts = new MsEdgeTTS()
          try {
            await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
            const { audioStream } = tts.toStream(chunk, prosody)
            for await (const data of audioStream) {
              if (abort.aborted) break
              controller.enqueue(
                data instanceof Uint8Array ? data : new Uint8Array(data as Buffer),
              )
            }
          } finally {
            tts.close()
          }
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-Chunks": String(chunks.length),
    },
  })
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function clamp(n: number, min: number, max: number) {
  if (Number.isNaN(n)) return (min + max) / 2
  return Math.max(min, Math.min(max, n))
}

function percentString(delta: number, scale: number) {
  const pct = Math.round(delta * scale)
  return `${pct >= 0 ? "+" : ""}${pct}%`
}

function chunkText(text: string, target: number): string[] {
  if (text.length <= target) return [text]
  const pieces = text
    .split(/(?<=[.!?])\s+|\n{2,}/g)
    .map((s) => s.trim())
    .filter(Boolean)

  const chunks: string[] = []
  let current = ""
  for (const piece of pieces) {
    if (piece.length > target) {
      if (current) {
        chunks.push(current)
        current = ""
      }
      for (let i = 0; i < piece.length; i += target) {
        chunks.push(piece.slice(i, i + target))
      }
      continue
    }
    if ((current + " " + piece).trim().length > target && current) {
      chunks.push(current)
      current = piece
    } else {
      current = current ? `${current} ${piece}` : piece
    }
  }
  if (current) chunks.push(current)
  return chunks
}
