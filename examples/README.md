# Examples

Six runnable quickstarts for `@relaygpu/client`. They install the SDK from the tarball `npm pack` builds,
so they exercise exactly what would be published.

```bash
npm pack                     # at the repo root: builds dist/ and writes relaygpu-client-0.1.0.tgz
cd examples && npm install
export RELAY_API_KEY=relay_sk_...
# export RELAY_BASE_URL=...  # optional; default https://relaygpu.com
npx tsx 01-image.ts
```

After a change to the SDK, run `npm pack` again and `npm install` here again (the tarball is copied in).

| File | What it does | Run | Billed |
|---|---|---|---|
| `01-image.ts` | `Qwen/qwen-image`, prints the link, saves the image to the temp dir | `npx tsx 01-image.ts ["prompt"]` | yes |
| `02-video-wait.ts` | Kling v3 T2V, 3 s, `std`; waits with progress | `npx tsx 02-video-wait.ts ["prompt"]` | yes |
| `03-upload-motion-control.ts` | explicit upload (`relay1d`) + implicit Blob upload into Kling v3 Motion Control; returns the `202`, deletes the explicit upload | `npx tsx 03-upload-motion-control.ts <video.mp4> <image URL>` | yes |
| `04-webhook-receiver.ts` | verifies deliveries on `:8787` with `RELAY_WEBHOOK_SECRET` | `npx tsx 04-webhook-receiver.ts` | no |
| | self-test: signs deliveries with a throwaway secret, posts them to itself, exits 0 | `npx tsx 04-webhook-receiver.ts --self-test` | no |
| `05-workflow-run.ts` | `script-voiceover` workflow, waits, prints the output | `npx tsx 05-workflow-run.ts ["brief"]` | yes |
| `06-chat-base-url.ts` | the OpenAI SDK pointed at Relay | `npx tsx 06-chat-base-url.ts` | yes |

Motion control needs a video of a person moving (MP4/MOV, at least 3 s, at most 100 MB) and a public URL
of an image showing one clear human character.

Typecheck all of them: `npm run typecheck`.
