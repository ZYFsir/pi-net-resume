/**
 * pi-net-resume - keep a pi session working across network outages.
 *
 * When the Wi-Fi link (usually a phone hotspot) drops, the provider request
 * fails, pi retries it `retry.maxRetries` times (default 3, backoff 2s/4s/8s),
 * and then the agent settles with an error and simply stops: nothing else will
 * happen until a human types something.
 *
 * This extension watches for exactly that terminal state:
 *
 *   1. `agent_end`       - remember the failure if the assistant message ended
 *                          with `stopReason: "error"` and a connectivity-class
 *                          error message.
 *   2. `agent_settled`   - fires only when no automatic retry, compaction retry
 *                          or queued continuation is left, i.e. pi really has
 *                          given up.
 *   3. wait for the link - poll NetworkManager and TCP-probe the model endpoint
 *                          (`ctx.model.baseUrl`) until it is reachable again.
 *   4. resume            - inject a user message ("network is back, continue")
 *                          into the same session, which starts a new turn.
 *
 * Guards: only connectivity errors arm it, only while the network is actually
 * down, it gives up after `maxAutoResumes`/`maxWaitMinutes`, it is cancelled by
 * typing (any interactive input wins), and it never fires while pi is busy.
 *
 * Config (first existing file wins):
 *   1. $PI_NET_RESUME_CONFIG
 *   2. <agent dir>/pi-net-resume.json
 *   3. <agent dir>/extensions/pi-net-resume/config.json
 *   4. config.json next to this extension
 * Commands: /net-resume  (status), /net-resume now, /net-resume off|on
 */

import { connect } from "node:net";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// --------------------------------------------------------------------------- //
// config
// --------------------------------------------------------------------------- //

const EXTENSION_ID = "pi-net-resume";

/**
 * The hidden custom message that starts a resumed turn.  It carries no content
 * the model should see; the `context` hook below removes it before the provider
 * call, so the continuation can be invisible to the LLM.
 *
 * Technique adapted from pi-invisible-continue (MIT,
 * https://github.com/monotykamary/pi-invisible-continue).  See resumeStyle.
 */
const RESUME_MARKER = "pi-net-resume:resume";

const DEFAULTS = {
	enabled: true,
	/** Only arm when the network is really down at settle time. */
	armOnlyWhenOffline: true,
	/** Stop auto-resuming after this many attempts. */
	maxAutoResumes: 20,
	/** Never auto-resume twice within this many seconds. */
	minSecondsBetweenResumes: 15,
	/** Give up waiting for the network after this long. */
	maxWaitMinutes: 120,
	/** Poll cadence while waiting for the link. */
	probeIntervalMs: 3000,
	/** Per-probe TCP timeout. */
	probeTimeoutMs: 4000,
	/** Ask NetworkManager for the link state before probing TCP. */
	checkNetworkManager: true,
	/** Extra host:port probes used together with the model endpoint. */
	extraProbeHosts: [] as string[],
	/** What to send when the network is back. */
	continueMessage:
		"The network is back (Wi-Fi reconnected). Continue the task from where it was interrupted; do not repeat steps that already completed. If anything from the last step is uncertain, say so briefly before continuing.",
	/** Assistant error messages matching this arm the extension. */
	errorPattern:
		"network|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|other side closed|getaddrinfo|connection (refused|lost|reset|closed|error)|reset before headers|upstream connect|timed? ?out|timeout|terminated|websocket|dns",
	/** ... unless they also match this (never auto-resume for these). */
	excludePattern: "usage limit|insufficient_quota|out of budget|quota|billing|rate.?limit|too many requests|\\b429\\b|unauthorized|invalid api key|authentication",
	/**
	 * Unambiguous broken-link signatures.  These override `excludePattern`, so a
	 * genuine outage is never vetoed by a stray "quota" or "429" elsewhere in
	 * the message.  Keep this conservative: only strings that cannot plausibly
	 * appear in a healthy response.
	 */
	hardNetworkPattern:
		"ECONNRESET|ECONNREFUSED|ECONNABORTED|ENETUNREACH|EHOSTUNREACH|ENETDOWN|ENETRESET|EPIPE|EPROTO|ENOTFOUND|EAI_AGAIN|EAI_FAIL|getaddrinfo|fetch failed|socket hang up|other side closed|reset before headers|network is unreachable|no route to host|name or service not known|temporary failure in name resolution|dns lookup failed|connect(ion)? (refused|lost|reset|timed? ?out)",
	/** Append a JSON-lines log here (empty = disabled). */
	logFile: "~/.local/state/pi-net-resume/pi-net-resume.log",
	/** Show desktop notifications on resume. */
	notify: true,
	/**
	 * How the resumed turn is started:
	 *
	 *   "hybrid"  - the turn is triggered by a hidden custom marker that the
	 *               `context` hook strips before the provider call, so the model
	 *               sees no new prompt text; the marker is displayed, so a human
	 *               reading the transcript still sees that an outage happened.
	 *   "hidden"  - as above, but nothing is displayed at all.
	 *   "visible" - send `continueMessage` as a real user message, so the model is
	 *               told why the turn restarted (and so is any reader).
	 */
	resumeStyle: "hybrid" as "hybrid" | "hidden" | "visible",
};

type Config = typeof DEFAULTS;

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * The directory this extension file lives in, so a packaged install can find a
 * config that ships beside it.  pi loads extensions through jiti, which does
 * not guarantee `import.meta.url` in every mode, so this is best-effort.
 */
function moduleDir(): string {
	try {
		const url = (import.meta as unknown as { url?: string }).url;
		if (url) return dirname(new URL(url).pathname);
	} catch {
		/* fall through */
	}
	return join(agentDir(), "extensions", EXTENSION_ID);
}

function expand(p: string): string {
	if (!p) return p;
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function loadConfig(): { config: Config; path: string } {
	// Search order, first existing file wins:
	//   1. explicit override (PI_NET_RESUME_CONFIG)
	//   2. <agent dir>/pi-net-resume.json          -- install-location agnostic
	//   3. <agent dir>/extensions/pi-net-resume/config.json  -- legacy / manual
	//   4. next to the extension itself            -- for a checkout or a
	//      `pi install npm:...` tree, where a bundled config.example.json sits
	// A package installed under ~/.pi/agent/npm/... therefore still finds the
	// user's config, and a user who follows the README lands somewhere real.
	const candidates = [
		process.env.PI_NET_RESUME_CONFIG,
		join(agentDir(), `${EXTENSION_ID}.json`),
		join(agentDir(), "extensions", EXTENSION_ID, "config.json"),
		join(moduleDir(), "config.json"),
	].filter(Boolean) as string[];
	for (const candidate of candidates) {
		const path = expand(candidate);
		if (!existsSync(path)) continue;
		try {
			const user = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
			const merged = { ...DEFAULTS, ...user };
			delete (merged as Record<string, unknown>)._comment;
			return { config: merged as Config, path };
		} catch (error) {
			console.error(`${EXTENSION_ID}: ignoring bad config ${path}: ${String(error)}`);
		}
	}
	return { config: { ...DEFAULTS }, path: `(built-in defaults; create ${expand(join(agentDir(), `${EXTENSION_ID}.json`))} to customise)` };
}

// --------------------------------------------------------------------------- //
// small helpers
// --------------------------------------------------------------------------- //

function logTo(config: Config, event: string, data: Record<string, unknown> = {}): void {
	if (!config.logFile) return;
	try {
		const path = expand(config.logFile);
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(
			path,
			`${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`,
			"utf8",
		);
	} catch {
		/* logging must never break the agent */
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// --------------------------------------------------------------------------- //
// invisible continuation
// --------------------------------------------------------------------------- //
//
// Adapted from pi-invisible-continue (MIT),
// https://github.com/monotykamary/pi-invisible-continue
//
// A resumed turn has to start somehow.  Sending a user message is the obvious
// way, but it puts text in front of the model that the model did not ask for --
// after an outage that text is noise at best, and can read as a new instruction
// at worst.  Instead the turn is started by a custom message that this extension
// removes again in the `context` hook, so the model simply continues from where
// the conversation actually stopped.

function isResumeMarker(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const candidate = message as { role?: unknown; customType?: unknown };
	return candidate.role === "custom" && candidate.customType === RESUME_MARKER;
}

/** An assistant attempt that never produced a usable answer. */
function isIncompleteAssistant(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const candidate = message as { role?: unknown; stopReason?: unknown };
	return (
		candidate.role === "assistant" &&
		(candidate.stopReason === "error" || candidate.stopReason === "aborted")
	);
}

function hasToolCalls(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const content = (message as { content?: unknown }).content;
	return (
		Array.isArray(content) &&
		content.some(
			(block) =>
				!!block &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "toolCall",
		)
	);
}

/**
 * Drop trailing failed attempts (retry-exhausted errors, aborts) so a resumed
 * turn does not re-serve the outage to the model.  Each failed provider call
 * leaves an assistant message with empty content, so after a few retries the
 * history ends in several of them.
 *
 * Guards: stop at the first message that is not an incomplete assistant, never
 * drop one that carries tool calls (its results have to stay paired), and never
 * empty the context.
 */
function stripTrailingIncompleteAssistants<T>(messages: readonly T[]): T[] {
	const stripped = [...messages];
	while (
		stripped.length > 1 &&
		isIncompleteAssistant(stripped[stripped.length - 1]) &&
		!hasToolCalls(stripped[stripped.length - 1])
	) {
		stripped.pop();
	}
	return stripped;
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (ok: boolean) => {
			if (settled) return;
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			resolve(ok);
		};
		const socket = connect({ host, port });
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

interface AssistantLike {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
}

function lastAssistant(messages: unknown): AssistantLike | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i] as AssistantLike | undefined;
		if (message && message.role === "assistant") return message;
	}
	return undefined;
}

function probeTargets(config: Config, ctx: ExtensionContext): Array<{ host: string; port: number }> {
	const targets: Array<{ host: string; port: number }> = [];
	const add = (raw: string) => {
		if (!raw) return;
		let host = raw;
		let port = 0;
		try {
			if (raw.includes("://")) {
				const url = new URL(raw);
				host = url.hostname;
				// url.port is empty for well-known schemes; only assume 443 for
				// https.  An http endpoint must not be probed on 443, and a
				// scheme-less host:port is taken literally.
				port = url.port
					? Number(url.port)
					: url.protocol === "https:"
						? 443
						: url.protocol === "http:"
							? 80
							: 0;
			} else if (/^\[[^\]]+\](:\d+)?$/.test(raw)) {
				// IPv6 literal: [::1] or [::1]:8443
				const match = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
				if (match) {
					host = match[1];
					port = match[2] ? Number(match[2]) : 0;
				}
			} else if (raw.includes(":")) {
				const idx = raw.lastIndexOf(":");
				const maybePort = raw.slice(idx + 1);
				if (/^\d+$/.test(maybePort)) {
					host = raw.slice(0, idx);
					port = Number(maybePort);
				} else {
					// a bare IPv6 literal with no port (127.0.0.1 style host is
					// unaffected because it has no colon)
					host = raw;
				}
			}
		} catch {
			return;
		}
		if (!host) return;
		// A host with no port tells us only the host, so we cannot probe it
		// meaningfully; fall back to the scheme default or 443.
		if (!port) port = 443;
		// Loopback and LAN endpoints are probed too: if the model itself lives
		// on 127.0.0.1 or a self-hosted box, reachability of that socket is
		// exactly what matters.
		if (!targets.some((t) => t.host === host && t.port === port)) targets.push({ host, port });
	};

	// Resolution order: the model pi will actually talk to, then API_BASE_URL-
	// style environment variables (a self-hosted gateway is usually configured
	// that way), then the explicit config list.
	try {
		// ctx.model carries the resolved base URL pi will actually talk to.
		const baseUrl = (ctx as unknown as { model?: { baseUrl?: string } }).model?.baseUrl;
		if (baseUrl) add(baseUrl);
	} catch {
		/* ignore */
	}
	if (targets.length === 0) {
		for (const key of ["MODEL_BASE_URL", "PI_BASE_URL", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"]) {
			const value = process.env[key];
			if (value) add(value);
		}
	}
	for (const extra of config.extraProbeHosts) add(extra);
	return targets;
}

// --------------------------------------------------------------------------- //
// extension
// --------------------------------------------------------------------------- //

export default function (pi: ExtensionAPI) {
	const { config, path } = loadConfig();
	if (!config.enabled) return;

	const errorRe = new RegExp(config.errorPattern, "i");
	const excludeRe = new RegExp(config.excludePattern, "i");
	// Signatures that are *unambiguously* a broken link.  A message containing one
	// of these is a connectivity failure even if it also mentions quota, 429 or
	// auth -- which happens for real: a gateway reports "429 ... connection reset
	// before headers", or a URL/id happens to contain the word "quota".
	// Without this, the excludePattern would veto a genuine outage and the
	// session would sit dead until someone typed.
	const hardNetworkRe = new RegExp(config.hardNetworkPattern, "i");

	/**
	 * Decide whether an error message describes a connectivity outage.
	 *
	 * Order matters: a hard network signature wins outright, then the exclude
	 * list vetoes (an explicit 429 / quota message must never be retried in a
	 * loop), and only then does a soft match arm the extension.
	 */
	function isConnectivityError(message: string): boolean {
		if (hardNetworkRe.test(message)) return true;
		if (excludeRe.test(message)) return false;
		return errorRe.test(message);
	}

	let pending: { message: string; at: number } | null = null;
	let waiting = false;
	let resumeCount = 0;
	let lastResumeAt = 0;
	let stopped = false;
	let sessionEnabled = true;
	let lastProbe: { at: number; reachable: boolean; detail: string } | null = null;
	let wake: (() => void) | null = null;

	logTo(config, "extension_loaded", { configPath: path });

	// -- connectivity ------------------------------------------------------ //

	async function nmState(): Promise<{ state: string; connectivity: string } | null> {
		if (!config.checkNetworkManager) return null;
		try {
			const result = await pi.exec("sh", [
				"-c",
				"command -v nmcli >/dev/null 2>&1 && LC_ALL=C nmcli -t -f STATE,CONNECTIVITY general",
			]);
			const line = result.stdout.trim().split("\n")[0] ?? "";
			const [state = "", connectivity = ""] = line.split(":");
			if (!state) return null;
			return { state, connectivity };
		} catch {
			return null;
		}
	}

	async function isOnline(ctx: ExtensionContext): Promise<{ online: boolean; detail: string }> {
		const nm = await nmState();
		if (nm && (nm.state === "disconnected" || nm.state === "asleep")) {
			lastProbe = { at: Date.now(), reachable: false, detail: `networkmanager:${nm.state}` };
			return { online: false, detail: `NetworkManager reports ${nm.state}` };
		}
		const targets = probeTargets(config, ctx);
		if (targets.length === 0) {
			// Nothing to probe (e.g. a local llama.cpp endpoint): trust NM.
			const online = nm ? nm.state === "connected" : true;
			const detail = nm ? `networkmanager:${nm.state}` : "no probe targets";
			lastProbe = { at: Date.now(), reachable: online, detail };
			return { online, detail };
		}
		for (const target of targets) {
			if (await tcpProbe(target.host, target.port, config.probeTimeoutMs)) {
				const detail = `${target.host}:${target.port} reachable`;
				lastProbe = { at: Date.now(), reachable: true, detail };
				return { online: true, detail };
			}
		}
		const detail = `no route to ${targets.map((t) => `${t.host}:${t.port}`).join(", ")}`;
		lastProbe = { at: Date.now(), reachable: false, detail };
		return { online: false, detail };
	}

	/**
	 * Remove our own marker from the outgoing request, and drop the failed
	 * attempts that led here.
	 *
	 * The marker only exists on a turn *we* started, so an ordinary turn is
	 * returned untouched.  That early return is what keeps this hook from
	 * interfering with pi's own retries, compaction or anything else.
	 */
	pi.on("context", async (event) => {
		const messages = event.messages as unknown[];
		if (!messages.some(isResumeMarker)) return;

		// The marker is what starts the resumed turn, so it will still be in the
		// history for the rest of the session.  Always drop it from the request --
		// the model must never read it -- but only strip the failed attempts when
		// this *is* that resume turn (the marker is the newest entry).  Otherwise
		// a later, unrelated failure would be hidden from the model too, which
		// would be pi's problem to report, not ours to silence.
		const resumesThisTurn = isResumeMarker(messages[messages.length - 1]);
		const withoutMarker = messages.filter((message) => !isResumeMarker(message));
		const next = resumesThisTurn
			? stripTrailingIncompleteAssistants(withoutMarker)
			: withoutMarker;

		if (next.length !== messages.length) {
			logTo(config, "context_rewritten", {
				removed: messages.length - next.length,
				from: messages.length,
				to: next.length,
				resumeTurn: resumesThisTurn,
			});
			return { messages: next };
		}
	});

	/**
	 * Start the resumed turn in the configured style.  "visible" tells the model
	 * why the conversation restarted; the other two keep it out of the model's
	 * view and differ only in what a human sees.
	 */
	function injectResume(): void {
		const style = config.resumeStyle;
		if (style === "visible") {
			pi.sendUserMessage(config.continueMessage);
			return;
		}
		pi.sendMessage(
			{
				customType: RESUME_MARKER,
				// Never read by the model: the `context` hook strips this very
				// message.  It is only shown when the style wants a human trace.
				content: config.continueMessage,
				display: style === "hybrid",
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	// -- resume loop ------------------------------------------------------- //

	async function waitAndResume(ctx: ExtensionContext): Promise<void> {
		if (waiting || !pending) return;
		waiting = true;
		const failure = pending;
		const deadline = Date.now() + config.maxWaitMinutes * 60_000;
		const startedAt = Date.now();
		let polls = 0;
		ctx.ui.setStatus(EXTENSION_ID, "network down - waiting to resume");
		ctx.ui.notify(
			`${EXTENSION_ID}: ${failure.message.slice(0, 120)} - will resume when the network is back`,
			"warning",
		);
		logTo(config, "waiting_for_network", { failureAt: failure.at, failure: failure.message });

		try {
			while (!stopped && pending === failure) {
				if (resumeCount >= config.maxAutoResumes) {
					logTo(config, "give_up_max_resumes", { resumeCount });
					ctx.ui.notify(
						`${EXTENSION_ID}: giving up after ${resumeCount} auto-resumes (raise maxAutoResumes to change)`,
						"error",
					);
					break;
				}
				if (Date.now() > deadline) {
					logTo(config, "give_up_timeout", { waitedMs: Date.now() - startedAt });
					ctx.ui.notify(
						`${EXTENSION_ID}: network still down after ${config.maxWaitMinutes} min, not resuming automatically`,
						"error",
					);
					break;
				}
				const { online, detail } = await isOnline(ctx);
				polls += 1;
				if (online) {
					// let routes, DNS and the DHCP lease settle, then confirm.
					await sleep(800);
					if (pending !== failure) return;
					if (!ctx.isIdle()) {
						await sleep(500);
						continue;
					}
					const waitForThrottle =
						config.minSecondsBetweenResumes * 1000 - (Date.now() - lastResumeAt);
					if (waitForThrottle > 0) await sleep(waitForThrottle);
					if (pending !== failure) return;
					const check = await isOnline(ctx);
					if (!check.online) continue;

					resumeCount += 1;
					lastResumeAt = Date.now();
					pending = null;
					logTo(config, "auto_resume", {
						resumeCount,
						waitedMs: Date.now() - startedAt,
						detail: check.detail,
					});
					ctx.ui.setStatus(EXTENSION_ID, undefined);
					ctx.ui.notify(
						`${EXTENSION_ID}: network is back (${check.detail}) - resuming`,
						"info",
					);
					pi.appendEntry(EXTENSION_ID, {
						at: new Date().toISOString(),
						resumeCount,
						waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
						detail: check.detail,
						resumeStyle: config.resumeStyle,
					});
					if (config.notify) {
						void pi
							.exec("sh", [
								"-c",
								`command -v notify-send >/dev/null 2>&1 && notify-send -a ${EXTENSION_ID} "pi" "network restored, resuming session"`,
							])
							.catch(() => undefined);
					}
					injectResume();
					return;
				}
				// wait for the poll interval, but wake up immediately on new input
				await Promise.race([sleep(config.probeIntervalMs), new Promise<void>((r) => (wake = r))]);
				wake = null;
			}
		} finally {
			waiting = false;
			if (pending === failure) ctx.ui.setStatus(EXTENSION_ID, undefined);
		}
	}

	function cancelPending(reason: string): void {
		if (!pending && !waiting) return;
		logTo(config, "cancelled", { reason });
		pending = null;
		wake?.();
		wake = null;
	}

	// -- events ------------------------------------------------------------ //

	pi.on("agent_end", async (event, ctx) => {
		const assistant = lastAssistant(event.messages);
		if (!assistant) return;
		if (assistant.stopReason === "error") {
			const message = assistant.errorMessage ?? "unknown error";
			if (isConnectivityError(message)) {
				pending = { message, at: Date.now() };
				logTo(config, "network_error", { message });
				ctx.ui.setStatus(EXTENSION_ID, "network error - will resume when back online");
			} else {
				pending = null;
				logTo(config, "non_network_error", { message });
			}
			return;
		}
		if (assistant.stopReason === "aborted") {
			// the user interrupted: never auto-resume that
			cancelPending("assistant aborted");
			return;
		}
		// a turn completed normally - reset the streak
		pending = null;
		resumeCount = 0;
		if (!waiting) ctx.ui.setStatus(EXTENSION_ID, undefined);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!sessionEnabled || !pending || waiting) return;
		// pi will not retry any more.  Make sure it really is an outage before
		// arming, so a lone provider hiccup does not burn tokens later.
		const { online, detail } = await isOnline(ctx);
		if (config.armOnlyWhenOffline && online) {
			logTo(config, "not_arming_online", { detail });
			pending = null;
			ctx.ui.setStatus(EXTENSION_ID, undefined);
			return;
		}
		logTo(config, "armed", { detail });
		void waitAndResume(ctx);
	});

	pi.on("agent_start", async () => {
		// pi is working again (auto-resume, user message, compaction retry, ...)
		if (waiting) return;
		if (!pending) resumeCount = 0;
	});

	pi.on("input", async (event) => {
		// Anything a human types wins over the automation.
		if (event.source === "interactive") cancelPending("user input");
		if (event.source === "extension") return;
	});

	pi.on("session_shutdown", async () => {
		stopped = true;
		wake?.();
	});

	// -- commands ---------------------------------------------------------- //

	pi.registerCommand(EXTENSION_ID, {
		description: "Network-outage auto-resume: status, 'now', 'on', 'off'",
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				sessionEnabled = arg === "on";
				if (!sessionEnabled) cancelPending("disabled by command");
				ctx.ui.notify(`${EXTENSION_ID}: ${sessionEnabled ? "enabled" : "disabled"}`, "info");
				return;
			}
			if (arg === "now") {
				const { online, detail } = await isOnline(ctx);
				if (!online) {
					ctx.ui.notify(`${EXTENSION_ID}: still offline (${detail})`, "warning");
					return;
				}
				resumeCount += 1;
				lastResumeAt = Date.now();
				pending = null;
				logTo(config, "manual_resume", { detail, resumeStyle: config.resumeStyle });
				injectResume();
				return;
			}
			const { online, detail } = await isOnline(ctx);
			const lines = [
				`enabled       : ${sessionEnabled ? "yes" : "no"}`,
				`config        : ${path}`,
				`status        : ${waiting ? "waiting for the network" : pending ? "armed" : "idle"}`,
				`resumes used  : ${resumeCount}/${config.maxAutoResumes}`,
				`resume style  : ${config.resumeStyle}`,
				`link now      : ${online ? "up" : "down"} (${detail})`,
				`probe targets : ${probeTargets(config, ctx).map((t) => `${t.host}:${t.port}`).join(", ") || "none"}`,
				`log           : ${expand(config.logFile) || "disabled"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
