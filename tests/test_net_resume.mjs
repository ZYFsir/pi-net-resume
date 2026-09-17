/**
 * Tests for the pi-net-resume extension.
 *
 * The extension is loaded with Node's TypeScript type-stripping, the pi API is
 * faked, and the network probe is a real TCP socket against 127.0.0.1 so the
 * whole "error -> armed -> waiting -> resumed" pipeline is exercised without
 * touching the machine's real network.
 *
 *   node --experimental-strip-types tests/test_net_resume.mjs
 */

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "..", "pkg", "pi-net-resume", "index.ts");

let failures = 0;
const tests = [];

function test(name, fn) {
	tests.push([name, fn]);
}

function deadline(ms, what) {
	return new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms));
}

async function waitFor(predicate, ms, what) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Boot the extension with a fake pi API and a temp config. */
async function boot(configOverrides = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-net-resume-test-"));
	const configPath = join(dir, "config.json");
	const logPath = join(dir, "log.jsonl");
	writeFileSync(
		configPath,
		JSON.stringify({
			checkNetworkManager: false,
			notify: false,
			probeIntervalMs: 100,
			probeTimeoutMs: 300,
			minSecondsBetweenResumes: 0,
			maxWaitMinutes: 1,
			logFile: logPath,
			...configOverrides,
		}),
		"utf8",
	);
	process.env.PI_NET_RESUME_CONFIG = configPath;

	const module = await import(`${EXTENSION}?t=${Date.now()}`);
	const handlers = new Map();
	const commands = new Map();
	const sent = [];
	const notifications = [];
	const statuses = [];

	const pi = {
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		appendEntry() {},
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		sendUserMessage(content, options) {
			sent.push({ kind: "user", content, options });
		},
		sendMessage(message, options) {
			// A custom message: the invisible-continuation path.
			sent.push({
				kind: "custom",
				content: message.content,
				customType: message.customType,
				display: message.display,
				options,
			});
		},
	};
	module.default(pi);

	const ctx = {
		model: { baseUrl: configOverrides._baseUrl ?? "http://127.0.0.1:1/v1" },
		isIdle: () => true,
		ui: {
			setStatus: (key, value) => statuses.push([key, value]),
			notify: (message, level) => notifications.push([message, level]),
		},
	};

	// Handlers may return a value (the `context` hook rewrites messages), so
	// collect results instead of discarding them.
	const emit = async (name, event = {}) => {
		const results = [];
		for (const handler of handlers.get(name) ?? []) {
			results.push(await handler({ type: name, ...event }, ctx));
		}
		return results;
	};

	const readLog = () =>
		existsSync(logPath)
			? readFileSync(logPath, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [];

	const events = () => readLog().map((entry) => entry.event);

	return { dir, configPath, logPath, handlers, commands, sent, notifications, statuses, ctx, emit, readLog, events };
}

/** A TCP server on a free port (or a specific port); resolves with {port, close}. */
function listen(port = 0) {
	return new Promise((resolve, reject) => {
		const server = createServer(() => {});
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
		});
	});
}

const NET_ERROR = { role: "assistant", stopReason: "error", errorMessage: "fetch failed: ENOTFOUND api.example.com" };

// ------------------------------------------------------------------------- //

test("a network error is noticed but nothing happens before pi settles", async () => {
	const app = await boot();
	await app.emit("agent_end", { messages: [NET_ERROR] });
	assert.equal(app.sent.length, 0, "must not resume on agent_end (pi may still retry)");
	assert.ok(app.events().includes("network_error"));
	assert.ok(!app.events().includes("armed"));
});

test("a non-network error is ignored", async () => {
	const app = await boot();
	await app.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "invalid api key" }] });
	await app.emit("agent_settled");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(app.sent.length, 0);
	assert.ok(app.events().includes("non_network_error"));
	assert.ok(!app.events().includes("armed"));
});

test("a rate-limit error is never auto-resumed", async () => {
	const app = await boot();
	await app.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "error", errorMessage: "429 rate limit exceeded" }],
	});
	await app.emit("agent_settled");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(app.sent.length, 0);
	assert.ok(!app.events().includes("armed"));
});

// -- error classification boundary ---------------------------------------- //
//
// pi-auto-resume (a sibling extension) owns token truncation, HTTP 429 and
// billing/quota exhaustion.  We own connectivity loss.  These cases pin the
// border in both directions: we must never steal its cases, and we must never
// drop a real outage just because a limit-ish word appears in the message.

/** Assert the extension treats `message` as a connectivity error (arms, then waits). */
async function assertArms(message) {
	const app = await boot({ _baseUrl: "http://127.0.0.1:1/v1" });
	await app.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: message }] });
	await app.emit("agent_settled");
	await waitFor(() => app.events().includes("waiting_for_network"), 3000, `arming for: ${message}`);
	await app.emit("session_shutdown");
	return app;
}

/** Assert the extension ignores `message` entirely (does not even arm). */
async function assertIgnores(message) {
	const app = await boot({ _baseUrl: "http://127.0.0.1:1/v1" });
	await app.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: message }] });
	await app.emit("agent_settled");
	await new Promise((r) => setTimeout(r, 300));
	assert.ok(!app.events().includes("waiting_for_network"), `must not arm for: ${message}`);
	assert.equal(app.sent.length, 0, `must not resume for: ${message}`);
}

test("the sibling extension's cases are left to it", async () => {
	// pi-auto-resume territory: never ours.
	for (const message of [
		"429 Too Many Requests",
		"rate limit exceeded, retry after 60s",
		"You exceeded your current quota",
		"insufficient_quota",
		"billing hard limit reached: please upgrade plan",
		"unauthorized: invalid api key",
	]) {
		await assertIgnores(message);
	}
});

test("a real outage is not vetoed by a limit-ish word elsewhere", async () => {
	// These are genuine connectivity failures whose text also happens to carry a
	// quota / 429 / auth word (a redirect path, an intermediate proxy, an id).
	// The hard network signature must win over excludePattern.
	for (const message of [
		"fetch failed: connect ECONNRESET (quota check endpoint)",
		"429 from gateway: upstream connect error, connection reset before headers",
		"socket hang up (rate limit backoff endpoint)",
		"connection refused to billing.example.com",
		"connect ECONNRESET while refreshing token: unauthorized",
	]) {
		await assertArms(message);
	}
});

test("an ambiguous auth/limit message with no hard signature stays vetoed", async () => {
	// Deliberate: without a broken-link signature, "unauthorized" / "quota" must
	// still veto.  Resuming an auth failure in a loop would burn tokens on a
	// request that cannot succeed -- exactly what excludePattern is for.
	for (const message of [
		"network error while refreshing token: unauthorized",
		"network request rejected: quota exhausted",
		"timeout from billing service: rate limit reached",
	]) {
		await assertIgnores(message);
	}
});

test("canonical connectivity errors arm the extension", async () => {
	for (const message of [
		"fetch failed",
		"getaddrinfo ENOTFOUND api.example.com",
		"connect ETIMEDOUT 1.2.3.4:443",
		"ENETUNREACH",
		"request timed out after 60000ms",
	]) {
		await assertArms(message);
	}
});

test("a user abort never arms the extension", async () => {
	const app = await boot();
	await app.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
	await app.emit("agent_settled");
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(app.sent.length, 0);
});

test("a network error while the link is up does not arm (armOnlyWhenOffline)", async () => {
	const server = await listen();
	const app = await boot({ _baseUrl: `http://127.0.0.1:${server.port}/v1` });
	await app.emit("agent_end", { messages: [NET_ERROR] });
	await app.emit("agent_settled");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(app.sent.length, 0, "reachable endpoint means it was not an outage");
	assert.ok(app.events().includes("not_arming_online"));
	await server.close();
});

test("waits for the link to come back, then resumes the session", async () => {
	// reserve a port, close it, so the probe target is genuinely unreachable
	const reservation = await listen();
	const probePort = reservation.port;
	await reservation.close();

	const app = await boot({ _baseUrl: `http://127.0.0.1:${probePort}/v1` });
	await app.emit("agent_end", { messages: [NET_ERROR] });
	await app.emit("agent_settled");

	await waitFor(() => app.events().includes("armed"), 2000, "arming");
	await waitFor(() => app.events().includes("waiting_for_network"), 2000, "the wait loop");
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(app.sent.length, 0, "must not resume while the port is closed");

	// the hotspot comes back
	const server = await listen(probePort);
	try {
		await waitFor(() => app.sent.length === 1, 5000, "the auto-resume");
	} finally {
		await server.close();
	}
	assert.equal(String(app.sent[0].content).includes("The network is back"), true);
	// default resumeStyle is "hybrid": the model-facing text is carried by a
	// custom marker that the context hook removes, not by a user message
	assert.equal(app.sent[0].kind, "custom", "hybrid style must not send a user message");
	assert.equal(app.sent[0].customType, "pi-net-resume:resume");
	assert.ok(app.events().includes("auto_resume"));
	const resumed = app.readLog().find((entry) => entry.event === "auto_resume");
	assert.equal(resumed.resumeCount, 1);
	assert.equal(resumed.detail, `127.0.0.1:${probePort} reachable`);
});

test("resume is cancelled by the user typing", async () => {
	const app = await boot({ _baseUrl: "http://127.0.0.1:1/v1" });
	await app.emit("agent_end", { messages: [NET_ERROR] });
	await app.emit("agent_settled");
	await waitFor(() => app.events().includes("waiting_for_network"), 2000, "the wait loop");
	await app.emit("input", { source: "interactive", text: "never mind" });
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(app.sent.length, 0);
	assert.ok(app.events().includes("cancelled"));
});

test("gives up after maxAutoResumes", async () => {
	const server = await listen();
	const app = await boot({
		_baseUrl: `http://127.0.0.1:${server.port}/v1`,
		armOnlyWhenOffline: false,
		maxAutoResumes: 1,
	});
	// first failure -> resume #1
	await app.emit("agent_end", { messages: [NET_ERROR] });
	await app.emit("agent_settled");
	await waitFor(() => app.sent.length === 1, 3000, "first resume");
	// second failure -> cap reached, must refuse
	await app.emit("agent_end", { messages: [NET_ERROR] });
	await app.emit("agent_settled");
	await waitFor(() => app.events().includes("give_up_max_resumes"), 3000, "the cap");
	assert.equal(app.sent.length, 1);
	await server.close();
});

test("a successful turn resets the resume counter", async () => {
	const server = await listen();
	const app = await boot({
		_baseUrl: `http://127.0.0.1:${server.port}/v1`,
		armOnlyWhenOffline: false,
		maxAutoResumes: 2,
	});
	await app.emit("agent_end", { messages: [NET_ERROR] });
	await app.emit("agent_settled");
	await waitFor(() => app.sent.length === 1, 3000, "first resume");
	await app.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await app.emit("agent_end", { messages: [NET_ERROR] });
	await app.emit("agent_settled");
	await waitFor(() => app.sent.length === 2, 3000, "second resume after a good turn");
	await server.close();
});

test("/net-resume reports status and /net-resume off disables automation", async () => {
	const app = await boot({ _baseUrl: "http://127.0.0.1:1/v1" });
	const command = app.commands.get("pi-net-resume");
	assert.ok(command, "command registered");
	await command.handler("", app.ctx);
	assert.match(app.notifications.at(-1)[0], /enabled\s*:\s*yes/);
	assert.match(app.notifications.at(-1)[0], /link now\s*:\s*down/);

	await command.handler("off", app.ctx);
	await app.emit("agent_end", { messages: [NET_ERROR] });
	await app.emit("agent_settled");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(app.sent.length, 0, "disabled sessions must not auto-resume");
});

// -- invisible continuation (absorbed from pi-invisible-continue) ---------- //

const MARKER = { role: "custom", customType: "pi-net-resume:resume", content: "continue" };
const FAILED = { role: "assistant", stopReason: "error", content: [] };
const FAILED_ABORTED = { role: "assistant", stopReason: "aborted", content: [] };
const WITH_TOOL_CALL = {
	role: "assistant",
	stopReason: "error",
	content: [{ type: "toolCall", name: "bash", arguments: {} }],
};
const USER = { role: "user", content: [{ type: "text", text: "do the thing" }] };

/** Run only the context hook; return the rewritten messages, or null for no rewrite. */
async function contextAfter(app, messages) {
	const results = await app.emit("context", { messages });
	const rewrite = results.find((r) => r && Array.isArray(r.messages));
	return rewrite ? rewrite.messages : null;
}

/** Boot with a live endpoint so a resume can actually complete. */
async function bootWithLiveLink(overrides = {}) {
	const server = await listen();
	const app = await boot({ _baseUrl: `http://127.0.0.1:${server.port}/v1`, ...overrides });
	return { app, server };
}

/** Drive one full outage -> resume cycle and return the injected message. */
async function resumeOnce(overrides = {}) {
	// The endpoint is deliberately live at settle time here: these cases are about
	// *how* the turn is restarted, not about the arming decision, so the
	// "only arm while offline" guard is switched off.
	const { app, server } = await bootWithLiveLink({ armOnlyWhenOffline: false, ...overrides });
	try {
		await app.emit("agent_end", { messages: [NET_ERROR] });
		await app.emit("agent_settled");
		await waitFor(() => app.sent.length > 0, 5000, "a resume");
		return app.sent[0];
	} finally {
		await server.close();
	}
}

test("the resume marker never reaches the model", async () => {
	const app = await boot();
	const out = await contextAfter(app, [USER, FAILED, MARKER]);
	assert.ok(out, "a rewrite must be returned when a marker is present");
	assert.equal(out.some((m) => m.role === "custom"), false, "the marker must be removed");
});

test("trailing failed attempts are stripped from the resumed request", async () => {
	const app = await boot();
	// A real outage leaves one empty assistant message per retry.
	const out = await contextAfter(app, [USER, FAILED, FAILED_ABORTED, MARKER]);
	assert.deepEqual(out, [USER], "both failed attempts and the marker must go");
});

test("stripping keeps tool-call attempts, which must stay paired", async () => {
	const app = await boot();
	const out = await contextAfter(app, [USER, WITH_TOOL_CALL, MARKER]);
	assert.deepEqual(out, [USER, WITH_TOOL_CALL], "an attempt with tool calls must survive");
});

test("stripping never empties the context", async () => {
	const app = await boot();
	const out = await contextAfter(app, [FAILED, MARKER]);
	assert.ok(out, "a rewrite is still expected");
	assert.equal(out.length, 1, "the failed attempt stays when it is all there is");
});

test("a later turn keeps its own failed attempt visible", async () => {
	// The marker stays in the session history, so it is present again on every
	// later request.  Only the resume turn itself may lose its trailing failed
	// attempts; a later error is pi's to report, not ours to hide.
	const app = await boot();
	const stale = [USER, MARKER, { role: "assistant", stopReason: "stop", content: [] }, USER, FAILED];
	const out = await contextAfter(app, stale);
	assert.ok(out, "the marker must still be removed from the request");
	assert.equal(out.some((m) => m.role === "custom"), false, "marker removed");
	assert.equal(out[out.length - 1], FAILED, "a later failure must NOT be stripped");
});

test("an ordinary turn is left completely untouched", async () => {
	// No marker => not ours to act on.  This is what keeps the extension from
	// interfering with pi's own retries or compaction.
	const app = await boot();
	const out = await contextAfter(app, [USER, FAILED, { role: "assistant", stopReason: "stop", content: [] }]);
	assert.equal(out, null, "no marker means no rewrite");
});

test("resumeStyle=visible sends a user message and rewrites nothing", async () => {
	const first = await resumeOnce({ resumeStyle: "visible" });
	assert.equal(first.kind, "user", "visible style must send a real user message");
	assert.equal(String(first.content).includes("The network is back"), true);
	const app = await boot();
	const out = await contextAfter(app, [USER, FAILED]);
	assert.equal(out, null, "visible style leaves no marker, so nothing is rewritten");
});

test("resumeStyle=hidden triggers a turn with nothing displayed", async () => {
	const first = await resumeOnce({ resumeStyle: "hidden" });
	assert.equal(first.kind, "custom", "hidden style must not send a user message");
	assert.equal(first.customType, "pi-net-resume:resume");
	assert.equal(first.display, false, "hidden style must not display the marker");
});

test("resumeStyle=hybrid shows a note to the human but not to the model", async () => {
	const first = await resumeOnce(); // hybrid is the default
	assert.equal(first.kind, "custom");
	assert.equal(first.display, true, "hybrid shows the note in the transcript");
	// ...and that very same message is what the context hook removes
	const app = await boot();
	const out = await contextAfter(app, [USER, FAILED, MARKER]);
	assert.equal(out.some((m) => m.role === "custom"), false);
});

// -- probe target resolution (portability) -------------------------------- //

test("a localhost model endpoint is probed on its own port", async () => {
	// The endpoint is up at settle time, so `armOnlyWhenOffline` must decline to
	// arm and record the endpoint's *own* port in the evidence.
	const server = await listen();
	try {
		const app = await boot({ _baseUrl: `http://127.0.0.1:${server.port}/v1` });
		await app.emit("agent_end", { messages: [NET_ERROR] });
		await app.emit("agent_settled");
		await waitFor(() => app.events().includes("not_arming_online"), 3000, "the online check");
		const entry = app.readLog().find((e) => e.event === "not_arming_online");
		assert.equal(entry.detail, `127.0.0.1:${server.port} reachable`);
	} finally {
		await server.close();
	}
});

test("an http endpoint is probed on 80, not 443", async () => {
	// A closed port 80 on loopback: the probe must target 80 and fail, so the
	// extension must stay waiting rather than resume.
	const app = await boot({ _baseUrl: "http://127.0.0.1/v1", maxWaitMinutes: 1 });
	await app.emit("agent_end", { messages: [NET_ERROR] });
	await app.emit("agent_settled");
	await waitFor(() => app.readLog().some((e) => e.event === "waiting_for_network"), 2000, "waiting state");
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(app.sent.length, 0, "http:// endpoint on a closed port 80 must not resume");
	await app.emit("session_shutdown");
});

test("an IPv6 endpoint is parsed into host and port", async () => {
	// [::1]:<closed port> must be probed literally; the scheme default must not
	// overwrite the explicit port.
	const app = await boot({ _baseUrl: "http://[::1]:9/v1" });
	await app.emit("agent_end", { messages: [NET_ERROR] });
	await app.emit("agent_settled");
	await waitFor(() => app.readLog().some((e) => e.event === "waiting_for_network"), 2000, "waiting state");
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(app.sent.length, 0, "[::1]:9 must not resume");
	await app.emit("session_shutdown");
});

test("a scheme-less host:port from extraProbeHosts is used as-is", async () => {
	// 127.0.0.1 is unreachable on port 1, so the extra probe host is what makes
	// the link look healthy -- and it must be taken literally, not rewritten to
	// the scheme default port.
	const server = await listen();
	try {
		const app = await boot({ _baseUrl: "http://127.0.0.1:1/v1", extraProbeHosts: [`127.0.0.1:${server.port}`] });
		await app.emit("agent_end", { messages: [NET_ERROR] });
		await app.emit("agent_settled");
		await waitFor(() => app.events().includes("not_arming_online"), 3000, "the online check");
		const entry = app.readLog().find((e) => e.event === "not_arming_online");
		assert.equal(entry.detail, `127.0.0.1:${server.port} reachable`);
	} finally {
		await server.close();
	}
});

// -- config resolution (portability of a packaged install) --------------- //

test("a config in the agent dir is found without PI_NET_RESUME_CONFIG", async () => {
	// Simulates `pi install npm:pi-net-resume`, where the package lives under
	// ~/.pi/agent/npm/... and the legacy extensions/<id>/config.json does not
	// exist.  The <agent dir>/pi-net-resume.json location must be honoured.
	const agent = mkdtempSync(join(tmpdir(), "pi-net-resume-agent-"));
	writeFileSync(join(agent, "pi-net-resume.json"), JSON.stringify({ maxAutoResumes: 7, minSecondsBetweenResumes: 42 }), "utf8");

	const previousConfig = process.env.PI_NET_RESUME_CONFIG;
	const previousAgent = process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_NET_RESUME_CONFIG;
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		const module = await import(`${EXTENSION}?t=${Date.now()}`);
		const commands = new Map();
		const notifications = [];
		module.default({
			on() {},
			registerCommand: (name, options) => commands.set(name, options),
			appendEntry() {},
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
			sendUserMessage() {},
		});
		const ctx = {
			model: { baseUrl: "http://127.0.0.1:1/v1" },
			isIdle: () => true,
			ui: { setStatus() {}, notify: (m) => notifications.push(m) },
		};
		await commands.get("pi-net-resume").handler("", ctx);
		const status = notifications.at(-1);
		assert.match(status, /maxAutoResumes|resumes used\s*:\s*0\/7/);
		assert.equal(status.includes("pi-net-resume.json"), true, `config path should be reported: ${status}`);
	} finally {
		if (previousConfig === undefined) delete process.env.PI_NET_RESUME_CONFIG;
		else process.env.PI_NET_RESUME_CONFIG = previousConfig;
		if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgent;
	}
});

// ------------------------------------------------------------------------- //

for (const [name, fn] of tests) {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failures += 1;
		console.error(`FAIL ${name}\n     ${error.message}`);
	}
}

console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures === 0 ? 0 : 1);
