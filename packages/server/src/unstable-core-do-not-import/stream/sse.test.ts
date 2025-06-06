import { EventEmitter, on } from 'node:events';
import { fetchServerResource } from '@trpc/server/__tests__/fetchServerResource';
import { EventSourcePolyfill, NativeEventSource } from 'event-source-polyfill';
import SuperJSON from 'superjson';
import type { inferAsyncIterableYield, Maybe } from '../types';
import { run, sleep } from '../utils';
import { sseHeaders, sseStreamConsumer, sseStreamProducer } from './sse';
import { isTrackedEnvelope, sse, tracked } from './tracked';

(global as any).EventSource = NativeEventSource || EventSourcePolyfill;

/* eslint-disable no-console */
export const suppressLogs = () => {
  const error = console.error;
  const noop = () => {
    // ignore
  };

  console.error = noop;
  return () => {
    console.error = error;
  };
};

test('e2e, server-sent events (SSE)', async () => {
  async function* data(lastEventId: string | undefined) {
    let i = lastEventId ? Number(lastEventId) : 0;
    while (true) {
      i++;
      yield tracked(String(i), i);

      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  type Data = inferAsyncIterableYield<ReturnType<typeof data>>;

  const written: string[] = [];

  await using server = fetchServerResource(async (request) => {
    const url = new URL(request.url);

    const lastEventId: string | null =
      request.headers.get('last-event-id') ??
      url.searchParams.get('lastEventId') ??
      url.searchParams.get('Last-Event-Id');

    const stream = sseStreamProducer({
      data: data(lastEventId ?? undefined),
      serialize: (v) => SuperJSON.serialize(v),
    })
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(
        // debug stream
        new TransformStream({
          transform(chunk, controller) {
            written.push(chunk);
            controller.enqueue(chunk);
          },
        }),
      );

    return new Response(stream, {
      headers: sseHeaders,
    });
  });

  const ac = new AbortController();
  const iterable = sseStreamConsumer<{
    data: Data;
    error: unknown;
    EventSource: typeof EventSourcePolyfill;
  }>({
    url: () => server.url,
    signal: ac.signal,
    init: () => ({
      lastEventIdQueryParameterName: 'lastEventId',
    }),
    deserialize: SuperJSON.deserialize,
    EventSource: EventSourcePolyfill,
  });
  let es: EventSource | null = null;

  function range(start: number, end: number) {
    return Array.from({ length: end - start }, (_, i) => i + start);
  }

  const ITERATIONS = 10;
  const values: number[] = [];
  const allEvents: inferAsyncIterableYield<typeof iterable>[] = [];
  // Iterate through the SSE events from the server
  for await (const value of iterable) {
    // Keep track of all events received
    allEvents.push(value);
    // Store reference to current EventSource instance
    es = value.eventSource;

    // If we receive a serialized error, throw it
    if (value.type === 'serialized-error') {
      throw value.error;
    }

    // Handle data events
    if (value.type === 'data') {
      // Store the actual data value
      values.push(value.data.data);

      // After receiving ITERATIONS number of values...
      if (values.length === ITERATIONS) {
        // Simulate the server crashed
        const release = suppressLogs();

        await Promise.all([
          // Restart the server
          await server.restart(),
          // Wait for the EventSource to detect the error and reconnect
          await new Promise<void>((resolve) => {
            es!.addEventListener(
              'error',
              () => {
                resolve();
              },
              { once: true },
            );
          }),
        ]);

        // Restore console logs
        release();
      }

      // Break after receiving double the ITERATIONS
      if (values.length === ITERATIONS * 2) {
        break;
      }
    }
  }

  expect(values).toEqual(range(1, ITERATIONS * 2 + 1));

  expect(server.abortCount).toBe(1);
  // The break after double the ITERATIONS will trigger a second socket close
  await vi.waitFor(() => expect(server.abortCount).toBe(2), {
    timeout: 1000,
  });

  expect(allEvents.filter((it) => it.type === 'connecting')).toHaveLength(2);
});

test('SSE on serverless - emit and disconnect early', async () => {
  const ee = new EventEmitter();

  async function* data(lastEventId: Maybe<number>, signal: AbortSignal) {
    let i = lastEventId ?? 0;

    for await (const _ of on(ee, 'next', { signal })) {
      yield* yieldEvent();
    }

    function* yieldEvent() {
      i++;
      yield tracked(String(i), i);
    }
  }
  type Data = inferAsyncIterableYield<ReturnType<typeof data>>;

  type RequestTrace = {
    lastEventId: string | null;
    written: string[];
  };
  const requests: RequestTrace[] = [];
  await using server = fetchServerResource(async (request) => {
    const url = new URL(request.url);

    const stringToNumber = (v: string | null) => {
      if (v === null) {
        return null;
      }
      const num = Number(v);
      if (Number.isNaN(num)) {
        return null;
      }
      return num;
    };
    const lastEventId: string | null =
      request.headers.get('last-event-id') ??
      url.searchParams.get('lastEventId') ??
      url.searchParams.get('Last-Event-Id');

    const requestTrace: RequestTrace = {
      lastEventId,
      written: [],
    };
    requests.push(requestTrace);

    const asNumber = stringToNumber(lastEventId);

    const stream = sseStreamProducer({
      data: data(asNumber, reqAbortCtrl.signal),
      serialize: (v) => SuperJSON.serialize(v),
      emitAndEndImmediately: true,
    })
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            requestTrace.written.push(chunk);
            controller.enqueue(chunk);
          },
        }),
      );

    return new Response(stream, {
      headers: sseHeaders,
    });
  });

  const reqAbortCtrl = new AbortController();

  const iterable = sseStreamConsumer<{
    data: Data;
    error: unknown;
    EventSource: typeof EventSource;
  }>({
    // from: es,
    url: () => server.url,
    signal: reqAbortCtrl.signal,
    init: () => ({}),
    deserialize: SuperJSON.deserialize,
    EventSource: globalThis.EventSource,
  });

  const emitterRun = run(async () => {
    while (!reqAbortCtrl.signal.aborted) {
      await sleep(10);
      // yield 2 events at a time to test if the client will get both without reconnecting in between
      ee.emit('next');
      ee.emit('next');
    }
  });

  function range(start: number, end: number) {
    return Array.from({ length: end - start }, (_, i) => i + start);
  }

  const ITERATIONS = 3;
  const values: number[] = [];
  for await (const value of iterable) {
    if (value.type === 'serialized-error') {
      throw value.error;
    }
    if (value.type === 'data') {
      values.push(value.data.data);
      if (values.length === ITERATIONS) {
        break;
      }
    }
  }

  // Little bit of non-determinism if the producerAbortCtrl.signal has fired
  // already...
  // But in no case should it be more than 1 (which would be the case if
  // producerAbortCtrl would not be triggered properly)
  expect(ee.listenerCount('next')).toBeLessThanOrEqual(1);

  reqAbortCtrl.abort();
  expect(ee.listenerCount('next')).toBe(0);

  // make sure for this to have terminated (without errors)
  await emitterRun;

  expect(values).toEqual(range(1, ITERATIONS + 1));

  expect(requests).toHaveLength(2);
  expect(requests).toMatchInlineSnapshot(`
    Array [
      Object {
        "lastEventId": null,
        "written": Array [
          "event: connected
    ",
          "data: {}
    ",
          "

    ",
          "data: {"json":1}
    ",
          "id: 1
    ",
          "

    ",
          "data: {"json":2}
    ",
          "id: 2
    ",
          "

    ",
        ],
      },
      Object {
        "lastEventId": "2",
        "written": Array [
          "event: connected
    ",
          "data: {}
    ",
          "

    ",
          "data: {"json":3}
    ",
          "id: 3
    ",
          "

    ",
          "data: {"json":4}
    ",
          "id: 4
    ",
          "

    ",
        ],
      },
    ]
  `);
});

test('sse()', () => {
  const event = sse({
    id: String(1),
    data: { json: 1 },
  });
  expect(isTrackedEnvelope(event)).toBe(true);

  // no properties
  sse({
    id: String(1),
    data: { json: 1 },
    // @ts-expect-error extras is not allowed
    extras: {},
  });
});
