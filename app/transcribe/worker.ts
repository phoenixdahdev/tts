/// <reference lib="webworker" />

import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers"

type LoadMsg = {
  type: "load"
  model: string
  device: "webgpu" | "wasm"
}

type TranscribeMsg = {
  type: "transcribe"
  audio: Float32Array
  language: string | null
}

type InMsg = LoadMsg | TranscribeMsg

let transcriber: AutomaticSpeechRecognitionPipeline | null = null
let loadedModel = ""
let loadedDevice = ""

self.addEventListener("message", async (event: MessageEvent<InMsg>) => {
  const msg = event.data
  try {
    if (msg.type === "load") {
      if (transcriber && loadedModel === msg.model && loadedDevice === msg.device) {
        ;(self as unknown as Worker).postMessage({ type: "ready", model: msg.model })
        return
      }
      transcriber = (await pipeline("automatic-speech-recognition", msg.model, {
        device: msg.device,
        dtype: msg.device === "webgpu" ? "fp32" : "q8",
        progress_callback: (p: unknown) => {
          ;(self as unknown as Worker).postMessage({ type: "progress", payload: p })
        },
      })) as AutomaticSpeechRecognitionPipeline
      loadedModel = msg.model
      loadedDevice = msg.device
      ;(self as unknown as Worker).postMessage({ type: "ready", model: msg.model })
      return
    }

    if (msg.type === "transcribe") {
      if (!transcriber) {
        ;(self as unknown as Worker).postMessage({
          type: "error",
          message: "Model not loaded yet",
        })
        return
      }
      ;(self as unknown as Worker).postMessage({ type: "transcribing" })
      const result = await transcriber(msg.audio, {
        language: msg.language ?? undefined,
        task: "transcribe",
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
      })
      ;(self as unknown as Worker).postMessage({ type: "result", payload: result })
      return
    }
  } catch (err) {
    ;(self as unknown as Worker).postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    })
  }
})

export {}
