import { BusEvent } from "@/bus/bus-event"
import path from "path"
import { $ } from "bun"
import z from "zod"
import fs from "fs"
import os from "os"
import { NamedError } from "@opencode-ai/util/error"
import { Log } from "../util/log"
import { iife } from "@/util/iife"
import { Flag } from "../flag/flag"

declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const OPENCODE_UPDATE_REPO: string | undefined
}

import semver from "semver"

export namespace Installation {
  const log = Log.create({ service: "installation" })
  export const UPDATE_REPO = process.env["OPENCODE_UPDATE_REPO"] || OPENCODE_UPDATE_REPO || "anomalyco/opencode"
  const UPDATE_INSTALL_URL = process.env["OPENCODE_UPDATE_INSTALL_URL"] || "https://opencode.ai/install"
  const UPDATE_NPM_PACKAGE = process.env["OPENCODE_UPDATE_NPM_PACKAGE"] || "opencode-ai"
  const UPDATE_BINARY_PATH = process.env["OPENCODE_UPDATE_BINARY_PATH"]

  export type Method = Awaited<ReturnType<typeof method>>

  export type ReleaseType = "patch" | "minor" | "major"

  export const Event = {
    Updated: BusEvent.define(
      "installation.updated",
      z.object({
        version: z.string(),
      }),
    ),
    UpdateAvailable: BusEvent.define(
      "installation.update-available",
      z.object({
        version: z.string(),
      }),
    ),
  }

  export function getReleaseType(current: string, latest: string): ReleaseType {
    const currMajor = semver.major(current)
    const currMinor = semver.minor(current)
    const newMajor = semver.major(latest)
    const newMinor = semver.minor(latest)

    if (newMajor > currMajor) return "major"
    if (newMinor > currMinor) return "minor"
    return "patch"
  }

  export const Info = z
    .object({
      version: z.string(),
      latest: z.string(),
    })
    .meta({
      ref: "InstallationInfo",
    })
  export type Info = z.infer<typeof Info>

  export async function info() {
    return {
      version: VERSION,
      latest: await latest(),
    }
  }

  export function isPreview() {
    return CHANNEL !== "latest"
  }

  export function isLocal() {
    return CHANNEL === "local"
  }

  function releaseBase() {
    return `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`
  }

  function releaseTagURL(version: string, asset: string) {
    return `https://github.com/${UPDATE_REPO}/releases/download/v${version}/${asset}`
  }

  function supportsAvx2() {
    if (process.arch !== "x64") return false
    if (process.platform === "linux") {
      try {
        return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
      } catch {
        return false
      }
    }
    if (process.platform === "darwin") {
      return false
    }
    if (process.platform === "win32") {
      return false
    }
    return false
  }

  function isMusl() {
    if (process.platform !== "linux") return false
    try {
      if (fs.existsSync("/etc/alpine-release")) return true
    } catch {}
    return false
  }

  function releaseAssetName() {
    const platform = process.platform === "win32" ? "windows" : process.platform
    const arch = process.arch === "x64" || process.arch === "arm64" || process.arch === "arm" ? process.arch : "x64"
    const ext = process.platform === "linux" ? ".tar.gz" : ".zip"

    const result = ["opencode", platform, arch]
    if (process.arch === "x64" && !supportsAvx2()) result.push("baseline")
    if (isMusl()) result.push("musl")
    return result.join("-") + ext
  }

  async function upgradeBinary(target: string) {
    if (!UPDATE_BINARY_PATH) {
      throw new UpgradeFailedError({
        stderr: "OPENCODE_UPDATE_BINARY_PATH is required for binary updates",
      })
    }

    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opencode-upgrade-"))
    const asset = releaseAssetName()
    const archive = path.join(tmp, asset)
    const binary = process.platform === "win32" ? "opencode.exe" : "opencode"

    try {
      const response = await fetch(releaseTagURL(target, asset), {
        headers: {
          "User-Agent": USER_AGENT,
        },
      })
      if (!response.ok) throw new Error(`Failed to download ${asset}: ${response.status} ${response.statusText}`)

      await Bun.write(archive, await response.arrayBuffer())
      if (process.platform === "linux") {
        await $`tar -xzf ${archive}`.cwd(tmp).quiet()
      } else {
        await $`unzip -q ${archive} -d ${tmp}`.quiet()
      }

      const extracted = path.join(tmp, binary)
      const temp = UPDATE_BINARY_PATH + ".new"
      await fs.promises.mkdir(path.dirname(UPDATE_BINARY_PATH), { recursive: true })
      await fs.promises.copyFile(extracted, temp)
      await fs.promises.chmod(temp, 0o755).catch(() => {})
      await fs.promises.rm(UPDATE_BINARY_PATH, { force: true })
      await fs.promises.rename(temp, UPDATE_BINARY_PATH)
    } catch (error) {
      throw new UpgradeFailedError({
        stderr: error instanceof Error ? error.message : String(error),
      })
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }

  export async function method() {
    const forced = process.env["OPENCODE_UPDATE_METHOD"]
    if (forced === "binary" || forced === "curl" || forced === "npm" || forced === "pnpm" || forced === "bun")
      return forced
    if (UPDATE_BINARY_PATH) return "binary"
    if (process.execPath.includes(path.join(".opencode", "bin"))) return "curl"
    if (process.execPath.includes(path.join(".local", "bin"))) return "curl"
    const exec = process.execPath.toLowerCase()

    const checks = [
      {
        name: "npm" as const,
        command: () => $`npm list -g --depth=0`.throws(false).quiet().text(),
      },
      {
        name: "yarn" as const,
        command: () => $`yarn global list`.throws(false).quiet().text(),
      },
      {
        name: "pnpm" as const,
        command: () => $`pnpm list -g --depth=0`.throws(false).quiet().text(),
      },
      {
        name: "bun" as const,
        command: () => $`bun pm ls -g`.throws(false).quiet().text(),
      },
      {
        name: "brew" as const,
        command: () => $`brew list --formula opencode`.throws(false).quiet().text(),
      },
      {
        name: "scoop" as const,
        command: () => $`scoop list opencode`.throws(false).quiet().text(),
      },
      {
        name: "choco" as const,
        command: () => $`choco list --limit-output opencode`.throws(false).quiet().text(),
      },
    ]

    checks.sort((a, b) => {
      const aMatches = exec.includes(a.name)
      const bMatches = exec.includes(b.name)
      if (aMatches && !bMatches) return -1
      if (!aMatches && bMatches) return 1
      return 0
    })

    for (const check of checks) {
      const output = await check.command()
      const installedName = check.name === "brew" || check.name === "choco" || check.name === "scoop" ? "opencode" : UPDATE_NPM_PACKAGE
      if (output.includes(installedName)) {
        return check.name
      }
    }

    return "unknown"
  }

  export const UpgradeFailedError = NamedError.create(
    "UpgradeFailedError",
    z.object({
      stderr: z.string(),
    }),
  )

  async function getBrewFormula() {
    const tapFormula = await $`brew list --formula anomalyco/tap/opencode`.throws(false).quiet().text()
    if (tapFormula.includes("opencode")) return "anomalyco/tap/opencode"
    const coreFormula = await $`brew list --formula opencode`.throws(false).quiet().text()
    if (coreFormula.includes("opencode")) return "opencode"
    return "opencode"
  }

  export async function upgrade(method: Method, target: string) {
    if (method === "binary") {
      await upgradeBinary(target)
      log.info("upgraded", {
        method,
        target,
      })
      await $`${process.execPath} --version`.nothrow().quiet().text()
      return
    }

    let cmd
    switch (method) {
      case "curl":
        cmd = $`curl -fsSL ${UPDATE_INSTALL_URL} | bash`.env({
          ...process.env,
          VERSION: target,
        })
        break
      case "npm":
        cmd = $`npm install -g ${UPDATE_NPM_PACKAGE}@${target}`
        break
      case "pnpm":
        cmd = $`pnpm install -g ${UPDATE_NPM_PACKAGE}@${target}`
        break
      case "bun":
        cmd = $`bun install -g ${UPDATE_NPM_PACKAGE}@${target}`
        break
      case "brew": {
        const formula = await getBrewFormula()
        if (formula.includes("/")) {
          cmd =
            $`brew tap anomalyco/tap && cd "$(brew --repo anomalyco/tap)" && git pull --ff-only && brew upgrade ${formula}`.env(
              {
                HOMEBREW_NO_AUTO_UPDATE: "1",
                ...process.env,
              },
            )
          break
        }
        cmd = $`brew upgrade ${formula}`.env({
          HOMEBREW_NO_AUTO_UPDATE: "1",
          ...process.env,
        })
        break
      }
      case "choco":
        cmd = $`echo Y | choco upgrade opencode --version=${target}`
        break
      case "scoop":
        cmd = $`scoop install opencode@${target}`
        break
      default:
        throw new Error(`Unknown method: ${method}`)
    }
    const result = await cmd.quiet().throws(false)
    if (result.exitCode !== 0) {
      const stderr = method === "choco" ? "not running from an elevated command shell" : result.stderr.toString("utf8")
      throw new UpgradeFailedError({
        stderr: stderr,
      })
    }
    log.info("upgraded", {
      method,
      target,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    })
    await $`${process.execPath} --version`.nothrow().quiet().text()
  }

  export const VERSION = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
  export const CHANNEL = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
  export const USER_AGENT = `opencode/${CHANNEL}/${VERSION}/${Flag.OPENCODE_CLIENT}`

  export async function latest(installMethod?: Method) {
    const detectedMethod = installMethod || (await method())

    if (detectedMethod === "brew") {
      const formula = await getBrewFormula()
      if (formula.includes("/")) {
        const infoJson = await $`brew info --json=v2 ${formula}`.quiet().text()
        const info = JSON.parse(infoJson)
        const version = info.formulae?.[0]?.versions?.stable
        if (!version) throw new Error(`Could not detect version for tap formula: ${formula}`)
        return version
      }
      return fetch("https://formulae.brew.sh/api/formula/opencode.json")
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.versions.stable)
    }

    if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
      const registry = await iife(async () => {
        const r = (await $`npm config get registry`.quiet().nothrow().text()).trim()
        const reg = r || "https://registry.npmjs.org"
        return reg.endsWith("/") ? reg.slice(0, -1) : reg
      })
      const channel = CHANNEL
      return fetch(`${registry}/${UPDATE_NPM_PACKAGE}/${channel}`)
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.version)
    }

    if (detectedMethod === "choco") {
      return fetch(
        "https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%27opencode%27%20and%20IsLatestVersion&$select=Version",
        { headers: { Accept: "application/json;odata=verbose" } },
      )
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.d.results[0].Version)
    }

    if (detectedMethod === "scoop") {
      return fetch("https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/opencode.json", {
        headers: { Accept: "application/json" },
      })
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.version)
    }

    return fetch(releaseBase(), {
      headers: {
        "User-Agent": USER_AGENT,
      },
    })
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText)
        return res.json()
      })
      .then((data: any) => data.tag_name.replace(/^v/, ""))
  }
}
