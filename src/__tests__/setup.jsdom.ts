/**
 * jsdom project setup — runs in each worker process before any test file loads.
 *
 * @heroui/ripple creates animation state and renders LazyMotion from framer-motion
 * whenever buttons are clicked, which triggers state updates outside React act() boundaries:
 *   "An update to LazyMotion inside a test was not wrapped in act(...)"
 *
 * Stubbing both @heroui/ripple and framer-motion completely eliminates this in tests.
 */
import { vi } from "vitest";
import React from "react";

vi.mock("@heroui/ripple", () => ({
  Ripple: () => null,
  useRipple: (props = {}) => ({
    ripples: [],
    onClear: () => {},
    onPress: () => {},
    ...props,
  }),
}));

vi.mock("framer-motion", () => ({
  LazyMotion: ({ children }: { children: React.ReactNode }) => children,
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  m: new Proxy(
    {},
    { get: (_target, tag: string | symbol) => (typeof tag === "string" ? tag : undefined) }
  ),
}));


