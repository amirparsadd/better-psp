// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://amirparsadd.github.io",
  base: "/better-psp",
  vite: {
    plugins: [tailwindcss()],
  },
});
