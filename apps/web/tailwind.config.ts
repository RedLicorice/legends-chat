import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg:      "rgb(var(--ch-bg)      / <alpha-value>)",
        panel:   "rgb(var(--ch-panel)   / <alpha-value>)",
        panel2:  "rgb(var(--ch-panel2)  / <alpha-value>)",
        border:  "rgb(var(--ch-border)  / <alpha-value>)",
        text:    "rgb(var(--ch-text)    / <alpha-value>)",
        muted:   "rgb(var(--ch-muted)   / <alpha-value>)",
        accent:  "rgb(var(--ch-accent)  / <alpha-value>)",
        accent2: "rgb(var(--ch-accent2) / <alpha-value>)",
        danger:  "rgb(var(--ch-danger)  / <alpha-value>)",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
} satisfies Config;
