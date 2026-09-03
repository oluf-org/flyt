// The trace read model (phase 1, first slice of Trace).
//
// A pure function from a session event list to the shape a surface renders:
// turns holding steps, each step holding its prompt assembly, its model
// request, its tool calls and its permission decisions. Route records attach
// to the request they describe.
//
// Deliberately small — no React, no kernel import, no file reads. The
// rendering slice that follows only has to render what this produces.
//
// **Live-safe.** A session log is still being written while it is watched, so
// the fold has to survive the tail being open: the last turn has no turn/end,
// the last step no step/end, one request no response, one tool call no result.
// None of that is an edge case — it is what every live run looks like.
// Unfinished parts stay in the model marked unfinished, never dropped.
//
// **Incremental.** Events arrive in `seq` order and the model is built forward,
// so a surface can feed it a cursor's worth of new events rather than re-reading
// the log. `feed` may be called with more events at any time and keeps the open
// turn, step, request and tool call that were already there.
//
// **Lossless by default.** An event type nobody has taught the fold about is
// kept on `trace.others`, not discarded. A plugin's events are still that run's
// record.

const TURN_START = 'turn.start';
const TURN_END = 'turn.end';
const STEP_START = 'step.start';
const STEP_END = 'step.end';
const STEP_PROMPT = 'step.prompt';
const LLM_REQUEST = 'llm.request';
const LLM_ATTEMPT = 'llm.attempt';
const LLM_STREAM = 'llm.stream';
const LLM_RESPONSE = 'llm.response';
const TOOL_INPUT_START = 'tool.input.start';
const TOOL_INPUT_DELTA = 'tool.input.delta';
const TOOL_INPUT_END = 'tool.input.end';
const TOOL_CALL = 'tool.call';
const TOOL_RESULT = 'tool.result';
const PERMISSION_DECISION = 'permission.decision';
/**
 * The event types this fold understands, as data.
 *
 * Exported so a test can hold it against the kernel's `SESSION_EVENTS` and
 * fail when the two drift. They drifted once already: the first version of
 * this file matched `turn/start` and `step/start`, borrowing the SLASH names
 * from the kernel's cordis events, which are dispatched in a process and are
 * not what a session log contains. Same run, two spellings, and a fold that
 * silently matched nothing at all.
 */
export const FOLDED_EVENTS = [
  TURN_START, TURN_END, STEP_START, STEP_END, STEP_PROMPT,
  LLM_REQUEST, LLM_ATTEMPT, LLM_STREAM,
  TOOL_INPUT_START, TOOL_INPUT_DELTA, TOOL_INPUT_END,
  LLM_RESPONSE, TOOL_CALL, TOOL_RESULT, PERMISSION_DECISION
];

function asRecord(value) {
  return value && typeof value === 'object' ? value : {};
}

function asOther(event) {
  return {
    seq: typeof event?.seq === 'number' ? event.seq : null,
    at: event?.at ?? null,
    type: event?.type ?? '',
    data: event?.data ?? null,
  };
}

/** The most recent turn that has not ended, or null. */
function openTurn(trace) {
  for (let i = trace.turns.length - 1; i >= 0; i--) {
    if (!trace.turns[i].finished) return trace.turns[i];
  }
  return null;
}

/** The most recent step that has not ended, inside the open turn. */
function openStep(trace) {
  const turn = openTurn(trace);
  if (!turn) return null;
  for (let i = turn.steps.length - 1; i >= 0; i--) {
    if (!turn.steps[i].finished) return turn.steps[i];
  }
  return null;
}

/** Find a tool call by id, newest step first so a live tail resolves first. */
function findToolCall(trace, callId) {
  if (callId === null || callId === undefined) return null;
  const want = String(callId);
  for (let t = trace.turns.length - 1; t >= 0; t--) {
    const steps = trace.turns[t].steps;
    for (let s = steps.length - 1; s >= 0; s--) {
      const calls = steps[s].toolCalls;
      for (let c = calls.length - 1; c >= 0; c--) {
        if (String(calls[c].callId) === want) return calls[c];
      }
    }
  }
  return null;
}

/** Find one streamed tool input by its request-local durable identity. */
function findToolInput(trace, inputId) {
  if (inputId === null || inputId === undefined) return null;
  const want = String(inputId);
  for (let t = trace.turns.length - 1; t >= 0; t--) {
    const steps = trace.turns[t].steps;
    for (let s = steps.length - 1; s >= 0; s--) {
      const inputs = steps[s].toolInputs;
      for (let i = inputs.length - 1; i >= 0; i--) {
        if (String(inputs[i].inputId) === want) return inputs[i];
      }
    }
  }
  return null;
}

/** Find a model request by call id, newest first. */
function findRequest(trace, callId) {
  const want = callId == null ? null : String(callId);
  for (let t = trace.turns.length - 1; t >= 0; t--) {
    for (let s = trace.turns[t].steps.length - 1; s >= 0; s--) {
      const request = trace.turns[t].steps[s].request;
      if (request && (want === null || String(request.callId) === want)) return request;
    }
  }
  return null;
}

/** A fresh, empty trace, ready to be fed. */
export function emptyTrace() {
  return { turns: [], others: [] };
}

/**
 * Fold `events` (in seq order) into `trace`, returning it.
 *
 * May be called repeatedly: it keeps whatever of the run the previous call left
 * open — the live tail — and continues from there. This is what lets a surface
 * feed a cursor's worth of new events instead of re-reading the log.
 */
export function feed(trace, events) {
  for (const event of events ?? []) {
    const type = typeof event?.type === 'string' ? event.type : '';
    if (!type) {
      trace.others.push(asOther(event));
      continue;
    }
    const data = asRecord(event.data);

    switch (type) {
      case TURN_START: {
        trace.turns.push({
          id: typeof data.turn === 'number' ? data.turn : trace.turns.length + 1,
          runId: data.runId ?? null,
          startedAt: event.at ?? null,
          startedSeq: typeof event.seq === 'number' ? event.seq : null,
          endedAt: null,
          endedSeq: null,
          finished: false,
          steps: [],
        });
        break;
      }

      case TURN_END: {
        const turn = openTurn(trace);
        if (turn) {
          turn.finished = true;
          turn.endedAt = event.at ?? turn.endedAt;
          turn.endedSeq = typeof event.seq === 'number' ? event.seq : turn.endedSeq;
        }
        break;
      }

      case STEP_START: {
        let turn = openTurn(trace);
        if (!turn) {
          turn = {
            id: trace.turns.length + 1,
            runId: data.runId ?? null,
            startedAt: event.at ?? null,
            startedSeq: typeof event.seq === 'number' ? event.seq : null,
            endedAt: null,
            endedSeq: null,
            finished: false,
            steps: [],
          };
          trace.turns.push(turn);
        }
        const stepNumber = typeof data.step === 'number' ? data.step : turn.steps.length + 1;
        turn.steps.push({
          id: `${data.runId ?? ''}:${data.blockId ?? ''}:${stepNumber}`,
          runId: data.runId ?? null,
          blockId: data.blockId ?? null,
          step: stepNumber,
          startedAt: event.at ?? null,
          startedSeq: typeof event.seq === 'number' ? event.seq : null,
          endedAt: null,
          endedSeq: null,
          finished: false,
          prompt: null,
          promptSeq: null,
          request: null,
          toolInputs: [],
          toolCalls: [],
          decisions: [],
        });
        break;
      }

      case STEP_END: {
        const step = openStep(trace);
        if (!step) break;
        step.finished = true;
        step.endedAt = event.at ?? step.endedAt;
        step.endedSeq = typeof event.seq === 'number' ? event.seq : step.endedSeq;
        const settled = asRecord(data.settled);
        if (step.request && settled) {
          if (settled.finishReason != null && step.request.finishReason == null) {
            step.request.finishReason = settled.finishReason;
          }
          if (settled.usage != null && step.request.usage == null) step.request.usage = settled.usage;
          if (settled.route != null && step.request.route == null) step.request.route = settled.route;
        }
        break;
      }

      case STEP_PROMPT: {
        const step = openStep(trace) ?? openTurn(trace)?.steps.at(-1) ?? null;
        if (step) {
          step.prompt = data.content ?? data.prompt ?? null;
          step.promptSeq = typeof event.seq === 'number' ? event.seq : step.promptSeq;
        }
        break;
      }

      case LLM_REQUEST: {
        const step = openStep(trace);
        if (!step) break;
        step.request = {
          callId: data.callId ?? null,
          provider: data.provider ?? null,
          model: data.model ?? null,
          configuredModel: data.configuredModel ?? null,
          maxTokens: Number.isFinite(data.maxTokens) ? data.maxTokens : null,
          prompt: data.prompt ?? null,
          requestedAt: event.at ?? null,
          requestedSeq: typeof event.seq === 'number' ? event.seq : null,
          respondedAt: null,
          respondedSeq: null,
          settled: false,
          finishReason: null,
          usage: null,
          route: null,
          content: null,
          contentSeq: null,
          reasoning: null,
          reasoningSeq: null,
          firstTokenAt: null,
          lastTokenAt: null,
          attempts: [],
        };
        break;
      }

      case LLM_ATTEMPT: {
        const request = findRequest(trace, data.callId) ?? openStep(trace)?.request ?? null;
        if (!request) break;
        const index = typeof data.index === 'number' ? data.index : request.attempts.length;
        let attempt = request.attempts.find(item => item.index === index);
        if (!attempt) {
          attempt = {
            index, model: data.model ?? request.model ?? null, provider: data.provider ?? null,
            resolvedModel: data.resolvedModel ?? null, status: 'started', error: null,
            startedAt: event.at ?? null, endedAt: null,
          };
          request.attempts.push(attempt);
        }
        if (data.model != null) attempt.model = data.model;
        if (data.provider != null) attempt.provider = data.provider;
        if (data.resolvedModel != null) attempt.resolvedModel = data.resolvedModel;
        if (data.status != null) attempt.status = data.status;
        if (data.error != null) attempt.error = String(data.error);
        if (data.status === 'started') attempt.startedAt = event.at ?? attempt.startedAt;
        if (data.status === 'failed' || data.status === 'succeeded') attempt.endedAt = event.at ?? attempt.endedAt;
        break;
      }

      case LLM_RESPONSE: {
        const step = openStep(trace);
        const request = step?.request ?? null;
        if (request) {
          request.settled = true;
          request.respondedAt = event.at ?? request.respondedAt;
          request.respondedSeq = typeof event.seq === 'number' ? event.seq : request.respondedSeq;
          if (data.finishReason != null) request.finishReason = data.finishReason;
          if (data.usage != null) request.usage = data.usage;
          if (data.route != null) request.route = data.route;
          if (data.content != null) {
            request.content = data.content;
            if (String(data.content).length) request.contentSeq ??= request.respondedSeq;
          }
          if (data.reasoning != null) {
            request.reasoning = data.reasoning;
            if (String(data.reasoning).length) request.reasoningSeq ??= request.respondedSeq;
          }
          // Non-streaming adapters deliver their first and last visible token
          // with the response envelope. Keep the timestamp on the request so
          // Work can use the same canonical trace for its live-idle clock.
          if ((String(data.content ?? '').length > 0 || String(data.reasoning ?? '').length > 0) && event.at != null) {
            request.firstTokenAt ??= event.at;
            request.lastTokenAt = event.at;
          }
        }
        // The response may carry the tool calls the model asked for; they are
        // part of this step's record too, attached by id.
        const calls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
        for (let callIndex = 0; callIndex < calls.length; callIndex++) {
          const call = calls[callIndex];
          const record = asRecord(call);
          const id = record.id ?? null;
          if (id == null) continue;
          // The settled response is authoritative. Retain interrupted inputs,
          // but mark the one this response committed so the UI replaces its
          // partial/raw view with the ordinary parsed tool-call record.
          const streamed = [...(step?.toolInputs ?? [])].reverse().find(input =>
            input.committed !== true
            && (String(input.toolCallId ?? '') === String(id)
              || (input.requestCallId === data.callId && input.index === callIndex)));
          if (streamed) streamed.committed = true;
          if (!findToolCall(trace, id)) {
            step?.toolCalls.push({
              callId: String(id),
              name: record.name ?? null,
              args: record.args ?? null,
              calledAt: event.at ?? null,
              calledSeq: typeof event.seq === 'number' ? event.seq : null,
              result: null,
              resultAt: null,
              resultSeq: null,
              hasResult: false,
              error: null,
            });
          }
        }
        break;
      }

      case LLM_STREAM: {
        const request = openStep(trace)?.request ?? null;
        if (!request) break;
        if (data.text != null) {
          request.content = `${request.content ?? ''}${String(data.text)}`;
          if (String(data.text).length) request.contentSeq ??= typeof event.seq === 'number' ? event.seq : null;
        }
        if (data.reasoning != null) {
          request.reasoning = `${request.reasoning ?? ''}${String(data.reasoning)}`;
          if (String(data.reasoning).length) request.reasoningSeq ??= typeof event.seq === 'number' ? event.seq : null;
        }
        if ((String(data.text ?? '').length > 0 || String(data.reasoning ?? '').length > 0) && event.at != null) {
          request.firstTokenAt ??= event.at;
          request.lastTokenAt = event.at;
        }
        break;
      }

      case TOOL_INPUT_START: {
        const step = openStep(trace);
        if (!step || data.inputId == null) break;
        if (findToolInput(trace, data.inputId)) break;
        step.toolInputs.push({
          inputId: String(data.inputId),
          requestCallId: data.requestCallId ?? null,
          index: Number.isInteger(data.index) ? data.index : step.toolInputs.length,
          toolCallId: data.toolCallId ?? null,
          name: data.name ?? null,
          arguments: '',
          complete: false,
          committed: false,
          startedAt: event.at ?? null,
          endedAt: null,
        });
        break;
      }

      case TOOL_INPUT_DELTA: {
        const input = findToolInput(trace, data.inputId);
        if (!input) break;
        if (data.toolCallId != null) input.toolCallId = data.toolCallId;
        if (data.name != null) input.name = data.name;
        input.arguments += String(data.delta ?? '');
        break;
      }

      case TOOL_INPUT_END: {
        const input = findToolInput(trace, data.inputId);
        if (!input) break;
        if (data.toolCallId != null) input.toolCallId = data.toolCallId;
        if (data.name != null) input.name = data.name;
        if (data.arguments != null) input.arguments = String(data.arguments);
        input.complete = true;
        input.endedAt = event.at ?? null;
        break;
      }

      case TOOL_CALL: {
        const step = openStep(trace);
        if (!step) break;
        if (findToolCall(trace, data.callId)) break; // already on the step
        step.toolCalls.push({
          callId: data.callId ?? null,
          name: data.name ?? null,
          args: data.args ?? null,
          calledAt: event.at ?? null,
          calledSeq: typeof event.seq === 'number' ? event.seq : null,
          result: null,
          resultAt: null,
          resultSeq: null,
          hasResult: false,
          error: null,
        });
        break;
      }

      case TOOL_RESULT: {
        const call = findToolCall(trace, data.callId);
        if (call) {
          call.result = data.result ?? data.content ?? null;
          call.error = data.error ?? null;
          call.resultAt = event.at ?? null;
          call.resultSeq = typeof event.seq === 'number' ? event.seq : null;
          call.hasResult = true;
        }
        break;
      }

      case PERMISSION_DECISION: {
        const step = openStep(trace);
        if (!step) break;
        step.decisions.push({
          callId: data.callId ?? null,
          decision: data.decision ?? null,
          reason: data.reason ?? null,
          at: event.at ?? null,
        });
        break;
      }

      default:
        // An event type nobody has taught this fold about is still the run's
        // record. Keep it whole instead of discarding it.
        trace.others.push(asOther(event));
        break;
    }
  }
  return trace;
}

/**
 * Fold a whole log into a trace in one call.
 *
 * Equivalent to feeding an empty trace every event — a surface that streams
 * the log just calls `feed` instead.
 */
export function foldTrace(events) {
  return feed(emptyTrace(), events);
}
