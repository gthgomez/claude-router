// sse_normalizer.ts
// Shared SSE normalization logic used by the router and tests.

function tryParseJson(input: string): unknown | undefined {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

export function createNormalizedProxyStream(params: {
  upstreamBody: ReadableStream<Uint8Array>;
  extractDeltas: (payload: unknown) => string[];
  onDelta: (delta: string) => void;
  onComplete: () => Promise<void> | void;
}): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let sseBuffer = '';
  let completed = false;

  const emitDelta = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    delta: string,
  ) => {
    if (!delta) return;
    params.onDelta(delta);
    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: delta } })}\n\n`,
      ),
    );
  };

  const processDataLine = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    line: string,
  ) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;

    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === '[DONE]') return;

    const payload = tryParseJson(dataStr);
    if (!payload) return;

    const deltas = params.extractDeltas(payload);
    for (const delta of deltas) {
      emitDelta(controller, delta);
    }
  };

  const finalize = async () => {
    if (completed) return;
    completed = true;
    await params.onComplete();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      reader = params.upstreamBody.getReader();

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            sseBuffer += decoder.decode(value, { stream: true });

            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() ?? '';

            for (const line of lines) {
              processDataLine(controller, line);
            }
          }

          const tail = sseBuffer.trim();
          if (tail) processDataLine(controller, tail);

          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          try {
            decoder.decode(new Uint8Array(), { stream: false });
          } catch {
            // ignore
          }
          await finalize();
        }
      })();
    },
    async cancel(reason) {
      try {
        if (reader) await reader.cancel(reason);
      } catch {
        // ignore
      } finally {
        await finalize();
      }
    },
  });
}
