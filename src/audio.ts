import type { Relay } from "./client.js";
import type { ModelOperations } from "./generated/models.js";
import type { HelperInput, HelperOutput, ImageOptions } from "./image.js";
import { run } from "./run.js";

type AudioOps = ModelOperations["Audio"];
type AsrOp = "audio_asr_whisper";
type SpeechOps = { [K in keyof AudioOps as AudioOps[K] extends AsrOp ? never : K]: AudioOps[K] };
type TranscribeOps = { [K in keyof AudioOps as AudioOps[K] extends AsrOp ? K : never]: AudioOps[K] };

/** Known text-to-speech model names, with autocomplete — any other string is accepted too. */
export type SpeechModel = keyof SpeechOps | (string & {});
/** Known speech-to-text model names, with autocomplete — any other string is accepted too. */
export type TranscribeModel = keyof TranscribeOps | (string & {});

/** Same options as the image helpers: an async answer (`async: true`) is waited for. */
export type AudioOptions = ImageOptions;

/** Text-to-speech and speech-to-text. */
export class Audio {
  readonly #relay: Relay;
  constructor(relay: Relay) {
    this.#relay = relay;
  }

  /** Text-to-speech. Returns the response body: `audio_url` (a link that expires) or `audio_base64` + `content_type`, per model. */
  async speech<M extends SpeechModel>(model: M, input: HelperInput<SpeechOps, M>, opts: AudioOptions = {}): Promise<HelperOutput<SpeechOps, M>> {
    return (await run(this.#relay, model, input as Record<string, unknown>, { ...opts, wait: true })) as HelperOutput<SpeechOps, M>;
  }

  /** Speech-to-text. `audio_url` may be a link or a Blob/bytes/stream (uploaded first). Returns `{ text, language?, duration? }`. */
  async transcribe<M extends TranscribeModel>(model: M, input: HelperInput<TranscribeOps, M>, opts: AudioOptions = {}): Promise<HelperOutput<TranscribeOps, M>> {
    return (await run(this.#relay, model, input as Record<string, unknown>, { ...opts, wait: true })) as HelperOutput<TranscribeOps, M>;
  }
}
