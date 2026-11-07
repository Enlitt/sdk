import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { checkEnvTarget, inspectEnvFile, readEnvPresence, readEnvValueForCheck, upsertEnvValue } from "./env-file.js";
import { contextFor, makeWorld, SENTINEL_SECRET } from "./test-harness.js";
import type { World } from "./test-harness.js";
import type { CliContext } from "./main.js";

let world: World;
let ctx: CliContext;

beforeEach(async () => {
  world = await makeWorld();
  ctx = contextFor(world);
});

const secretInput = { file: ".env.local", name: "ENLITT_SECRET_KEY", value: SENTINEL_SECRET, replace: false, secret: true };

const modeOf = async (relative: string): Promise<string> =>
  ((await stat(join(world.project, relative))).mode & 0o777).toString(8);

describe("upsertEnvValue", () => {
  it("creates the file with mode 0600 and appends the file to .gitignore once", async () => {
    const result = await upsertEnvValue(ctx, secretInput);
    expect(result).toEqual({ file: ".env.local", replaced: false, gitignored: true, changed: true });
    expect(await world.read(".env.local")).toBe(`ENLITT_SECRET_KEY=${SENTINEL_SECRET}\n`);
    expect(await modeOf(".env.local")).toBe("600");
    expect(await world.read(".gitignore")).toBe("/.env.local\n");

    // A second variable in the same file does not duplicate the ignore line.
    await upsertEnvValue(ctx, { ...secretInput, name: "ENLITT_CLIENT_ID", value: "enl_client_abc", secret: false });
    expect(await world.read(".gitignore")).toBe("/.env.local\n");
  });

  it("keeps existing .gitignore content and adds a missing trailing newline", async () => {
    await world.write(".gitignore", "node_modules");
    await upsertEnvValue(ctx, secretInput);
    expect(await world.read(".gitignore")).toBe("node_modules\n/.env.local\n");
  });

  it("does not touch .gitignore when the file is already ignored", async () => {
    world.git.ignored.add(".env.local");
    const result = await upsertEnvValue(ctx, secretInput);
    expect(result.gitignored).toBe(true);
    await expect(world.read(".gitignore")).rejects.toThrow();
  });

  it("outside a git work tree it writes the file and reports not ignored", async () => {
    world.git.inWorkTree = false;
    const result = await upsertEnvValue(ctx, secretInput);
    expect(result.gitignored).toBe(false);
    await expect(world.read(".gitignore")).rejects.toThrow();
  });

  it("refuses a tracked file before any write", async () => {
    world.git.tracked.add(".env.local");
    await world.write(".env.local", "KEEP=1\n");
    await expect(upsertEnvValue(ctx, secretInput)).rejects.toMatchObject({ code: "env_file_tracked" });
    expect(await world.read(".env.local")).toBe("KEEP=1\n");
    await expect(world.read(".gitignore")).rejects.toThrow();
  });

  it("refuses an existing key without replace and leaves the file byte-identical", async () => {
    const original = "# header\r\nENLITT_SECRET_KEY=old\r\n\nOTHER=1";
    await world.write(".env.local", original);
    await expect(upsertEnvValue(ctx, secretInput)).rejects.toMatchObject({ code: "env_key_exists" });
    expect(await world.read(".env.local")).toBe(original);
    await expect(checkEnvTarget(ctx, { file: ".env.local", name: "ENLITT_SECRET_KEY", replace: false })).rejects.toMatchObject({ code: "env_key_exists" });
    await expect(checkEnvTarget(ctx, { file: ".env.local", name: "ENLITT_SECRET_KEY", replace: true })).resolves.toBeUndefined();
  });

  it("replace changes only the matching line and keeps comments, blanks, and CRLF", async () => {
    await world.write(".env.local", "# header\r\nENLITT_SECRET_KEY=old\r\n\nOTHER=1\nexport ENLITT_SECRET_KEY_2=x\n");
    const result = await upsertEnvValue(ctx, { ...secretInput, replace: true });
    expect(result.replaced).toBe(true);
    expect(await world.read(".env.local")).toBe(
      `# header\r\nENLITT_SECRET_KEY=${SENTINEL_SECRET}\r\n\nOTHER=1\nexport ENLITT_SECRET_KEY_2=x\n`
    );
    expect(await modeOf(".env.local")).toBe("600");
  });

  it("appends to a file that lacks a trailing newline and keeps its other lines", async () => {
    await world.write(".env.local", "OTHER=1");
    await upsertEnvValue(ctx, secretInput);
    expect(await world.read(".env.local")).toBe(`OTHER=1\nENLITT_SECRET_KEY=${SENTINEL_SECRET}\n`);
  });

  it("reports changed:false and writes nothing when the line already holds the value", async () => {
    await upsertEnvValue(ctx, secretInput);
    await chmod(join(world.project, ".env.local"), 0o644);
    const again = await upsertEnvValue(ctx, { ...secretInput, replace: true });
    expect(again.changed).toBe(false);
    // A secret file is tightened even when no content changes.
    expect(await modeOf(".env.local")).toBe("600");
  });

  it("leaves a non-secret variable's file mode alone", async () => {
    await world.write(".env.local", "A=1\n");
    await chmod(join(world.project, ".env.local"), 0o640);
    await upsertEnvValue(ctx, { ...secretInput, name: "ENLITT_CLIENT_ID", value: "enl_client_abc", secret: false });
    expect(await modeOf(".env.local")).toBe("640");
  });

  it("leaves no temp files behind", async () => {
    await upsertEnvValue(ctx, secretInput);
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(world.project)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses paths that leave the project", async () => {
    for (const file of ["../outside.env", "/etc/enlitt.env", "a/../../outside.env"]) {
      await expect(upsertEnvValue(ctx, { ...secretInput, file }), file).rejects.toMatchObject({ code: "usage_error" });
    }
    await expect(readFile(join(world.root, "outside.env"), "utf8")).rejects.toThrow();
  });

  it("refuses a symlink that points outside the project, for the file and for a directory", async () => {
    await writeFile(join(world.root, "outside.env"), "OUT=1\n");
    await symlink(join(world.root, "outside.env"), join(world.project, "link.env"));
    await expect(upsertEnvValue(ctx, { ...secretInput, file: "link.env" })).rejects.toMatchObject({ code: "usage_error" });
    expect(await readFile(join(world.root, "outside.env"), "utf8")).toBe("OUT=1\n");

    await mkdir(join(world.root, "elsewhere"));
    await symlink(join(world.root, "elsewhere"), join(world.project, "dir"));
    await expect(upsertEnvValue(ctx, { ...secretInput, file: "dir/.env" })).rejects.toMatchObject({ code: "usage_error" });
    await expect(stat(join(world.root, "elsewhere", ".env"))).rejects.toThrow();
  });

  it("allows a symlink that stays inside the project", async () => {
    await world.write("real.env", "A=1\n");
    await symlink(join(world.project, "real.env"), join(world.project, "inside.env"));
    await expect(upsertEnvValue(ctx, { ...secretInput, file: "inside.env" })).resolves.toMatchObject({ changed: true });
  });

  it("creates missing parent directories inside the project", async () => {
    await upsertEnvValue(ctx, { ...secretInput, file: "apps/web/.env.local" });
    expect(await world.read("apps/web/.env.local")).toContain("ENLITT_SECRET_KEY=");
  });

  it("rejects names and values that would corrupt the file without echoing the value", async () => {
    const bad = "x y\nINJECT=1";
    const error = await upsertEnvValue(ctx, { ...secretInput, value: bad }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain("INJECT");
    await expect(upsertEnvValue(ctx, { ...secretInput, name: "BAD NAME" })).rejects.toThrow();
  });

  it("without git installed it still writes and does not claim the file is ignored", async () => {
    world.git.missing = true;
    const result = await upsertEnvValue(ctx, secretInput);
    expect(result.gitignored).toBe(false);
    expect(await modeOf(".env.local")).toBe("600");
  });
});

describe("readers", () => {
  it("readEnvPresence reports booleans only, and empty values count as absent", async () => {
    await world.write(".env.local", `ENLITT_SECRET_KEY=${SENTINEL_SECRET}\nENLITT_CLIENT_ID=\n`);
    const presence = await readEnvPresence(ctx, ".env.local", ["ENLITT_SECRET_KEY", "ENLITT_CLIENT_ID", "NOPE"]);
    expect(presence).toEqual({ ENLITT_SECRET_KEY: true, ENLITT_CLIENT_ID: false, NOPE: false });
    expect(await readEnvPresence(ctx, "missing.env", ["A"])).toEqual({ A: false });
  });

  it("readEnvValueForCheck returns the value, or undefined when missing or empty", async () => {
    await world.write(".env.local", "A=1\nB=\n");
    expect(await readEnvValueForCheck(ctx, ".env.local", "A")).toBe("1");
    expect(await readEnvValueForCheck(ctx, ".env.local", "B")).toBeUndefined();
    expect(await readEnvValueForCheck(ctx, "none.env", "A")).toBeUndefined();
  });

  it("inspectEnvFile reports existence, tracking, ignore state, and loose modes", async () => {
    expect(await inspectEnvFile(ctx, ".env.local")).toEqual({ exists: false, tracked: false, ignored: null, looseMode: false });
    await world.write(".env.local", "A=1\n");
    await chmod(join(world.project, ".env.local"), 0o644);
    expect(await inspectEnvFile(ctx, ".env.local")).toEqual({ exists: true, tracked: false, ignored: false, looseMode: true });
    world.git.tracked.add(".env.local");
    world.git.ignored.add(".env.local");
    await chmod(join(world.project, ".env.local"), 0o600);
    expect(await inspectEnvFile(ctx, ".env.local")).toMatchObject({ tracked: true, ignored: true, looseMode: false });
    world.git.inWorkTree = false;
    expect((await inspectEnvFile(ctx, ".env.local")).ignored).toBeNull();
  });
});
