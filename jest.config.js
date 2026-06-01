// jest.config.js
'use strict';

/** @type {import('jest').Config} */
module.exports = {
	testEnvironment: 'node',
	testMatch: ['**/__tests__/**/*.test.js'],

	collectCoverageFrom: [
		'src/**/*.js',
		'!src/**/*.test.js',
	],

	// ✅ coverageThresholds → coverageThreshold (s 제거)
	coverageThreshold: {
		global: {
			branches:   80,
			functions:  80,
			lines:      80,
			statements: 80,
		},
	},

	coverageReporters: ['text', 'lcov', 'clover'],
	clearMocks: true,
	restoreMocks: true,
};