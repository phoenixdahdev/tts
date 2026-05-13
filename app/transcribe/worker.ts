/// <reference lib="webworker" />

import {
  pipeline,
  WhisperTextStreamer,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers"

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
        dtype:
          msg.device === "webgpu"
            ? { encoder_model: "fp32", decoder_model_merged: "q4" }
            : { encoder_model: "fp32", decoder_model_merged: "fp32" },
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

      const post = (self as unknown as Worker).postMessage.bind(self)
      const processor = (transcriber as unknown as { processor: { feature_extractor: { config: { chunk_length: number } } } }).processor
      const model = (transcriber as unknown as { model: { config: { max_source_positions: number } } }).model
      const time_precision =
        processor.feature_extractor.config.chunk_length /
        model.config.max_source_positions

      const streamer = new WhisperTextStreamer(
        transcriber.tokenizer as unknown as ConstructorParameters<typeof WhisperTextStreamer>[0],
        {
        time_precision,
        skip_prompt: true,
        skip_special_tokens: true,
        on_chunk_start: (start: number) => {
          post({ type: "chunk-start", start })
        },
        callback_function: (text: string) => {
          post({ type: "partial", text })
        },
        on_chunk_end: (end: number) => {
          post({ type: "chunk-end", end })
        },
        on_finalize: () => {
          post({ type: "stream-end" })
        },
        },
      )

      const result = await transcriber(msg.audio, {
        language: msg.language ?? undefined,
        task: "transcribe",
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
        streamer,
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
