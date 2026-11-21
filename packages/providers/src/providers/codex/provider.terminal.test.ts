import { expect, it } from "bun:test";
import { CodexProvider } from "./provider";

function event(type: string, data: Record<string, unknown>) {
	return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

const partial =
	event("response.created", { response: { id: "resp_partial" } }) +
	event("response.output_text.delta", { delta: "Partial answer" });

async function translate(
	body: string | ReadableStream<Uint8Array>,
	stream = true,
) {
	return new CodexProvider().processResponse(
		new Response(body, {
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-stream": String(stream),
			},
		}),
		null,
	);
}

it.each([
	["clean EOF", partial],
	["sentinel without a response terminal", `${partial}data: [DONE]\n\n`],
	[
		"EOF inside a response terminal",
		`${partial}event: response.completed\ndata: {"response":`,
	],
	[
		"EOF inside tool arguments",
		partial +
			event("response.output_item.added", {
				output_index: 0,
				item: { type: "function_call", call_id: "call_1", name: "Read" },
			}) +
			event("response.function_call_arguments.delta", {
				output_index: 0,
				delta: '{"file',
			}),
	],
])("reports %s as truncated without fabricating a normal stop", async (_name, body) => {
	const response = await translate(body);
	const result = await response.text();
	expect(result).toContain("Partial answer");
	expect(result).toContain("event: error");
	expect(result).toContain('"code":"codex_stream_truncated"');
	expect(result).not.toContain("event: message_delta");
	expect(result).not.toContain("event: message_stop");
});

it("returns a 502 for truncated non-streaming Messages", async () => {
	const response = await translate(partial, false);
	expect(response.status).toBe(502);
	expect(await response.json()).toMatchObject({
		type: "error",
		error: { type: "api_error", code: "codex_stream_truncated" },
	});
});

it("preserves explicit incomplete semantics in non-streaming Messages", async () => {
	const response = await translate(
		partial +
			event("response.incomplete", {
				response: {
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
				},
			}),
		false,
	);
	expect(await response.json()).toMatchObject({
		type: "message",
		stop_reason: "max_tokens",
	});
});

it("accepts a response terminal carried in repeated data fields", async () => {
	const response = await translate(
		partial +
			'data: {"type":"response.completed",\ndata: "response":{"status":"completed","usage":{"output_tokens":5}}}\n\n',
	);
	const result = await response.text();
	expect(result).toContain("event: message_stop");
	expect(result).toContain('"output_tokens":5');
	expect(result).not.toContain("event: error");
});
