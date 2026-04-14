import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "#0b0d12",
        panel: "#141821",
        panel2: "#1a1f2b",
        border: "#262d3b",
        text: "#e6e9f2",
        muted: "#8a93a6",
        accent: "#7c5cff",
        accent2: "#5cc8ff",
        danger: "#ff5c7c",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
