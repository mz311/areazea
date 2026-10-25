import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 950: "#050509", 900: "#0a0a12", 800: "#10101c", 700: "#181828", 600: "#232338" },
        neon: { 300: "#c4a1ff", 400: "#a66bff", 500: "#8b3dff", 600: "#7020e6", 700: "#5a16bd" },
      },
      boxShadow: {
        neon: "0 0 24px -4px rgba(139,61,255,.55)",
        "neon-lg": "0 0 60px -8px rgba(139,61,255,.65)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "system-ui", "sans-serif"],
      },
      keyframes: {
        float: { "0%,100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-10px)" } },
        shimmer: { "100%": { transform: "translateX(100%)" } },
      },
      animation: { float: "float 6s ease-in-out infinite", shimmer: "shimmer 2s infinite" },
    },
  },
  plugins: [],
};
export default config;
