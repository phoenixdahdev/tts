"use client"

import { useEffect, useMemo, useRef, useState } from "react"

type Voice = {
  Name: string
  ShortName: string
  Gender: string
  Locale: string
  FriendlyName: string
  SuggestedCodec: string
  Status: string
}

type Status = "idle" | "loading" | "ready" | "error"

const DEFAULT_TEXT =
  "Welcome! Paste any length of text — even an entire chapter — pick a voice, and click Generate. The audio is created server-side using Microsoft Edge's neural voices, completely free, no API key required."

export default function Home() {
  const [text, setText] = useState(DEFAULT_TEXT)
  const [voices, setVoices] = useState<Voice[]>([])
  const [voice, setVoice] = useState("en-US-AriaNeural")
  const [localeFilter, setLocaleFilter] = useState("en")
  const [genderFilter, setGenderFilter] = useState<"all" | "Female" | "Male">("all")
  const [rate, setRate] = useState(1)
  const [pitch, setPitch] = useState(1)
  const [status, setStatus] = useState<Status>("idle")
  const [error, setError] = useState<string | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null)
  const [elapsed, setElapsed] = useState(0)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch("/api/voices")
      .then((r) => r.json())
      .then((data: Voice[] | { error: string }) => {
        if (cancelled) return
        if (Array.isArray(data)) {
          data.sort((a, b) => a.Locale.localeCompare(b.Locale) || a.ShortName.localeCompare(b.ShortName))
          setVoices(data)
        } else {
          setError(data.error)
        }
      })
      .catch((err) => !cancelled && setError(`Failed to load voices: ${err.message}`))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl)
      abortRef.current?.abort()
    }
  }, [audioUrl])

  const locales = useMemo(() => {
    const set = new Set<string>()
    for (const v of voices) set.add(v.Locale.split("-")[0])
    return Array.from(set).sort()
  }, [voices])

  const filteredVoices = useMemo(() => {
    return voices.filter((v) => {
      if (localeFilter !== "all" && !v.Locale.toLowerCase().startsWith(localeFilter.toLowerCase())) {
        return false
      }
      if (genderFilter !== "all" && v.Gender !== genderFilter) return false
      return true
    })
  }, [voices, localeFilter, genderFilter])

  const selectedVoice = useMemo(() => {
    if (filteredVoices.length === 0) return voice
    if (filteredVoices.some((v) => v.ShortName === voice)) return voice
    return filteredVoices[0].ShortName
  }, [filteredVoices, voice])

  async function generate() {
    setError(null)
    if (!text.trim()) {
      setError("Type or paste some text first.")
      return
    }
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl)
      setAudioUrl(null)
      setAudioBlob(null)
    }

    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    setStatus("loading")
    setElapsed(0)
    const start = Date.now()
    const tick = setInterval(() => setElapsed(Date.now() - start), 100)

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: selectedVoice, rate, pitch }),
        signal: ac.signal,
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(errBody.error ?? `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      setAudioBlob(blob)
      setAudioUrl(url)
      setStatus("ready")
      setTimeout(() => audioRef.current?.play().catch(() => {}), 50)
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setStatus("idle")
      } else {
        setError((err as Error).message)
        setStatus("error")
      }
    } finally {
      clearInterval(tick)
    }
  }

  function cancel() {
    abortRef.current?.abort()
    setStatus("idle")
  }

  function download() {
    if (!audioBlob || !audioUrl) return
    const a = document.createElement("a")
    a.href = audioUrl
    const safeVoice = selectedVoice.replace(/[^a-zA-Z0-9-]/g, "_")
    a.download = `tts-${safeVoice}-${Date.now()}.mp3`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const charCount = text.length
  const isLoading = status === "loading"
  const sizeKb = audioBlob ? (audioBlob.size / 1024).toFixed(0) : null

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Text to Speech</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Powered by Microsoft Edge neural voices via{" "}
          <code className="rounded bg-neutral-200 px-1 py-0.5 text-xs dark:bg-neutral-800">
            msedge-tts
          </code>
          . Free, no API key, no permission dialogs. Direct MP3 download.
        </p>
      </header>

      <div className="relative">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          className="w-full resize-y rounded-lg border border-neutral-300 bg-white px-4 py-3 text-base text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          placeholder="Paste any length of text…"
          maxLength={100000}
        />
        <span className="absolute bottom-2 right-3 text-xs text-neutral-400">
          {charCount.toLocaleString()} / 100,000
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">Language</span>
          <select
            value={localeFilter}
            onChange={(e) => setLocaleFilter(e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="all">All languages</option>
            {locales.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">Gender</span>
          <select
            value={genderFilter}
            onChange={(e) => setGenderFilter(e.target.value as typeof genderFilter)}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="all">Any</option>
            <option value="Female">Female</option>
            <option value="Male">Male</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm sm:col-span-1">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">
            Voice ({filteredVoices.length})
          </span>
          <select
            value={selectedVoice}
            onChange={(e) => setVoice(e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {filteredVoices.length === 0 && <option value="">No voices match filters</option>}
            {filteredVoices.map((v) => (
              <option key={v.ShortName} value={v.ShortName}>
                {v.ShortName} — {v.Gender}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">
            Rate {rate.toFixed(2)}x
          </span>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={rate}
            onChange={(e) => setRate(parseFloat(e.target.value))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-neutral-700 dark:text-neutral-300">
            Pitch {pitch.toFixed(2)}
          </span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={pitch}
            onChange={(e) => setPitch(parseFloat(e.target.value))}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={generate}
          disabled={isLoading || !text.trim()}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {isLoading ? `Generating… ${(elapsed / 1000).toFixed(1)}s` : "Generate"}
        </button>
        <button
          type="button"
          onClick={download}
          disabled={!audioBlob}
          className="rounded-md border border-neutral-900 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white dark:text-white dark:hover:bg-neutral-800"
        >
          Download MP3{sizeKb ? ` (${sizeKb} KB)` : ""}
        </button>
        {isLoading && (
          <button
            type="button"
            onClick={cancel}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Cancel
          </button>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}

      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          controls
          className="w-full"
          aria-label="Generated speech"
        />
      )}
    </main>
  )
}
