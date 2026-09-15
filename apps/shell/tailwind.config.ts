import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        rail: "var(--rail)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        line: "var(--line)",
        paper: "var(--paper)",
        surface: "var(--surface)",
        accent: "var(--accent)",
        ok: "var(--ok)",
        warn: "var(--warn)",
        danger: "var(--danger)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
      boxShadow: {
        panel: "0 1px 0 rgba(28, 27, 25, 0.04)",
      },
    },
  },
  plugins: [],
};

export default config;
