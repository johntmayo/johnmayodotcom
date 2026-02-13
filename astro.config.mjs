import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  outDir: "./docs",
  site: "https://johnmayo.com",
  trailingSlash: "never"
});
