import crypto from "node:crypto";
import { TIME_CONSTANTS, ValidationError } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Provider } from "@better-ccflare/providers";
import type { RequestMeta } from "@better-ccflare/types";
import { chatGptCloudflareCookieJar } from "../chatgpt-cloudflare-cookies";
import { ERROR_MESSAGES, INTERNAL_PROBE_SECRET_HEADER } from "./proxy-types";

const log = new Logger("ProxyRequest");
const SLOW_HEADERS_MS = 30 * TIME_CONSTANTS.SECOND;

/**
 * Internal proxy control headers that must NEVER be forwarded to the upstream
 * provider: they gate privileged proxy behaviour (see isInternalProbe), and a
 * provider or custom endpoint that received them — the probe secret above all —
 * could replay them with a marker to forge privileged requests.
 */
function stripInternalControlHeaders(headers: Headers): void {
	headers.delete(INTERNAL_PROBE_SECRET_HEADER);
	headers.delete("x-better-ccflare-auto-refresh");
	headers.delete("x-better-ccflare-keepalive");
	headers.delete("x-better-ccflare-request-id");
	headers.delete("x-better-ccflare-request-stream");
	headers.delete("x-better-ccflare-codex-custom-tools");
	headers.delete("x-better-ccflare-native-responses");
	headers.delete("x-better-ccflare-authenticated-caller");
	headers.delete("x-better-ccflare-exclude-providers");
	headers.delete("x-better-ccflare-codex-continuation");
	headers.delete("x-better-ccflare-prompt-cache-mode");
	headers.delete("x-better-ccflare-prompt-cache-ttl");
	headers.delete("x-better-ccflare-prompt-cache-breakpoint");
	headers.delete("x-better-ccflare-codex-path");
	headers.delete("x-better-ccflare-codex-transport");
}

/**
 * Creates request metadata for tracking and analytics
 * @param req - The incoming request
 * @param url - The parsed URL
 * @returns Request metadata object
 */
export function createRequestMetadata(req: Request, url: URL): RequestMeta {
	return {
		id: crypto.randomUUID(),
		method: req.method,
		path: url.pathname,
		timestamp: Date.now(),
		headers: req.headers,
	};
}

/**
 * Validates that the provider can handle the requested path
 * @param provider - The provider instance
 * @param pathname - The request path
 * @throws {ValidationError} If provider cannot handle the path
 */
export function validateProviderPath(
	provider: Provider,
	pathname: string,
): void {
	if (!provider.canHandle(pathname)) {
		throw new ValidationError(
			`${ERROR_MESSAGES.PROVIDER_CANNOT_HANDLE}: ${pathname}`,
			"path",
			pathname,
		);
	}
}

/**
 * Prepares request body for analytics and creates body stream factory
 * @param req - The incoming request
 * @returns Object containing the buffered body and stream factory
 */
export async function prepareRequestBody(req: Request): Promise<{
	buffer: ArrayBuffer | null;
	createStream: () => ReadableStream<Uint8Array> | undefined;
}> {
	let buffer: ArrayBuffer | null = null;

	if (req.body) {
		buffer = await req.arrayBuffer();
	}

	return {
		buffer,
		createStream: () => {
			if (!buffer) return undefined;
			return new Response(buffer).body ?? undefined;
		},
	};
}

/**
 * Makes the actual HTTP request to the provider
 * @param targetUrl - The target URL to fetch
 * @param method - HTTP method
 * @param headers - Request headers
 * @param createBodyStream - Function to create request body stream
 * @param hasBody - Whether the request has a body
 * @returns Promise resolving to the response
 */
export async function makeProxyRequest(
	target: string | Request,
	method?: string,
	headers?: Headers,
	createBodyStream?: () => ReadableStream<Uint8Array> | undefined,
	hasBody?: boolean,
	signal?: AbortSignal,
): Promise<Response> {
	// The caller's abort source: either passed explicitly, or already carried by
	// a Request target (Request derivation preserves the signal object). It must
	// survive the header phase — a client that disconnects mid-stream is the
	// primary reason this exists, and that happens long after the headers.
	const callerSignal =
		signal ?? (target instanceof Request ? target.signal : undefined);

	const timeoutController = new AbortController();

	// Both reasons must be able to abort the same fetch. Combining them keeps
	// the caller signal live for the whole stream lifetime, whereas replacing
	// one with the other silently drops a client disconnect (upstream leak) or
	// the header timeout.
	const effectiveSignal = callerSignal
		? AbortSignal.any([callerSignal, timeoutController.signal])
		: timeoutController.signal;

	const targetUrl = target instanceof Request ? target.url : target;
	const mutableHeaders = new Headers(
		target instanceof Request ? target.headers : headers,
	);
	stripInternalControlHeaders(mutableHeaders);
	chatGptCloudflareCookieJar.applyCookieHeader(targetUrl, mutableHeaders);
	const outbound =
		target instanceof Request
			? new Request(target, {
					headers: mutableHeaders,
					signal: effectiveSignal,
				})
			: target;
	const outboundInit =
		typeof target === "string"
			? {
					method,
					headers: mutableHeaders,
					body: createBodyStream?.(),
					signal: effectiveSignal,
					...(hasBody ? ({ duplex: "half" } as RequestInit) : {}),
				}
			: undefined;

	// Both timers cover only the wait for headers. The pending warning is
	// diagnostic and must never abort a healthy request or keep Bun alive.
	const startedAt = performance.now();
	let attemptId: string | undefined;
	const details = () => {
		attemptId ??= crypto.randomUUID();
		return { attemptId, elapsedMs: Math.round(performance.now() - startedAt) };
	};
	const timeoutId = setTimeout(
		() => timeoutController.abort(),
		TIME_CONSTANTS.PROXY_REQUEST_TIMEOUT_MS,
	);
	const pendingTimer = setTimeout(() => {
		log.warn("upstream_headers_pending", details());
	}, SLOW_HEADERS_MS);
	pendingTimer.unref?.();

	let response: Response;
	try {
		response = await fetch(outbound, outboundInit);
	} catch (error) {
		// The composite retains the first abort reason even if both signals
		// have fired by the time fetch rejects.
		const outcome =
			timeoutController.signal.aborted &&
			effectiveSignal.reason === timeoutController.signal.reason
				? "header_timeout"
				: callerSignal?.aborted
					? "client_cancelled"
					: "transport_error";
		const fields = { ...details(), outcome };
		if (outcome === "client_cancelled")
			log.info("upstream_headers_failed", fields);
		else log.warn("upstream_headers_failed", fields);
		throw error;
	} finally {
		clearTimeout(timeoutId);
		clearTimeout(pendingTimer);
	}
	if (attemptId) log.info("upstream_headers_received", details());
	chatGptCloudflareCookieJar.captureFromResponse(targetUrl, response);
	return response;
}
