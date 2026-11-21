/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { TIME_CONSTANTS } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	CodexProvider,
	OpenAICompatibleProvider,
} from "@better-ccflare/providers";
import { makeProxyRequest, validateProviderPath } from "../request-handler";

describe("validateProviderPath", () => {
	it("accepts count_tokens for OpenAI-compatible provider", () => {
		expect(() =>
			validateProviderPath(
				new OpenAICompatibleProvider(),
				"/v1/messages/count_tokens",
			),
		).not.toThrow();
	});

	it("accepts count_tokens for Codex provider", () => {
		expect(() =>
			validateProviderPath(new CodexProvider(), "/v1/messages/count_tokens"),
		).not.toThrow();
	});
});

describe("makeProxyRequest: upstream header observations", () => {
	const url = "https://private.example/v1/messages?token=private";

	afterEach(() => {
		mock.restore();
	});

	function watchTimers() {
		const timers = spyOn(globalThis, "setTimeout");
		const cleared = spyOn(globalThis, "clearTimeout");
		const readTimer = (delay: number) => {
			const index = timers.mock.calls.findIndex(([, ms]) => ms === delay);
			const fire = timers.mock.calls[index]?.[0];
			const scheduled = timers.mock.results[index];
			if (typeof fire !== "function" || scheduled?.type !== "return")
				throw new Error(`No header timer at ${delay}ms`);
			return { fire, handle: scheduled.value };
		};
		return {
			pending: () => readTimer(30_000),
			timeout: () => readTimer(TIME_CONSTANTS.PROXY_REQUEST_TIMEOUT_MS),
			expectCleared() {
				expect(cleared).toHaveBeenCalledWith(this.pending().handle);
				expect(cleared).toHaveBeenCalledWith(this.timeout().handle);
			},
		};
	}

	function holdFetch() {
		const reply = Promise.withResolvers<Response>();
		const seen = Promise.withResolvers<AbortSignal>();
		spyOn(globalThis, "fetch").mockImplementation((input, init) => {
			const signal = input instanceof Request ? input.signal : init?.signal;
			if (!signal) throw new Error("Fetch must carry the proxy abort signal");
			signal.addEventListener("abort", () => reply.reject(signal.reason), {
				once: true,
			});
			seen.resolve(signal);
			return reply.promise;
		});
		return { reply, seen: seen.promise };
	}

	it("reports a slow fetch without aborting it and clears both timers at headers", async () => {
		const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
		const info = spyOn(Logger.prototype, "info").mockImplementation(() => {});
		const timers = watchTimers();
		const fetch = holdFetch();
		const request = makeProxyRequest(new Request(url));
		const signal = await fetch.seen;

		expect(timers.pending().handle.hasRef()).toBe(false);
		expect(warn).not.toHaveBeenCalled();
		timers.pending().fire();
		expect(warn.mock.calls).toEqual([
			[
				"upstream_headers_pending",
				{ attemptId: expect.any(String), elapsedMs: expect.any(Number) },
			],
		]);
		expect(signal.aborted).toBe(false);

		const response = new Response(new ReadableStream());
		fetch.reply.resolve(response);
		expect(await request).toBe(response);
		timers.expectCleared();
		expect(info.mock.calls).toEqual([
			[
				"upstream_headers_received",
				{
					attemptId: warn.mock.calls[0]?.[1].attemptId,
					elapsedMs: expect.any(Number),
				},
			],
		]);
		await response.body?.cancel();
	});

	it.each([
		"header_timeout",
		"client_cancelled",
	] as const)("reports %s when that abort wins, preserving the fetch rejection", async (outcome) => {
		const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
		const info = spyOn(Logger.prototype, "info").mockImplementation(() => {});
		const timers = watchTimers();
		const fetch = holdFetch();
		const client = new AbortController();
		const clientReason = new Error("private client abort reason");
		const request = makeProxyRequest(
			url,
			"POST",
			new Headers({ Authorization: "Bearer private" }),
			undefined,
			false,
			client.signal,
		);
		const signal = await fetch.seen;

		if (outcome === "header_timeout") {
			timers.timeout().fire();
			expect(signal.aborted).toBe(true);
			expect(client.signal.aborted).toBe(false);
			client.abort(clientReason);
		} else {
			client.abort(clientReason);
			expect(signal.reason).toBe(clientReason);
			timers.timeout().fire();
		}

		await expect(request).rejects.toBe(signal.reason);
		timers.expectCleared();
		const [recorded, other] =
			outcome === "header_timeout" ? [warn, info] : [info, warn];
		expect(recorded.mock.calls).toEqual([
			[
				"upstream_headers_failed",
				{
					attemptId: expect.any(String),
					elapsedMs: expect.any(Number),
					outcome,
				},
			],
		]);
		expect(other).not.toHaveBeenCalled();
	});

	it("classifies a fetch rejection without an aborted signal as a transport error", async () => {
		const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
		const timers = watchTimers();
		const fetch = holdFetch();
		const request = makeProxyRequest(new Request(url));
		const signal = await fetch.seen;
		const error = new DOMException("private upstream error", "AbortError");
		fetch.reply.reject(error);

		await expect(request).rejects.toBe(error);
		expect(signal.aborted).toBe(false);
		timers.expectCleared();
		expect(warn.mock.calls).toEqual([
			[
				"upstream_headers_failed",
				{
					attemptId: expect.any(String),
					elapsedMs: expect.any(Number),
					outcome: "transport_error",
				},
			],
		]);
	});
});
