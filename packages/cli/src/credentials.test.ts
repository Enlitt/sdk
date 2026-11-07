import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  configDirectory,
  credentialPath,
  deleteCredential,
  loadCredential,
  pendingPath,
  requireCredential,
  saveCredential,
  writePrivateFile
} from "./credentials.js";
import type { StoredCredential } from "./credentials.js";
import { contextFor, loginAs, makeWorld, SENTINEL_CLI_TOKEN } from "./test-harness.js";
import type { World } from "./test-harness.js";

let world: World;

beforeEach(async () => {
  world = await makeWorld();
});

const credential: StoredCredential = {
  version: 1,
  api_origin: "https://api.enlitt.com",
  token: SENTINEL_CLI_TOKEN,
  credential_id: "cred_1",
  business: { id: "biz_1", name: "Acme Games" },
  login_email: "dev@example.com",
  token_expires_at: "2027-01-01T00:00:00Z"
};

const mode = async (path: string): Promise<string> => ((await stat(path)).mode & 0o777).toString(8);

describe("paths", () => {
  it("uses XDG_CONFIG_HOME, then ~/.config, and per-environment names", () => {
    const ctx = contextFor(world);
    expect(configDirectory(ctx)).toBe(join(world.config, "enlitt"));
    expect(credentialPath(ctx)).toBe(join(world.config, "enlitt", "cli-production.json"));
    expect(pendingPath(contextFor(world, { env: "staging" }))).toBe(join(world.config, "enlitt", "cli-staging.pending.json"));
    delete world.env.XDG_CONFIG_HOME;
    expect(configDirectory(contextFor(world))).toBe(join(world.home, ".config", "enlitt"));
  });

  it("uses %APPDATA% on Windows", () => {
    const base = contextFor(world);
    const ctx = { ...base, deps: { ...base.deps, platform: "win32" as const, env: { APPDATA: "C:\\Users\\x\\AppData\\Roaming" } } };
    expect(configDirectory(ctx)).toContain("enlitt");
    expect(configDirectory(ctx)).toContain("AppData");
  });
});

describe("save and load", () => {
  it("writes a 0600 file in a 0700 directory and reads it back", async () => {
    const ctx = contextFor(world);
    await saveCredential(ctx, credential);
    expect(await mode(credentialPath(ctx))).toBe("600");
    expect(await mode(configDirectory(ctx))).toBe("700");
    expect(await loadCredential(ctx)).toEqual(credential);
    expect(await readdir(configDirectory(ctx))).toEqual(["cli-production.json"]);
  });

  it("tightens an existing config directory that was too open", async () => {
    const ctx = contextFor(world);
    await mkdir(configDirectory(ctx), { recursive: true });
    await chmod(configDirectory(ctx), 0o755);
    await saveCredential(ctx, credential);
    expect(await mode(configDirectory(ctx))).toBe("700");
  });

  it("registers the token with the scrubber on load and save", async () => {
    const ctx = contextFor(world);
    await saveCredential(ctx, credential);
    const fresh = contextFor(world);
    await loadCredential(fresh);
    expect(fresh.secrets.scrub(`x ${SENTINEL_CLI_TOKEN} y`)).not.toContain(SENTINEL_CLI_TOKEN);
  });

  it("is not logged in without a file, with corrupt JSON, or with a malformed body", async () => {
    const ctx = contextFor(world);
    expect(await loadCredential(ctx)).toBeNull();
    await mkdir(configDirectory(ctx), { recursive: true });
    await writeFile(credentialPath(ctx), "{not json", { mode: 0o600 });
    expect(await loadCredential(ctx)).toBeNull();
    await writeFile(credentialPath(ctx), JSON.stringify({ version: 1, token: "x" }), { mode: 0o600 });
    expect(await loadCredential(ctx)).toBeNull();
    await expect(requireCredential(ctx)).rejects.toMatchObject({ code: "not_logged_in" });
  });

  it("reads a credential for another API origin as not logged in", async () => {
    const ctx = contextFor(world);
    await saveCredential(ctx, { ...credential, api_origin: "https://staging-api.enlitt.com" });
    expect(await loadCredential(ctx)).toBeNull();
  });

  it("reads an expired credential as not logged in", async () => {
    await loginAs(world, SENTINEL_CLI_TOKEN, "2026-06-15T11:59:59Z");
    expect(await loadCredential(contextFor(world))).toBeNull();
    await loginAs(world, SENTINEL_CLI_TOKEN, "not a date");
    expect(await loadCredential(contextFor(world))).toBeNull();
  });

  it("refuses a file other users can read, with the chmod action and without the token", async () => {
    const ctx = contextFor(world);
    await saveCredential(ctx, credential);
    await chmod(credentialPath(ctx), 0o644);
    const error = await loadCredential(ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "insecure_credential_file" });
    expect(JSON.stringify(error)).not.toContain(SENTINEL_CLI_TOKEN);
    expect(String((error as { action: string }).action)).toContain("chmod 600");
    // The CLI surfaces it rather than reporting a silent logout.
    const result = await world.run(["whoami", "--json"]);
    expect(result.json).toMatchObject({ error: { code: "insecure_credential_file" } });
    expect(result.stdout).not.toContain(SENTINEL_CLI_TOKEN);
  });

  it("skips the permission check on Windows", async () => {
    const base = contextFor(world);
    const ctx = { ...base, deps: { ...base.deps, platform: "win32" as const, env: { APPDATA: world.config } } };
    await saveCredential(ctx, credential);
    await chmod(credentialPath(ctx), 0o666);
    expect(await loadCredential(ctx)).toEqual(credential);
  });

  it("deleteCredential removes the file and succeeds when there is none", async () => {
    const ctx = contextFor(world);
    await saveCredential(ctx, credential);
    await deleteCredential(ctx);
    expect(await loadCredential(ctx)).toBeNull();
    await expect(deleteCredential(ctx)).resolves.toBeUndefined();
  });
});

describe("atomic write", () => {
  it("keeps the old file intact and leaves no temp file when the rename fails", async () => {
    const ctx = contextFor(world);
    await saveCredential(ctx, credential);
    // A directory at the target path makes the rename fail after the temp file is written.
    const blocked = join(configDirectory(ctx), "blocked");
    await mkdir(join(blocked, "inner"), { recursive: true });
    await expect(writePrivateFile(blocked, "secret")).rejects.toThrow();
    expect((await readdir(configDirectory(ctx))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(await readFile(credentialPath(ctx), "utf8")).token).toBe(SENTINEL_CLI_TOKEN);
  });

  it("replaces the file in one step and the result is 0600 even when the old one was looser", async () => {
    const ctx = contextFor(world);
    await saveCredential(ctx, credential);
    await chmod(credentialPath(ctx), 0o644);
    await saveCredential(ctx, { ...credential, credential_id: "cred_2" });
    expect(await mode(credentialPath(ctx))).toBe("600");
    expect((await loadCredential(ctx))?.credential_id).toBe("cred_2");
  });
});
