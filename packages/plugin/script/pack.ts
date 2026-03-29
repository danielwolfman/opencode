#!/usr/bin/env bun
import { Script } from "@opencode-ai/script"
import { $ } from "bun"
import { fileURLToPath } from "url"
import path from "path"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

await $`rm -rf dist`
await $`bun tsc`

const pkg = await import("../package.json").then((m) => m.default)
const original = JSON.parse(JSON.stringify(pkg))

try {
  pkg.version = Script.version

  for (const [key, value] of Object.entries(pkg.exports)) {
    if (typeof value !== "string") continue
    const file = value.replace("./src/", "./dist/").replace(".ts", "")
    // @ts-ignore
    pkg.exports[key] = {
      import: file + ".js",
      types: file + ".d.ts",
    }
  }

  await Bun.write("package.json", JSON.stringify(pkg, null, 2))
  await $`bun pm pack`

  const name = Array.from(new Bun.Glob("*.tgz").scanSync(".")).at(0)
  if (!name) throw new Error("Failed to locate packed plugin tarball")
  await $`mkdir -p dist`
  await $`mv ./${name} ./dist/${name}`

  console.log(path.join(dir, "dist", name))
} finally {
  await Bun.write("package.json", JSON.stringify(original, null, 2) + "\n")
}
