import { execSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

export interface TempGitRepo {
  readonly root: string
  readonly defaultBranch: string
}

export const initTempGitRepo = (root: string, opts?: { envFile?: string; withSetup?: boolean }): TempGitRepo => {
  execSync("git init -b main", { cwd: root, stdio: "ignore" })
  execSync("git config user.email test@example.com", { cwd: root, stdio: "ignore" })
  execSync("git config user.name Test", { cwd: root, stdio: "ignore" })
  fs.writeFileSync(path.join(root, "README.md"), "hello\n")
  if (opts?.envFile !== undefined) {
    fs.writeFileSync(path.join(root, ".env"), opts.envFile)
    fs.writeFileSync(path.join(root, ".gitignore"), ".env\n")
    fs.writeFileSync(path.join(root, ".worktreeinclude"), ".env*\n")
  }
  if (opts?.withSetup) {
    fs.mkdirSync(path.join(root, ".coolie"), { recursive: true })
    fs.writeFileSync(path.join(root, ".coolie", "setup.sh"), `#!/bin/bash
set -e
test -f .env || exit 2
echo setup-ran
mkdir -p .coolie
echo "$COOLIE_PORT_0" > .coolie/port.txt
`)
  }
  execSync("git add README.md", { cwd: root, stdio: "ignore" })
  if (fs.existsSync(path.join(root, ".gitignore"))) execSync("git add .gitignore", { cwd: root, stdio: "ignore" })
  execSync("git commit -m init", { cwd: root, stdio: "ignore" })
  return { root, defaultBranch: "main" }
}
