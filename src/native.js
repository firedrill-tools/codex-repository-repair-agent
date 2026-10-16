import { Codex } from "@openai/codex-sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hash } from "./scope.js";
import { RelayOwner } from "./relay-owner.js";
import { untilAbort, within } from "./waits.js";
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const counters = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];
const measurements = (usage) =>
  Object.fromEntries(
    counters.map((key) => {
      const value = usage?.[key];
      return [
        key,
        {
          source: "SDK event",
          state:
            value === undefined
              ? "unknown"
              : Number.isSafeInteger(value) && value >= 0
                ? "observed"
                : "invalid",
          value: Number.isSafeInteger(value) && value >= 0 ? value : null,
        },
      ];
    }),
  );
const label = (value) =>
  typeof value === "string" && Boolean(value.trim()) && value.length <= 2000;
export async function runNative(workspace, prompt, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 180000)
    throw new Error("timeoutMs must be10–180000");
  const controller = new AbortController(),
    abort = () =>
      controller.abort(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new Error("Codex interrupted"),
      );
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new Error("Codex turn deadline exceeded")),
    timeoutMs,
  );
  const observation = {
    sdk: { package: "@openai/codex-sdk", declared_version: "0.162.1" },
    execution_kind: options.sdk
      ? "caller_injected_sdk"
      : options.sdkFactory
        ? "caller_sdk_factory"
        : "owned_native_sdk",
    process_ownership: options.sdk ? "caller SDK" : "preflight",
    requested_model: options.model ?? null,
    provider_base_url: null,
    diagnostics: [],
    actual_model: { status: "unknown", id: null },
    started_at: new Date().toISOString(),
    completed: false,
    threadId: null,
    finalResponse: "",
    usage: null,
    sdk_usage_measurements: measurements(null),
    usage_source: "SDK event; cache_write_input_tokens may be SDK-defaulted0",
    provider_usage: { status: "unknown", totals: null },
    cost_usd: null,
    prompt_sha256: hash(prompt),
    events: [],
    cleanup_requested: false,
    limits: {
      native_ms: timeoutMs,
      sdk_event_bytes: 1048576,
      sdk_events: 2000,
      cli_stdout_bytes: 1048576,
      cli_stderr_bytes: 65536,
      prompt_bytes: 16384,
      process_term_grace_ms: 200,
      process_cleanup_ms: 5000,
      sdk_cleanup_wait_ms: 5500,
    },
  };
  let iterator,
    thread,
    runtimeHome,
    finished = false,
    threadStarted = false,
    turnStarted = false,
    exhausted = false,
    iteratorFailed = false,
    eventBytes = 0,
    relayOwner = null,
    failure = null;
  let finalized = false;
  const sdkErrors = [];
  const asyncPending = new Set();
  const track = (value) => {
    const promise = Promise.resolve(value);
    asyncPending.add(promise);
    void promise.then(
      () => asyncPending.delete(promise),
      (error) => {
        asyncPending.delete(promise);
        if (!finalized)
          sdkErrors.push({
            name: error?.name ?? "Error",
            message: error?.message ?? String(error),
            code: error?.code ?? null,
            cause:
              error?.cause instanceof Error
                ? { name: error.cause.name, message: error.cause.message }
                : null,
          });
      },
    );
    return promise;
  };
  const relayAbort = () => {
    if (relayOwner)
      void relayOwner
        .stop(controller.signal.reason?.message ?? "cancelled")
        .catch((error) => {
          if (!finalized)
            observation.relay_stop_error = {
              name: error.name,
              message: error.message,
            };
        });
  };
  controller.signal.addEventListener("abort", relayAbort);
  const items = new Map(),
    pending = new Set();
  try {
    controller.signal.throwIfAborted();
    if (
      options.model !== undefined &&
      (!label(options.model) || /\s/.test(options.model))
    )
      throw new Error("Enabled model name required");
    if (options.baseUrl !== undefined) {
      const url = new URL(options.baseUrl);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
        )
      )
        throw new Error(
          "Provider base URL requires HTTPS or loopback HTTP without credentials/query/fragment",
        );
      observation.provider_base_url = url.href;
    }
    let sdk = options.sdk;
    if (!sdk) {
      const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
      if (typeof apiKey !== "string" || !apiKey.trim())
        throw new Error(
          "OPENAI_API_KEY required for an isolated Codex runtime; no account-config fallback",
        );
      runtimeHome = await fs.mkdtemp(
        path.join(os.tmpdir(), "firedrill-repair-runtime-"),
      );
      observation.runtime_home = runtimeHome;
      observation.runtime_config =
        "private temporary Codex home and explicit provider key";
      const env = { PATH: process.env.PATH ?? "", CODEX_HOME: runtimeHome };
      for (const key of ["SystemRoot", "WINDIR"])
        if (process.env[key]) env[key] = process.env[key];
      if (options.sdkFactory) {
        sdk = options.sdkFactory({
          apiKey,
          env,
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        });
        observation.process_ownership = "caller SDK factory";
      } else {
        relayOwner = await RelayOwner.create({
          cwd: workspace,
          cliPath: options.cliPath,
          timeoutMs,
          startupDelayMs: options.startupDelayMs ?? 0,
          signal: controller.signal,
        });
        observation.process_ownership = "owned public executable relay";
        observation.cli = relayOwner.read();
        sdk = new Codex({
          apiKey,
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
          env: {
            ...env,
            FIREDRILL_RELAY_CONFIG: path.join(
              relayOwner.directory,
              "config.json",
            ),
          },
          codexPathOverride: relayOwner.launcher,
        });
      }
    } else
      observation.runtime_config = "caller-owned SDK configuration/resources";
    thread = sdk.startThread({
      ...(options.model ? { model: options.model } : {}),
      workingDirectory: workspace,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
    });
    await options.onObservation?.(observation);
    controller.signal.throwIfAborted();
    const stream = await untilAbort(
      track(
        thread.runStreamed(prompt, {
          signal: controller.signal,
        }),
      ),
      controller.signal,
    );
    iterator = stream.events;
    for (;;) {
      controller.signal.throwIfAborted();
      if (relayOwner) relayOwner.dispatched = true;
      let next;
      try {
        next = await untilAbort(track(iterator.next()), controller.signal);
      } catch (error) {
        iteratorFailed = true;
        throw error;
      }
      if (next.done) {
        exhausted = true;
        break;
      }
      const event = next.value;
      try {
        controller.signal.throwIfAborted();
        const encoded = JSON.stringify(event, (_key, value) => {
          if (typeof value === "number" && !Number.isFinite(value))
            throw new Error("Nonfinite SDK event value");
          return value;
        });
        if (typeof encoded !== "string") throw new Error("Invalid SDK event");
        eventBytes += Buffer.byteLength(encoded);
        if (eventBytes > 1048576 || observation.events.length >= 2000)
          throw new Error("Codex event evidence limit exceeded");
        if (relayOwner) {
          observation.cli = relayOwner.read();
          const raw = observation.cli.records[observation.events.length];
          if (!raw || raw.parse_error || observation.cli.decode_error)
            throw new Error("Original CLI event is invalid or missing");
          const expected = structuredClone(raw.body);
          if (expected?.type === "turn.completed" && object(expected.usage))
            expected.usage.cache_write_input_tokens ??= 0;
          if (JSON.stringify(expected) !== encoded)
            throw new Error("SDK event differs from its original CLI record");
        }
        observation.events.push(structuredClone(event));
        observation.threadId = thread.id ?? null;
        if (event?.type === "turn.completed") {
          observation.usage = structuredClone(event.usage ?? null);
          observation.sdk_usage_measurements = measurements(event.usage);
        }
        await options.onObservation?.(observation);
        if (!object(event) || finished)
          throw new Error("Unsupported event or event after completed turn");
        if (event.type === "thread.started") {
          if (threadStarted || !label(event.thread_id))
            throw new Error("Invalid/repeated thread start");
          threadStarted = true;
        } else if (event.type === "turn.started") {
          if (!threadStarted || turnStarted)
            throw new Error("Invalid/repeated turn start");
          turnStarted = true;
        } else if (
          ["item.started", "item.updated", "item.completed"].includes(
            event.type,
          )
        ) {
          if (
            !threadStarted ||
            !object(event.item) ||
            !label(event.item.id) ||
            (!turnStarted && event.item.type !== "error")
          )
            throw new Error("Invalid item before active turn");
          const item = event.item;
          if (["command_execution", "file_change"].includes(item.type))
            observation.finalResponse = "";
          if (["mcp_tool_call", "web_search"].includes(item.type)) {
            observation.external_effect_status = "unknown";
            throw new Error(
              "Unexpected external tool observed; inspect actual effects",
            );
          }
          if (
            ![
              "agent_message",
              "reasoning",
              "command_execution",
              "file_change",
              "todo_list",
              "error",
            ].includes(item.type)
          )
            throw new Error("Unknown SDK item type");
          const previous = items.get(item.id);
          if (previous?.completed || (previous && previous.type !== item.type))
            throw new Error("Replayed or mismatched SDK item");
          if (event.type === "item.started" && previous)
            throw new Error("Repeated started item");
          if (item.type === "agent_message" || item.type === "reasoning")
            if (typeof item.text !== "string")
              throw new Error("Invalid SDK message text");
          if (item.type === "error") {
            if (
              event.type !== "item.completed" ||
              typeof item.message !== "string"
            )
              throw new Error("Invalid diagnostic item");
            observation.diagnostics.push({
              source: "SDK error item",
              event_index: observation.events.length - 1,
              message: item.message,
            });
          }
          if (event.type === "item.completed") {
            if (
              ["command_execution", "file_change"].includes(item.type) &&
              !["completed", "failed"].includes(item.status)
            )
              throw new Error("Item is not terminal");
            pending.delete(item.id);
            items.set(item.id, { type: item.type, completed: true });
            if (item.type === "agent_message")
              observation.finalResponse = item.text;
          } else {
            pending.add(item.id);
            items.set(item.id, { type: item.type, completed: false });
          }
        } else if (event.type === "turn.completed") {
          if (!turnStarted || pending.size || !observation.finalResponse.trim())
            throw new Error("Turn lacks final answer or has pending work");
          finished = true;
        } else if (event.type === "error") {
          if (!threadStarted || typeof event.message !== "string")
            throw new Error("Invalid runtime diagnostic");
          observation.diagnostics.push({
            source: "SDK runtime diagnostic",
            event_index: observation.events.length - 1,
            message: event.message,
          });
        } else if (event.type === "turn.failed")
          throw new Error(
            event.error?.message ?? event.message ?? "Codex failed",
          );
        else throw new Error("Unsupported SDK event type");
      } catch (error) {
        controller.abort(error);
        await new Promise((resolve) => setImmediate(resolve));
        throw error;
      }
    }
    controller.signal.throwIfAborted();
    if (!finished) throw new Error("Codex stream ended without turn.completed");
    observation.protocol_completed = true;
  } catch (error) {
    observation.error = {
      name: error.name,
      message: error.message,
      code: error.code ?? null,
    };
    const reason = controller.signal.reason;
    if (controller.signal.aborted && reason instanceof Error)
      observation.abort_reason = { name: reason.name, message: reason.message };
    observation.native_error = observation.error;
    failure =
      controller.signal.aborted && reason instanceof Error && reason !== error
        ? new Error(reason.message, { cause: error })
        : error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (
      iterator &&
      !exhausted &&
      !iteratorFailed &&
      !controller.signal.aborted
    ) {
      controller.abort(new Error("Owned iterator cleanup"));
      await new Promise((resolve) => setImmediate(resolve));
    }
    observation.cleanup_requested = true;
    observation.abort_requested = controller.signal.aborted;
    if (failure && relayOwner)
      try {
        await relayOwner.stop(failure.message);
      } catch (error) {
        observation.relay_stop_error = {
          name: error.name,
          message: error.message,
        };
      }
    if (iterator) {
      const returned = await within(track(iterator.return?.()), 5500);
      observation.iterator_return_settled = returned.settled;
      if (!returned.settled || returned.error)
        failure ??=
          returned.error ?? new Error("SDK iterator cleanup did not settle");
    }
    if (asyncPending.size) {
      const drained = await within(Promise.allSettled([...asyncPending]), 5500);
      if (!drained.settled)
        failure ??= new Error("SDK operations did not drain");
    }
    observation.sdk_operations_drained = asyncPending.size === 0;
    observation.sdk_errors = structuredClone(sdkErrors);
    if (relayOwner) {
      try {
        observation.cli = await relayOwner.finish({ failed: Boolean(failure) });
        if (
          observation.cli.cleanup_error ||
          observation.cli.execution_error ||
          observation.cli.decode_error ||
          observation.cli.records.some((record) => record.parse_error)
        )
          failure ??= new Error(
            observation.cli.cleanup_error ??
              observation.cli.execution_error?.message ??
              observation.cli.decode_error ??
              "Original CLI JSONL is invalid",
          );
        if (observation.cli.stdin.sha256 !== hash(prompt))
          failure ??= new Error(
            "Original CLI prompt differs from prepared intent",
          );
        if (!observation.cli.cleanup_error) {
          await relayOwner.dispose();
          observation.cli.lifecycle = { ...relayOwner.lifecycle };
        }
      } catch (error) {
        failure ??= error;
        observation.relay_cleanup_error = {
          name: error.name,
          message: error.message,
        };
      }
    }
    controller.signal.removeEventListener("abort", relayAbort);
    if (runtimeHome) {
      if (
        (!relayOwner &&
          observation.sdk_operations_drained &&
          observation.iterator_return_settled !== false) ||
        (relayOwner &&
          observation.cli?.lifecycle.group_exit_confirmed === true &&
          observation.cli?.lifecycle.relay_exit_confirmed === true &&
          observation.cli?.lifecycle.descendants_exit_confirmed === true)
      ) {
        await fs.rm(runtimeHome, { recursive: true, force: true });
        observation.runtime_home_removed = true;
      } else observation.runtime_home_removed = false;
    }
    observation.completed = Boolean(
      observation.protocol_completed &&
      !failure &&
      observation.sdk_operations_drained,
    );
    finalized = true;
    observation.finished_at = new Date().toISOString();
    if (failure)
      observation.error = {
        name: failure.name,
        message: failure.message,
        code: failure.code ?? null,
      };
    try {
      await options.onObservation?.(observation);
    } catch (error) {
      failure ??= error;
      observation.completed = false;
      observation.recording_error = {
        name: error.name,
        message: error.message,
      };
    }
  }
  if (failure) {
    failure.observation = observation;
    throw failure;
  }
  return observation;
}
