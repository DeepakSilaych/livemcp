import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', timeout: 15000, fullyParallel: true, use: { headless: true, launchOptions: process.env.LIVEMCP_CHROME ? { executablePath: process.env.LIVEMCP_CHROME } : {} } });
