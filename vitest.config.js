"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var config_1 = require("vitest/config");
exports.default = (0, config_1.defineConfig)({
    test: {
        exclude: [
            "**/node_modules/**",
            "**/dist/**",
            "test/**",
            "e2e/**",
            "contracts/**",
            "contracts-stellar/**",
        ],
        projects: [
            // ── Node / crypto / service tests ─────────────────────────────────────
            // fileParallelism:false runs test files serially in one fork, so tests
            // that share module-level state (e.g. mocked singletons) don't race.
            // testTimeout is set high to cover the streaming 1 GB benchmark.
            {
                test: {
                    name: "node",
                    include: ["src/__tests__/**/*.test.ts"],
                    globals: true,
                    pool: "forks",
                    fileParallelism: false,
                    hookTimeout: 30000,
                    testTimeout: 10 * 60 * 1000, // 10 min — covers 1 GB benchmark
                },
            },
            // ── jsdom / React component tests ─────────────────────────────────────
            // Isolated project so the jsdom worker never queues behind the heavy
            // node crypto benchmarks (root cause of the worker-start timeout).
            // setupFiles runs once per worker process before any test module loads.
            // server.deps.inline ensures @heroui and framer-motion are processed by Vite
            // transform pipeline so vi.mock intercepts them properly.
            {
                test: {
                    name: "jsdom",
                    include: ["src/__tests__/**/*.test.tsx"],
                    globals: true,
                    environment: "jsdom",
                    pool: "forks",
                    server: {
                        deps: {
                            inline: [/@heroui\/.*/, "framer-motion"],
                        },
                    },
                    setupFiles: ["./src/__tests__/setup.jsdom.ts"],
                    testTimeout: 30000,
                },
            },
        ],
    },
});
