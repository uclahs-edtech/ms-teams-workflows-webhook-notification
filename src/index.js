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
const MAX_RESPONSE_BODY_LENGTH = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

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
 * @param {boolean} params.includeContext
 * @param {string}  params.buttonText
 * @param {string}  params.buttonUrl
 * @returns {object} Webhook request payload.
 */
function buildAdaptiveCardPayload({ title, message, includeContext, buttonText, buttonUrl }) {
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
 * @param {string}  params.color
 * @param {boolean} params.includeContext
 * @param {string}  params.buttonText
 * @param {string}  params.buttonUrl
 * @returns {object} Webhook request payload.
 */
function buildMessageCardPayload({ title, message, color, includeContext, buttonText, buttonUrl }) {
	const payload = {
		'@type':    'MessageCard',
		'@context': 'http://schema.org/extensions',
		themeColor: color.replace('#', ''),
		summary:    title,
		sections: [
			{
				activityTitle: title,
				activityText:  message,
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
		const rawColor      = core.getInput('color');
		const rawButtonText = core.getInput('button-text');
		const rawButtonUrl  = core.getInput('button-url');
		const cardType      = core.getInput('card-type').toLowerCase().trim();
		const includeCtx    = core.getInput('include-github-context').trim() === 'true';
		const dryRun        = core.getInput('dry-run').trim() === 'true';

		// --- Register webhook URL as a secret so it never appears in logs ---
		core.setSecret(rawWebhookUrl);

		// --- Validate webhook URL (SSRF prevention) ---
		const parsedUrl = validateWebhookUrl(rawWebhookUrl);

		// --- Sanitize text inputs ---
		const title      = sanitizeText(rawTitle,      'title',       MAX_TITLE_LENGTH);
		const message    = sanitizeText(rawMessage,    'message',     MAX_MESSAGE_LENGTH);
		const buttonText = sanitizeText(rawButtonText, 'button-text', MAX_BUTTON_LENGTH);
		const color      = validateColor(rawColor);

		// --- Validate button URL (if provided) ---
		const buttonUrl = validateButtonUrl(rawButtonUrl);

		// --- Validate card type ---
		if (!['adaptive', 'message'].includes(cardType)) {
			throw new Error(`Invalid card-type "${cardType}". Must be "adaptive" or "message".`);
		}

		// --- Build payload ---
		const params  = { title, message, color, includeContext: includeCtx, buttonText, buttonUrl };
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
	buildAdaptiveCardPayload,
	buildMessageCardPayload,
	buildGitHubFacts,
	postJson,
	run,
};

if (require.main === module) {
	run();
}
