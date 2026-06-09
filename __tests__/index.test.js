// __tests__/index.test.js
// Unit tests for input validation and payload building logic.
/* eslint-disable security/detect-object-injection */

'use strict';

// --- Mocks must be declared before any require() calls ---
jest.mock('@actions/core');
jest.mock('@actions/github', () => ({
	context: {
		repo:      { owner: 'test-owner', repo: 'test-repo' },
		ref:       'refs/heads/main',
		actor:     'test-actor',
		workflow:  'CI',
		runNumber: 42,
		eventName: 'push',
	},
}));

const core  = require('@actions/core');
const github = require('@actions/github');
const https = require('https');
const { URL } = require('url');

const {
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
	postJson,
	run,
} = require('../src/index');

// ─── Module loading ──────────────────────────────────────────────────────────

describe('module loading', () => {
	it('does not execute the action when imported by tests or other modules', () => {
		expect(core.getInput).not.toHaveBeenCalled();
	});
});

// ─── validateWebhookUrl ───────────────────────────────────────────────────────

describe('validateWebhookUrl', () => {
	it('accepts a valid Power Automate URL', () => {
		expect(() =>
			validateWebhookUrl('https://prod-00.westus.logic.azure.com/workflows/abc')
		).not.toThrow();
	});

	it('accepts a regional Azure Logic Apps URL', () => {
		expect(() =>
			validateWebhookUrl('https://prod-99.eastus.logic.azure.com/workflows/abc')
		).not.toThrow();
	});

	it('rejects HTTP (non-HTTPS) URLs', () => {
		expect(() =>
			validateWebhookUrl('http://prod-00.westus.logic.azure.com/workflows/abc')
		).toThrow('only HTTPS');
	});

	it('rejects webhook URLs with embedded credentials', () => {
		expect(() =>
			validateWebhookUrl('https://user:pass@prod-00.westus.logic.azure.com/workflows/abc')
		).toThrow('credentials are not allowed');
	});

	it('rejects webhook URLs with non-default HTTPS ports', () => {
		expect(() =>
			validateWebhookUrl('https://prod-00.westus.logic.azure.com:8443/workflows/abc')
		).toThrow('only the default HTTPS port');
	});

	it('rejects URLs from non-allowed domains (SSRF prevention)', () => {
		expect(() =>
			validateWebhookUrl('https://attacker.example.com/steal')
		).toThrow('not in the allowed domain list');
	});

	it('rejects malformed URLs', () => {
		expect(() =>
			validateWebhookUrl('not-a-url')
		).toThrow('could not be parsed');
	});

	it('returns a parsed URL object on success', () => {
		const result = validateWebhookUrl(
			'https://prod-00.westus.logic.azure.com/workflows/abc'
		);
		expect(result).toBeInstanceOf(URL);
	});

	it('accepts a new Power Platform Workflow webhook URL', () => {
		expect(() =>
			validateWebhookUrl(
				'https://default39c3716b64714fd5ac04a7dbaa3278.2b.environment.api.powerplatform.com/workflows/abc'
			)
		).not.toThrow();
	});
});

// ─── sanitizeText ─────────────────────────────────────────────────────────────

describe('sanitizeText', () => {
	beforeEach(() => jest.clearAllMocks());

	it('trims leading and trailing whitespace', () => {
		expect(sanitizeText('  hello  ', 'title', 100)).toBe('hello');
	});

	it('removes non-printable control characters while preserving newlines and tabs', () => {
		expect(sanitizeText('\u0000hello\n\tworld\u007F', 'message', 100)).toBe(
			'hello\n\tworld'
		);
	});

	it('returns the original string when within max length', () => {
		expect(sanitizeText('hello', 'title', 100)).toBe('hello');
	});

	it('truncates text that exceeds max length and emits a warning', () => {
		const long = 'a'.repeat(300);
		const result = sanitizeText(long, 'message', 200);
		expect(result).toHaveLength(200);
		expect(core.warning).toHaveBeenCalledWith(
			expect.stringContaining('message')
		);
	});

	it('throws when value is not a string', () => {
		expect(() => sanitizeText(123, 'title', 100)).toThrow(
			'Input "title" must be a string.'
		);
	});
});

// ─── validateButtonUrl ────────────────────────────────────────────────────────

describe('validateButtonUrl', () => {
	it('accepts a valid HTTPS URL', () => {
		expect(validateButtonUrl('https://github.com/owner/repo')).toBe(
			'https://github.com/owner/repo'
		);
	});

	it('returns empty string for blank input', () => {
		expect(validateButtonUrl('')).toBe('');
	});

	it('returns empty string for whitespace-only input', () => {
		expect(validateButtonUrl('   ')).toBe('');
	});

	it('rejects HTTP button URLs', () => {
		expect(() => validateButtonUrl('http://github.com')).toThrow('only HTTPS');
	});

	it('rejects button URLs with embedded credentials', () => {
		expect(() => validateButtonUrl('https://user:pass@github.com')).toThrow(
			'credentials are not allowed'
		);
	});

	it('rejects malformed button URLs', () => {
		expect(() => validateButtonUrl('not-a-url')).toThrow('could not be parsed');
	});
});

// ─── validateColor ────────────────────────────────────────────────────────────

describe('validateColor', () => {
	beforeEach(() => jest.clearAllMocks());

	it('accepts a valid 6-digit hex color', () => {
		expect(validateColor('#0078D4')).toBe('#0078D4');
	});

	it('accepts a valid 3-digit hex color', () => {
		expect(validateColor('#fff')).toBe('#fff');
	});

	it('falls back to default color for invalid input and emits a warning', () => {
		const result = validateColor('not-a-color');
		expect(result).toBe('#0078D4');
		expect(core.warning).toHaveBeenCalled();
	});

	it('falls back to default color when hash is missing', () => {
		const result = validateColor('0078D4');
		expect(result).toBe('#0078D4');
	});
});

// ─── formatDetailPayload ─────────────────────────────────────────────────────

describe('formatDetailPayload', () => {
	beforeEach(() => jest.clearAllMocks());

	it('returns empty string for blank input', () => {
		expect(formatDetailPayload('   ')).toBe('');
	});

	it('pretty-prints JSON payloads', () => {
		const result = formatDetailPayload('{"status":"success","steps":[{"name":"build"}]}');
		expect(result).toContain('"status": "success"');
		expect(result).toContain('"name": "build"');
	});

	it('keeps non-JSON payloads as text', () => {
		expect(formatDetailPayload('plain detail text')).toBe('plain detail text');
	});

	it('truncates long payloads and emits a warning', () => {
		const result = formatDetailPayload('a'.repeat(7000));
		expect(result).toHaveLength(6000);
		expect(core.warning).toHaveBeenCalledWith(
			expect.stringContaining('payload')
		);
	});

	it('throws when value is not a string', () => {
		expect(() => formatDetailPayload({ status: 'success' })).toThrow(
			'Input "payload" must be a string.'
		);
	});
});

// ─── generated detail payload ────────────────────────────────────────────────

describe('generated detail payload', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		github.context.payload = {
			commits: [
				{ message: 'SPMS-169 fixed the educator filter in timeslots page\n\nBody' },
				{
					message:
						'Merge pull request #56 from ets/feature/SPMS-169-as-an-admin-i-want-to-filter-timeslots-by-educator',
				},
			],
		};
		jest.useFakeTimers().setSystemTime(new Date('2026-05-29T00:19:15Z'));
	});

	afterEach(() => {
		jest.useRealTimers();
		github.context.payload = undefined;
	});

	it('formats known statuses for generated details', () => {
		expect(formatStatusLine('success')).toBe('Success!');
		expect(formatStatusLine('failure')).toBe('Failed!');
		expect(formatStatusLine('cancelled')).toBe('Cancelled!');
		expect(formatStatusLine('skipped')).toBe('Skipped!');
		expect(formatStatusLine('timed_out')).toBe('Timed_out!');
	});

	it('formats timestamps in the requested timezone', () => {
		expect(formatTimestamp(new Date('2026-05-29T00:19:15Z'))).toBe(
			'05/28/2026 17:19:15'
		);
	});

	it('formats timestamps with default arguments', () => {
		expect(formatTimestamp()).toBe('05/28/2026 17:19:15');
	});

	it('falls back to the default timezone when timezone is invalid', () => {
		const result = formatTimestamp(new Date('2026-05-29T00:19:15Z'), 'Invalid/Timezone');
		expect(result).toBe('05/28/2026 17:19:15');
		expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Invalid timezone'));
	});

	it('converts sparse GitHub job payloads to changelog details', () => {
		const result = buildGeneratedDetailPayload(
			'{"status":"success","container":{}}',
			'America/Los_Angeles'
		);

		expect(result).toContain('Changelog:');
		expect(result).toContain('SPMS-169 fixed the educator filter in timeslots page');
		expect(result).toContain(
			'Merge pull request #56 from ets/feature/SPMS-169-as-an-admin-i-want-to-filter-timeslots-by-educator'
		);
		expect(result).toContain('Success!');
		expect(result).toContain('05/28/2026 17:19:15');
		expect(result).not.toContain('"container"');
	});

	it('uses fallback event titles when commits are unavailable', () => {
		github.context.payload = {
			head_commit: {
				message: 'Release 2.3 SPMS-169 fix\n\nFull release notes',
			},
		};

		expect(buildChangelogLines()).toEqual(['Release 2.3 SPMS-169 fix']);
	});

	it('returns no changelog lines when no event messages are available', () => {
		github.context.payload = {};
		expect(buildChangelogLines()).toEqual([]);
	});

	it('returns no changelog lines when event payload is missing', () => {
		github.context.payload = undefined;
		expect(buildChangelogLines()).toEqual([]);
	});

	it('ignores commits without messages', () => {
		github.context.payload = {
			commits: [null, {}, { message: '' }],
		};

		expect(buildChangelogLines()).toEqual([]);
	});

	it('uses pull request titles when commit and head commit messages are unavailable', () => {
		github.context.payload = {
			pull_request: {
				title: 'Merge pull request #57 from ets/staging',
			},
		};

		expect(buildChangelogLines()).toEqual(['Merge pull request #57 from ets/staging']);
	});

	it('uses release names and tags as changelog fallbacks', () => {
		github.context.payload = {
			release: {
				name: 'Release 2.3 SPMS-169 fix',
				tag_name: 'v2.3.0',
			},
		};
		expect(buildChangelogLines()).toEqual(['Release 2.3 SPMS-169 fix']);

		github.context.payload = {
			release: {
				tag_name: 'v2.3.0',
			},
		};
		expect(buildChangelogLines()).toEqual(['v2.3.0']);
	});

	it('builds generated job details without a changelog section when no messages exist', () => {
		github.context.payload = {};
		const result = buildGeneratedDetailPayload(
			'{"status":"success","container":{}}',
			'America/Los_Angeles'
		);

		expect(result).toBe('Success!\n05/28/2026 17:19:15');
	});

	it('truncates generated job details and emits a warning', () => {
		github.context.payload = {
			commits: Array.from({ length: 20 }, (_, index) => ({
				message: `${index} ${'a'.repeat(400)}`,
			})),
		};

		const result = buildGeneratedDetailPayload(
			'{"status":"success","container":{}}',
			'America/Los_Angeles'
		);

		expect(result).toHaveLength(6000);
		expect(core.warning).toHaveBeenCalledWith(
			expect.stringContaining('Generated payload exceeds')
		);
	});

	it('keeps non-job payloads as formatted payload text', () => {
		const result = buildGeneratedDetailPayload('{"status":"success"}', 'America/Los_Angeles');
		expect(result).toContain('"status": "success"');
		expect(result).not.toContain('Changelog:');
	});

	it('keeps array payloads as formatted payload text', () => {
		const result = buildGeneratedDetailPayload('[{"status":"success"}]', 'America/Los_Angeles');
		expect(result).toContain('"status": "success"');
		expect(result).not.toContain('Success!');
	});
});

// ─── buildAdaptiveCardPayload ─────────────────────────────────────────────────

describe('buildAdaptiveCardPayload', () => {
	const baseParams = {
		title:          'Test Title',
		message:        'Test message',
		detailPayload:  '',
		includeContext: false,
		buttonText:     '',
		buttonUrl:      '',
	};

	it('returns a valid Workflow webhook envelope', () => {
		const payload = buildAdaptiveCardPayload(baseParams);
		expect(payload.type).toBe('message');
		expect(payload.attachments).toHaveLength(1);
		expect(payload.attachments[0].contentType).toBe(
			'application/vnd.microsoft.card.adaptive'
		);
	});

	it('includes title and message in card body', () => {
		const payload = buildAdaptiveCardPayload(baseParams);
		const body = payload.attachments[0].content.body;
		expect(body[0].text).toBe('Test Title');
		expect(body[1].text).toBe('Test message');
	});

	it('includes FactSet when includeContext is true', () => {
		const payload = buildAdaptiveCardPayload({ ...baseParams, includeContext: true });
		const body = payload.attachments[0].content.body;
		const factSet = body.find((b) => b.type === 'FactSet');
		expect(factSet).toBeDefined();
		expect(factSet.facts.length).toBeGreaterThan(0);
	});

	it('does not include FactSet when includeContext is false', () => {
		const payload = buildAdaptiveCardPayload(baseParams);
		const body = payload.attachments[0].content.body;
		const factSet = body.find((b) => b.type === 'FactSet');
		expect(factSet).toBeUndefined();
	});

	it('includes action button when both buttonText and buttonUrl are provided', () => {
		const payload = buildAdaptiveCardPayload({
			...baseParams,
			buttonText: 'View Run',
			buttonUrl:  'https://github.com/run/1',
		});
		const actions = payload.attachments[0].content.actions;
		expect(actions).toHaveLength(1);
		expect(actions[0].type).toBe('Action.OpenUrl');
		expect(actions[0].url).toBe('https://github.com/run/1');
	});

	it('does not include actions when button fields are empty', () => {
		const payload = buildAdaptiveCardPayload(baseParams);
		expect(payload.attachments[0].content.actions).toBeUndefined();
	});

	it('includes detail payload when provided', () => {
		const payload = buildAdaptiveCardPayload({
			...baseParams,
			detailPayload: '{\n  "status": "success"\n}',
		});
		const body = payload.attachments[0].content.body;
		const detail = body.find((b) => b.fontType === 'Monospace');
		expect(detail).toBeDefined();
		expect(detail.text).toContain('"status": "success"');
	});
});

// ─── buildMessageCardPayload ──────────────────────────────────────────────────

describe('buildMessageCardPayload', () => {
	const baseParams = {
		title:          'Test Title',
		message:        'Test message',
		detailPayload:  '',
		color:          '#FF0000',
		includeContext: false,
		buttonText:     '',
		buttonUrl:      '',
	};

	it('returns a valid MessageCard object', () => {
		const payload = buildMessageCardPayload(baseParams);
		expect(payload['@type']).toBe('MessageCard');
		expect(payload['@context']).toBe('http://schema.org/extensions');
	});

	it('sets themeColor without the leading hash', () => {
		const payload = buildMessageCardPayload(baseParams);
		expect(payload.themeColor).toBe('FF0000');
	});

	it('includes potentialAction when button fields are provided', () => {
		const payload = buildMessageCardPayload({
			...baseParams,
			buttonText: 'Open',
			buttonUrl:  'https://github.com',
		});
		expect(payload.potentialAction).toHaveLength(1);
		expect(payload.potentialAction[0]['@type']).toBe('OpenUri');
	});

	it('does not include potentialAction when button fields are empty', () => {
		const payload = buildMessageCardPayload(baseParams);
		expect(payload.potentialAction).toBeUndefined();
	});

	it('includes facts when includeContext is true', () => {
		const payload = buildMessageCardPayload({
			title:          'Test Title',
			message:        'Test message',
			detailPayload:  '',
			color:          '#FF0000',
			includeContext: true,   // ← 267번 브랜치 커버
			buttonText:     '',
			buttonUrl:      '',
		});
		expect(payload.sections[0].facts.length).toBeGreaterThan(0);
	});

	it('includes detail payload in activity text when provided', () => {
		const payload = buildMessageCardPayload({
			...baseParams,
			detailPayload: '{\n  "conclusion": "success"\n}',
		});
		expect(payload.sections[0].activityText).toContain('**Details**');
		expect(payload.sections[0].activityText).toContain('"conclusion": "success"');
	});
});

// ─── postJson ─────────────────────────────────────────────────────────────────

describe('postJson', () => {
	afterEach(() => jest.restoreAllMocks());

	it('resolves with status and body on success', async () => {
		// Mock https.request to simulate a 200 response
		jest.spyOn(https, 'request').mockImplementation((options, callback) => {
			const mockRes = {
				statusCode: 200,
				on: jest.fn((event, handler) => {
					if (event === 'data') handler('{"result":"ok"}');
					if (event === 'end')  handler();
				}),
			};
			callback(mockRes);
			return {
				on:      jest.fn().mockReturnThis(),
				write:   jest.fn(),
				end:     jest.fn(),
				destroy: jest.fn(),
			};
		});

		const parsedUrl = new URL('https://prod-00.westus.logic.azure.com/workflows/abc');
		const result = await postJson(parsedUrl, { type: 'message' });
		expect(result.status).toBe(200);
		expect(result.body).toBe('{"result":"ok"}');
	});

	it('caps the collected response body', async () => {
		jest.spyOn(https, 'request').mockImplementation((options, callback) => {
			const mockRes = {
				statusCode: 200,
				on: jest.fn((event, handler) => {
					if (event === 'data') {
						handler('x'.repeat(70 * 1024));
						handler('y');
					}
					if (event === 'end')  handler();
				}),
			};
			callback(mockRes);
			return {
				on:      jest.fn().mockReturnThis(),
				write:   jest.fn(),
				end:     jest.fn(),
				destroy: jest.fn(),
			};
		});

		const parsedUrl = new URL('https://prod-00.westus.logic.azure.com/workflows/abc');
		const result = await postJson(parsedUrl, {});
		expect(result.body).toHaveLength(64 * 1024);
		expect(result.body).not.toContain('y');
	});

	it('rejects on request error', async () => {
		jest.spyOn(https, 'request').mockImplementation(() => {
			const req = {
				on: jest.fn((event, handler) => {
					if (event === 'error') handler(new Error('Network failure'));
					return req;
				}),
				write:   jest.fn(),
				end:     jest.fn(),
				destroy: jest.fn(),
			};
			return req;
		});

		const parsedUrl = new URL('https://prod-00.westus.logic.azure.com/workflows/abc');
		await expect(postJson(parsedUrl, {})).rejects.toThrow('Network failure');
	});

	it('rejects on timeout and calls destroy', async () => {
		const mockDestroy = jest.fn();

		jest.spyOn(https, 'request').mockImplementation(() => {
			const req = {
				on: jest.fn((event, handler) => {
					if (event === 'timeout') handler();
					return req;
				}),
				write:   jest.fn(),
				end:     jest.fn(),
				destroy: mockDestroy,   // ← destroy 호출 여부 확인
			};
			return req;
		});

		const parsedUrl = new URL('https://prod-00.westus.logic.azure.com/workflows/abc');
		await expect(postJson(parsedUrl, {})).rejects.toThrow('timed out');
		expect(mockDestroy).toHaveBeenCalled();   // 319번 라인 커버
	});
});

// ─── run ──────────────────────────────────────────────────────────────────────

describe('run', () => {
	// Default valid inputs
	const defaultInputs = {
		'webhook-url':            'https://prod-00.westus.logic.azure.com/workflows/abc',
		'title':                  'Test Title',
		'message':                'Test message',
		'payload':                '',
		'color':                  '#0078D4',
		'include-github-context': 'false',
		'button-text':            '',
		'button-url':             '',
		'card-type':              'adaptive',
		'timezone':               'America/Los_Angeles',
		'dry-run':                'false',
	};

	beforeEach(() => {
		// Mock all core functions
		core.getInput.mockImplementation((name) => defaultInputs[name] ?? '');
		core.setSecret.mockImplementation(() => {});
		core.setOutput.mockImplementation(() => {});
		core.setFailed.mockImplementation(() => {});
		core.info.mockImplementation(() => {});
		core.debug.mockImplementation(() => {});
		core.warning.mockImplementation(() => {});

		// Mock https.request to simulate a successful 200 response by default
		jest.spyOn(https, 'request').mockImplementation((options, callback) => {
			const mockRes = {
				statusCode: 200,
				on: jest.fn((event, handler) => {
					if (event === 'data') handler('');
					if (event === 'end')  handler();
				}),
			};
			callback(mockRes);
			return {
				on:      jest.fn().mockReturnThis(),
				write:   jest.fn(),
				end:     jest.fn(),
				destroy: jest.fn(),
			};
		});
	});

	afterEach(() => jest.restoreAllMocks());

	it('sends adaptive card and sets output status on success', async () => {
		await run();
		expect(core.setOutput).toHaveBeenCalledWith('status', '200');
		expect(core.setFailed).not.toHaveBeenCalled();
	});

	it('sends message card when card-type is "message"', async () => {
		core.getInput.mockImplementation((name) => ({
			...defaultInputs, 'card-type': 'message',
		}[name] ?? ''));
		await run();
		expect(core.setOutput).toHaveBeenCalledWith('status', '200');
	});

	it('exits early and sets dry-run output when dry-run is true', async () => {
		core.getInput.mockImplementation((name) => ({
			...defaultInputs, 'dry-run': 'true',
		}[name] ?? ''));
		await run();
		expect(core.setOutput).toHaveBeenCalledWith('status', 'dry-run');
		expect(https.request).not.toHaveBeenCalled();
	});

	it('calls setFailed when webhook returns non-2xx status', async () => {
		jest.spyOn(https, 'request').mockImplementation((options, callback) => {
			const mockRes = {
				statusCode: 500,
				on: jest.fn((event, handler) => {
					if (event === 'data') handler('');
					if (event === 'end')  handler();
				}),
			};
			callback(mockRes);
			return {
				on:      jest.fn().mockReturnThis(),
				write:   jest.fn(),
				end:     jest.fn(),
				destroy: jest.fn(),
			};
		});
		await run();
		expect(core.setFailed).toHaveBeenCalledWith(
			expect.stringContaining('500')
		);
	});

	it('calls setFailed when card-type is invalid', async () => {
		core.getInput.mockImplementation((name) => ({
			...defaultInputs, 'card-type': 'invalid-type',
		}[name] ?? ''));
		await run();
		expect(core.setFailed).toHaveBeenCalledWith(
			expect.stringContaining('Action failed')
		);
	});

	it('calls setFailed and redacts HTTPS URLs from error message', async () => {
		// Simulate a network error where an HTTPS URL appears in the error message
		jest.spyOn(https, 'request').mockImplementation(() => {
			const req = {
				on: jest.fn((event, handler) => {
					if (event === 'error') {
						handler(new Error(
							'connect ECONNREFUSED https://prod-00.westus.logic.azure.com/workflows/abc'
						));
					}
					return req;
				}),
				write:   jest.fn(),
				end:     jest.fn(),
				destroy: jest.fn(),
			};
			return req;
		});
		await run();
		// URL must be redacted — must not appear in the logged error
		expect(core.setFailed).toHaveBeenCalledWith(
			expect.stringContaining('[REDACTED_URL]')
		);
		expect(core.setFailed).toHaveBeenCalledWith(
			expect.not.stringContaining('https://')
		);
	});

	it('includes payload input in the sent request body', async () => {
		let requestBody = '';
		jest.spyOn(https, 'request').mockImplementation((options, callback) => {
			const mockRes = {
				statusCode: 200,
				on: jest.fn((event, handler) => {
					if (event === 'data') handler('');
					if (event === 'end')  handler();
				}),
			};
			callback(mockRes);
			return {
				on:      jest.fn().mockReturnThis(),
				write:   jest.fn((data) => { requestBody = data; }),
				end:     jest.fn(),
				destroy: jest.fn(),
			};
		});

		core.getInput.mockImplementation((name) => ({
			...defaultInputs,
			'payload': '{"status":"success"}',
		}[name] ?? ''));

		await run();

		const sentPayload = JSON.parse(requestBody);
		const body = sentPayload.attachments[0].content.body;
		const detail = body.find((b) => b.fontType === 'Monospace');
		expect(detail.text).toContain('"status": "success"');
	});

	it('uses the default timezone when timezone input is blank', async () => {
		let requestBody = '';
		jest.spyOn(https, 'request').mockImplementation((options, callback) => {
			const mockRes = {
				statusCode: 200,
				on: jest.fn((event, handler) => {
					if (event === 'data') handler('');
					if (event === 'end')  handler();
				}),
			};
			callback(mockRes);
			return {
				on:      jest.fn().mockReturnThis(),
				write:   jest.fn((data) => { requestBody = data; }),
				end:     jest.fn(),
				destroy: jest.fn(),
			};
		});

		jest.useFakeTimers().setSystemTime(new Date('2026-05-29T00:19:15Z'));
		github.context.payload = {};
		core.getInput.mockImplementation((name) => ({
			...defaultInputs,
			'payload':  '{"status":"success","container":{}}',
			'timezone': '',
		}[name] ?? ''));

		await run();

		const sentPayload = JSON.parse(requestBody);
		const body = sentPayload.attachments[0].content.body;
		const detail = body.find((b) => b.fontType === 'Monospace');
		expect(detail.text).toContain('05/28/2026 17:19:15');
		jest.useRealTimers();
	});
});

describe('buildGitHubFacts', () => {
	const { buildGitHubFacts } = require('../src/index');

	it('returns an array of fact objects', () => {
		const facts = buildGitHubFacts();
		expect(Array.isArray(facts)).toBe(true);
		expect(facts.length).toBeGreaterThan(0);
		expect(facts[0]).toHaveProperty('title');
		expect(facts[0]).toHaveProperty('value');
	});

	it('falls back to N/A when context values are null or undefined', () => {
		// Override github mock to return null values
		jest.mock('@actions/github', () => ({
			context: {
				repo:      { owner: null, repo: undefined },  // ← 154번 브랜치 커버
				ref:       null,
				actor:     undefined,
				workflow:  null,
				runNumber: null,
				eventName: undefined,
			},
		}));

		jest.resetModules();
		const { buildGitHubFacts: buildGitHubFactsFresh } = require('../src/index');
		const facts = buildGitHubFactsFresh();

		// All null/undefined values should be sanitized to 'N/A'
		facts.forEach((fact) => {
			expect(fact.value).not.toBeNull();
			expect(fact.value).not.toBeUndefined();
		});
	});
});
