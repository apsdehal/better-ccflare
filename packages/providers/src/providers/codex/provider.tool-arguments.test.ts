import { expect, it } from "bun:test";
import { CodexProvider } from "./provider";

const desktopStartSession = "mcp__ccd_session__start_session";

const frame = (type: string, data: Record<string, unknown>) =>
	`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

const added = (output_index: number, name = "search") =>
	frame("response.output_item.added", {
		output_index,
		item: { type: "function_call", name, call_id: `call_${output_index}` },
	});

const delta = (output_index: number, chunk: string) =>
	frame("response.function_call_arguments.delta", {
		output_index,
		delta: chunk,
	});

const argumentsDone = (output_index: number, args: unknown) =>
	frame("response.function_call_arguments.done", {
		output_index,
		arguments: args,
	});

const itemDone = (output_index: number, args?: unknown, status?: string) =>
	frame("response.output_item.done", {
		output_index,
		item: {
			type: "function_call",
			call_id: `call_${output_index}`,
			arguments: args,
			status,
		},
	});

async function translate(
	frames: string[],
	stream = true,
	terminal = frame("response.completed", {
		response: { id: "resp_tool_args", status: "completed" },
	}),
) {
	return new CodexProvider().processResponse(
		new Response(frames.join("") + terminal, {
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-stream": String(stream),
			},
		}),
		null,
	);
}

async function eventsOf(frames: string[], terminal?: string) {
	const body = await (await translate(frames, true, terminal)).text();
	return body
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

const suggestedTask = {
	initiation: "own_initiative",
	title: "Check sample formatting",
	context: "fresh",
	prompt: "Inspect the sample file and suggest formatting improvements.",
	background:
		"The sample illustrates document formatting. This follow-up is read-only and should only suggest changes.",
};

it("keeps Desktop session tool properties optional in the Codex request", async () => {
	const parameters = {
		type: "object",
		properties: {
			initiation: {
				type: "string",
				enum: ["user_asked", "own_initiative", "offer"],
			},
			host: { type: "string" },
		},
	};
	const request = new Request("https://example.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-opus-4-8",
			max_tokens: 100,
			messages: [{ role: "user", content: "Inspect the sample." }],
			tools: [
				{
					name: desktopStartSession,
					description: "Propose or start a Desktop session.",
					defer_loading: true,
					input_schema: parameters,
				},
				{ name: "Search", input_schema: { type: "object" } },
			],
		}),
	});
	const transformed = await new CodexProvider().transformRequestBody(
		request,
		undefined,
	);
	const body = await transformed.json();
	expect(body.tool_choice).toBeUndefined();
	expect(body.tools).toEqual([
		{
			type: "function",
			name: desktopStartSession,
			description: "Propose or start a Desktop session.",
			strict: false,
			parameters,
		},
		{ type: "function", name: "Search", parameters: { type: "object" } },
	]);
});

it.each([
	true,
	false,
])("omits empty Desktop session placeholders while preserving the suggestion (stream=%s)", async (stream) => {
	const expected = {
		...suggestedTask,
		target: "local",
		wake_when_done: false,
		name: "sample-formatting",
		use_worktree: true,
		effort: "medium",
		permission_mode: "default",
	};
	const frames = [
		added(0, desktopStartSession),
		itemDone(
			0,
			JSON.stringify({
				...expected,
				proposal_id: "",
				model: "",
				host: "",
				cwd: "",
				environment: "",
				repository: "",
				source_branch: "",
				branch_name: "",
				preset: "",
			}),
		),
	];
	if (stream) {
		const events = await eventsOf(frames);
		expect(events.find((e) => e.type === "content_block_delta")?.delta).toEqual(
			{ type: "input_json_delta", partial_json: JSON.stringify(expected) },
		);
		expect(events.at(-1)?.type).toBe("message_stop");
	} else {
		const response = await translate(frames, false);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.stop_reason).toBe("tool_use");
		expect(body.content).toEqual([
			{
				type: "tool_use",
				id: "call_0",
				name: desktopStartSession,
				input: expected,
			},
		]);
	}
});

it.each([
	{},
	{ target: "ssh", host: "Saved development connection", cwd: "/sample" },
	{
		target: "cloud",
		environment: "Sample environment",
		repository: "demo/repo",
	},
	{ preset: "Sample preset" },
	{ target: "ssh", host: 42 },
])("keeps Desktop routing and validation fields unchanged: %j", async (routing) => {
	const input = { ...suggestedTask, ...routing };
	const response = await translate(
		[added(0, desktopStartSession), itemDone(0, JSON.stringify(input))],
		false,
	);
	expect((await response.json()).content[0].input).toEqual(input);
});

it("only cleans empty routing placeholders on the Desktop session tool", async () => {
	const events = await eventsOf([
		added(0, desktopStartSession),
		itemDone(0, JSON.stringify({ ...suggestedTask, host: "  ", cwd: null })),
		added(1, "search"),
		itemDone(1, '{"host":"","cwd":null}'),
	]);
	expect(
		events.filter((e) => e.type === "content_block_delta").map((e) => e.delta),
	).toEqual([
		{ type: "input_json_delta", partial_json: JSON.stringify(suggestedTask) },
		{ type: "input_json_delta", partial_json: '{"host":"","cwd":null}' },
	]);
});

it("uses final item arguments ahead of the done event and incomplete deltas", async () => {
	const response = await translate(
		[
			added(0, "Read"),
			delta(0, '{"file_path":"part'),
			argumentsDone(0, '{"file_path":"interim.txt"}'),
			itemDone(0, '{"file_path":"final.txt","pages":""}'),
		],
		false,
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		content: [
			{
				type: "tool_use",
				id: "call_0",
				name: "Read",
				input: { file_path: "final.txt" },
			},
		],
		stop_reason: "tool_use",
	});
});

it("uses done arguments and delta fallback independently for parallel tools", async () => {
	const results = await eventsOf([
		added(2),
		added(4),
		delta(4, '{"query":"sec'),
		delta(2, '{"query":"partial'),
		argumentsDone(2, '{"query":"first"}'),
		frame("response.output_item.done", {
			output_index: 3,
			item: { type: "reasoning" },
		}),
		delta(4, 'ond"}'),
		itemDone(4),
		itemDone(2),
	]);
	for (const [index, id, partialJson] of [
		[0, "call_2", '{"query":"first"}'],
		[1, "call_4", '{"query":"second"}'],
	] as const) {
		expect(results.filter((event) => event.index === index)).toEqual([
			{
				type: "content_block_start",
				index,
				content_block: { type: "tool_use", name: "search", id, input: {} },
			},
			{
				type: "content_block_delta",
				index,
				delta: { type: "input_json_delta", partial_json: partialJson },
			},
			{ type: "content_block_stop", index },
		]);
	}
	expect(results.at(-1)?.type).toBe("message_stop");
});

it.each([
	["invalid JSON", [itemDone(0, '{"query":')]],
	["wrong final type", [itemDone(0, null)]],
	["invalid done event", [argumentsDone(0, ""), itemDone(0)]],
	["missing done arguments", [argumentsDone(0, undefined), itemDone(0)]],
])("returns a stream error for %s instead of using stale deltas", async (_, done) => {
	const results = await eventsOf([
		added(0),
		delta(0, '{"query":"stale"}'),
		...done,
	]);
	expect(results.map((event) => event.type)).toEqual([
		"message_start",
		"content_block_start",
		"error",
	]);
	expect(results.at(-1)?.error).toEqual({
		type: "api_error",
		message: "Codex upstream returned malformed tool arguments.",
	});
});

it("returns a stream error if completion arrives before the tool item is done", async () => {
	const results = await eventsOf([
		added(0),
		argumentsDone(0, '{"query":"unfinished"}'),
	]);
	expect(results.map((event) => event.type)).toEqual([
		"message_start",
		"content_block_start",
		"error",
	]);
	expect(results.at(-1)?.error).toEqual({
		type: "api_error",
		message: "Codex upstream completed with an unfinished tool call.",
	});
});

it("preserves explicit token limits for partially generated tool arguments", async () => {
	const results = await eventsOf(
		[added(0), added(1), itemDone(0, '{"query":', "incomplete")],
		frame("response.incomplete", {
			response: {
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
			},
		}),
	);
	expect(results.map((event) => event.type)).toEqual([
		"message_start",
		"content_block_start",
		"content_block_start",
		"content_block_stop",
		"content_block_stop",
		"message_delta",
		"message_stop",
	]);
	expect(results.at(-2)?.delta).toMatchObject({ stop_reason: "max_tokens" });
});
