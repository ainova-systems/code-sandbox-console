const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  // `vscode` is provided by the runtime host, never bundle it.
  external: ["vscode"],
  // Sourcemaps are a watch-mode/dev convenience only. `.vscodeignore` excludes
  // `**/*.map` from the VSIX, so a production build must not emit a
  // `sourceMappingURL` comment pointing at a file that never ships.
  sourcemap: watch ? true : false,
  logLevel: "info",
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
