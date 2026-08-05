import { validateHarnessEvent, validateTaskEventsRequest } from "../../contracts/src/index.mjs";

export function encodeTaskEventSse(event) {
  validateHarnessEvent(event);
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function encodeSseHeartbeat(comment = "heartbeat") {
  const safe = String(comment).replace(/\r|\n/g, " ").slice(0, 256);
  return `: ${safe}\n\n`;
}

export async function* streamTaskEvents(service, input, options = {}) {
  if (!service || typeof service.events !== "function") throw new TypeError("service must have events method");
  const req = { afterSequence: -1, limit: 100, ...input };
  validateTaskEventsRequest(req);
  const signal = options.signal;
  const heartbeatMs = options.heartbeatMs;
  let after = req.afterSequence;
  let lastEventTime = Date.now();

  while (true) {
    if (signal?.aborted) return;
    try {
      const result = await service.events({ taskId: req.taskId, afterSequence: after, limit: req.limit, waitMs: 500 }, { signal });
      if (result.events.length > 0) {
        for (const ev of result.events) {
          yield encodeTaskEventSse(ev);
          after = ev.sequence;
          lastEventTime = Date.now();
        }
      }
      if (!result.hasMore && heartbeatMs && heartbeatMs > 0 && Date.now() - lastEventTime >= heartbeatMs) {
        yield encodeSseHeartbeat("heartbeat");
        lastEventTime = Date.now();
      }
    } catch (e) {
      if (e.name === "AbortError") return;
      throw e;
    }
  }
}
