// src/index.js
// MS Teams Workflows Webhook Notification Action
// Sends Adaptive Card or Message Card payloads to a Teams channel
// via the new Power Automate Workflow incoming webhook.

'use strict';

const core   = require('@actions/core');
const github = require('@actions/github');
const https  = require('https');
const { URL } = require('url');

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_TITLE_LENGTH   = 200;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_BUTTON_LENGTH  = 100;
const MAX_PAYLOAD_LENGTH = 6000;
const MAX_RESPONSE_BODY_LENGTH = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEZONE = 'America/Los_Angeles';

// Only allow Microsoft-owned domains for the webhook URL (SSRF prevention).
// Power Automate webhook URLs are always under these domains.
const ALLOWED_WEBHOOK_HOSTS = [
	// Legacy Azure Logic Apps / Power Automate (older webhooks)
	'prod-00.westus.logic.azure.com',
	'prod-01.westus.logic.azure.com',
	/^[\w-]+\.[\w-]+\.logic\.azure\.com$/,
	/^[\w-]+\.logic\.azure\.com$/,
	/^[\w-]+\.logic\.azure\.us$/,
	/^[\w-]+\.logic\.azure\.cn$/,
	/^[\w-]+\.[\w-]+\.logic\.azure\.us$/,
	/^[\w-]+\.[\w-]+\.logic\.azure\.cn$/,
	/^[\w-]+\.[\w-]+\.environment\.api\.powerplatform\.com$/,
	/^[\w-]+\.environment\.api\.powerplatform\.com$/,
	/^[\w-]+\.api\.powerplatform\.com$/,
];

// ─── Input Validation & Sanitization ─────────────────────────────────────────

/**
 * Validates that the webhook URL is HTTPS and belongs to an allowed domain.
 * Throws an error if validation fails.
 *
 * @param {string} rawUrl - The raw webhook URL string from action input.
 * @returns {URL} Parsed and validated URL object.
 */
function validateWebhookUrl(rawUrl) {
	let parsed;

	try {
		parsed = new URL(rawUrl);
	} catch {
		throw new Error('Invalid webhook URL: could not be parsed as a URL.');
	}

	if (parsed.protocol !== 'https:') {
		throw new Error('Invalid webhook URL: only HTTPS is allowed.');
	}

	if (parsed.username || parsed.password) {
		throw new Error('Invalid webhook URL: credentials are not allowed.');
	}

	if (parsed.port && parsed.port !== '443') {
		throw new Error('Invalid webhook URL: only the default HTTPS port is allowed.');
	}

	const host = parsed.hostname.toLowerCase();
	const isAllowed = ALLOWED_WEBHOOK_HOSTS.some((entry) =>
		typeof entry === 'string' ? entry === host : entry.test(host)
	);

	if (!isAllowed) {
		throw new Error(
			`Webhook URL host "${host}" is not in the allowed domain list. ` +
			'Ensure the URL is a valid MS Teams / Power Automate webhook URL.'
		);
	}

	return parsed;
}

/**
 * Sanitizes a plain-text input by trimming whitespace, removing non-printable
 * control characters, and enforcing a max length.
 *
 * @param {string} value  - Raw input string.
 * @param {string} name   - Field name (used in error messages).
 * @param {number} maxLen - Maximum allowed character length.
 * @returns {string} Sanitized string.
 */
function sanitizeText(value, name, maxLen) {
	if (typeof value !== 'string') {
		throw new Error(`Input "${name}" must be a string.`);
	}

	const trimmed = Array.from(value)
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code === 9 || code === 10 || code === 13 || (code > 31 && code !== 127);
		})
		.join('')
		.trim();

	if (trimmed.length > maxLen) {
		core.warning(
			`Input "${name}" exceeds ${maxLen} characters and will be truncated.`
		);
		return trimmed.slice(0, maxLen);
	}

	return trimmed;
}

/**
 * Validates and sanitizes the button URL.
 * Only HTTPS URLs are allowed for action buttons.
 *
 * @param {string} rawUrl - Raw button URL string.
 * @returns {string} The validated URL string, or empty string if blank.
 */
function validateButtonUrl(rawUrl) {
	const url = rawUrl.trim();
	if (!url) return '';

	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error('Invalid button-url: could not be parsed as a URL.');
	}

	if (parsed.protocol !== 'https:') {
		throw new Error('Invalid button-url: only HTTPS URLs are allowed.');
	}

	if (parsed.username || parsed.password) {
		throw new Error('Invalid button-url: credentials are not allowed.');
	}

	return parsed.href;
}

/**
 * Validates the hex color string.
 * Falls back to the default blue if the value is invalid.
 *
 * @param {string} value - Raw color string (e.g. "#0078D4").
 * @returns {string} Valid hex color string.
 */
function validateColor(value) {
	const DEFAULT_COLOR = '#0078D4';
	const cleaned = value.trim();
	if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(cleaned)) {
		return cleaned;
	}
	core.warning(`Invalid color value "${cleaned}". Falling back to ${DEFAULT_COLOR}.`);
	return DEFAULT_COLOR;
}

/**
 * Formats an optional detail payload for display in the notification card.
 * JSON values are pretty-printed; non-JSON values are displayed as text.
 *
 * @param {string} rawPayload - Raw payload string from action input.
 * @returns {string} Formatted payload text, or empty string if blank.
 */
function formatDetailPayload(rawPayload) {
	if (typeof rawPayload !== 'string') {
		throw new Error('Input "payload" must be a string.');
	}

	const cleaned = Array.from(rawPayload)
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code === 9 || code === 10 || code === 13 || (code > 31 && code !== 127);
		})
		.join('')
		.trim();

	if (!cleaned) return '';

	let formatted = cleaned;
	try {
		formatted = JSON.stringify(JSON.parse(cleaned), null, 2);
	} catch {
		// Keep non-JSON payloads as plain text.
	}

	if (formatted.length > MAX_PAYLOAD_LENGTH) {
		core.warning(
			`Input "payload" exceeds ${MAX_PAYLOAD_LENGTH} characters and will be truncated.`
		);
		return formatted.slice(0, MAX_PAYLOAD_LENGTH);
	}

	return formatted;
}

function parseJsonObject(value) {
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed
			: null;
	} catch {
		return null;
	}
}

function isSparseJobPayload(payload) {
	if (!payload || typeof payload.status !== 'string') return false;
	if (!Object.prototype.hasOwnProperty.call(payload, 'container')) return false;

	return Object.keys(payload).every((key) =>
		['status', 'container', 'services'].includes(key)
	);
}

function formatStatusLine(status) {
	const normalized = status.trim().toLowerCase();

	switch (normalized) {
		case 'success':
			return 'Success!';
		case 'failure':
		case 'failed':
			return 'Failed!';
		case 'cancelled':
		case 'canceled':
			return 'Cancelled!';
		case 'skipped':
			return 'Skipped!';
		default:
			return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}!`;
	}
}

function formatTimestamp(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone,
			year:      'numeric',
			month:     '2-digit',
			day:       '2-digit',
			hour:      '2-digit',
			minute:    '2-digit',
			second:    '2-digit',
			hour12:    false,
			hourCycle: 'h23',
		}).formatToParts(date);

		const value = (type) => parts.find((part) => part.type === type)?.value;
		return `${value('month')}/${value('day')}/${value('year')} ${value('hour')}:${value('minute')}:${value('second')}`;
	} catch {
		core.warning(`Invalid timezone "${timeZone}". Falling back to ${DEFAULT_TIMEZONE}.`);
		return formatTimestamp(date, DEFAULT_TIMEZONE);
	}
}

function buildChangelogLines() {
	const eventPayload = github.context.payload || {};
	const commits = Array.isArray(eventPayload.commits) ? eventPayload.commits : [];
	const messages = commits
		.map((commit) => String(commit?.message || '').split(/\r?\n/)[0].trim())
		.filter(Boolean);

	if (messages.length > 0) {
		return messages.slice(0, 20);
	}

	const fallbackMessage =
		eventPayload.head_commit?.message ||
		eventPayload.pull_request?.title ||
		eventPayload.release?.name ||
		eventPayload.release?.tag_name ||
		'';

	return fallbackMessage
		? [String(fallbackMessage).split(/\r?\n/)[0].trim()].filter(Boolean)
		: [];
}

function buildGeneratedDetailPayload(rawPayload, timeZone) {
	const formattedPayload = formatDetailPayload(rawPayload);
	const parsedPayload = parseJsonObject(formattedPayload);

	if (!isSparseJobPayload(parsedPayload)) {
		return formattedPayload;
	}

	const lines = [];
	const changelogLines = buildChangelogLines();

	if (changelogLines.length > 0) {
		lines.push('Changelog:', ...changelogLines);
	}

	lines.push(formatStatusLine(parsedPayload.status));
	lines.push(formatTimestamp(new Date(), timeZone));

	const generated = lines.join('\n');
	if (generated.length > MAX_PAYLOAD_LENGTH) {
		core.warning(
			`Generated payload exceeds ${MAX_PAYLOAD_LENGTH} characters and will be truncated.`
		);
		return generated.slice(0, MAX_PAYLOAD_LENGTH);
	}

	return generated;
}

// ─── Payload Builders ─────────────────────────────────────────────────────────

/**
 * Builds the GitHub context fact set for display in the Teams card.
 * Sanitizes all values sourced from GitHub context before embedding.
 *
 * @returns {{ title: string, value: string }[]} Array of fact objects.
 */
function buildGitHubFacts() {
	const ctx  = github.context;
	const repo = `${ctx.repo.owner}/${ctx.repo.repo}`;

	// Sanitize context values — they come from external sources (branch names, etc.)
	const sanitize = (v) =>
		String(v ?? 'N/A')
			.replace(/[<>"]/g, '')  // strip HTML/JSON-unsafe chars
			.slice(0, 200);

	return [
		{ title: '📦 Repository', value: sanitize(repo) },
		{ title: '🔀 Ref',        value: sanitize(ctx.ref) },
		{ title: '👤 Actor',      value: sanitize(ctx.actor) },
		{ title: '⚙️  Workflow',  value: sanitize(ctx.workflow) },
		{ title: '🔢 Run',        value: `#${sanitize(ctx.runNumber)}` },
		{ title: '📝 Event',      value: sanitize(ctx.eventName) },
	];
}

/**
 * Builds a Workflow-compatible Adaptive Card payload.
 * This format is required by the new Power Automate webhook trigger.
 *
 * Spec: https://learn.microsoft.com/connectors/teams/#request-body-adaptive-cards
 *
 * @param {object} params
 * @param {string}  params.title
 * @param {string}  params.message
 * @param {string}  params.detailPayload
 * @param {boolean} params.includeContext
 * @param {string}  params.buttonText
 * @param {string}  params.buttonUrl
 * @returns {object} Webhook request payload.
 */
function buildAdaptiveCardPayload({ title, message, detailPayload, includeContext, buttonText, buttonUrl }) {
	const body = [
		{
			type:   'TextBlock',
			text:   title,
			weight: 'Bolder',
			size:   'Medium',
			color:  'Accent',
			wrap:   true,
		},
		{
			type:    'TextBlock',
			text:    message,
			wrap:    true,
			spacing: 'Medium',
		},
	];

	if (detailPayload) {
		body.push(
			{
				type:      'TextBlock',
				text:      'Details',
				weight:    'Bolder',
				spacing:   'Medium',
				separator: true,
				wrap:      true,
			},
			{
				type:     'TextBlock',
				text:     detailPayload,
				fontType: 'Monospace',
				wrap:     true,
				spacing:  'Small',
			}
		);
	}

	if (includeContext) {
		body.push({
			type:      'FactSet',
			facts:     buildGitHubFacts(),
			spacing:   'Medium',
			separator: true,
		});
	}

	const card = {
		$schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
		type:    'AdaptiveCard',
		version: '1.4',
		body,
		msteams: { width: 'Full' },
	};

	// Only add action button when both fields are provided
	if (buttonText && buttonUrl) {
		card.actions = [
			{
				type:  'Action.OpenUrl',
				title: buttonText,
				url:   buttonUrl,
				style: 'positive',
			},
		];
	}

	// Wrap in the Workflow webhook envelope format
	return {
		type: 'message',
		attachments: [
			{
				contentType: 'application/vnd.microsoft.card.adaptive',
				contentUrl:  null,
				content:     card,
			},
		],
	};
}

/**
 * Builds a legacy MessageCard payload.
 * Provided as a fallback for environments that do not support Adaptive Cards.
 *
 * Spec: https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using
 *
 * @param {object} params
 * @param {string}  params.title
 * @param {string}  params.message
 * @param {string}  params.detailPayload
 * @param {string}  params.color
 * @param {boolean} params.includeContext
 * @param {string}  params.buttonText
 * @param {string}  params.buttonUrl
 * @returns {object} Webhook request payload.
 */
function buildMessageCardPayload({ title, message, detailPayload, color, includeContext, buttonText, buttonUrl }) {
	const activityText = detailPayload
		? `${message}\n\n**Details**\n\n\`\`\`json\n${detailPayload}\n\`\`\``
		: message;

	const payload = {
		'@type':    'MessageCard',
		'@context': 'http://schema.org/extensions',
		themeColor: color.replace('#', ''),
		summary:    title,
		sections: [
			{
				activityTitle: title,
				activityText,
				facts:         includeContext ? buildGitHubFacts() : [],
				markdown:      true,
			},
		],
	};

	if (buttonText && buttonUrl) {
		payload.potentialAction = [
			{
				'@type': 'OpenUri',
				name:    buttonText,
				targets: [{ os: 'default', uri: buttonUrl }],
			},
		];
	}

	return payload;
}

// ─── HTTP Client ──────────────────────────────────────────────────────────────

/**
 * Sends a JSON POST request to the given HTTPS URL.
 * Enforces a hard timeout to prevent the action from hanging.
 *
 * @param {URL}    parsedUrl - Pre-validated URL object.
 * @param {object} payload   - JSON-serializable payload object.
 * @returns {Promise<{ status: number, body: string }>}
 */
function postJson(parsedUrl, payload) {
	return new Promise((resolve, reject) => {
		const data = JSON.stringify(payload);

		const options = {
			hostname: parsedUrl.hostname,
			path:     parsedUrl.pathname + parsedUrl.search,
			method:   'POST',
			headers: {
				'Content-Type':   'application/json',
				'Content-Length': Buffer.byteLength(data),
				// Do not forward GitHub token or other env secrets as custom headers
			},
			timeout: REQUEST_TIMEOUT_MS,
		};

		const req = https.request(options, (res) => {
			let body = '';
			res.on('data', (chunk) => {
				if (body.length < MAX_RESPONSE_BODY_LENGTH) {
					body += chunk.toString();
					body = body.slice(0, MAX_RESPONSE_BODY_LENGTH);
				}
			});
			res.on('end',  ()      => { resolve({ status: res.statusCode, body }); });
		});

		req.on('timeout', () => {
			req.destroy();
			reject(new Error(`Webhook request timed out after ${REQUEST_TIMEOUT_MS}ms.`));
		});

		req.on('error', reject);

		req.write(data);
		req.end();
	});
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
	try {
		// --- Read inputs ---
		const rawWebhookUrl = core.getInput('webhook-url', { required: true });
		const rawTitle      = core.getInput('title');
		const rawMessage    = core.getInput('message', { required: true });
		const rawPayload    = core.getInput('payload');
		const rawColor      = core.getInput('color');
		const rawButtonText = core.getInput('button-text');
		const rawButtonUrl  = core.getInput('button-url');
		const cardType      = core.getInput('card-type').toLowerCase().trim();
		const includeCtx    = core.getInput('include-github-context').trim() === 'true';
		const dryRun        = core.getInput('dry-run').trim() === 'true';
		const timezone      = core.getInput('timezone').trim() || DEFAULT_TIMEZONE;

		// --- Register webhook URL as a secret so it never appears in logs ---
		core.setSecret(rawWebhookUrl);

		// --- Validate webhook URL (SSRF prevention) ---
		const parsedUrl = validateWebhookUrl(rawWebhookUrl);

		// --- Sanitize text inputs ---
		const title      = sanitizeText(rawTitle,      'title',       MAX_TITLE_LENGTH);
		const message    = sanitizeText(rawMessage,    'message',     MAX_MESSAGE_LENGTH);
		const detailPayload = buildGeneratedDetailPayload(rawPayload, timezone);
		const buttonText = sanitizeText(rawButtonText, 'button-text', MAX_BUTTON_LENGTH);
		const color      = validateColor(rawColor);

		// --- Validate button URL (if provided) ---
		const buttonUrl = validateButtonUrl(rawButtonUrl);

		// --- Validate card type ---
		if (!['adaptive', 'message'].includes(cardType)) {
			throw new Error(`Invalid card-type "${cardType}". Must be "adaptive" or "message".`);
		}

		// --- Build payload ---
		const params = {
			title,
			message,
			detailPayload,
			color,
			includeContext: includeCtx,
			buttonText,
			buttonUrl,
		};
		const payload = cardType === 'message'
			? buildMessageCardPayload(params)
			: buildAdaptiveCardPayload(params);

		// --- Dry-run: log payload and exit without sending ---
		if (dryRun) {
			core.info('[dry-run] Payload built successfully. No request sent.');
			// Log the payload structure but redact the URL
			core.debug(`[dry-run] Payload: ${JSON.stringify(payload, null, 2)}`);
			core.setOutput('status', 'dry-run');
			return;
		}

		// --- Send request ---
		core.info(`Sending ${cardType} card to Teams webhook...`);
		const { status } = await postJson(parsedUrl, payload);

		core.setOutput('status', String(status));

		if (status < 200 || status >= 300) {
			// Do NOT log body verbatim — it may contain internal MS endpoint info
			core.setFailed(`Teams webhook returned unexpected status: ${status}`);
		} else {
			core.info(`Teams notification sent successfully (HTTP ${status}).`);
		}

	} catch (error) {
		// Ensure webhook URL does not leak through error messages
		const safeMessage = error.message.replace(/https?:\/\/\S+/g, '[REDACTED_URL]');
		core.setFailed(`Action failed: ${safeMessage}`);
	}
}

module.exports = {
	validateWebhookUrl,
	sanitizeText,
	validateButtonUrl,
	validateColor,
	formatDetailPayload,
	buildGeneratedDetailPayload,
	buildChangelogLines,
	formatStatusLine,
	formatTimestamp,
	buildAdaptiveCardPayload,
	buildMessageCardPayload,
	buildGitHubFacts,
	postJson,
	run,
};

/* istanbul ignore next */
if (require.main === module) {
	run();
}
