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

	// Jest expects the singular coverageThreshold key.
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
