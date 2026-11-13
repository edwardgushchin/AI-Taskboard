import { createRequire } from "node:module";

type Transcriber = (samples: Float32Array, options: {
  language: "ru" | "en";
  chunk_length_s: number;
  stride_length_s: number;
}) => Promise<{ text: string }>;

const require = createRequire(import.meta.url);
let model: Promise<Transcriber> | undefined;
let busy = false;

export async function transcribeVoice(samples: Float32Array, language: "ru" | "en", cacheDir: string): Promise<string> {
  if (busy) throw new Error("Voice transcription is already running.");
  busy = true;
  try {
    model ??= Promise.resolve().then((): Promise<Transcriber> => {
      const { pipeline } = require("@huggingface/transformers");
      return pipeline("automatic-speech-recognition", "Xenova/whisper-base", {
        device: "cpu",
        dtype: "q8",
        revision: "64da57285918e20ea79ea5c88eed7197933abaa8",
        cache_dir: cacheDir,
      });
    }).catch(error => {
      model = undefined;
      throw error;
    });
    const result = await (await model)(samples, { language, chunk_length_s: 30, stride_length_s: 5 });
    return result.text.trim();
  } finally {
    busy = false;
  }
}
