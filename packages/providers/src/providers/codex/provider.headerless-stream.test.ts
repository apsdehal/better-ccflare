import { describe, expect, it } from "bun:test";
import { CodexProvider } from "./provider";

const encoder = new TextEncoder();
const frame = (event: string, data: unknown) =>
	encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const created = () =>
	frame("response.created", {
		response: { id: "headerless-test", model: "gpt-6.1-sol" },
	});
const completed = () =>
	frame("response.completed", {
		response: {
			model: "gpt-6.1-sol",
			usage: { input_tokens: 2, output_tokens: 1 },
		},
	});
function upstream() {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
	});
	return { body, controller };
}
function readerFor(response: Response) {
	const body = response.body;
	if (!body) throw new Error("Expected response body");
	return body.getReader();
}
async function within<T>(pending: Promise<T>) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			pending,
			new Promise<"deadline">((resolve) => {
				timer = setTimeout(() => resolve("deadline"), 100);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("Codex headerless incremental streaming", () => {
	for (const contentType of [null, "application/json", "text/plain"]) {
		it(`returns SSE frames before upstream EOF with content-type ${contentType}`, async () => {
			const source = upstream();
			const headers = new Headers();
			if (contentType) headers.set("content-type", contentType);
			source.controller.enqueue(created());
			const provider = new CodexProvider({ streamHeartbeatIntervalMs: 20 });
			const pending = provider.processResponse(
				new Response(source.body, { headers }),
				null,
			);
			const response = await within(pending);
			let first: unknown = "deadline";
			let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
			if (response !== "deadline") {
				reader = readerFor(response);
				const result = await within(reader.read());
				if (result !== "deadline")
					first = new TextDecoder().decode(result.value);
			}
			source.controller.enqueue(completed());
			source.controller.close();
			if (reader) {
				while (!(await reader.read()).done) {}
				reader.releaseLock();
			} else await (await pending).text();
			expect(response).not.toBe("deadline");
			expect(first).toContain("event: message_start");
		});
	}

	it("recognizes a split SSE prefix without waiting for the completed body", async () => {
		const source = upstream();
		source.controller.enqueue(encoder.encode(" \nev"));
		const pending = new CodexProvider().processResponse(
			new Response(source.body),
			null,
		);
		source.controller.enqueue(
			encoder.encode(new TextDecoder().decode(created()).slice(2)),
		);
		const response = await within(pending);
		source.controller.enqueue(completed());
		source.controller.close();
		const body = await (await pending).text();
		expect(response).not.toBe("deadline");
		expect(body).toContain("event: message_start");
	});

	it("forwards headerless JSON bytes before EOF without reclassifying them as SSE", async () => {
		const source = upstream();
		source.controller.enqueue(encoder.encode('{"ok":'));
		const pending = new CodexProvider().processResponse(
			new Response(source.body),
			null,
		);
		const response = await within(pending);
		let first = "deadline";
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		if (response !== "deadline") {
			reader = readerFor(response);
			const value = await within(reader.read());
			if (value !== "deadline") first = new TextDecoder().decode(value.value);
		}
		source.controller.enqueue(encoder.encode("true}"));
		source.controller.close();
		if (reader) {
			while (!(await reader.read()).done) {}
			reader.releaseLock();
		} else await (await pending).text();
		expect(first).toBe('{"ok":');
	});

	it("preserves native Responses SSE headers and events without EOF buffering", async () => {
		const source = upstream();
		source.controller.enqueue(created());
		const pending = new CodexProvider().processResponse(
			new Response(source.body, {
				headers: {
					"x-better-ccflare-native-responses": "true",
					"x-better-ccflare-request-stream": "true",
				},
			}),
			null,
		);
		const response = await within(pending);
		source.controller.enqueue(completed());
		source.controller.close();
		const final = await pending;
		const body = await final.text();
		expect(response).not.toBe("deadline");
		expect(final.headers.get("content-type")).toContain("text/event-stream");
		expect(body).toContain("event: response.created");
		expect(body).not.toContain("event: message_start");
	});
	it("cancelling a probed headerless response aborts the underlying fetch owner", async () => {
		const source = upstream();
		const abort = new AbortController();
		abort.signal.addEventListener(
			"abort",
			() => source.controller.error(new Error("fetch aborted")),
			{ once: true },
		);
		source.controller.enqueue(encoder.encode('{"ok":'));
		const response = await new CodexProvider({
			streamDrainDeadlineMs: 10,
		}).processResponse(new Response(source.body), null, undefined, abort);
		const reader = readerFor(response);
		await reader.read();
		await reader.cancel("client disconnected");
		await Bun.sleep(20);
		expect(abort.signal.aborted).toBeTrue();
		expect(source.body.locked).toBeFalse();
	});

	it("forwards a midstream read failure after a headerless prefix", async () => {
		const source = upstream();
		source.controller.enqueue(encoder.encode('{"ok":'));
		const response = await new CodexProvider().processResponse(
			new Response(source.body),
			null,
		);
		const reader = readerFor(response);
		await reader.read();
		source.controller.error(new Error("fixture connection reset"));
		await expect(reader.read()).rejects.toThrow("fixture connection reset");
	});
	for (const prefix of [null, "ev"]) {
		it(`bounds a silent or incomplete first prefix (${prefix}) before CLI idle expiry`, async () => {
			const source = upstream();
			if (prefix) source.controller.enqueue(encoder.encode(prefix));
			const abort = new AbortController();
			abort.signal.addEventListener(
				"abort",
				() => source.controller.error(new Error("aborted fetch")),
				{ once: true },
			);
			const started = performance.now();
			const pending = new CodexProvider({
				streamFormatProbeTimeoutMs: 20,
				streamDrainDeadlineMs: 10,
			}).processResponse(new Response(source.body), null, undefined, abort);
			await expect(pending).rejects.toThrow("format probe timed out");
			expect(performance.now() - started).toBeLessThan(200);
			expect(abort.signal.aborted).toBeTrue();
			await Bun.sleep(5);
			expect(source.body.locked).toBeFalse();
		});
	}

	it("retains declared custom-tool Responses protocol before the tool event arrives", async () => {
		const source = upstream();
		source.controller.enqueue(created());
		const pending = new CodexProvider().processResponse(
			new Response(source.body, {
				headers: {
					"x-better-ccflare-codex-custom-tools": "true",
					"x-better-ccflare-request-stream": "true",
				},
			}),
			null,
		);
		const response = await within(pending);
		source.controller.enqueue(
			frame("response.output_item.added", {
				item: {
					type: "custom_tool_call",
					call_id: "fixture",
					name: "custom",
					input: "{}",
				},
			}),
		);
		source.controller.enqueue(completed());
		source.controller.close();
		const final = await pending;
		const body = await final.text();
		expect(response).not.toBe("deadline");
		expect(body).toContain("custom_tool_call");
		expect(body).not.toContain("event: message_start");
	});
});
