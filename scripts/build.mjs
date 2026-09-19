import { watch } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { build, context } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(root, "src");
const publicDirectory = resolve(root, "public");
const outputDirectory = resolve(root, "dist");
const isWatchMode = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: [
    resolve(sourceDirectory, "background/index.ts"),
    resolve(sourceDirectory, "content/index.ts"),
    resolve(sourceDirectory, "popup/index.ts"),
    resolve(sourceDirectory, "popup/popup.css"),
    resolve(sourceDirectory, "options/index.ts"),
    resolve(sourceDirectory, "options/options.css"),
    resolve(sourceDirectory, "demo/index.ts"),
    resolve(sourceDirectory, "demo/demo.css")
  ],
  outbase: sourceDirectory,
  outdir: outputDirectory,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome120"],
  sourcemap: true,
  logLevel: "info"
};

async function copyPublicFiles() {
  await mkdir(outputDirectory, { recursive: true });
  await cp(publicDirectory, outputDirectory, { recursive: true, force: true });
}

async function buildOnce() {
  await rm(outputDirectory, { recursive: true, force: true });
  await copyPublicFiles();
  await build(buildOptions);
}

if (!isWatchMode) {
  await buildOnce();
} else {
  await rm(outputDirectory, { recursive: true, force: true });
  await copyPublicFiles();
  const buildContext = await context(buildOptions);
  await buildContext.rebuild();
  await buildContext.watch();
  const publicWatcher = watch(publicDirectory, { recursive: true }, () => {
    void copyPublicFiles();
  });

  console.log("Watching source files. Load dist/ as an unpacked extension.");
  const stop = async () => {
    publicWatcher.close();
    await buildContext.dispose();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await new Promise(() => undefined);
}
