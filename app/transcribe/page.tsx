"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

type ProgressItem = {
  status: string
  file?: string
  progress?: number
  loaded?: number
  total?: number
  name?: string
}

type Chunk = {
  timestamp: [number | null, number | null]
  text: string
}

type TranscriptionResult = {
  text: string
  chunks?: Chunk[]
}

type Phase = "idle" | "decoding" | "loading-model" | "transcribing" | "done" | "error"

const MODELS = [
  { id: "Xenova/whisper-tiny", label: "tiny (~75 MB, fastest)", multilingual: true },
  { id: "Xenova/whisper-base", label: "base (~145 MB, balanced)", multilingual: true },
  { id: "Xenova/whisper-small", label: "small (~480 MB, accurate)", multilingual: true },
]

const LANGUAGES = [
  { id: "", label: "Auto-detect" },
  { id: "english", label: "English" },
  { id: "spanish", label: "Spanish" },
  { id: "french", label: "French" },
  { id: "german", label: "German" },
  { id: "italian", label: "Italian" },
  { id: "portuguese", label: "Portuguese" },
  { id: "dutch", label: "Dutch" },
  { id: "russian", label: "Russian" },
  { id: "chinese", label: "Chinese" },
  { id: "japanese", label: "Japanese" },
  { id: "korean", label: "Korean" },
  { id: "arabic", label: "Arabic" },
  { id: "hindi", label: "Hindi" },
]

export default function TranscribePage() {
  const [file, setFile] = useState<File | null>(null)
  const [model, setModel] = useState(MODELS[1].id)
  const [language, setLanguage] = useState("")
  const [phase, setPhase] = useState<Phase>("idle")
  const [error, setError] = useState<string | null>(null)
  const [downloads, setDownloads] = useState<Record<string, ProgressItem>>({})
  const [result, setResult] = useState<TranscriptionResult | null>(null)
  const [device, setDevice] = useState<"webgpu" | "wasm">("wasm")
  const [elapsed, setElapsed] = useState(0)
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null)

  const workerRef = useRef<Worker | null>(null)
  const audioRef = useRef<Float32Array | null>(null)
  const startRef = useRef(0)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (typeof navigator === "undefined") return
      if (!("gpu" in navigator)) return
      try {
        const adapter = await (
          navigator as Navigator & { gpu: { requestAdapter: () => Promise<unknown> } }
        ).gpu.requestAdapter()
        if (!cancelled && adapter) setDevice("webgpu")
      } catch {
        /* fall back to wasm */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
    workerRef.current = worker

    worker.addEventListener("message", (event: MessageEvent) => {
      const msg = event.data
      switch (msg.type) {
        case "progress": {
          const item = msg.payload as ProgressItem
          if (item.file) {
            setDownloads((prev) => ({ ...prev, [item.file as string]: item }))
          }
          break
        }
        case "ready":
          setPhase("transcribing")
          startRef.current = Date.now()
          if (tickRef.current) clearInterval(tickRef.current)
          tickRef.current = setInterval(() => setElapsed(Date.now() - startRef.current), 100)
          if (audioRef.current) {
            worker.postMessage({
              type: "transcribe",
              audio: audioRef.current,
              language: language || null,
            })
          }
          break
        case "transcribing":
          break
        case "result":
          if (tickRef.current) {
            clearInterval(tickRef.current)
            tickRef.current = null
          }
          setResult(msg.payload as TranscriptionResult)
          setPhase("done")
          break
        case "error":
          if (tickRef.current) {
            clearInterval(tickRef.current)
            tickRef.current = null
          }
          setError(msg.message)
          setPhase("error")
          break
      }
    })

    worker.addEventListener("error", (e: ErrorEvent) => {
      setError(e.message || "Worker error")
      setPhase("error")
    })

    return () => {
      worker.terminate()
      workerRef.current = null
      if (tickRef.current) clearInterval(tickRef.current)
    }
  }, [language])

  useEffect(() => {
    return () => {
      if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl)
    }
  }, [audioPreviewUrl])

  const handleFile = (f: File | null) => {
    if (audioPreviewUrl) URL.revokeObjectURL(audioPreviewUrl)
    setFile(f)
    setResult(null)
    setError(null)
    setDownloads({})
    setPhase("idle")
    setAudioPreviewUrl(f ? URL.createObjectURL(f) : null)
  }

  const start = useCallback(async () => {
    if (!file || !workerRef.current) return
    setError(null)
    setResult(null)
    setDownloads({})

    setPhase("decoding")
    let mono: Float32Array
    try {
      mono = await decodeToMono16k(file)
    } catch (err) {
      setError(
        `Failed to decode audio: ${err instanceof Error ? err.message : "unknown"}. ` +
          "Try a different file or extract audio with ffmpeg first.",
      )
      setPhase("error")
      return
    }

    audioRef.current = mono
    setPhase("loading-model")
    workerRef.current.postMessage({ type: "load", model, device })
  }, [file, model, device])

  const downloadProgress = useMemo(() => {
    const items = Object.values(downloads).filter(
      (d) => d.status === "progress" || d.status === "done" || d.status === "ready",
    )
    if (items.length === 0) return null
    const totalBytes = items.reduce((sum, d) => sum + (d.total ?? 0), 0)
    const loadedBytes = items.reduce(
      (sum, d) => sum + (d.status === "done" || d.status === "ready" ? (d.total ?? 0) : (d.loaded ?? 0)),
      0,
    )
    return { totalBytes, loadedBytes, items }
  }, [downloads])

  const downloadText = () => {
    if (!result) return
    download(`transcript-${Date.now()}.txt`, result.text, "text/plain")
  }

  const downloadSrt = () => {
    if (!result?.chunks) return
    const srt = chunksToSrt(result.chunks)
    download(`transcript-${Date.now()}.srt`, srt, "application/x-subrip")
  }

  const busy = phase !== "idle" && phase !== "done" && phase !== "error"

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Transcribe Video / Audio</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Whisper runs in your browser via{" "}
          <code className="rounded bg-neutral-200 px-1 py-0.5 text-xs dark:bg-neutral-800">
            @huggingface/transformers
          </code>
          . No upload, no API key. Models cache after first load.{" "}
          <span className="font-medium">
            Device: {device === "webgpu" ? "WebGPU (fast)" : "WASM (slower)"}
          </span>
        </p>
      </header>

      <label className="block">
        <span className="sr-only">File</span>
        <div className="rounded-lg border-2 border-dashed border-neutral-300 bg-neutral-50 p-6 text-center transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900">
          <input
            type="file"
            accept="audio/*,video/*"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            className="block w-full cursor-pointer text-sm file:mr-3 file:rounded-md file:border-0 file:bg-neutral-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-neutral-700 dark:file:bg-white dark:file:text-neutral-900 dark:hover:file:bg-neutral-200"
          />
          {file && (
            <p className="mt-3 text-xs text-neutral-500">
              {file.name} — {(file.size / 1024 / 1024).toFixed(1)} MB
            </p>
          )}
        </div>
      </label>

      {audioPreviewUrl && file?.type.startsWith("video/") && (
        <video src={audioPreviewUrl} controls className="w-full rounded-md" />
      )}
      {audioPreviewUrl && file?.type.startsWith("audio/") && (
        <audio src={audioPreviewUrl} controls className="w-full" aria-label="Input audio" />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">Model</span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">Language</span>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            disabled={busy}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
          >
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={start}
          disabled={!file || busy}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {phase === "decoding" && "Decoding audio…"}
          {phase === "loading-model" && "Loading model…"}
          {phase === "transcribing" && `Transcribing… ${(elapsed / 1000).toFixed(1)}s`}
          {(phase === "idle" || phase === "done" || phase === "error") && "Transcribe"}
        </button>
        <button
          type="button"
          onClick={downloadText}
          disabled={!result}
          className="rounded-md border border-neutral-900 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white dark:text-white dark:hover:bg-neutral-800"
        >
          Download .txt
        </button>
        <button
          type="button"
          onClick={downloadSrt}
          disabled={!result?.chunks?.length}
          className="rounded-md border border-neutral-900 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white dark:text-white dark:hover:bg-neutral-800"
        >
          Download .srt
        </button>
      </div>

      {phase === "loading-model" && downloadProgress && (
        <div className="space-y-2 rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs dark:border-neutral-800 dark:bg-neutral-900">
          <p className="font-medium text-neutral-700 dark:text-neutral-300">
            Downloading model files (cached after first run)
          </p>
          {downloadProgress.items.map((d) => (
            <div key={d.file} className="space-y-0.5">
              <div className="flex justify-between text-neutral-500">
                <span className="truncate">{d.file}</span>
                <span>
                  {d.status === "done" || d.status === "ready"
                    ? "✓"
                    : `${Math.round(d.progress ?? 0)}%`}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                <div
                  className="h-full bg-neutral-900 transition-all dark:bg-white"
                  style={{
                    width: `${d.status === "done" || d.status === "ready" ? 100 : (d.progress ?? 0)}%`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}

      {result && (
        <section className="space-y-4">
          <div>
            <h2 className="mb-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Transcript
            </h2>
            <div className="max-h-96 overflow-y-auto rounded-md border border-neutral-200 bg-white p-4 text-sm leading-relaxed dark:border-neutral-800 dark:bg-neutral-900">
              {result.chunks && result.chunks.length > 0 ? (
                result.chunks.map((c, i) => (
                  <p key={i} className="mb-2 flex gap-3">
                    <span className="shrink-0 font-mono text-xs text-neutral-400">
                      {formatTimestamp(c.timestamp[0])}
                    </span>
                    <span>{c.text.trim()}</span>
                  </p>
                ))
              ) : (
                <p className="whitespace-pre-wrap">{result.text}</p>
              )}
            </div>
          </div>
        </section>
      )}
    </main>
  )
}

async function decodeToMono16k(file: File): Promise<Float32Array> {
  const arrayBuffer = await file.arrayBuffer()
  const Ctx =
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) throw new Error("Web Audio API not supported")
  const tempCtx = new Ctx()
  const decoded = await tempCtx.decodeAudioData(arrayBuffer.slice(0))
  await tempCtx.close()

  const target = 16000
  if (decoded.sampleRate === target && decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0).slice(0)
  }

  const offline = new OfflineAudioContext(
    1,
    Math.ceil((decoded.duration * target) / 1),
    target,
  )
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start(0)
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice(0)
}

function formatTimestamp(seconds: number | null): string {
  if (seconds === null || Number.isNaN(seconds)) return "--:--"
  const s = Math.max(0, seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
    : `${m}:${sec.toString().padStart(2, "0")}`
}

function srtTimestamp(seconds: number): string {
  const s = Math.max(0, seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const ms = Math.floor((s - Math.floor(s)) * 1000)
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${sec
    .toString()
    .padStart(2, "0")},${ms.toString().padStart(3, "0")}`
}

function chunksToSrt(chunks: Chunk[]): string {
  return chunks
    .map((c, i) => {
      const start = c.timestamp[0] ?? 0
      const end = c.timestamp[1] ?? start + 2
      return `${i + 1}\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\n${c.text.trim()}\n`
    })
    .join("\n")
}

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
